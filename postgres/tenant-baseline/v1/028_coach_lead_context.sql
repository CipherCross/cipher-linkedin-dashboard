-- Step 028: what the AI coach knows about the lead, their company and us.
--
-- The coach wrote its ideas from the thread, the playbook and the ICP alone,
-- so they fell back on [placeholders]. This step stores the context that makes
-- them personal (spec specs/2026-10-20-coach-lead-context.md):
--
-- * lead_profiles: the lead's LinkedIn profile as Linked Helper scraped it --
--   about, location, current title and company, recent positions, skills --
--   delivered by the sync agent through the machine ingest path. One row per
--   (instance, profile), the thread key messages use. The machine writes only
--   its own instance's rows; active members read all of them.
-- * lh2_schema_reports: the names (never the data) of Linked Helper's person
--   tables and columns on each notebook, so the profile extraction can be
--   checked and widened against the real schema. One row per instance.
-- * lead_company_context: the lead's company as the Apollo import recorded it
--   in Airtable (website, industry, size, description, ...), cached by the
--   server for the coach. `found = false` caches a miss.
-- * company_site_snapshots: readable text of a company website, fetched by
--   the server, keyed by domain. `thin = true` marks a page that rendered too
--   little text to use.
-- * playbook gains our_company / our_website: what we sell, to whom, and our
--   proof points, sent to every coach.
--
-- No DELETE is granted to anyone: every row is a cache or a mirror, refreshed
-- in place, never the only copy of anything. No AI sandbox access to the new
-- tables; the playbook's existing AI read now includes the two new columns.

SET ROLE app_owner;

CREATE TABLE public.lead_profiles (
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    about text,
    location text,
    current_title text,
    current_company text,
    positions jsonb DEFAULT '[]'::jsonb NOT NULL,
    skills jsonb DEFAULT '[]'::jsonb NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lead_profiles_pkey PRIMARY KEY (instance_id, profile_url),
    CONSTRAINT lead_profiles_instance_id_fkey FOREIGN KEY (instance_id)
        REFERENCES public.instances(id) ON DELETE CASCADE,
    CONSTRAINT lead_profiles_about_length CHECK (about IS NULL OR char_length(about) <= 4000),
    CONSTRAINT lead_profiles_location_length CHECK (location IS NULL OR char_length(location) <= 300),
    CONSTRAINT lead_profiles_title_length CHECK (current_title IS NULL OR char_length(current_title) <= 500),
    CONSTRAINT lead_profiles_company_length CHECK (current_company IS NULL OR char_length(current_company) <= 500),
    CONSTRAINT lead_profiles_positions_check CHECK (jsonb_typeof(positions) = 'array' AND jsonb_array_length(positions) <= 10),
    CONSTRAINT lead_profiles_skills_check CHECK (jsonb_typeof(skills) = 'array' AND jsonb_array_length(skills) <= 40)
);

CREATE TABLE public.lh2_schema_reports (
    instance_id text NOT NULL,
    person_tables jsonb DEFAULT '{}'::jsonb NOT NULL,
    reported_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lh2_schema_reports_pkey PRIMARY KEY (instance_id),
    CONSTRAINT lh2_schema_reports_instance_id_fkey FOREIGN KEY (instance_id)
        REFERENCES public.instances(id) ON DELETE CASCADE,
    CONSTRAINT lh2_schema_reports_tables_check CHECK (jsonb_typeof(person_tables) = 'object')
);

CREATE TABLE public.lead_company_context (
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    found boolean NOT NULL,
    company_name text,
    website text,
    industry text,
    employees text,
    founded_year text,
    country text,
    keywords text,
    description text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lead_company_context_pkey PRIMARY KEY (instance_id, profile_url),
    CONSTRAINT lead_company_context_instance_id_fkey FOREIGN KEY (instance_id)
        REFERENCES public.instances(id) ON DELETE CASCADE,
    CONSTRAINT lead_company_context_lengths CHECK (
        coalesce(char_length(company_name), 0) <= 500 AND coalesce(char_length(website), 0) <= 500
        AND coalesce(char_length(industry), 0) <= 500 AND coalesce(char_length(employees), 0) <= 100
        AND coalesce(char_length(founded_year), 0) <= 20 AND coalesce(char_length(country), 0) <= 200
        AND coalesce(char_length(keywords), 0) <= 4000 AND coalesce(char_length(description), 0) <= 8000)
);

CREATE TABLE public.company_site_snapshots (
    domain text NOT NULL,
    url text NOT NULL,
    title text,
    body text,
    thin boolean DEFAULT false NOT NULL,
    error text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_site_snapshots_pkey PRIMARY KEY (domain),
    CONSTRAINT company_site_snapshots_domain_check CHECK (domain ~ '^[a-z0-9.-]{1,253}$'),
    CONSTRAINT company_site_snapshots_lengths CHECK (
        char_length(url) <= 1000 AND coalesce(char_length(title), 0) <= 500
        AND coalesce(char_length(body), 0) <= 20000 AND coalesce(char_length(error), 0) <= 500)
);

ALTER TABLE public.playbook
    ADD COLUMN our_company text DEFAULT ''::text NOT NULL,
    ADD COLUMN our_website text,
    ADD CONSTRAINT playbook_our_company_length CHECK (char_length(our_company) <= 12000),
    ADD CONSTRAINT playbook_our_website_length CHECK (our_website IS NULL OR char_length(our_website) <= 500);

CREATE TRIGGER touch_lead_profiles_updated_at BEFORE UPDATE ON public.lead_profiles
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.lead_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lh2_schema_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_company_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_site_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_profiles_machine_actor ON public.lead_profiles
    FOR ALL TO app_machine
    USING (instance_id = public.machine_actor_instance())
    WITH CHECK (instance_id = public.machine_actor_instance());
CREATE POLICY lead_profiles_active_member ON public.lead_profiles
    FOR SELECT TO app_runtime, app_readonly
    USING (public.is_active_team_member());

CREATE POLICY lh2_schema_reports_machine_actor ON public.lh2_schema_reports
    FOR ALL TO app_machine
    USING (instance_id = public.machine_actor_instance())
    WITH CHECK (instance_id = public.machine_actor_instance());
CREATE POLICY lh2_schema_reports_active_member ON public.lh2_schema_reports
    FOR SELECT TO app_runtime, app_readonly
    USING (public.is_active_team_member());

CREATE POLICY lead_company_context_active_member ON public.lead_company_context
    FOR ALL TO app_runtime, app_readonly
    USING (public.is_active_team_member())
    WITH CHECK (public.is_active_team_member());
CREATE POLICY company_site_snapshots_active_member ON public.company_site_snapshots
    FOR ALL TO app_runtime, app_readonly
    USING (public.is_active_team_member())
    WITH CHECK (public.is_active_team_member());

REVOKE ALL ON TABLE
    public.lead_profiles,
    public.lh2_schema_reports,
    public.lead_company_context,
    public.company_site_snapshots
    FROM PUBLIC;

GRANT SELECT ON TABLE
    public.lead_profiles,
    public.lh2_schema_reports,
    public.lead_company_context,
    public.company_site_snapshots
    TO app_runtime, app_readonly;
GRANT SELECT, INSERT, UPDATE ON TABLE
    public.lead_profiles,
    public.lh2_schema_reports
    TO app_machine;
GRANT INSERT, UPDATE ON TABLE
    public.lead_company_context,
    public.company_site_snapshots
    TO app_runtime;

RESET ROLE;
