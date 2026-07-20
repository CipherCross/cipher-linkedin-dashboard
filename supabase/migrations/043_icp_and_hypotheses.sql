-- ICP (Ideal Customer Profile) + Hypothesis layer.
--
-- Structure: Hypothesis -> ICP -> campaigns -> leads, with searches also
-- attachable to a hypothesis and per-industry include/exclude keywords living
-- on the ICP. Fully structured (typed columns/arrays, no Markdown escape
-- hatch) — the in-app editor is source-of-truth after this seed.
--
-- icps / icp_personas / icp_industries: the ICP definition, editable via
-- /api/playbook (save_icp / save_icp_persona / save_icp_industry actions).
-- hypotheses / hypothesis_campaigns: groups campaigns under a named
-- hypothesis for stats. hypothesis_campaigns is a SEPARATE join table (not a
-- column on campaigns) because campaigns is agent-owned — the agent must
-- never clobber this assignment on re-sync.
-- saved_searches.hypothesis_id: many searches -> one hypothesis (execution
-- side of an ICP's keyword definition).
--
-- New-table canon (matches 040_saved_searches.sql): bigint identity PK,
-- check() length caps, text[] not null default '{}', RLS enable + `for
-- select using (true)`, explicit grant to ai_sql_runner (034 revoked the
-- auto-grant — every new table needs this or run_sql/chat/MCP 403), a
-- touch_updated_at trigger, and a unique index as the upsert target.

create table if not exists icps (
  id                     bigint generated always as identity primary key,
  name                   text not null check (char_length(name) between 1 and 120),
  airtable_url           text check (airtable_url is null or char_length(airtable_url) <= 500),
  main_product           text check (main_product is null or char_length(main_product) <= 500),
  core_sphere            text check (core_sphere is null or char_length(core_sphere) <= 500),
  secondary_sphere       text check (secondary_sphere is null or char_length(secondary_sphere) <= 500),
  product_stage          text check (product_stage is null or char_length(product_stage) <= 500),
  monetization           text check (monetization is null or char_length(monetization) <= 500),
  features_note          text check (features_note is null or char_length(features_note) <= 2000),
  purchase_triggers      text[] not null default '{}',
  features               text[] not null default '{}',
  company_countries      text[] not null default '{}',
  company_headcount      text check (company_headcount is null or char_length(company_headcount) <= 200),
  company_age            text check (company_age is null or char_length(company_age) <= 200),
  apollo_industries      text[] not null default '{}',
  funding                text check (funding is null or char_length(funding) <= 500),
  dev_team_availability  text check (dev_team_availability is null or char_length(dev_team_availability) <= 500),
  dev_team_location      text check (dev_team_location is null or char_length(dev_team_location) <= 500),
  include_keywords       text[] not null default '{}',
  exclude_keywords       text[] not null default '{}',
  archived               boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint icps_purchase_triggers_len check (array_length(purchase_triggers, 1) is null or array_length(purchase_triggers, 1) <= 50),
  constraint icps_features_len check (array_length(features, 1) is null or array_length(features, 1) <= 50),
  constraint icps_countries_len check (array_length(company_countries, 1) is null or array_length(company_countries, 1) <= 200),
  constraint icps_industries_len check (array_length(apollo_industries, 1) is null or array_length(apollo_industries, 1) <= 100),
  constraint icps_include_kw_len check (array_length(include_keywords, 1) is null or array_length(include_keywords, 1) <= 500),
  constraint icps_exclude_kw_len check (array_length(exclude_keywords, 1) is null or array_length(exclude_keywords, 1) <= 500)
);

create unique index if not exists icps_lower_name on icps (lower(name));

alter table icps enable row level security;
drop policy if exists "read icps" on icps;
create policy "read icps" on icps for select using (true);
grant select on icps to ai_sql_runner;

drop trigger if exists touch_icps_updated_at on icps;
create trigger touch_icps_updated_at
  before update on icps
  for each row execute function public.touch_updated_at();

-- icp_personas: N buyer personas per ICP (seed: management, product, technical).
-- `kind` is free text (not an enum) — the sheet's three personas are a starting
-- point, not an exhaustive vocabulary.
create table if not exists icp_personas (
  id                bigint generated always as identity primary key,
  icp_id            bigint not null references icps(id) on delete cascade,
  kind              text not null check (char_length(kind) between 1 and 120),
  job_titles        text[] not null default '{}',
  age_range         text check (age_range is null or char_length(age_range) <= 60),
  location          text check (location is null or char_length(location) <= 300),
  background        text check (background is null or char_length(background) <= 2000),
  profile_status    text check (profile_status is null or char_length(profile_status) <= 500),
  connections_note  text check (connections_note is null or char_length(connections_note) <= 200),
  followers_note    text check (followers_note is null or char_length(followers_note) <= 200),
  sort              integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint icp_personas_job_titles_len check (array_length(job_titles, 1) is null or array_length(job_titles, 1) <= 100)
);

create unique index if not exists icp_personas_icp_lower_kind on icp_personas (icp_id, lower(kind));
create index if not exists icp_personas_icp_id on icp_personas (icp_id);

alter table icp_personas enable row level security;
drop policy if exists "read icp_personas" on icp_personas;
create policy "read icp_personas" on icp_personas for select using (true);
grant select on icp_personas to ai_sql_runner;

drop trigger if exists touch_icp_personas_updated_at on icp_personas;
create trigger touch_icp_personas_updated_at
  before update on icp_personas
  for each row execute function public.touch_updated_at();

-- icp_industries: definition side of "both" (decision 3) — per-industry
-- include/exclude keyword REFINEMENTS, distinct from the ICP-wide lists above.
-- Starts empty; no auto-merge with icps.include_keywords/exclude_keywords.
create table if not exists icp_industries (
  id                bigint generated always as identity primary key,
  icp_id            bigint not null references icps(id) on delete cascade,
  name              text not null check (char_length(name) between 1 and 200),
  include_keywords  text[] not null default '{}',
  exclude_keywords  text[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint icp_industries_include_kw_len check (array_length(include_keywords, 1) is null or array_length(include_keywords, 1) <= 100),
  constraint icp_industries_exclude_kw_len check (array_length(exclude_keywords, 1) is null or array_length(exclude_keywords, 1) <= 100)
);

create unique index if not exists icp_industries_icp_lower_name on icp_industries (icp_id, lower(name));
create index if not exists icp_industries_icp_id on icp_industries (icp_id);

alter table icp_industries enable row level security;
drop policy if exists "read icp_industries" on icp_industries;
create policy "read icp_industries" on icp_industries for select using (true);
grant select on icp_industries to ai_sql_runner;

drop trigger if exists touch_icp_industries_updated_at on icp_industries;
create trigger touch_icp_industries_updated_at
  before update on icp_industries
  for each row execute function public.touch_updated_at();

-- hypotheses: named, reusable groupings of campaigns under one ICP (one ICP
-- can back many hypotheses — decision 2).
create table if not exists hypotheses (
  id           bigint generated always as identity primary key,
  name         text not null check (char_length(name) between 1 and 160),
  icp_id       bigint references icps(id) on delete set null,
  description  text check (description is null or char_length(description) <= 2000),
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists hypotheses_lower_name on hypotheses (lower(name));
create index if not exists hypotheses_icp_id on hypotheses (icp_id);

alter table hypotheses enable row level security;
drop policy if exists "read hypotheses" on hypotheses;
create policy "read hypotheses" on hypotheses for select using (true);
grant select on hypotheses to ai_sql_runner;

drop trigger if exists touch_hypotheses_updated_at on hypotheses;
create trigger touch_hypotheses_updated_at
  before update on hypotheses
  for each row execute function public.touch_updated_at();

-- hypothesis_campaigns: join table, NOT a column on campaigns — campaigns is
-- agent-owned (id = "<instance_id>:<lh_campaign_id>", upserted every sync), so
-- this assignment must live in a table the agent never writes to or a re-sync
-- could clobber it. unique(campaign_id) enforces decision 7: a campaign
-- belongs to at most one hypothesis.
create table if not exists hypothesis_campaigns (
  hypothesis_id  bigint not null references hypotheses(id) on delete cascade,
  campaign_id    text not null references campaigns(id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (hypothesis_id, campaign_id),
  unique (campaign_id)
);

create index if not exists hypothesis_campaigns_hypothesis_id on hypothesis_campaigns (hypothesis_id);

alter table hypothesis_campaigns enable row level security;
drop policy if exists "read hypothesis_campaigns" on hypothesis_campaigns;
create policy "read hypothesis_campaigns" on hypothesis_campaigns for select using (true);
grant select on hypothesis_campaigns to ai_sql_runner;

-- saved_searches -> hypothesis (many searches, one hypothesis; decision 5).
alter table saved_searches add column if not exists hypothesis_id bigint references hypotheses(id) on delete set null;
create index if not exists saved_searches_hypothesis_id on saved_searches (hypothesis_id);

-- Atomic "replace this hypothesis's campaign set" — a plain function (not
-- SECURITY DEFINER: it's only ever called with the service-role key, which
-- already bypasses RLS with full table privileges, unlike ai_execute_sql /
-- pipeline_auto_advance which constrain a lower-privileged caller). One
-- function call = one implicit transaction, so the release/drop/attach below
-- can't leave a campaign half-migrated between hypotheses. Campaign existence
-- is enforced by hypothesis_campaigns' FK on campaigns(id) — an unknown
-- campaign id raises a foreign-key violation (23503) the caller maps to a 400.
create or replace function public.set_hypothesis_campaigns(p_hypothesis_id bigint, p_campaign_ids text[])
returns void
language plpgsql
as $$
begin
  if not exists (select 1 from hypotheses where id = p_hypothesis_id) then
    raise exception 'unknown hypothesis id %', p_hypothesis_id;
  end if;

  -- Drop this hypothesis's old assignments that aren't in the new set.
  delete from hypothesis_campaigns
  where hypothesis_id = p_hypothesis_id
    and not (campaign_id = any(p_campaign_ids));

  -- Release every campaign in the new set from whichever hypothesis currently
  -- holds it (itself included) so the unique(campaign_id) reattachment below
  -- can't 23505 against a stale row.
  delete from hypothesis_campaigns
  where campaign_id = any(p_campaign_ids);

  insert into hypothesis_campaigns (hypothesis_id, campaign_id)
  select p_hypothesis_id, x
  from unnest(p_campaign_ids) as x;
end;
$$;

revoke execute on function public.set_hypothesis_campaigns(bigint, text[]) from public, anon, authenticated;
grant execute on function public.set_hypothesis_campaigns(bigint, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- Seed: "Web 2 Mob" ICP, imported once from the provided Google Sheet
-- (web -> mobile dev shops targeting wellness/health-tech). All later editing
-- happens in-app — this is a one-time import, not a live sync (non-goal).
-- idempotent: on conflict do nothing against the unique indexes above, so
-- re-running this migration (or a fresh `db push`) never duplicates rows.

insert into icps (
  name, airtable_url, main_product, core_sphere, secondary_sphere, product_stage,
  monetization, purchase_triggers, features, company_countries, company_headcount,
  company_age, apollo_industries, funding, dev_team_availability, dev_team_location,
  include_keywords, exclude_keywords
) values (
  'Web 2 Mob',
  'https://airtable.com/app4P6PbWSwEEmOIz/tblEYOgRDRg0aYfzI/viw1AjbeLDQxVdfAv?blocks=hide',
  'Web-приложение / SaaS платформа / Web dashboard',
  'Wellness & Health Tech (Медитация, фитнес, nutrition, mental health, sleep, coaching)',
  'Fitness Tech / Mental Health / Nutrition / Corporate Wellness / FemTech / Longevity',
  'Growth / Scale (post-MVP, product-market fit)',
  'Subscription (SaaS) / B2B2C / Freemium + Premium',
  array['1. Юзеры требуют мобильное приложение','2. Конкуренты запустили мобильные приложения','3. Инвесторы требуют mobile-first','4. Push-уведомления нужны для engagement','5. Wearable integrations (Apple Health, Fitbit)','6. App Store presence для маркетинга'],
  array['Dashboard','client portal','analytics','progress tracking','booking','content library','integrations (wearables, API)'],
  array['USA','UK','Canada','Australia','Portugal','Spain','France','Ireland','Belgium','Netherlands','Switzerland','Germany','Austria','Norway','Sweden','Finland','Israel','Malta','Cyprus','Denmark','Luxembourg','Italy','Estonia','Greece','Iceland','New Zealand','Singapore','UAE'],
  '5-50 (може бути до 100)',
  '2015 – 2025',
  array['alternative medicine','computer software','consumer services','health, wellness & fitness','hospital & health care','internet','mental health care','professional training & coaching','informational technology & services'],
  null,
  'Нет in-house девелоперов мобильного приложения',
  '✅ Same as Company country or Eastern Europe ❌ India, Pakistan, etc.',
  array['meditation','mindfulness','breathwork','guided meditation','sleep sounds','nutrition tracker','calorie tracker','food tracking','meal planning','AI food scanner','macro tracker','dietitian platform','nutrition coaching','fitness coaching','personal training','workout app','fitness platform','training software','gym management','wellness marketplace','wellness booking','spa management','salon booking','studio management','mental health app','therapy platform','telehealth','mood tracker','CBT app','DBT app','corporate wellness','employee wellness','workplace wellbeing','wellness challenge','sleep tracking','sleep tech','recovery app','femtech','women''s health','cycle tracker','fertility app','pregnancy app','longevity platform','preventive health','biomarker tracking','health optimization','wellness app','health app','wellbeing platform','wellness tech','health tech','wellness SaaS','wellness platform','digital wellness','health coaching','online coaching','fitness SaaS','digital therapeutics','behavioral health','habits','health & wellness','wellness','mobile health','stress management','stress reduction','mental wellness','emotional tracking','emotion tracking','self-care','daily tracking','insomnia','journaling','healthtech','fitness tech','fittech','mental health','nutrition','digital health','holistic health','functional medicine','longevity','biohacking','telemedicine','wellness coaching','fitness app','meditation app','coaching platform','telehealth platform','client portal','patient portal','wellness dashboard','habit tracker','sleep tracker','food tracker','workout builder','meal planner','symptom tracker','coaching software','nutrition software','breathwork app','fasting app','self-care app','wellness startup','health innovation','personalized wellness','AI-powered health','data-driven health','evidence-based wellness','chronic disease management','addiction recovery','sobriety app','kids mental health','senior wellness','pelvic health','postpartum','prenatal app','menopause app','gut health','sports nutrition','athlete recovery','practitioner management','therapist practice management','anxiety','depression','affirmations','affirmation','manifestation','astrology','burnout','manifesting','horoscope','Spirituality','Quit app'],
  array['restaurant','food delivery','grocery store','food manufacturer','supplement manufacturer','vitamin manufacturer','gym equipment','fitness apparel','sportswear','protein powder','mattress','pillow','bedding','CPAP','pharmaceutical','clinical trial','hospital','inpatient care','insurance broker','insurance company','yoga mat','candles','incense','essential oils','retreat center','hotel','travel agency','cosmetics','skincare brand','plastic surgery','baby products','diapers','maternity clothing','medical device','drug development','co-working','payroll','HR software','recruiting','staffing agency','WordPress theme','Wix','Squarespace','recipe blog','food blog','fitness influencer','wellness influencer','podcast production','book publisher','print magazine','brick-and-mortar only','franchise consulting','real estate','construction','automotive','banking','accounting','legal services','law firm','education K-12','university','government agency','non-profit charity','religious organization','military','defense','agriculture','mining','oil and gas','manufacturing','logistics','shipping','warehousing']
)
on conflict (lower(name)) do nothing;

insert into icp_personas (
  icp_id, kind, job_titles, age_range, location, background, profile_status,
  connections_note, followers_note, sort
)
select id, 'management', array['CEO','COO','Chief Executive Officer','Chief Operating Officer','President','Founder','Co-Founder','Managing Partner','Director of Business Operations','General Partner','Managing Director','VP of Operations','Director of Operations','Head of Operations','Chief of Staff'], '25 – 50', 'same as company office',
       null, 'There is a personal photo (not an image); there is some activity.',
       '> 250 connections', '< 5''000 followers', 0
from icps where lower(name) = lower('Web 2 Mob')
on conflict (icp_id, lower(kind)) do nothing;

insert into icp_personas (
  icp_id, kind, job_titles, age_range, location, background, profile_status,
  connections_note, followers_note, sort
)
select id, 'product', array['VP of Product','Head of Product','Product Manager','Head of Marketing','Head of Growth','Director of Product','Senior Product Manager','Product Owner','VP Growth','Director of Growth','Growth Lead','VP Marketing','Director of Marketing','Growth Product Manager','Product Growth Manager'], '25 – 50', 'same as company office',
       null, 'There is a personal photo (not an image); there is some activity.',
       '> 250 connections', '< 5''000 followers', 1
from icps where lower(name) = lower('Web 2 Mob')
on conflict (icp_id, lower(kind)) do nothing;

insert into icp_personas (
  icp_id, kind, job_titles, age_range, location, background, profile_status,
  connections_note, followers_note, sort
)
select id, 'technical', array['CTO','Chief Technology Officer','VP Engineering','Head of Engineering','Director of Engineering','Lead Engineer','Tech Lead','Team Lead','Principal Engineer','Staff Engineer','Engineering Manager','Head of Mobile','Head of Backend','Head of Platform','Platform Lead','Solutions Architect','Software Architect','Head of Security','Security Lead','Head of Data','Data Engineering Lead','Cloud Architect'], '25 – 50', 'same as company office',
       null, 'There is a personal photo (not an image); there is some activity.',
       '> 250 connections', '< 5''000 followers', 2
from icps where lower(name) = lower('Web 2 Mob')
on conflict (icp_id, lower(kind)) do nothing;

-- One icp_industries row per Apollo industry name (seed mapping table).
insert into icp_industries (icp_id, name)
select id, x.name
from icps, unnest(array['alternative medicine','computer software','consumer services','health, wellness & fitness','hospital & health care','internet','mental health care','professional training & coaching','informational technology & services']) as x(name)
where lower(icps.name) = lower('Web 2 Mob')
on conflict (icp_id, lower(name)) do nothing;
