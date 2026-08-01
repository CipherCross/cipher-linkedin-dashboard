-- Provider-neutral business schema baseline v1.
-- Source contract: Supabase tenant baseline v053 inventory at S04.
-- This artifact contains business tables, identities, constraints, indexes and final views only.
-- Functions, triggers, identity-provider mappings, actor context, RLS and provider runtime are deferred.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.team_members (
    id bigint NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    email text,
    role text DEFAULT 'member'::text NOT NULL,
    CONSTRAINT team_members_role_check CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text])))
);

CREATE TABLE public.annotations (
    id bigint NOT NULL,
    instance_id text,
    campaign_id text,
    note text NOT NULL,
    noted_at date DEFAULT CURRENT_DATE NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.briefing_jobs (
    briefing_date date NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    seed text,
    signals_block text,
    prior_md text,
    drafts jsonb,
    verified_text text,
    error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    briefing_kind text DEFAULT 'daily'::text NOT NULL,
    CONSTRAINT briefing_jobs_briefing_kind_check CHECK ((briefing_kind = ANY (ARRAY['daily'::text, 'weekly'::text])))
);

CREATE TABLE public.briefings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    briefing_date date NOT NULL,
    headline text,
    summary text,
    sections jsonb DEFAULT '[]'::jsonb NOT NULL,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    risks jsonb DEFAULT '[]'::jsonb NOT NULL,
    model text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    changes jsonb DEFAULT '[]'::jsonb NOT NULL,
    metrics jsonb DEFAULT '[]'::jsonb NOT NULL,
    briefing_kind text DEFAULT 'daily'::text NOT NULL,
    period_start date,
    period_end date,
    CONSTRAINT briefings_briefing_kind_check CHECK ((briefing_kind = ANY (ARRAY['daily'::text, 'weekly'::text])))
);

CREATE TABLE public.messages (
    id bigint NOT NULL,
    instance_id text NOT NULL,
    campaign_id text,
    profile_url text NOT NULL,
    direction text DEFAULT 'in'::text NOT NULL,
    body text,
    sent_at timestamp with time zone NOT NULL,
    sentiment text,
    reason text,
    classified_at timestamp with time zone,
    classified_model text,
    content_hash text DEFAULT ''::text NOT NULL,
    source text DEFAULT 'sync'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    notified_at timestamp with time zone,
    intent_level text,
    intent_reason text,
    intent_classified_at timestamp with time zone,
    intent_classified_model text,
    intent_taxonomy_version text,
    CONSTRAINT messages_intent_level_check CHECK ((intent_level = ANY (ARRAY['p1'::text, 'p2'::text, 'p3'::text]))),
    CONSTRAINT messages_sentiment_check CHECK ((sentiment = ANY (ARRAY['positive'::text, 'neutral'::text, 'negative'::text, 'objection'::text, 'referral'::text, 'auto'::text]))),
    CONSTRAINT messages_source_check CHECK ((source = ANY (ARRAY['sync'::text, 'manual'::text])))
);

