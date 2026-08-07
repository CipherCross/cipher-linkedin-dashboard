-- The machine ingest path: the credential relation, the batch ledger that makes
-- a repeated payload idempotent, and the write surface of app_machine. Apply
-- after 008 in a tenant database that has received the full baseline.
--
-- Why this step exists. The sync agent runs on notebooks nobody in this project
-- administers, and today it authenticates to the database with a key that
-- bypasses every row policy: one shared credential, held in a config file on
-- every notebook, that cannot be scoped to one machine, cannot be rotated
-- without touching all of them, and cannot be revoked at all without revoking
-- everyone. Every property this step adds is a property that key cannot have.
--
-- The shape mirrors step 007's system write path, with three differences, and
-- each is the point:
--
--   * The role is app_machine, the seven-role bootstrap's "machine/ingest
--     principal reserved for S21, fails closed". Until now it held no grant of
--     any kind. It gains DML on exactly the seven relations the agent writes
--     and on the two this step creates, and nothing else.
--   * The gate is not one constant. app_system's policies compare
--     app.actor_id against the nil uuid, because there is exactly one system
--     principal. There are as many machines as there are notebooks, so the
--     machine gate is a lookup: app.actor_id must be the id of a credential row
--     that exists, is not revoked and has not expired. Revocation is therefore
--     enforced by the database on every statement, not by the handler that
--     happens to check first.
--   * The gate also SCOPES. Every business policy below additionally requires
--     the row's instance to be the credential's instance, so a credential
--     issued for one notebook cannot write another notebook's leads even
--     through a handler bug. Step 007 needs no equivalent: the system principal
--     legitimately spans every instance.
--
-- What this step does NOT do:
--
--   * It grants nothing to app_runtime, app_system, app_readonly or
--     app_ai_runner, and takes nothing away from them. The three admin
--     functions in section E are granted to app_runtime alone and gate
--     themselves on public.is_app_admin(), exactly as step 004's write path
--     does -- an ordinary member cannot mint a machine credential, and no role
--     receives raw DML on the credential table.
--   * It adds no DELETE, anywhere, to any role. A credential is revoked, never
--     removed, because a removed credential takes its batch history with it.
--   * It does not touch the AI SQL guard, which stays SELECT-only. The
--     credential table is readable through the guard exactly as every other
--     table is -- and carries no secret material to read: only a SHA-256 of a
--     256-bit random secret, which is not reversible to the secret.
--   * It creates no role and changes no role attribute. app_machine is a
--     seven-role contract member and already exists in every prepared cluster.
--     It is NOLOGIN there, and the LOGIN attribute a production deployment
--     needs is cluster scope, not database scope: it arrives through the
--     additive control-plane artifact 000_machine_ingest_role_bootstrap.sql,
--     pinned in the manifest beside this step, for the same reason step 007's
--     login did. This step is correct and complete in a database whose
--     app_machine cannot log in; nothing in it depends on the attribute.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_machine') THEN
        RAISE EXCEPTION
            'app_machine does not exist: prepare the cluster with the seven-role '
            'bootstrap before applying step 009'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
END
$$;

SET ROLE app_owner;

