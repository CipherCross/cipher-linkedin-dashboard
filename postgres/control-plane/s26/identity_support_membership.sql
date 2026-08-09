-- Fixed S26 control-plane operation: create the non-login support membership
-- in the disabled state. The bridge supplies only the target project; callers
-- cannot supply SQL, a role, an email address, or an active/expiry override.
SET ROLE app_owner;

DO $$
DECLARE
  support_user_id uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.team_members
    WHERE lower(email) = 'platform-support@ciphercross.dev'
  ) THEN
    UPDATE public.users
       SET active = false
     WHERE id IN (
       SELECT user_id
       FROM public.team_members
       WHERE lower(email) = 'platform-support@ciphercross.dev'
     );
    UPDATE public.team_members
       SET active = false, role = 'member'
     WHERE lower(email) = 'platform-support@ciphercross.dev';
    RETURN;
  END IF;

  INSERT INTO public.users (active) VALUES (false) RETURNING id INTO support_user_id;
  INSERT INTO public.team_members (name, active, email, role, user_id)
  VALUES ('CipherCross Platform Support', false, 'platform-support@ciphercross.dev', 'member', support_user_id);
END
$$;

RESET ROLE;
