-- Lead demographics: inferred age range and gender per lead, plus the raw text
-- signals the inference is built from. Feature 2 of the search-library / demographics
-- rollout.
--
--   education_start_year / first_job_start_year — synced from LH2 by the agent
--     (person_education.start_year MIN, person_positions.start_year MIN), garbage
--     placeholder years already rejected agent-side. Text signals only.
--   birth_year_min / birth_year_max — a RANGE, computed by /api/classify with pure
--     arithmetic (no model): education start -> birth in [start-19, start-18], else
--     first-job start -> [start-23, start-21]; the UI renders age from the current
--     year. Sanity floor 1930 in the inference job.
--   gender / gender_confidence — inferred by Haiku from name + headline in /api/classify;
--     'unknown' is a first-class value (ambiguous/initials/non-Western names).
--   demo_model — 'claude-haiku-4-5' for AI inference, 'manual' for an SDR override
--     (set via /api/pipeline set_gender; treated as ground truth, never re-inferred).
--   demo_inferred_at — NULL means "not yet processed"; the classify job's idempotency
--     filter (demo_inferred_at IS NULL) so re-runs and manual rows are never re-touched.
--
-- No view changes: campaign demographics charts compute client-side from leads
-- (matches how leads.ts already derives range metrics).

alter table leads
  add column if not exists education_start_year int  check (education_start_year between 1950 and 2100),
  add column if not exists first_job_start_year int  check (first_job_start_year between 1950 and 2100),
  add column if not exists birth_year_min       int,
  add column if not exists birth_year_max       int,
  add column if not exists gender               text check (gender in ('male','female','unknown')),
  add column if not exists gender_confidence    real check (gender_confidence between 0 and 1),
  add column if not exists demo_inferred_at     timestamptz,
  add column if not exists demo_model           text;