--
-- SECTION A -- THE CREDENTIAL RELATION
--
-- Name: agent_credential; Owner: app_owner
--
-- One row per machine that may ingest. `instance_id` is deliberately plain text
-- with no foreign key to public.instances: a credential is issued BEFORE the
-- notebook it belongs to has ever synced, and the row in public.instances is
-- created by the first ingest that credential performs. A foreign key would
-- make issuing a credential for a new notebook impossible without first
-- inventing its instance row by hand.
--
-- `tenant_id` is the value a deployment declares about itself. In the
-- one-database-per-tenant shape this baseline is built for it is redundant with
-- the database, and that redundancy is the check: a credential minted for
-- another tenant, or a dump restored into the wrong deployment, is refused by
-- section D rather than accepted because the row happened to be present.
--
-- What is stored of the secret is a SHA-256 of it, hex, and nothing else. The
-- secret is 256 bits from a CSPRNG, so a slow password KDF would buy nothing
-- that its entropy has not already bought -- there is no dictionary to run
-- against it and no human memory that shortened it. The unique index means an
-- issuing bug cannot mint the same secret twice; it is not a lookup path, and
-- section D never selects on it alone.
--
CREATE TABLE public.agent_credential (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    instance_id text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    secret_algo text DEFAULT 'sha256'::text NOT NULL,
    secret_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_reason text,
    last_used_at timestamp with time zone,
    CONSTRAINT agent_credential_tenant_id_check
        CHECK (tenant_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    CONSTRAINT agent_credential_instance_id_check
        CHECK (instance_id <> ''::text AND char_length(instance_id) <= 200),
    CONSTRAINT agent_credential_label_check
        CHECK (char_length(label) <= 200),
    CONSTRAINT agent_credential_secret_algo_check
        CHECK (secret_algo = 'sha256'::text),
    CONSTRAINT agent_credential_secret_hash_check
        CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT agent_credential_revoked_reason_check
        CHECK (revoked_reason IS NULL OR char_length(revoked_reason) <= 500),
    CONSTRAINT agent_credential_revoked_reason_needs_revocation
        CHECK (revoked_reason IS NULL OR revoked_at IS NOT NULL)
);

ALTER TABLE ONLY public.agent_credential
    ADD CONSTRAINT agent_credential_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_credential
    ADD CONSTRAINT agent_credential_secret_hash_key UNIQUE (secret_hash);

CREATE INDEX agent_credential_instance_id_idx
    ON public.agent_credential USING btree (instance_id);

--
-- SECTION B -- THE BATCH LEDGER
--
-- Name: agent_ingest_batch; Owner: app_owner
--
-- What makes a repeated payload idempotent. One row per (credential,
-- idempotency key), written in the SAME transaction as the rows it describes.
--
-- There is deliberately no status column and no 'failed' row. A batch that
-- fails part way rolls back, and the claim row rolls back with it, so a failed
-- ingest leaves no trace at all and the retry is an ordinary first attempt. A
-- status column would mean the opposite: a 'failed' row committed separately
-- from the writes it describes, which is a second write that can itself fail,
-- and a retry that has to decide whether to trust it.
--
-- `payload_digest` is what makes the key honest. The same key with the same
-- payload is a replay and is answered from `row_counts`; the same key with a
-- DIFFERENT payload is a caller bug -- two distinct batches sharing a key --
-- and is refused rather than silently answered with the first batch's result.
--
-- The foreign key has no ON DELETE action, deliberately: no role holds DELETE
-- on public.agent_credential, so the reference cannot be broken, and a
-- cascade would be a delete path written for a delete that must never happen.
--
CREATE TABLE public.agent_ingest_batch (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    credential_id uuid NOT NULL,
    instance_id text NOT NULL,
    idempotency_key text NOT NULL,
    payload_digest text NOT NULL,
    row_counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    rows_written integer DEFAULT 0 NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_ingest_batch_idempotency_key_check
        CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$'),
    CONSTRAINT agent_ingest_batch_payload_digest_check
        CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT agent_ingest_batch_rows_written_check
        CHECK (rows_written >= 0)
);

ALTER TABLE ONLY public.agent_ingest_batch
    ADD CONSTRAINT agent_ingest_batch_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_ingest_batch
    ADD CONSTRAINT agent_ingest_batch_credential_id_idempotency_key_key
        UNIQUE (credential_id, idempotency_key);

ALTER TABLE ONLY public.agent_ingest_batch
    ADD CONSTRAINT agent_ingest_batch_credential_id_fkey
        FOREIGN KEY (credential_id) REFERENCES public.agent_credential(id);

CREATE INDEX agent_ingest_batch_instance_received_idx
    ON public.agent_ingest_batch USING btree (instance_id, received_at DESC);

--
-- SECTION C -- THE MACHINE ACTOR
--
-- Name: machine_actor_instance(); Owner: app_owner
--
-- The single question every policy in section D asks: which notebook is the
-- currently published actor allowed to write, if any? It returns NULL for an
-- absent, malformed, unknown, revoked or expired actor -- and NULL never equals
-- an instance_id, so every policy below fails closed on all five at once rather
-- than needing five clauses.
--
-- SECURITY DEFINER because the policies of section D must be able to consult
-- the credential table without app_machine holding a general read of it, and
-- STABLE so the lookup is evaluated once per statement rather than once per row.
-- It takes no argument and therefore cannot be pointed at another actor: it
-- reports on the transaction it is called in and nothing else.
--
-- The uuid regex before the cast is step 002's, for step 002's reason: a
-- malformed setting must make the policy false, not raise 22P02 from inside a
-- policy where the error text would be the caller's only feedback.
--
CREATE FUNCTION public.machine_actor_instance() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select c.instance_id
    from public.agent_credential c
   where c.id = case
       when pg_catalog.current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         then pg_catalog.current_setting('app.actor_id', true)::uuid
       else null::uuid
     end
     and c.revoked_at is null
     and (c.expires_at is null or c.expires_at > pg_catalog.now());
$$;

REVOKE ALL ON FUNCTION public.machine_actor_instance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.machine_actor_instance() TO app_machine;

--
-- SECTION D -- THE MACHINE WRITE SURFACE
--
-- The grants bound the command vocabulary; the policies bound the rows. No
-- DELETE is granted anywhere, so FOR ALL opens no delete.
--
-- public.agent_credential is granted SELECT and a COLUMN-LEVEL UPDATE on
-- last_used_at only. A machine may record that it was used and may read its own
-- row; it may not revoke itself, extend its own expiry, move itself to another
-- instance or read any other machine's row.
--

GRANT SELECT, INSERT, UPDATE ON TABLE
    public.instances,
    public.campaigns,
    public.campaign_steps,
    public.leads,
    public.messages,
    public.events,
    public.sync_runs
    TO app_machine;

GRANT SELECT, INSERT ON TABLE public.agent_ingest_batch TO app_machine;

GRANT SELECT ON TABLE public.agent_credential TO app_machine;
GRANT UPDATE (last_used_at) ON TABLE public.agent_credential TO app_machine;

GRANT USAGE, SELECT ON SEQUENCE
    public.messages_id_seq,
    public.events_id_seq
    TO app_machine;

ALTER TABLE public.agent_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_ingest_batch ENABLE ROW LEVEL SECURITY;

-- The two relations this step creates carry the same active-human policy every
-- other business table received in step 002, so the dashboard's own reads of
-- them behave like every other read. app_runtime gets SELECT only: the write
-- path for a human is section E's three functions, never a statement.

GRANT SELECT ON TABLE public.agent_credential TO app_runtime, app_readonly;
GRANT SELECT ON TABLE public.agent_ingest_batch TO app_runtime, app_readonly;

CREATE POLICY agent_credential_active_member ON public.agent_credential
    FOR SELECT TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY agent_ingest_batch_active_member ON public.agent_ingest_batch
    FOR SELECT TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

-- One FOR ALL policy per relation for the machine, each gated on the credential
-- AND scoped to its instance. public.instances is keyed by id rather than by an
-- instance_id column, and campaign_steps reaches its instance through its
-- campaign; the other five carry the column directly.

CREATE POLICY instances_machine_actor ON public.instances
    FOR ALL TO app_machine
    USING (id = public.machine_actor_instance())
    WITH CHECK (id = public.machine_actor_instance());

CREATE POLICY campaigns_machine_actor ON public.campaigns
    FOR ALL TO app_machine
    USING (instance_id = public.machine_actor_instance())
    WITH CHECK (instance_id = public.machine_actor_instance());

CREATE POLICY campaign_steps_machine_actor ON public.campaign_steps
    FOR ALL TO app_machine
    USING (EXISTS (
        SELECT 1 FROM public.campaigns c
         WHERE c.id = campaign_steps.campaign_id
           AND c.instance_id = public.machine_actor_instance()))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.campaigns c
         WHERE c.id = campaign_steps.campaign_id
           AND c.instance_id = public.machine_actor_instance()));

