\set ON_ERROR_STOP on

-- Step 014 behavior and capability boundary, executed inside the ledger
-- clean-room after every manifest step has been applied.
BEGIN;
SET LOCAL ROLE app_owner;

DO $$
DECLARE
  v_columns integer;
BEGIN
  SELECT count(*) INTO v_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'campaigns'
    AND column_name IN (
      'runtime_status', 'is_archived', 'status_observed_at',
      'status_source', 'status_raw'
    );
  IF v_columns <> 5 THEN
    RAISE EXCEPTION 'campaign runtime observation columns missing: %/5', v_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.campaigns'::regclass
      AND tgname = 'campaigns_keep_latest_runtime_observation'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'campaign runtime monotonic trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.campaigns'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'campaigns RLS is not enabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.campaigns'::regclass
      AND polname = 'campaigns_machine_actor'
  ) THEN
    RAISE EXCEPTION 'campaigns machine policy was lost';
  END IF;

  IF NOT has_table_privilege('app_machine', 'public.campaigns', 'SELECT')
     OR NOT has_table_privilege('app_machine', 'public.campaigns', 'INSERT')
     OR NOT has_table_privilege('app_machine', 'public.campaigns', 'UPDATE')
     OR has_table_privilege('app_machine', 'public.campaigns', 'DELETE') THEN
    RAISE EXCEPTION 'app_machine campaigns grant boundary changed';
  END IF;

  IF NOT has_table_privilege('app_runtime', 'public.campaign_metrics', 'SELECT')
     OR NOT has_table_privilege('app_readonly', 'public.campaign_metrics', 'SELECT')
     OR NOT has_table_privilege('app_ai_runner', 'public.campaign_metrics', 'SELECT') THEN
    RAISE EXCEPTION 'campaign_metrics read grants are incomplete';
  END IF;
END $$;

INSERT INTO public.instances (id, label) VALUES ('step-014-fixture', 'Step 014 fixture');
INSERT INTO public.campaigns (
  id, instance_id, lh_campaign_id, name, status,
  runtime_status, is_archived, status_observed_at, status_source, status_raw
) VALUES (
  'step-014-fixture:1', 'step-014-fixture', '1', 'Fixture', 'legacy-active',
  'running', false, '2026-09-01T12:00:00Z', 'fixture-v1', '{"runtime":"R"}'
);

-- An older retry must not regress any member of the observation tuple.
UPDATE public.campaigns
SET runtime_status = 'stopped', is_archived = true,
    status_observed_at = '2026-09-01T11:00:00Z',
    status_source = 'older', status_raw = '{"runtime":"X"}'
WHERE id = 'step-014-fixture:1';

DO $$
DECLARE v public.campaigns%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.campaigns WHERE id = 'step-014-fixture:1';
  IF v.runtime_status <> 'running' OR v.is_archived IS DISTINCT FROM false
     OR v.status_observed_at <> '2026-09-01T12:00:00Z'::timestamptz
     OR v.status_source <> 'fixture-v1' THEN
    RAISE EXCEPTION 'older observation regressed the stored state: %', row_to_json(v);
  END IF;
END $$;

-- Equal observation times are deterministic last-write-wins; ordinary updates
-- that carry no observation preserve the last known tuple.
UPDATE public.campaigns
SET runtime_status = 'queued', is_archived = true,
    status_observed_at = '2026-09-01T12:00:00Z',
    status_source = 'fixture-v2', status_raw = '{"runtime":"Q"}'
WHERE id = 'step-014-fixture:1';
UPDATE public.campaigns
SET name = 'Fixture renamed', runtime_status = NULL, is_archived = NULL,
    status_observed_at = NULL, status_source = NULL, status_raw = NULL
WHERE id = 'step-014-fixture:1';

DO $$
DECLARE v public.campaigns%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.campaigns WHERE id = 'step-014-fixture:1';
  IF v.runtime_status <> 'queued' OR v.is_archived IS DISTINCT FROM true
     OR v.status_observed_at <> '2026-09-01T12:00:00Z'::timestamptz
     OR v.status_source <> 'fixture-v2' OR v.name <> 'Fixture renamed' THEN
    RAISE EXCEPTION 'latest/no-observation behavior is wrong: %', row_to_json(v);
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE public.campaigns
    SET runtime_status = 'active', status_observed_at = '2026-09-01T13:00:00Z',
        status_source = 'invalid-fixture'
    WHERE id = 'step-014-fixture:1';
    RAISE EXCEPTION 'invalid runtime value was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

ROLLBACK;
SELECT 'portable campaign runtime status assertions passed' AS result;
