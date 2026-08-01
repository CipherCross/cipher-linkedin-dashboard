\set ON_ERROR_STOP on

-- Fixture setup uses the migration principal's explicit owner capability only
-- to create canonical identity rows. The behavior assertions run in a fresh
-- app_runtime connection and never use this owner capability.
SET ROLE app_owner;

INSERT INTO public.users (id, active)
VALUES
  ('00000000-0000-0000-0000-000000000001', true),
  ('00000000-0000-0000-0000-000000000002', true),
  ('00000000-0000-0000-0000-000000000003', false);

INSERT INTO public.team_members (name, active, email, role, user_id)
VALUES
  ('Active One', true, 'active-one@example.test', 'member', '00000000-0000-0000-0000-000000000001'),
  ('Active Two', true, 'active-two@example.test', 'admin', '00000000-0000-0000-0000-000000000002'),
  ('Inactive Three', false, 'inactive-three@example.test', 'member', '00000000-0000-0000-0000-000000000003');

INSERT INTO public.user_identities (user_id, provider, provider_subject)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'fixture', 'subject-one'),
  ('00000000-0000-0000-0000-000000000002', 'fixture', 'subject-two'),
  ('00000000-0000-0000-0000-000000000003', 'fixture', 'subject-three');

INSERT INTO public.playbook (id, content) VALUES (true, 'shared fixture');

RESET ROLE;
SELECT 'portable identity RLS fixtures seeded by app_migration' AS result;
