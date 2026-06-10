-- Private storage bucket holding the latest sync-agent build. Notebooks
-- self-update from it on every scheduled sync using their service-role key
-- (which bypasses RLS); no policies are added, so the anon key has no access.
-- Deploy a new build with sync-agent/deploy.sh.
insert into storage.buckets (id, name, public)
values ('agent', 'agent', false)
on conflict (id) do nothing;