CREATE TABLE public.campaign_steps (
    campaign_id text NOT NULL,
    step_index integer NOT NULL,
    step_label text,
    step_type text,
    template_body text,
    sent_count integer DEFAULT 0 NOT NULL,
    replied_count integer DEFAULT 0 NOT NULL,
    current_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.campaigns (
    id text NOT NULL,
    instance_id text NOT NULL,
    lh_campaign_id text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    briefing_context text,
    briefing_context_updated_at timestamp with time zone,
    CONSTRAINT campaigns_briefing_context_length CHECK (((briefing_context IS NULL) OR (char_length(briefing_context) <= 4000)))
);

CREATE TABLE public.coaching_digest (
    instance_id text NOT NULL,
    summary text,
    patterns jsonb DEFAULT '[]'::jsonb NOT NULL,
    computed_at timestamp with time zone,
    model text
);

CREATE TABLE public.conversation_coaching (
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    next_action text,
    issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    tips jsonb DEFAULT '[]'::jsonb NOT NULL,
    summary text,
    last_msg_marker text,
    coached_at timestamp with time zone,
    model text
);

CREATE TABLE public.conversation_follow_up_state (
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    next_follow_up_date date,
    owner_id bigint,
    revision bigint DEFAULT 0 NOT NULL,
    last_event_id bigint,
    last_mutation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text DEFAULT 'unknown'::text NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT conversation_follow_up_state_revision_check CHECK ((revision >= 0)),
    CONSTRAINT conversation_follow_up_state_updated_by_check CHECK (((char_length(btrim(updated_by)) >= 1) AND (char_length(btrim(updated_by)) <= 120)))
);

CREATE TABLE public.events (
    id bigint NOT NULL,
    instance_id text NOT NULL,
    campaign_id text,
    profile_url text,
    event_type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    raw jsonb
);

CREATE TABLE public.follow_up_events (
    id bigint NOT NULL,
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    mutation_id uuid NOT NULL,
    event_ordinal smallint NOT NULL,
    request_fingerprint text NOT NULL,
    event_kind text NOT NULL,
    previous_due_date date,
    new_due_date date,
    previous_owner_id bigint,
    new_owner_id bigint,
    previous_owner_name text,
    new_owner_name text,
    state_revision bigint NOT NULL,
    actor text NOT NULL,
    reason text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT follow_up_events_actor_check CHECK (((char_length(btrim(actor)) >= 1) AND (char_length(btrim(actor)) <= 120))),
    CONSTRAINT follow_up_events_event_kind_check CHECK ((event_kind = ANY (ARRAY['scheduled'::text, 'rescheduled'::text, 'reassigned'::text, 'completed'::text, 'skipped'::text, 'canceled'::text]))),
    CONSTRAINT follow_up_events_event_ordinal_check CHECK (((event_ordinal >= 1) AND (event_ordinal <= 2))),
    CONSTRAINT follow_up_events_new_owner_name_check CHECK (((new_owner_name IS NULL) OR (char_length(new_owner_name) <= 100))),
    CONSTRAINT follow_up_events_previous_owner_name_check CHECK (((previous_owner_name IS NULL) OR (char_length(previous_owner_name) <= 100))),
    CONSTRAINT follow_up_events_reason_check CHECK (((reason IS NULL) OR (char_length(reason) <= 1000))),
    CONSTRAINT follow_up_events_skip_reason_check CHECK (((event_kind <> 'skipped'::text) OR ((reason IS NOT NULL) AND (btrim(reason) <> ''::text)))),
    CONSTRAINT follow_up_events_state_revision_check CHECK ((state_revision > 0)),
    CONSTRAINT follow_up_events_values_check CHECK ((((event_kind = 'scheduled'::text) AND (previous_due_date IS NULL) AND (new_due_date IS NOT NULL) AND (new_owner_name IS NOT NULL)) OR ((event_kind = 'rescheduled'::text) AND (previous_due_date IS NOT NULL) AND (new_due_date IS NOT NULL) AND (previous_due_date <> new_due_date)) OR ((event_kind = 'reassigned'::text) AND (previous_due_date IS NOT NULL) AND (new_due_date = previous_due_date) AND (new_owner_name IS NOT NULL) AND (previous_owner_name IS DISTINCT FROM new_owner_name)) OR ((event_kind = ANY (ARRAY['completed'::text, 'skipped'::text, 'canceled'::text])) AND (previous_due_date IS NOT NULL) AND (new_due_date IS NULL))))
);

CREATE TABLE public.hypotheses (
    id bigint NOT NULL,
    name text NOT NULL,
    icp_id bigint,
    description text,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hypotheses_description_check CHECK (((description IS NULL) OR (char_length(description) <= 2000))),
    CONSTRAINT hypotheses_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 160)))
);

CREATE TABLE public.hypothesis_campaigns (
    hypothesis_id bigint NOT NULL,
    campaign_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.icp_industries (
    id bigint NOT NULL,
    icp_id bigint NOT NULL,
    name text NOT NULL,
    include_keywords text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT icp_industries_include_kw_len CHECK (((array_length(include_keywords, 1) IS NULL) OR (array_length(include_keywords, 1) <= 100))),
    CONSTRAINT icp_industries_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200)))
);

