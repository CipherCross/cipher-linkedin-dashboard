-- Step 022: the name and headline of a conversation partner who has no lead.
--
-- Chat-store sync (step 019) brings in every one-to-one LinkedIn conversation,
-- including existing connections and people outside any campaign.  Those have
-- messages but no public.leads row, so the reply queue can only show them as
-- "LinkedIn contact" plus a profile identifier -- two thirds of the inbound
-- threads on 2026-09-30.  The sync agent reads the partner's name and headline
-- from the Linked Helper chat store and delivers them here through the machine
-- ingest path.  Reads prefer a lead's own name and fall back to this row.
--
-- One row per (instance, profile), the same thread key messages use.  The
-- machine writes only its own instance's rows; active team members read all of
-- them, like every other conversation table.  Not readable by the AI SQL
-- sandbox: like the other tables added after step 010 it is outside the
-- run_sql allowlist.  No DELETE is granted to anyone: a contact row is a cached
-- label, refreshed by the next sync, and never the only copy of anything.

SET ROLE app_owner;

CREATE TABLE public.conversation_contacts (
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    full_name text,
    headline text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_contacts_pkey PRIMARY KEY (instance_id, profile_url),
    CONSTRAINT conversation_contacts_instance_id_fkey FOREIGN KEY (instance_id)
        REFERENCES public.instances(id) ON DELETE CASCADE,
    CONSTRAINT conversation_contacts_full_name_length CHECK (full_name IS NULL OR char_length(full_name) <= 1000),
    CONSTRAINT conversation_contacts_headline_length CHECK (headline IS NULL OR char_length(headline) <= 1000)
);

CREATE TRIGGER touch_conversation_contacts_updated_at BEFORE UPDATE ON public.conversation_contacts
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.conversation_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY conversation_contacts_machine_actor ON public.conversation_contacts
    FOR ALL TO app_machine
    USING (instance_id = public.machine_actor_instance())
    WITH CHECK (instance_id = public.machine_actor_instance());
CREATE POLICY conversation_contacts_active_member ON public.conversation_contacts
    FOR SELECT TO app_runtime, app_readonly
    USING (public.is_active_team_member());

REVOKE ALL ON TABLE public.conversation_contacts FROM PUBLIC;
GRANT SELECT ON TABLE public.conversation_contacts TO app_runtime, app_readonly;
GRANT SELECT, INSERT, UPDATE ON TABLE public.conversation_contacts TO app_machine;

RESET ROLE;