CREATE POLICY leads_machine_actor ON public.leads
    FOR ALL TO app_machine
    USING (instance_id = public.machine_actor_instance())
    WITH CHECK (instance_id = public.machine_actor_instance());

CREATE POLICY messages_machine_actor ON public.messages
    FOR ALL TO app_machine
    USING (instance_id = public.machine_actor_instance())
    WITH CHECK (instance_id = public.machine_actor_instance());

CREATE POLICY events_machine_actor ON public.events
    FOR ALL TO app_machine
    USING (instance_id = public.machine_actor_instance())
    WITH CHECK (instance_id = public.machine_actor_instance());

CREATE POLICY sync_runs_machine_actor ON public.sync_runs
    FOR ALL TO app_machine
    USING (instance_id = public.machine_actor_instance())
    WITH CHECK (instance_id = public.machine_actor_instance());

-- The batch ledger and the credential's own row. Both are keyed on the actor
-- itself rather than on the instance: two credentials may serve one notebook
-- (a rotation overlap), and neither may read or claim the other's batches.

CREATE POLICY agent_ingest_batch_machine_actor ON public.agent_ingest_batch
    FOR ALL TO app_machine
    USING (
        instance_id = public.machine_actor_instance()
        AND credential_id::text = current_setting('app.actor_id', true))
    WITH CHECK (
        instance_id = public.machine_actor_instance()
        AND credential_id::text = current_setting('app.actor_id', true));

