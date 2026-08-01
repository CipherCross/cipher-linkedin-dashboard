\set ON_ERROR_STOP on

-- Seed fixtures as the migration owner. Runtime roles cannot mutate identity
-- or membership rows directly; the server-owned identity API owns that path.
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

-- A valid active actor can read the shared workspace and its own identity
-- boundary, and can perform business DML through the runtime role.
BEGIN;
SET LOCAL ROLE app_runtime;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 1 THEN 1 ELSE 0 END AS active_shared_read;
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.users) = 1
                     AND (SELECT count(*) FROM public.user_identities) = 1
                     AND (SELECT count(*) FROM public.team_members) = 1
                THEN 1 ELSE 0 END AS active_identity_boundary_read;
INSERT INTO public.annotations (note, noted_at) VALUES ('active actor fixture', CURRENT_DATE);
ROLLBACK;

-- A second active member also reads shared business data but only its own
-- canonical identity, provider mapping and membership row.
BEGIN;
SET LOCAL ROLE app_runtime;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000002';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 1 THEN 1 ELSE 0 END AS second_active_shared_read;
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.users) = 1
                     AND (SELECT count(*) FROM public.user_identities) = 1
                     AND (SELECT count(*) FROM public.team_members) = 1
                THEN 1 ELSE 0 END AS second_identity_boundary_read;
ROLLBACK;

-- Missing, malformed, and unknown actors all fail closed without an unsafe
-- text-to-UUID cast escaping the policy expression.
BEGIN;
SET LOCAL ROLE app_runtime;
RESET app.actor_id;
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 0
                     AND (SELECT count(*) FROM public.users) = 0
                     AND (SELECT count(*) FROM public.user_identities) = 0
                THEN 1 ELSE 0 END AS missing_actor_denied;
ROLLBACK;

BEGIN;
SET LOCAL ROLE app_runtime;
SET LOCAL app.actor_id = 'not-a-uuid';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 0
                     AND (SELECT count(*) FROM public.users) = 0
                THEN 1 ELSE 0 END AS malformed_actor_denied;
ROLLBACK;

BEGIN;
SET LOCAL ROLE app_runtime;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000099';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 0
                     AND (SELECT count(*) FROM public.users) = 0
                THEN 1 ELSE 0 END AS unknown_actor_denied;
ROLLBACK;

-- The inactive canonical user and inactive membership cannot see shared or
-- identity data.
BEGIN;
SET LOCAL ROLE app_runtime;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000003';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 0
                     AND (SELECT count(*) FROM public.users) = 0
                     AND (SELECT count(*) FROM public.user_identities) = 0
                     AND (SELECT count(*) FROM public.team_members) = 0
                THEN 1 ELSE 0 END AS inactive_actor_denied;
ROLLBACK;

-- SET LOCAL is transaction-scoped: after rollback, the runtime role has no
-- actor context and shared reads are denied again.
BEGIN;
SET LOCAL ROLE app_runtime;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 1 THEN 1 ELSE 0 END AS transaction_actor_allow;
ROLLBACK;

BEGIN;
SET LOCAL ROLE app_runtime;
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 0 THEN 1 ELSE 0 END AS transaction_actor_reset;
ROLLBACK;

SELECT 'portable identity, actor context and RLS behavior assertions passed' AS result;