CREATE TABLE public.icp_personas (
    id bigint NOT NULL,
    icp_id bigint NOT NULL,
    kind text NOT NULL,
    job_titles text[] DEFAULT '{}'::text[] NOT NULL,
    age_range text,
    location text,
    background text,
    profile_status text,
    connections_note text,
    followers_note text,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT icp_personas_age_range_check CHECK (((age_range IS NULL) OR (char_length(age_range) <= 60))),
    CONSTRAINT icp_personas_background_check CHECK (((background IS NULL) OR (char_length(background) <= 2000))),
    CONSTRAINT icp_personas_connections_note_check CHECK (((connections_note IS NULL) OR (char_length(connections_note) <= 200))),
    CONSTRAINT icp_personas_followers_note_check CHECK (((followers_note IS NULL) OR (char_length(followers_note) <= 200))),
    CONSTRAINT icp_personas_job_titles_len CHECK (((array_length(job_titles, 1) IS NULL) OR (array_length(job_titles, 1) <= 100))),
    CONSTRAINT icp_personas_kind_check CHECK (((char_length(kind) >= 1) AND (char_length(kind) <= 120))),
    CONSTRAINT icp_personas_location_check CHECK (((location IS NULL) OR (char_length(location) <= 300))),
    CONSTRAINT icp_personas_profile_status_check CHECK (((profile_status IS NULL) OR (char_length(profile_status) <= 500)))
);

CREATE TABLE public.icps (
    id bigint NOT NULL,
    name text NOT NULL,
    airtable_url text,
    main_product text,
    core_sphere text,
    secondary_sphere text,
    product_stage text,
    monetization text,
    features_note text,
    purchase_triggers text[] DEFAULT '{}'::text[] NOT NULL,
    features text[] DEFAULT '{}'::text[] NOT NULL,
    company_countries text[] DEFAULT '{}'::text[] NOT NULL,
    company_headcount text,
    company_age text,
    apollo_industries text[] DEFAULT '{}'::text[] NOT NULL,
    funding text,
    dev_team_availability text,
    dev_team_location text,
    exclude_keywords text[] DEFAULT '{}'::text[] NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT icps_airtable_url_check CHECK (((airtable_url IS NULL) OR (char_length(airtable_url) <= 500))),
    CONSTRAINT icps_company_age_check CHECK (((company_age IS NULL) OR (char_length(company_age) <= 200))),
    CONSTRAINT icps_company_headcount_check CHECK (((company_headcount IS NULL) OR (char_length(company_headcount) <= 200))),
    CONSTRAINT icps_core_sphere_check CHECK (((core_sphere IS NULL) OR (char_length(core_sphere) <= 500))),
    CONSTRAINT icps_countries_len CHECK (((array_length(company_countries, 1) IS NULL) OR (array_length(company_countries, 1) <= 200))),
    CONSTRAINT icps_dev_team_availability_check CHECK (((dev_team_availability IS NULL) OR (char_length(dev_team_availability) <= 500))),
    CONSTRAINT icps_dev_team_location_check CHECK (((dev_team_location IS NULL) OR (char_length(dev_team_location) <= 500))),
    CONSTRAINT icps_exclude_kw_len CHECK (((array_length(exclude_keywords, 1) IS NULL) OR (array_length(exclude_keywords, 1) <= 500))),
    CONSTRAINT icps_features_len CHECK (((array_length(features, 1) IS NULL) OR (array_length(features, 1) <= 50))),
    CONSTRAINT icps_features_note_check CHECK (((features_note IS NULL) OR (char_length(features_note) <= 2000))),
    CONSTRAINT icps_funding_check CHECK (((funding IS NULL) OR (char_length(funding) <= 500))),
    CONSTRAINT icps_industries_len CHECK (((array_length(apollo_industries, 1) IS NULL) OR (array_length(apollo_industries, 1) <= 100))),
    CONSTRAINT icps_main_product_check CHECK (((main_product IS NULL) OR (char_length(main_product) <= 500))),
    CONSTRAINT icps_monetization_check CHECK (((monetization IS NULL) OR (char_length(monetization) <= 500))),
    CONSTRAINT icps_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT icps_product_stage_check CHECK (((product_stage IS NULL) OR (char_length(product_stage) <= 500))),
    CONSTRAINT icps_purchase_triggers_len CHECK (((array_length(purchase_triggers, 1) IS NULL) OR (array_length(purchase_triggers, 1) <= 50))),
    CONSTRAINT icps_secondary_sphere_check CHECK (((secondary_sphere IS NULL) OR (char_length(secondary_sphere) <= 500)))
);