CREATE POLICY agent_credential_machine_self ON public.agent_credential
    FOR ALL TO app_machine
    USING (id::text = current_setting('app.actor_id', true)
        AND instance_id = public.machine_actor_instance())
    WITH CHECK (id::text = current_setting('app.actor_id', true)
        AND instance_id = public.machine_actor_instance());

--
-- SECTION E -- RESOLUTION, ISSUE AND REVOCATION
--
-- Name: agent_credential_resolve(uuid, text, text); Owner: app_owner
--
-- The machine equivalent of step 004's identity_resolve_actor, and the second
-- function in this baseline deliberately reachable with no actor context,
-- because -- like that one -- it is what establishes the actor.
--
-- It answers one question: does this exact (id, secret hash, tenant) triple
-- name a live credential? Three properties keep it from being more than that:
--
--   * It is not an enumeration primitive. An unknown id, a wrong secret, a
--     foreign tenant, a revoked credential and an expired one all return zero
--     rows and are indistinguishable from each other.
--   * The caller must already hold BOTH halves of the token. Presenting an id
--     alone tells you nothing; presenting a secret alone is not a call this
--     function accepts.
--   * The tenant is an argument rather than a lookup, so a deployment declares
--     which tenant it serves and a credential belonging to another one is
--     refused HERE, before an actor is published, rather than by a handler.
--
-- The hash comparison is an ordinary SQL equality and is not constant-time. What
-- a timing oracle on it could recover is the stored SHA-256 -- which the caller
-- must already possess to be asking, and which does not yield the secret.
--
CREATE FUNCTION public.agent_credential_resolve(
    p_credential_id uuid,
    p_secret_hash text,
    p_tenant_id text
) RETURNS TABLE (credential_id uuid, instance_id text, tenant_id text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select c.id, c.instance_id, c.tenant_id
    from public.agent_credential c
   where c.id = p_credential_id
     and c.secret_hash = p_secret_hash
     and c.tenant_id = p_tenant_id
     and c.revoked_at is null
     and (c.expires_at is null or c.expires_at > pg_catalog.now());
$$;

REVOKE ALL ON FUNCTION public.agent_credential_resolve(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_credential_resolve(uuid, text, text) TO app_machine;

--
-- Name: agent_credential_issue(text, text, text, timestamptz, text); Owner: app_owner
--
-- Issue, gated on public.is_app_admin() exactly as step 004's write path is.
-- The secret is generated by the CALLER and only its hash is passed here: a
-- secret this function generated would have to travel back through a result
-- set, which puts it in the server log of anything that logs statements and in
-- the query plan cache. What comes back is the row, never secret material.
--
-- It is not an upsert. Issuing is always a new credential, because rotation is
-- "issue the new one, revoke the old one when the notebook has it" -- an
-- overlap the unique key on (credential, idempotency key) is unaffected by.
--
CREATE FUNCTION public.agent_credential_issue(
    p_tenant_id text,
    p_instance_id text,
    p_label text,
    p_secret_hash text,
    p_expires_at timestamp with time zone DEFAULT NULL
) RETURNS TABLE (
    id uuid,
    tenant_id text,
    instance_id text,
    label text,
    created_at timestamp with time zone,
    expires_at timestamp with time zone
)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_actor uuid;
begin
  if not public.is_app_admin() then
    raise exception 'insufficient_privilege: an admin actor is required to issue a machine credential'
      using errcode = '42501';
  end if;

  v_actor := case
      when pg_catalog.current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then pg_catalog.current_setting('app.actor_id', true)::uuid
      else null::uuid
    end;

  return query
  insert into public.agent_credential (
      tenant_id, instance_id, label, secret_hash, created_by, expires_at)
  values (
      p_tenant_id, p_instance_id, coalesce(p_label, ''), p_secret_hash, v_actor, p_expires_at)
  returning
      agent_credential.id,
      agent_credential.tenant_id,
      agent_credential.instance_id,
      agent_credential.label,
      agent_credential.created_at,
      agent_credential.expires_at;
end;
$$;

REVOKE ALL ON FUNCTION public.agent_credential_issue(text, text, text, text, timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_credential_issue(text, text, text, text, timestamp with time zone) TO app_runtime;

--
-- Name: agent_credential_revoke(uuid, text); Owner: app_owner
--
-- Revocation, admin-gated on the same predicate. It is idempotent in the sense
-- that matters operationally -- revoking an already-revoked credential returns
-- the row and does not move revoked_at, so an operator repeating the call after
-- a timeout does not rewrite the moment the credential died -- and it returns
-- zero rows for an id that does not exist, which the caller reports as a 404
-- rather than as a success.
--
CREATE FUNCTION public.agent_credential_revoke(
    p_credential_id uuid,
    p_reason text DEFAULT NULL
) RETURNS TABLE (
    id uuid,
    instance_id text,
    revoked_at timestamp with time zone,
    revoked_reason text
)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.is_app_admin() then
    raise exception 'insufficient_privilege: an admin actor is required to revoke a machine credential'
      using errcode = '42501';
  end if;

  return query
  update public.agent_credential c
     set revoked_at = coalesce(c.revoked_at, pg_catalog.now()),
         revoked_reason = coalesce(c.revoked_reason, nullif(p_reason, ''))
   where c.id = p_credential_id
  returning c.id, c.instance_id, c.revoked_at, c.revoked_reason;
end;
$$;

REVOKE ALL ON FUNCTION public.agent_credential_revoke(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_credential_revoke(uuid, text) TO app_runtime;

--
-- Name: agent_credential_directory(); Owner: app_owner
--
-- The admin read. public.agent_credential's member policy already lets any
-- active member SELECT it, which is deliberate -- there is nothing secret in the
-- row -- but the dashboard needs a projection with a stable shape and an
-- explicit refusal for non-admins, so the listing is a function like the roster
-- read rather than a table scan spelled out in a handler.
--
-- It returns no secret_hash. The hash is not secret material in the sense that
-- matters, but a listing is the wrong place to hand it out: nothing on the read
-- path has a use for it, and the resolve function is the only thing that
-- compares it.
--
CREATE FUNCTION public.agent_credential_directory() RETURNS TABLE (
    id uuid,
    tenant_id text,
    instance_id text,
    label text,
    created_at timestamp with time zone,
    created_by uuid,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_reason text,
    last_used_at timestamp with time zone
)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.is_app_admin() then
    raise exception 'insufficient_privilege: an admin actor is required to list machine credentials'
      using errcode = '42501';
  end if;

  return query
  select c.id, c.tenant_id, c.instance_id, c.label, c.created_at, c.created_by,
         c.expires_at, c.revoked_at, c.revoked_reason, c.last_used_at
    from public.agent_credential c
   order by c.instance_id, c.created_at desc;
end;
$$;

REVOKE ALL ON FUNCTION public.agent_credential_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_credential_directory() TO app_runtime;

RESET ROLE;
