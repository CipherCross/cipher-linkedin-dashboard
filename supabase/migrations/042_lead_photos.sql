-- Lead photos: the sync agent mirrors each lead's LinkedIn profile photo from the
-- notebooks into Supabase Storage so the UI can show avatars for faster visual lead
-- identification. Feature 3 of the search-library / demographics rollout.
--
-- DISPLAY ONLY — these bytes are NEVER an inference input. Photo-based age/gender
-- categorization is dropped (Anthropic usage policy: biometric categorization of
-- non-consenting people). The classify demographics job selects text columns
-- explicitly and never reads photo_path; the SCHEMA_DOC entry repeats the rule.
--
-- Public bucket: these avatars are already public on LinkedIn and the dashboard is
-- read-open, so a public bucket needs no storage RLS policy for reads. The agent
-- writes with its service key (bypasses RLS). LinkedIn media URLs are signed and
-- expire in weeks, so the agent downloads the bytes at sync time and mirrors them
-- here; photo_path is the bucket-relative path <instance_id>/<slug>.jpg.

insert into storage.buckets (id, name, public)
values ('lead-photos', 'lead-photos', true)
on conflict (id) do nothing;

alter table leads
  add column if not exists photo_path      text,        -- bucket-relative: <instance_id>/<slug>.jpg
  add column if not exists photo_synced_at timestamptz; -- when the agent last resolved a photo (NULL path = tried, none found)