CREATE TABLE public.instances (
    id text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    last_sync_at timestamp with time zone,
    agent_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    account_name text,
    account_url text,
    account_avatar text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    config_updated_at timestamp with time zone
);

CREATE TABLE public.lead_gender_reviews (
    id bigint NOT NULL,
    lead_id uuid,
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    action text NOT NULL,
    predicted_gender text,
    predicted_confidence real,
    predicted_model text,
    predicted_version text,
    reviewed_gender text,
    reviewer text,
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lead_gender_reviews_action_check CHECK ((action = ANY (ARRAY['set'::text, 'clear'::text]))),
    CONSTRAINT lead_gender_reviews_predicted_confidence_check CHECK (((predicted_confidence >= (0)::double precision) AND (predicted_confidence <= (1)::double precision))),
    CONSTRAINT lead_gender_reviews_predicted_gender_check CHECK ((predicted_gender = ANY (ARRAY['male'::text, 'female'::text, 'unknown'::text]))),
    CONSTRAINT lead_gender_reviews_reviewed_gender_check CHECK ((reviewed_gender = ANY (ARRAY['male'::text, 'female'::text, 'unknown'::text])))
);

CREATE TABLE public.lead_notes (
    id bigint NOT NULL,
    lead_id uuid NOT NULL,
    author text,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instance_id text NOT NULL,
    campaign_id text NOT NULL,
    profile_url text NOT NULL,
    full_name text,
    headline text,
    company text,
    status text,
    invited_at timestamp with time zone,
    connected_at timestamp with time zone,
    first_message_at timestamp with time zone,
    replied_at timestamp with time zone,
    last_action_at timestamp with time zone,
    raw jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    added_at timestamp with time zone,
    pipeline_stage text,
    pipeline_substatus text,
    lost_reason text,
    pipeline_stage_changed_at timestamp with time zone,
    assigned_to bigint,
    education_start_year integer,
    first_job_start_year integer,
    birth_year_min integer,
    birth_year_max integer,
    gender text,
    gender_confidence real,
    demo_inferred_at timestamp with time zone,
    demo_model text,
    photo_path text,
    photo_synced_at timestamp with time zone,
    age_inferred_at timestamp with time zone,
    age_method_version text,
    age_source text,
    gender_inferred_at timestamp with time zone,
    gender_model_version text,
    CONSTRAINT leads_age_source_check CHECK ((age_source = ANY (ARRAY['education'::text, 'first_job'::text, 'combined'::text, 'conflict'::text]))),
    CONSTRAINT leads_education_start_year_check CHECK (((education_start_year >= 1950) AND (education_start_year <= 2100))),
    CONSTRAINT leads_first_job_start_year_check CHECK (((first_job_start_year >= 1950) AND (first_job_start_year <= 2100))),
    CONSTRAINT leads_gender_check CHECK ((gender = ANY (ARRAY['male'::text, 'female'::text, 'unknown'::text]))),
    CONSTRAINT leads_gender_confidence_check CHECK (((gender_confidence >= (0)::double precision) AND (gender_confidence <= (1)::double precision))),
    CONSTRAINT leads_pipeline_stage_check CHECK (((pipeline_stage IS NULL) OR (pipeline_stage = ANY (ARRAY['first_contact'::text, 'interested'::text, 'neutral'::text, 'negative'::text, 'following_up'::text, 'negotiations_call'::text, 'call_booked'::text, 'call_done'::text, 'proposal_in_progress'::text, 'proposal_presented'::text, 'client'::text, 'lost'::text])))),
    CONSTRAINT leads_pipeline_substatus_check CHECK (((pipeline_substatus IS NULL) OR (pipeline_substatus = ANY (ARRAY['soft_no'::text, 'hard_no'::text, 'lost'::text, 'proposal'::text, 'later'::text, 'not_a_fit'::text, 'waiting_decision'::text, 'contract'::text, 'needs_changes'::text]))))
);

CREATE TABLE public.pipeline_events (
    id bigint NOT NULL,
    lead_id uuid NOT NULL,
    kind text NOT NULL,
    actor text DEFAULT 'unknown'::text NOT NULL,
    from_stage text,
    to_stage text,
    from_substatus text,
    to_substatus text,
    from_assignee text,
    to_assignee text,
    lost_reason text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pipeline_events_kind_check CHECK ((kind = ANY (ARRAY['stage'::text, 'assignment'::text])))
);

