-- Resumable job state for the Morning Briefing pipeline.
--
-- /api/briefing's 4-stage Opus ensemble (2 parallel investigate passes, a verify/
-- merge pass, a structuring pass) used to run inside one serverless invocation —
-- confirmed hitting Vercel's real 300s platform timeout on slow days. This table
-- lets the pipeline resume across invocations: each call does at most one stage,
-- persists its result here, and advances `status`. `version` is an optimistic-
-- concurrency token (bumped on every write) so two invocations racing for the
-- same stage can't both "win" — see frontend/api/briefing.ts's claim()/
-- advanceBriefingJob(). `attempt` counts consecutive retries of the CURRENT
-- stage and resets whenever a stage advances.
--
-- Follows this repo's universal RLS convention (anon-readable, service-role-only
-- writes) — same as sync_runs/briefings.

create table if not exists briefing_jobs (
  briefing_date  date primary key,
  status         text not null default 'pending',
    -- 'pending' | 'investigating' | 'investigated' | 'verifying' | 'verified'
    -- | 'structuring' | 'done' | 'error'
  version        int not null default 0,
  attempt        int not null default 0,
  seed           text,
  signals_block  text,
  prior_md       text,
  drafts         jsonb,          -- [{label, text}] from the investigate stage
  verified_text  text,           -- output of the verify/merge stage
  error          text,
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

alter table briefing_jobs enable row level security;
create policy "read briefing_jobs" on briefing_jobs for select using (true);
