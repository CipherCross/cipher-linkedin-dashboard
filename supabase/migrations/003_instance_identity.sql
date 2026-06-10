-- Real LinkedIn identity of the account behind each instance, displayed on
-- the dashboard instead of the bare notebook label. Filled by the sync agent
-- from config.yaml (account_name / account_url / account_avatar) or from an
-- optional mapping.owner query against the local lh.db.
alter table instances
  add column if not exists account_name text,
  add column if not exists account_url text,
  add column if not exists account_avatar text;