CREATE TABLE public.playbook (
    id boolean DEFAULT true NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT playbook_singleton CHECK (id)
);

CREATE TABLE public.saved_searches (
    id bigint NOT NULL,
    name text NOT NULL,
    platform text NOT NULL,
    description text,
    include_keywords text[] DEFAULT '{}'::text[] NOT NULL,
    exclude_keywords text[] DEFAULT '{}'::text[] NOT NULL,
    boolean_query text,
    filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    author text,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    hypothesis_id bigint,
    CONSTRAINT saved_searches_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT saved_searches_platform_check CHECK (((char_length(platform) >= 1) AND (char_length(platform) <= 60)))
);

CREATE TABLE public.sync_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instance_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    rows_upserted integer DEFAULT 0 NOT NULL,
    error text
);

ALTER TABLE public.annotations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.annotations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.follow_up_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.follow_up_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.hypotheses ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.hypotheses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.icp_industries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.icp_industries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.icp_personas ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.icp_personas_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.icps ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.icps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.lead_gender_reviews ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.lead_gender_reviews_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.lead_notes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.lead_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.pipeline_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pipeline_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.saved_searches ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.saved_searches_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.team_members ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.team_members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_scope_key UNIQUE NULLS NOT DISTINCT (note, noted_at, instance_id, campaign_id);

ALTER TABLE ONLY public.briefing_jobs
    ADD CONSTRAINT briefing_jobs_pkey PRIMARY KEY (briefing_date, briefing_kind);

ALTER TABLE ONLY public.briefings
    ADD CONSTRAINT briefings_date_kind_key UNIQUE (briefing_date, briefing_kind);

ALTER TABLE ONLY public.briefings
    ADD CONSTRAINT briefings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.campaign_steps
    ADD CONSTRAINT campaign_steps_pkey PRIMARY KEY (campaign_id, step_index);

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_instance_id_lh_campaign_id_key UNIQUE (instance_id, lh_campaign_id);

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.coaching_digest
    ADD CONSTRAINT coaching_digest_pkey PRIMARY KEY (instance_id);

ALTER TABLE ONLY public.conversation_coaching
    ADD CONSTRAINT conversation_coaching_pkey PRIMARY KEY (instance_id, profile_url);

ALTER TABLE ONLY public.conversation_follow_up_state
    ADD CONSTRAINT conversation_follow_up_state_pkey PRIMARY KEY (instance_id, profile_url);

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_identity_key UNIQUE NULLS NOT DISTINCT (instance_id, campaign_id, profile_url, event_type);

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.follow_up_events
    ADD CONSTRAINT follow_up_events_mutation_id_event_ordinal_key UNIQUE (mutation_id, event_ordinal);

ALTER TABLE ONLY public.follow_up_events
    ADD CONSTRAINT follow_up_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hypotheses
    ADD CONSTRAINT hypotheses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hypothesis_campaigns
    ADD CONSTRAINT hypothesis_campaigns_campaign_id_key UNIQUE (campaign_id);

ALTER TABLE ONLY public.hypothesis_campaigns
    ADD CONSTRAINT hypothesis_campaigns_pkey PRIMARY KEY (hypothesis_id, campaign_id);

