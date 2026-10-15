-- Step 026: the lead CHECKs stop accepting the slugs step 025 retired.
--
-- Step 025 moved every 'interested'/'neutral' lead to 'replied' and every
-- 'negative' lead to 'lost', but kept the three old stage slugs allowed so the
-- build deployed before it could keep writing during the rollout.  That build
-- is gone (production serves afae528, which never writes them), so the stage
-- CHECK now lists only the live vocabulary of frontend/api/_lib/pipeline.ts.
--
-- The substatus CHECK drops 'soft_no', 'hard_no' and 'lost' for the same
-- reason: they were the substatuses of the retired 'negative' stage (025
-- folded them into lost_reason), and no live stage offers them.
--
-- Production held none of the six slugs on 2026-10-15 (stages: replied 127,
-- lost 122, no interested/neutral/negative; substatuses: waiting_decision
-- only).  A tenant that still holds one stops here with a named error instead
-- of a bare 23514, and the step rolls back whole.
--
-- pipeline_events is not touched: its from_stage/to_stage and substatus
-- columns are an audit trail with no CHECK, and still hold the old slugs.  No
-- grant, policy, function, view or data change.

SET ROLE app_owner;

DO $$
DECLARE
  stale_stages integer;
  stale_substatuses integer;
BEGIN
  SELECT count(*) INTO stale_stages
    FROM public.leads
   WHERE pipeline_stage IN ('interested', 'neutral', 'negative');
  SELECT count(*) INTO stale_substatuses
    FROM public.leads
   WHERE pipeline_substatus IN ('soft_no', 'hard_no', 'lost');
  IF stale_stages > 0 OR stale_substatuses > 0 THEN
    RAISE EXCEPTION 'step 026: % lead(s) still hold a retired stage and % a retired substatus; apply step 025 first',
      stale_stages, stale_substatuses;
  END IF;
END
$$;

ALTER TABLE public.leads DROP CONSTRAINT leads_pipeline_stage_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_pipeline_stage_check CHECK (
  pipeline_stage IS NULL OR pipeline_stage = ANY (ARRAY[
    'first_contact'::text, 'replied'::text, 'following_up'::text,
    'negotiations_call'::text, 'call_booked'::text, 'call_done'::text,
    'proposal_in_progress'::text, 'proposal_presented'::text,
    'client'::text, 'lost'::text
  ])
);

ALTER TABLE public.leads DROP CONSTRAINT leads_pipeline_substatus_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_pipeline_substatus_check CHECK (
  pipeline_substatus IS NULL OR pipeline_substatus = ANY (ARRAY[
    'proposal'::text, 'later'::text, 'not_a_fit'::text,
    'waiting_decision'::text, 'contract'::text, 'needs_changes'::text
  ])
);

RESET ROLE;
