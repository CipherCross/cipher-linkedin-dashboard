# Authentication rollout

Authentication is invite-only Supabase email/password auth. An Auth user gets
application access only when `team_members.auth_user_id` points to that user and
the row is active. `role = 'admin'` controls sensitive Vercel API actions.

## 1. Configure Supabase Auth

In Supabase Dashboard → Authentication:

1. Disable public user signup.
2. Set the minimum password length to 12.
3. Configure production SMTP and sender identity.
4. Set the production Site URL.
5. Allow the exact production URL, local development URL, and only the Vercel
   preview URL pattern the team actually uses.
6. Change the invitation email link to:

   ```html
   <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite">
     Accept invitation
   </a>
   ```

7. Change the recovery email link to:

   ```html
   <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">
     Reset password
   </a>
   ```

The token is deliberately in the query string. Supabase's implicit-flow URL
fragment conflicts with this SPA's `HashRouter`.

## 2. Set environment variables

Set these on Vercel before deploying fail-closed API handlers:

- Existing: `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, Airtable and Slack
  variables as applicable.
- `SUPABASE_URL` (recommended; server functions may fall back to
  `VITE_SUPABASE_URL`).
- `SUPABASE_ANON_KEY`, equal to the project's public/anon key.
- `CRON_SECRET`, a random machine secret used automatically by Vercel crons.
- `NOTIFY_SECRET`, a different random secret for sync-agent reply pings.
- `MCP_SECRET`, a different random secret shared only with trusted MCP clients.

Remove `ADMIN_SECRET` after the auth-aware release is verified. Browser requests
now use the signed-in user's Supabase JWT.

On every notebook, add this local-only key to `sync-agent/config.yaml`:

```yaml
notify_secret: "<same value as Vercel NOTIFY_SECRET>"
```

Do not add `notify_secret` to remote instance config. The dashboard rejects it
and the agent does not include it in `REMOTE_CONFIG_KEYS`.

## 3. Apply the additive migration

Apply only `supabase/migrations/050_auth_identity.sql` first. It adds identity
columns and helper/RPC functions but leaves current read policies intact.

Migration 051 must be a separate deployment changeset. Do not run a repo-level
`supabase db push` from a checkout containing both new unapplied migrations
before the auth-aware Vercel release is live.

## 4. Bootstrap the first admin

Invite the first administrator from Supabase Dashboard. Then link the Auth UUID
to a new teammate:

```sql
insert into public.team_members (name, email, role, active, auth_user_id)
select
  'Admin Name',
  lower(u.email),
  'admin',
  true,
  u.id
from auth.users u
where lower(u.email) = lower('admin@example.com');
```

To link an existing assignment-only teammate instead:

```sql
update public.team_members tm
set email = lower(u.email),
    role = 'admin',
    active = true,
    auth_user_id = u.id
from auth.users u
where tm.id = 123
  and lower(u.email) = lower('admin@example.com');
```

Verify the invariant:

```sql
select id, name, email, role, active, auth_user_id
from public.team_members
where active and role = 'admin' and auth_user_id is not null;
```

At least one row must be returned.

## 5. Deploy and check the auth-aware application

Deploy the frontend and API changes. Before RLS lockdown:

1. Accept the admin invitation and set a password.
2. Sign in, refresh, sign out, and sign back in.
3. Load every dashboard route.
4. Perform one ordinary pipeline action and one admin action.
5. Open Team, invite a test member, and verify the member receives `403` for an
   admin-only action.
6. Trigger one cron request, one authenticated notify ping, and one MCP request.

## 6. Apply the lockdown

Only after step 5 passes, introduce/apply
`supabase/migrations/051_authenticated_rls.sql`. It removes anonymous table/view
reads and converts exposed views to invoker security.

Immediately verify:

- An anon PostgREST request cannot read dashboard tables or views.
- An active member can load all dashboard data.
- An inactive or unlinked Auth user receives no rows and cannot use APIs.
- The service role can still sync/write.
- `lead-photos` remains public and the `agent` bucket remains private.

If a critical browser read was omitted, roll back migration 051's policy/grant
changes only. Keep migration 050 and the auth-aware app deployed; they are
backward-compatible with the old read policies.