ALTER TABLE ONLY public.icp_industries
    ADD CONSTRAINT icp_industries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.icp_personas
    ADD CONSTRAINT icp_personas_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.icps
    ADD CONSTRAINT icps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.instances
    ADD CONSTRAINT instances_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_gender_reviews
    ADD CONSTRAINT lead_gender_reviews_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_notes
    ADD CONSTRAINT lead_notes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_campaign_id_profile_url_key UNIQUE (campaign_id, profile_url);

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_identity_key UNIQUE (instance_id, profile_url, direction, sent_at, content_hash);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pipeline_events
    ADD CONSTRAINT pipeline_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.playbook
    ADD CONSTRAINT playbook_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.saved_searches
    ADD CONSTRAINT saved_searches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sync_runs
    ADD CONSTRAINT sync_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_name_key UNIQUE (name);

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.campaign_steps
    ADD CONSTRAINT campaign_steps_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.coaching_digest
    ADD CONSTRAINT coaching_digest_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.conversation_coaching
    ADD CONSTRAINT conversation_coaching_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.conversation_follow_up_state
    ADD CONSTRAINT conversation_follow_up_state_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.conversation_follow_up_state
    ADD CONSTRAINT conversation_follow_up_state_last_event_id_fkey FOREIGN KEY (last_event_id) REFERENCES public.follow_up_events(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.conversation_follow_up_state
    ADD CONSTRAINT conversation_follow_up_state_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.team_members(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.follow_up_events
    ADD CONSTRAINT follow_up_events_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.follow_up_events
    ADD CONSTRAINT follow_up_events_new_owner_id_fkey FOREIGN KEY (new_owner_id) REFERENCES public.team_members(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.follow_up_events
    ADD CONSTRAINT follow_up_events_previous_owner_id_fkey FOREIGN KEY (previous_owner_id) REFERENCES public.team_members(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.hypotheses
    ADD CONSTRAINT hypotheses_icp_id_fkey FOREIGN KEY (icp_id) REFERENCES public.icps(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.hypothesis_campaigns
    ADD CONSTRAINT hypothesis_campaigns_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.hypothesis_campaigns
    ADD CONSTRAINT hypothesis_campaigns_hypothesis_id_fkey FOREIGN KEY (hypothesis_id) REFERENCES public.hypotheses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.icp_industries
    ADD CONSTRAINT icp_industries_icp_id_fkey FOREIGN KEY (icp_id) REFERENCES public.icps(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.icp_personas
    ADD CONSTRAINT icp_personas_icp_id_fkey FOREIGN KEY (icp_id) REFERENCES public.icps(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.lead_gender_reviews
    ADD CONSTRAINT lead_gender_reviews_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.lead_gender_reviews
    ADD CONSTRAINT lead_gender_reviews_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.lead_notes
    ADD CONSTRAINT lead_notes_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.team_members(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pipeline_events
    ADD CONSTRAINT pipeline_events_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.saved_searches
    ADD CONSTRAINT saved_searches_hypothesis_id_fkey FOREIGN KEY (hypothesis_id) REFERENCES public.hypotheses(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.sync_runs
    ADD CONSTRAINT sync_runs_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;

CREATE INDEX briefings_date_idx ON public.briefings USING btree (briefing_date DESC);

CREATE INDEX briefings_kind_date_idx ON public.briefings USING btree (briefing_kind, briefing_date DESC);

CREATE INDEX conversation_follow_up_active_due_idx ON public.conversation_follow_up_state USING btree (next_follow_up_date, owner_id) WHERE ((next_follow_up_date IS NOT NULL) AND (archived_at IS NULL));

CREATE INDEX conversation_follow_up_owner_due_idx ON public.conversation_follow_up_state USING btree (owner_id, next_follow_up_date) WHERE ((next_follow_up_date IS NOT NULL) AND (archived_at IS NULL));

CREATE INDEX events_time_idx ON public.events USING btree (occurred_at);

CREATE INDEX follow_up_events_thread_time_idx ON public.follow_up_events USING btree (instance_id, profile_url, occurred_at DESC, id DESC);

CREATE INDEX follow_up_events_time_idx ON public.follow_up_events USING btree (occurred_at DESC, id DESC);

CREATE INDEX hypotheses_icp_id ON public.hypotheses USING btree (icp_id);

CREATE UNIQUE INDEX hypotheses_lower_name ON public.hypotheses USING btree (lower(name));

CREATE INDEX hypothesis_campaigns_hypothesis_id ON public.hypothesis_campaigns USING btree (hypothesis_id);

CREATE INDEX icp_industries_icp_id ON public.icp_industries USING btree (icp_id);

CREATE UNIQUE INDEX icp_industries_icp_lower_name ON public.icp_industries USING btree (icp_id, lower(name));

CREATE INDEX icp_personas_icp_id ON public.icp_personas USING btree (icp_id);

CREATE UNIQUE INDEX icp_personas_icp_lower_kind ON public.icp_personas USING btree (icp_id, lower(kind));

CREATE UNIQUE INDEX icps_lower_name ON public.icps USING btree (lower(name));

CREATE INDEX lead_gender_reviews_person_idx ON public.lead_gender_reviews USING btree (instance_id, profile_url, reviewed_at DESC);

CREATE INDEX lead_notes_lead_idx ON public.lead_notes USING btree (lead_id, created_at DESC);

CREATE INDEX leads_added_idx ON public.leads USING btree (added_at);

CREATE INDEX leads_assigned_to_idx ON public.leads USING btree (assigned_to) WHERE (assigned_to IS NOT NULL);

CREATE INDEX leads_campaign_idx ON public.leads USING btree (campaign_id);

CREATE INDEX leads_gender_backlog_idx ON public.leads USING btree (instance_id, added_at) WHERE ((gender_inferred_at IS NULL) AND (demo_model IS DISTINCT FROM 'manual'::text));

CREATE INDEX leads_instance_idx ON public.leads USING btree (instance_id);

CREATE INDEX leads_instance_profile_idx ON public.leads USING btree (instance_id, profile_url);

CREATE INDEX leads_pipeline_stage_idx ON public.leads USING btree (pipeline_stage) WHERE (pipeline_stage IS NOT NULL);

CREATE INDEX leads_updated_at_idx ON public.leads USING btree (updated_at);

CREATE INDEX messages_campaign_sentiment_idx ON public.messages USING btree (campaign_id) WHERE (sentiment IS NOT NULL);

CREATE INDEX messages_inbound_sentiment_idx ON public.messages USING btree (instance_id, campaign_id, profile_url, sent_at DESC) WHERE ((direction = 'in'::text) AND (sentiment IS NOT NULL));

CREATE INDEX messages_intent_backlog_idx ON public.messages USING btree (sent_at DESC) WHERE ((direction = 'in'::text) AND (COALESCE(sentiment, ''::text) <> 'auto'::text) AND (COALESCE(intent_taxonomy_version, ''::text) <> 'p123-v1'::text));

CREATE INDEX messages_notify_pending_idx ON public.messages USING btree (sent_at) WHERE ((direction = 'in'::text) AND (source = 'sync'::text) AND (notified_at IS NULL));

CREATE INDEX messages_thread_latest_nonempty_idx ON public.messages USING btree (instance_id, profile_url, sent_at DESC, id DESC) WHERE ((body IS NOT NULL) AND (btrim(body) <> ''::text));

CREATE INDEX messages_unclassified_idx ON public.messages USING btree (sent_at) WHERE ((direction = 'in'::text) AND (sentiment IS NULL));

CREATE INDEX messages_updated_at_idx ON public.messages USING btree (updated_at);

CREATE INDEX pipeline_events_lead_idx ON public.pipeline_events USING btree (lead_id, occurred_at);

CREATE INDEX pipeline_events_time_idx ON public.pipeline_events USING btree (occurred_at);

CREATE INDEX saved_searches_hypothesis_id ON public.saved_searches USING btree (hypothesis_id);

CREATE UNIQUE INDEX saved_searches_platform_name ON public.saved_searches USING btree (platform, lower(name));

CREATE UNIQUE INDEX team_members_email_lower_uidx ON public.team_members USING btree (lower(email)) WHERE (email IS NOT NULL);

CREATE VIEW public.campaign_metrics WITH (security_invoker='true') AS
 SELECT c.id AS campaign_id,
    c.name AS campaign_name,
    c.instance_id,
    c.status,
    count(l.id) AS total_leads,
    count(l.invited_at) AS invites_sent,
    count(l.connected_at) AS accepted,
    count(l.replied_at) AS replies,
    round(((100.0 * (count(l.connected_at) FILTER (WHERE (l.invited_at IS NOT NULL)))::numeric) / (NULLIF(count(l.invited_at), 0))::numeric), 1) AS acceptance_rate,
    round(((100.0 * (count(l.replied_at) FILTER (WHERE (l.connected_at IS NOT NULL)))::numeric) / (NULLIF(count(l.connected_at), 0))::numeric), 1) AS reply_rate,
    max(l.last_action_at) AS last_activity_at,
    c.briefing_context,
    c.briefing_context_updated_at
   FROM (public.campaigns c
     LEFT JOIN public.leads l ON ((l.campaign_id = c.id)))
  GROUP BY c.id;

CREATE VIEW public.campaign_reply_intent WITH (security_invoker='true') AS
 SELECT campaign_id,
    intent_level,
    count(*) AS cnt
   FROM public.messages
  WHERE ((direction = 'in'::text) AND (intent_level IS NOT NULL))
  GROUP BY campaign_id, intent_level;

CREATE VIEW public.campaign_reply_sentiment WITH (security_invoker='true') AS
 SELECT campaign_id,
    sentiment,
    count(*) AS cnt
   FROM public.messages
  WHERE ((direction = 'in'::text) AND (sentiment IS NOT NULL))
  GROUP BY campaign_id, sentiment;

CREATE VIEW public.conversation_latest_message WITH (security_invoker='true') AS
 SELECT DISTINCT ON (instance_id, profile_url) instance_id,
    profile_url,
    id AS message_id,
    direction,
    body,
    sent_at,
    source
   FROM public.messages m
  WHERE ((body IS NOT NULL) AND (btrim(body) <> ''::text))
  ORDER BY instance_id, profile_url, sent_at DESC, id DESC;

CREATE VIEW public.conversation_reply_intent WITH (security_invoker='true') AS
 WITH ranked AS (
         SELECT messages.instance_id,
            messages.profile_url,
            messages.campaign_id,
            messages.sent_at,
            messages.intent_level,
            row_number() OVER (PARTITION BY messages.instance_id, messages.profile_url ORDER BY
                CASE messages.intent_level
                    WHEN 'p3'::text THEN 3
                    WHEN 'p2'::text THEN 2
                    WHEN 'p1'::text THEN 1
                    ELSE 0
                END DESC, messages.sent_at, messages.id) AS highest_rn,
            row_number() OVER (PARTITION BY messages.instance_id, messages.profile_url, messages.intent_level ORDER BY messages.sent_at, messages.id) AS level_rn
           FROM public.messages
          WHERE ((messages.direction = 'in'::text) AND (messages.intent_level IS NOT NULL))
        ), milestones AS (
         SELECT ranked.instance_id,
            ranked.profile_url,
            max(ranked.intent_level) FILTER (WHERE (ranked.highest_rn = 1)) AS highest_intent,
            min(ranked.sent_at) FILTER (WHERE (ranked.intent_level = 'p1'::text)) AS first_p1_at,
            min(ranked.sent_at) FILTER (WHERE (ranked.intent_level = 'p2'::text)) AS first_p2_at,
            min(ranked.sent_at) FILTER (WHERE (ranked.intent_level = 'p3'::text)) AS first_p3_at,
            max(ranked.campaign_id) FILTER (WHERE ((ranked.intent_level = 'p3'::text) AND (ranked.level_rn = 1))) AS first_p3_campaign_id
           FROM ranked
          GROUP BY ranked.instance_id, ranked.profile_url
        )
 SELECT mi.instance_id,
    mi.profile_url,
    mi.highest_intent,
    mi.first_p1_at,
    mi.first_p2_at,
    mi.first_p3_at,
    mi.first_p3_campaign_id,
    max(m.sent_at) FILTER (WHERE ((m.direction = 'out'::text) AND (m.sent_at > mi.first_p3_at))) AS last_out_after_p3_at,
    max(m.sent_at) FILTER (WHERE ((m.direction = 'in'::text) AND (m.sent_at > mi.first_p3_at))) AS last_in_after_p3_at
   FROM (milestones mi
     LEFT JOIN public.messages m ON (((m.instance_id = mi.instance_id) AND (m.profile_url = mi.profile_url))))
  GROUP BY mi.instance_id, mi.profile_url, mi.highest_intent, mi.first_p1_at, mi.first_p2_at, mi.first_p3_at, mi.first_p3_campaign_id;

CREATE VIEW public.daily_activity WITH (security_invoker='true') AS
 SELECT (date_trunc('day'::text, occurred_at))::date AS day,
    instance_id,
    event_type,
    count(*) AS cnt
   FROM public.events
  GROUP BY ((date_trunc('day'::text, occurred_at))::date), instance_id, event_type;

CREATE VIEW public.pipeline_metrics WITH (security_invoker='true') AS
 SELECT campaign_id,
    instance_id,
    pipeline_stage,
    pipeline_substatus,
    count(*) AS leads,
    min(pipeline_stage_changed_at) AS oldest_in_stage,
    count(*) FILTER (WHERE (pipeline_stage_changed_at < (now() - '14 days'::interval))) AS stale_14d
   FROM public.leads
  WHERE (pipeline_stage IS NOT NULL)
  GROUP BY campaign_id, instance_id, pipeline_stage, pipeline_substatus;
