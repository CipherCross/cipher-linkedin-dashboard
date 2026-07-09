-- Structured key-metrics strip for the Morning Briefing. /api/briefing's
-- structuring stage now emits an optional `metrics: [{label, value, note?}]`
-- block (the day's headline numbers) that BriefingCard renders above the digest
-- and slack.ts posts. Until now the pipeline persisted it via an upsert fallback
-- because the column didn't exist; this adds it so the value lands in a real
-- column. Defaults to an empty array so pre-existing rows and briefings without
-- metrics read back as [] rather than NULL.

alter table briefings add column if not exists metrics jsonb not null default '[]'::jsonb;
