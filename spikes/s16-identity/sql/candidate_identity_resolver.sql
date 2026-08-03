-- CANDIDATE, NOT APPLIED. A proposal for S17 and for the migration ledger.
--
-- S16 applies this file to its ephemeral clean-room container only, to measure
-- what it would buy. It is deliberately NOT in postgres/tenant-baseline/, has
-- NOT been applied to the Neon project, and must not be. The ledger is the only
-- sanctioned apply path (R5), and adding this is a schema change — the same
-- shape of decision the owner already took for the B4 roster function, and it
-- should ride in the same session.
--
-- What it is for. `user_identities` is readable by app_runtime only through
-- `user_identities_active_actor_select`, which requires
-- `user_id = app.actor_id`. Reading the mapping therefore requires already
-- knowing the answer, which is why S12 needed a proposal and why S17 would
-- otherwise need one too. This function is the alternative: resolve the
-- subject directly, in one round trip, with no proposal to keep in sync.
--
-- Why it is safe to expose. It answers exactly one question — "which active
-- canonical actor owns this (provider, subject) pair" — and the caller must
-- already possess the subject, which only a verified session yields. It leaks
-- nothing about any other user: an unknown subject and an inactive user are
-- indistinguishable, both returning zero rows. It is not an enumeration
-- primitive, because it takes no wildcard and returns no list.
--
-- Its exposure compared with the status quo. The propose-then-confirm shape
-- already lets a caller test a (subject, canonical id) *pair*; this function
-- lets a caller who holds a subject learn the id. That is strictly more, and it
-- is the reason this is the owner's decision rather than the spike's.

SET ROLE app_owner;

CREATE FUNCTION public.identity_resolve_actor(
    p_provider text,
    p_subject text
)
RETURNS TABLE (actor_id uuid, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT ui.user_id, tm.role
    FROM public.user_identities ui
    JOIN public.team_members tm ON tm.user_id = ui.user_id
    JOIN public.users u ON u.id = ui.user_id
   WHERE ui.provider = p_provider
     AND ui.provider_subject = p_subject
     AND tm.active
     AND u.active;
$$;

-- Same posture as is_active_team_member()/is_app_admin() in the baseline's
-- 003 artifact: nothing to PUBLIC, execute to the runtime roles only.
REVOKE ALL ON FUNCTION public.identity_resolve_actor(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.identity_resolve_actor(text, text) TO app_runtime;

RESET ROLE;
