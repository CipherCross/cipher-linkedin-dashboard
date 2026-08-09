-- Fixed S26 control-plane operation: create the first company admin and the
-- Better Auth credential row atomically. Parameters are positional and fixed:
-- the three tokens below are replaced by the bridge with escaped literals.
SET ROLE app_owner;

DO $$
DECLARE
  admin_user_id uuid;
  normalized_email text := lower(btrim(__ADMIN_EMAIL__));
  display_name text := left(split_part(normalized_email, '@', 1), 100);
BEGIN
  IF normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'invalid company-admin email' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.team_members WHERE active AND role = 'admin') THEN
    IF EXISTS (
      SELECT 1 FROM public.team_members
      WHERE active AND role = 'admin' AND lower(email) = normalized_email
    ) AND EXISTS (
      SELECT 1 FROM identity."user"
      WHERE lower("email") = normalized_email
    ) AND EXISTS (
      SELECT 1
      FROM public.team_members tm
      JOIN public.user_identities ui
        ON ui.user_id = tm.user_id
       AND ui.provider = 'better-auth'
      JOIN identity."account" ia
        ON ia."userId" = ui.provider_subject
       AND ia."providerId" = 'credential'
      WHERE tm.active
        AND tm.role = 'admin'
        AND lower(tm.email) = normalized_email
    ) THEN
      -- A known or outcome-unknown retry is idempotent for the same invite.
      RETURN;
    END IF;
    RAISE EXCEPTION 'a different active company admin already exists' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM public.team_members WHERE lower(email) = normalized_email)
     OR EXISTS (SELECT 1 FROM identity."user" WHERE lower("email") = normalized_email) THEN
    RAISE EXCEPTION 'company-admin identity already exists' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.users (active) VALUES (true) RETURNING id INTO admin_user_id;
  INSERT INTO public.team_members (name, active, email, role, user_id)
  VALUES (display_name, true, normalized_email, 'admin', admin_user_id);
  INSERT INTO public.user_identities (user_id, provider, provider_subject)
  VALUES (admin_user_id, 'better-auth', __ADMIN_SUBJECT__);

  INSERT INTO identity."user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
  VALUES (__ADMIN_SUBJECT__, display_name, normalized_email, false, now(), now());
  INSERT INTO identity."account"
    ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
  VALUES (gen_random_uuid()::text, __ADMIN_SUBJECT__, 'credential', __ADMIN_SUBJECT__, __ADMIN_PASSWORD_HASH__, now(), now());
END
$$;

RESET ROLE;
