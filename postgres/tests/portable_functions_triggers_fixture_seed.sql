\set ON_ERROR_STOP on

-- Business fixtures for the S07 function/trigger assertions, seeded through the
-- migration principal's explicit owner capability. The behavior assertions then
-- run in separate app_runtime and app_system connections and never use this
-- owner capability to prove a result. No credential value of any kind is stored.
SET ROLE app_owner;

INSERT INTO public.instances (id, label, config)
VALUES ('notebook-test', 'Test notebook', '{"placeholder": true}'::jsonb);

INSERT INTO public.campaigns (id, instance_id, lh_campaign_id, name)
VALUES ('notebook-test:1', 'notebook-test', '1', 'Test campaign');

-- alpha carries a complete milestone chain and is the regression fixture.
-- beta starts with every milestone NULL and is the fill-forward fixture.
INSERT INTO public.leads (
  id, instance_id, campaign_id, profile_url, full_name, headline,
  invited_at, connected_at, first_message_at, replied_at, added_at
)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'notebook-test', 'notebook-test:1',
   'https://example.test/in/alpha', 'Alpha Person', 'Head of Testing',
   '2026-01-05 10:00:00+00', '2026-01-07 11:00:00+00',
   '2026-01-08 12:00:00+00', '2026-01-09 13:00:00+00', '2026-01-04 09:00:00+00'),
  ('22222222-2222-4222-8222-222222222222', 'notebook-test', 'notebook-test:1',
   'https://example.test/in/beta', 'Beta Person', 'Testing Lead',
   NULL, NULL, NULL, NULL, NULL);

-- gamma is the pipeline_auto_advance fixture: it replied, has no stage yet and
-- its latest real inbound reply is positive.
INSERT INTO public.leads (
  id, instance_id, campaign_id, profile_url, full_name, replied_at, pipeline_stage
)
VALUES
  ('33333333-3333-4333-8333-333333333333', 'notebook-test', 'notebook-test:1',
   'https://example.test/in/gamma', 'Gamma Person', '2026-01-20 08:00:00+00', NULL);

-- gamma-in-1 is synced, not manual: the manual delete path must refuse it.
INSERT INTO public.messages (instance_id, campaign_id, profile_url, direction, body, sent_at, sentiment, content_hash, source)
VALUES
  ('notebook-test', 'notebook-test:1', 'https://example.test/in/gamma', 'in',
   'Sounds interesting, tell me more', '2026-01-20 08:00:00+00', 'positive', 'gamma-in-1', 'sync');

-- alpha's manual inbound thread. The first row's sent_at is exactly alpha's
-- replied_at, so deleting it must recompute the milestone to the later row.
INSERT INTO public.messages (instance_id, campaign_id, profile_url, direction, body, sent_at, content_hash, source)
VALUES
  ('notebook-test', 'notebook-test:1', 'https://example.test/in/alpha', 'in',
   'First pasted reply', '2026-01-09 13:00:00+00', 'alpha-in-1', 'manual'),
  ('notebook-test', 'notebook-test:1', 'https://example.test/in/alpha', 'in',
   'Second pasted reply', '2026-01-11 15:00:00+00', 'alpha-in-2', 'manual');

RESET ROLE;
SELECT 'portable function/trigger business fixtures seeded by app_migration' AS result;
