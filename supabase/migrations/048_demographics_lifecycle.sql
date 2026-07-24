-- Demographics lifecycle v2.
--
-- Age and gender used to share demo_inferred_at even though they have unrelated
-- inputs and execution paths. That made a successful gender classification
-- permanently block age when the notebook synced education/job years later.
--
-- Age is now derived synchronously whenever either source year changes. Gender
-- keeps its own processing stamp/version and is reset only when name/headline
-- changes (manual confirmations are preserved).

alter table leads
  add column if not exists age_inferred_at timestamptz,
  add column if not exists age_method_version text,
  add column if not exists age_source text
    check (age_source in ('education', 'first_job', 'combined', 'conflict')),
  add column if not exists gender_inferred_at timestamptz,
  add column if not exists gender_model_version text;

-- Infer a deliberately broad birth-year range from plausible starting ages:
--   education: 16..21  -> birth in [start-21, start-16]
--   first job: 17..27  -> birth in [start-27, start-17]
-- When both exist, use their intersection. No overlap means the source records
-- contradict each other, so return no age instead of choosing one arbitrarily.
create or replace function public.refresh_lead_age_estimate() returns trigger
language plpgsql as $$
declare
  edu_min int;
  edu_max int;
  job_min int;
  job_max int;
  inferred_min int;
  inferred_max int;
  current_year int := extract(year from now() at time zone 'utc')::int;
begin
  if new.education_start_year is null and new.first_job_start_year is null then
    new.birth_year_min := null;
    new.birth_year_max := null;
    new.age_inferred_at := null;
    new.age_method_version := null;
    new.age_source := null;
    return new;
  end if;

  if new.education_start_year is not null then
    edu_min := new.education_start_year - 21;
    edu_max := new.education_start_year - 16;
  end if;
  if new.first_job_start_year is not null then
    job_min := new.first_job_start_year - 27;
    job_max := new.first_job_start_year - 17;
  end if;

  if edu_min is not null and job_min is not null then
    inferred_min := greatest(edu_min, job_min);
    inferred_max := least(edu_max, job_max);
    new.age_source := 'combined';
  elsif edu_min is not null then
    inferred_min := edu_min;
    inferred_max := edu_max;
    new.age_source := 'education';
  else
    inferred_min := job_min;
    inferred_max := job_max;
    new.age_source := 'first_job';
  end if;

  new.age_inferred_at := now();
  new.age_method_version := 'career-signals-v2';

  if inferred_min is null
     or inferred_max is null
     or inferred_min > inferred_max
     or inferred_min < 1930
     or inferred_max > current_year - 15 then
    new.birth_year_min := null;
    new.birth_year_max := null;
    new.age_source := 'conflict';
  else
    new.birth_year_min := inferred_min;
    new.birth_year_max := inferred_max;
  end if;

  return new;
end $$;

-- Trigger names sort before touch_leads_updated_at, so the change-aware updated_at
-- trigger sees the final derived values and advances the frontend delta cursor.
drop trigger if exists refresh_lead_age_estimate on leads;
create trigger refresh_lead_age_estimate
  before insert or update of education_start_year, first_job_start_year on leads
  for each row execute function public.refresh_lead_age_estimate();

-- Re-run name-based inference when its text inputs genuinely change. An SDR
-- confirmation is treated as an explicit override and survives notebook syncs.
create or replace function public.reset_lead_gender_on_input_change() returns trigger
language plpgsql as $$
begin
  if (new.full_name, new.headline) is distinct from (old.full_name, old.headline)
     and coalesce(old.demo_model, '') <> 'manual' then
    new.gender := null;
    new.gender_confidence := null;
    new.gender_inferred_at := null;
    new.gender_model_version := null;
    -- Legacy compatibility fields retained until all clients use the split lifecycle.
    new.demo_inferred_at := null;
    new.demo_model := null;
  end if;
  return new;
end $$;

drop trigger if exists reset_lead_gender_on_input_change on leads;
create trigger reset_lead_gender_on_input_change
  before update of full_name, headline on leads
  for each row execute function public.reset_lead_gender_on_input_change();

-- Preserve already-completed gender work. A future prompt/model change can bump
-- name-headline-v1 in the API and selectively reprocess non-manual rows.
update leads
set gender_inferred_at = coalesce(gender_inferred_at, demo_inferred_at),
    gender_model_version = case
      when demo_model = 'manual' then null
      else coalesce(gender_model_version, 'name-headline-v1')
    end
where gender is not null;

-- Force the age trigger over the full existing dataset, including the rows whose
-- old shared demo_inferred_at stamp previously prevented a late-arriving year from
-- being used.
update leads
set education_start_year = education_start_year,
    first_job_start_year = first_job_start_year;

create index if not exists leads_gender_backlog_idx
  on leads (instance_id, added_at)
  where gender_inferred_at is null and demo_model is distinct from 'manual';

-- Preserve the prediction that existed before a human correction. The old
-- implementation overwrote it in place, making accuracy/calibration impossible
-- to measure. One row represents one explicit set/clear action for a person.
create table if not exists lead_gender_reviews (
  id                    bigint generated always as identity primary key,
  lead_id               uuid references leads(id) on delete set null,
  instance_id           text not null references instances(id) on delete cascade,
  profile_url           text not null,
  action                text not null check (action in ('set', 'clear')),
  predicted_gender      text check (predicted_gender in ('male', 'female', 'unknown')),
  predicted_confidence  real check (predicted_confidence between 0 and 1),
  predicted_model       text,
  predicted_version     text,
  reviewed_gender       text check (reviewed_gender in ('male', 'female', 'unknown')),
  reviewer              text,
  reviewed_at           timestamptz not null default now()
);

create index if not exists lead_gender_reviews_person_idx
  on lead_gender_reviews (instance_id, profile_url, reviewed_at desc);

alter table lead_gender_reviews enable row level security;
drop policy if exists "read lead_gender_reviews" on lead_gender_reviews;
create policy "read lead_gender_reviews" on lead_gender_reviews
  for select using (true);
