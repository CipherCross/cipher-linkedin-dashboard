-- The system write path: RLS and grants for server-owned jobs that have no
-- human actor. Apply after 006 in a tenant database that has received the
-- full baseline.
--
-- Why this step exists. Every business-table policy in step 002 is an
-- active-HUMAN policy: it opens only when app.actor_id is a well-formed uuid
-- belonging to an active canonical user with an active membership. The AI
-- layer's cron paths — the briefing job machine, the reply classifier, the
-- reply notifier — and its machine-authenticated surfaces have no human to
-- publish, so they fail closed on every provider that carries this baseline.
-- This step is their remedy: a narrow, named write surface for app_system,
-- the server-owned system/job principal the seven-role bootstrap reserved for
-- exactly this session.
--
-- The shape deliberately mirrors step 002's runtime contract with two
-- differences, and both are the point:
--
--   * The role is app_system, which until now held no table grant at all —
--     USAGE on public and EXECUTE on the AI SQL guard was its entire
--     privilege set. It gains DML on exactly five relations, the ones the
--     system jobs own: briefing_jobs and briefings (the resumable briefing
--     pipeline), messages (the classifier's labels and the notifier's claim),
--     leads (the demographics stamp) and saved_searches (the machine-
--     authenticated library write). Nothing else opens.
--   * The gate is the SYSTEM actor, not a human one. The application's AI
--     store publishes app.actor_id transaction-locally on every transaction;
--     for system jobs it publishes the nil uuid — the canonical system actor
--     id, well-formed under step 002's uuid regex but belonging to no user:
--     step 005, the only function that creates users, generates their ids
--     with gen_random_uuid() and accepts no caller-supplied id, so the nil
--     uuid is unassignable. A system transaction that fails to publish it —
--     or publishes anything else — finds every policy below closed, exactly
--     as a human actor that matches no member does.
--
-- What this step does NOT change: app_system still cannot reach the guard's
-- read surface any differently, no other role gains anything, the AI SQL
-- guard stays SELECT-only, and no policy of any other role is touched. The
-- LOGIN attribute this path needs at connection time is cluster scope and is
-- provided by 000_ai_execution_role_bootstrap.sql, the additive control-plane
-- prerequisite pinned in the manifest — not here, because roles are not
-- carried by pg_dump and a restore target must find the login already
-- present.

SET ROLE app_owner;

GRANT SELECT, INSERT, UPDATE ON TABLE
    public.briefing_jobs,
    public.briefings,
    public.messages,
    public.leads,
    public.saved_searches
    TO app_system;

GRANT USAGE, SELECT ON SEQUENCE
    public.messages_id_seq,
    public.saved_searches_id_seq
    TO app_system;

-- One FOR ALL policy per relation, exactly as step 002 does for the runtime
-- role: the command vocabulary is bounded by the grants above (no DELETE was
-- granted, so FOR ALL opens no delete), and the row gate is the published
-- system actor. USING governs which existing rows a system transaction can
-- see or change; WITH CHECK governs what it can insert or change them into.
-- current_setting(..., true) is NULL when the actor was never published, and
-- NULL never equals the system actor id — the policy fails closed on an
-- absent setting, not open.

CREATE POLICY briefing_jobs_system_actor ON public.briefing_jobs
    FOR ALL TO app_system
    USING (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000')
    WITH CHECK (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000');

CREATE POLICY briefings_system_actor ON public.briefings
    FOR ALL TO app_system
    USING (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000')
    WITH CHECK (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000');

CREATE POLICY messages_system_actor ON public.messages
    FOR ALL TO app_system
    USING (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000')
    WITH CHECK (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000');

CREATE POLICY leads_system_actor ON public.leads
    FOR ALL TO app_system
    USING (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000')
    WITH CHECK (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000');

CREATE POLICY saved_searches_system_actor ON public.saved_searches
    FOR ALL TO app_system
    USING (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000')
    WITH CHECK (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000');
