-- Step 021: let a follow-up outcome clear the follow_up workflow action.
--
-- Step 017 made reply_review_state_projection_guard derive action from the
-- legacy follow-up writes: a date sets action = 'follow_up', and clearing the
-- date resolves the conversation -- but only when NEW.action IS NULL.  The
-- legacy apply_follow_up_action never writes action, so on cancel, and on
-- complete or skip without a next date, NEW.action still carries the
-- 'follow_up' the guard itself set when the task was scheduled.  The row then
-- violates conversation_follow_up_state_follow_up_date_check (SQLSTATE 23514)
-- and the whole outcome rolls back: no task on the platform could be canceled.
--
-- The widened branch resolves a cleared date whose action is still
-- 'follow_up'.  The workflow wrapper is unaffected: it always writes an
-- explicit action, and the only action it pairs with a NULL date is not
-- 'follow_up'.  No data repair is needed; the CHECK refused every such row.

SET ROLE app_owner;

CREATE OR REPLACE FUNCTION public.reply_review_state_projection_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.do_not_contact AND NEW.action IS DISTINCT FROM 'resolved' THEN
    RAISE EXCEPTION 'do_not_contact requires resolved action' USING ERRCODE = '22023';
  END IF;
  IF NEW.do_not_contact AND (NEW.action IN ('needs_reply', 'follow_up', 'awaiting_reply')
      OR NEW.next_follow_up_date IS NOT NULL) THEN
    RAISE EXCEPTION 'do_not_contact blocks active follow-up actions' USING ERRCODE = '42501';
  END IF;
  -- Keep old schedule/reschedule/complete/cancel callers and the new action
  -- projection in one state store. The legacy function does not know action.
  IF NEW.next_follow_up_date IS NOT NULL THEN
    NEW.action := 'follow_up';
  ELSIF NEW.next_follow_up_date IS NULL AND NEW.archived_at IS NOT NULL THEN
    NEW.action := 'resolved';
  ELSIF OLD.next_follow_up_date IS NOT NULL
        AND NEW.next_follow_up_date IS NULL
        AND (NEW.action IS NULL OR NEW.action = 'follow_up') THEN
    NEW.action := 'resolved';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.reply_review_state_projection_guard() OWNER TO app_owner;
REVOKE ALL ON FUNCTION public.reply_review_state_projection_guard() FROM PUBLIC;

RESET ROLE;
