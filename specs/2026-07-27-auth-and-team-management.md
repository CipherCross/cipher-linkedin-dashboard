# Authentication and team management

## Goal

Protect the dashboard, its Supabase data, and its browser-facing Vercel APIs with invite-only Supabase Auth using email and password. Every active authenticated teammate can read the full dashboard; server-controlled `member` and `admin` roles determine who may perform sensitive actions, and authenticated identity becomes the authoritative actor for CRM notes and audit events.

Add a Team Management page that every active user can read and only admins can edit. Preserve purpose-specific authentication for cron jobs, the sync-agent reply notification, and MCP clients, while intentionally leaving lead photos public.

## Non-goals

- Per-campaign, per-instance, or row-level visibility differences between teammates.
- Public self-service signup or email-domain-based automatic enrollment.
- Google, Microsoft, SAML, or other SSO in this iteration.
- MFA enforcement, custom session-duration policies, or device/session administration.
- Replacing the service-role key used by trusted server and sync processes.
- Making the `lead-photos` storage bucket private.
- Turning every historical `team_members` row into an application login; assignment-only teammates may remain without an Auth identity.
- Adding a thirteenth Vercel function solely for auth or invitations.

## Research findings

- The browser already uses one `@supabase/supabase-js` client in `frontend/src/lib/supabase.ts`. The installed SDK supports session lifecycle, password authentication, token claims, password updates, and sign-out without another Vercel function.
- `frontend/src/App.tsx` currently mounts `DataProvider` before the router and has no auth gate. The gate must precede `DataProvider`, or logged-out visitors will trigger the complete data fetch before the UI redirects.
- Browser reads go directly to Supabase. RLS is enabled, but current SELECT policies generally use `using (true)`, so a login screen by itself would not protect the data.
- Most exposed SQL views run with owner privileges. They must use `security_invoker = true` and authenticated-only grants, or they can bypass the RLS of their underlying tables. `conversation_latest_message` already demonstrates the intended pattern.
- All Vercel APIs use the service-role client from `frontend/api/_lib/core.ts`, which bypasses RLS. Browser-facing handlers therefore need explicit bearer-token verification and an active-team-member/admin lookup before using `db()`.
- Authorization is currently inconsistent: several routes use an optional, fail-open `ADMIN_SECRET`; some user-triggered AI/import routes are open; scheduled GET routes conditionally use `CRON_SECRET`; and MCP has a separate fail-closed shared-secret path.
- `frontend/src/lib/admin.ts` stores `ADMIN_SECRET` in `localStorage`. It is the natural compatibility point for changing callers to attach the current Supabase access token, but the stored shared-secret and prompt flow should be removed.
- `team_members` is currently an assignment directory, not an identity table. CRM actions accept caller-provided actor/author strings and `usePipelineActions.ts` stores “Who am I” in `localStorage`.
- There are already 12 top-level Vercel API functions, matching the documented Hobby-plan constraint. Team invitation and management should therefore be added as action-level operations to the existing `/api/pipeline` function.
- Supabase recommends targeting authenticated RLS policies explicitly, keeping authorization state in server-controlled data rather than editable `user_metadata`, and using `security_invoker` for exposed views: [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security).
- Supabase’s current React guidance uses a shared client plus session/claim validation and `onAuthStateChange`: [Use Supabase Auth with React](https://supabase.com/docs/guides/auth/quickstarts/react) and [`getClaims`](https://supabase.com/docs/reference/javascript/auth-getclaims).
- Server functions should receive a bearer JWT, verify it, and only then use privileged data access: [Securing functions](https://supabase.com/docs/guides/functions/auth) and [JWT verification](https://supabase.com/docs/guides/auth/jwts).
- Invite-only access can be enforced by disabling new-user signup and inviting users through a trusted Admin API or the Supabase Dashboard: [Auth configuration](https://supabase.com/docs/guides/auth/general-configuration) and [Inviting users](https://supabase.com/docs/guides/auth/users).
- Production password recovery and invitation email delivery require correct redirect allowlists and production SMTP configuration: [Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls) and [Password-based Auth](https://supabase.com/docs/guides/auth/passwords).

## Decisions

- **Data visibility:** Every active authenticated teammate can read the full dashboard. There is no campaign/account partitioning in this release.
- **Enrollment:** Access is invite-only. Public signup is disabled in Supabase.
- **Sign-in method:** Email and password.
- **Authorization:** Sensitive operations require the server-controlled `admin` role. This includes instance configuration, imports and deletions, reclassification, manual briefing generation, strategy/playbook changes, and team management.
- **Ordinary member actions:** Active members may use the dashboard, chat/coach, and normal CRM workflows such as moving leads, assigning owners, and writing notes.
- **Identity:** Each application user maps one-to-one to a `team_members` row. The authenticated member name replaces the local “Who am I” picker as the actor for new notes and audit events; historical text remains unchanged.
- **Team Management page:** All active members can view it; admins can invite users and edit names, roles, and active status. Assignment-only teammate records without login access remain supported.
- **Machine callers:** Cron, sync-agent notification, and MCP retain separate non-user credentials. Browser credentials are not reused for these processes.
- **Public exception:** `lead-photos` remains public.

## Approach

Use Supabase Auth as the identity/session authority and extend the existing `team_members` directory into the application membership record. Migration 050 adds:

- `auth_user_id uuid null unique references auth.users(id) on delete set null`
- `email text null`
- `role text not null default 'member' check (role in ('member', 'admin'))`
- A partial unique index on `lower(email)` where email is not null

Both identity fields remain nullable so existing assignment-only teammates keep their IDs, assignments, and history. An Auth user may link to exactly one team member. An application login is usable only when its linked row has `active = true`.

Migration 050 also adds `public.is_active_team_member()` and `public.is_app_admin()` as `stable security definer` boolean functions with `set search_path = ''`, fully qualified object references, and execution granted only to `authenticated`. They compare `auth.uid()` to `public.team_members.auth_user_id` and check live `active`/`role` values. This prevents a still-valid JWT from retaining database access after a member is deactivated and avoids recursive RLS on `team_members`.

Create `AuthProvider` above `DataProvider` and `HashRouter`. It owns these explicit states:

- `initializing`: validate/restore the persisted session and process an invite/recovery callback.
- `signed_out`: show email/password login plus “Forgot password”.
- `setting_password`: require a password after invite acceptance or recovery.
- `unauthorized`: the Auth user is unlinked or its team row is inactive; show a neutral contact-an-admin screen and allow sign-out.
- `ready`: expose the linked member, `role`, `isAdmin`, and sign-out, then mount dashboard data and routes.

While ready, revalidate the linked membership row every 60 seconds and whenever the tab regains visibility. If the row is no longer active/visible, transition out of `ready` and unmount `DataProvider`; direct RLS and API access are blocked immediately, while this bounds already-rendered stale data that cannot be remotely erased from browser memory.

Use `signInWithPassword` for normal login. Do not use Supabase’s implicit fragment callback because `HashRouter` owns the fragment. Customize invitation and recovery email templates to send `token_hash` and `type` as ordinary query parameters; before mounting `HashRouter`, verify them with `verifyOtp`, remove the one-time parameters with `history.replaceState`, and present `updateUser({ password })`. Allowlist the exact production origin, localhost origin, and explicitly supported Vercel preview pattern. Public signup remains disabled.

Add `frontend/src/lib/api.ts` with `authFetch`. It obtains the current session access token for every request, sends `Authorization: Bearer <JWT>`, and normalizes `401`, `403`, expired-session, JSON, and streaming responses. Delete the `localStorage.adminSecret` and prompt behavior; keep a temporary re-export only if needed to make the call-site conversion mechanical.

Add `frontend/api/_lib/auth.ts` with three guards:

- `requireUser(req)` verifies the bearer JWT with the project’s Supabase Auth/JWKS configuration and returns the Auth subject.
- `requireMember(req)` additionally loads the linked `team_members` row through the service-role client and requires `active = true`.
- `requireAdmin(req)` additionally requires `role = 'admin'`.

The member lookup happens on every privileged API request rather than trusting a role cached in client state or user-editable metadata. Missing/invalid/expired bearer credentials return `401`; a valid but unlinked, inactive, or underprivileged identity returns `403`. Only after a guard succeeds may a handler use the service-role `db()` client.

Server token verification uses `SUPABASE_URL` plus a new `SUPABASE_ANON_KEY` (the public project key, but kept as an unprefixed server variable for clarity); privileged work continues to use `SUPABASE_SERVICE_ROLE_KEY`. Browser configuration remains only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Set a minimum password length of 12 in Supabase Auth, retain platform login/recovery rate limits, and use generic recovery success text that does not disclose whether an email exists.

The exact API authorization matrix is:

| Endpoint / action | Required principal |
| --- | --- |
| `/api/chat` POST | Active member |
| `/api/coach` POST, including digest/force | Active member |
| `/api/pipeline`: `set_stage`, `assign`, `add_note`, `delete_note`, and all follow-up actions | Active member |
| `/api/pipeline`: `set_gender`, legacy `add_member`/`set_member_active`, and new team-management actions | Admin |
| `/api/config` POST | Admin |
| `/api/import`: metadata, preview, search, commit, conversation import, and message deletion | Admin |
| `/api/playbook`: legacy playbook save and every search/ICP/hypothesis/context action | Admin |
| `/api/reclassify` POST | Admin |
| `/api/review-digest` POST | Admin |
| `/api/classify` POST, including demographics mode | Admin |
| `/api/classify` GET | Valid `CRON_SECRET` |
| `/api/briefing` POST | Admin |
| `/api/briefing` GET | Valid `CRON_SECRET` |
| `/api/notify-replies` POST | Valid `NOTIFY_SECRET` |
| `/api/notify-replies` GET | Valid `CRON_SECRET` |
| `/api/mcp` GET/POST/DELETE and all exposed tools | Valid `MCP_SECRET` |

Every required machine secret is fail-closed: an absent environment value is a server configuration error, never permission to proceed. Vercel continues to attach `CRON_SECRET` to scheduled requests. The sync agent reads a new local-only `notify_secret` key and sends it as a bearer token matching server `NOTIFY_SECRET`; it is excluded from `REMOTE_CONFIG_KEYS` and rejected by `/api/config`, so it cannot enter browser-readable `instances.config`. MCP moves from mixed open-read/`ADMIN_SECRET` behavior to one fail-closed `MCP_SECRET` boundary because its tools use service-role-backed analytics and cannot inherit the SPA session.

Keep ordinary CRM mutations available to members, but change their function signatures so the server supplies the authenticated principal. Ignore/remove client `actor` and `author` fields for stage moves, assignments, notes, and follow-up mutations. Persist `principal.member.name` as the snapshot text. Preserve the literal `auto` actor for automated database transitions and do not rewrite historical rows.

Add the following action-level operations to `/api/pipeline`, preserving the 12-function Vercel limit:

- `invite_member` (admin): accepts normalized `name`, `email`, `role`, and optional existing assignment-only `member_id`; creates or reuses the team row, calls `auth.admin.inviteUserByEmail`, and links the returned Auth UUID.
- `update_member` (admin): changes name, role, or active status and updates/bans the linked Auth user when needed.

Invitation is retryable rather than pretending the Auth and public-schema writes are transactional. Create/reuse the team row first; if Auth invitation fails, retain the unlinked row and return an actionable error so an admin can retry. A retry looks up an exact normalized Auth email and links it instead of creating duplicates. Email is immutable after linking in this release; changing it means deactivating the old login and issuing a new invitation. Renaming a teammate changes future attribution only; existing audit text remains a snapshot.

Migration 050 includes a service-role-only `admin_update_team_member` RPC that performs the role/active update and “at least one active linked admin” invariant in one database transaction. The API verifies the caller is an admin before invoking it. For deactivation, commit the team-row change before banning the Auth user so RLS/API access closes even if the Auth update fails; for reactivation, unban first and set `active = true` second. Return a recoverable partial-state error when the Auth administration call fails. Self-deactivation or self-demotion is rejected when it would remove the final active admin.

The Team page is a lazy `/team` route visible to every active member. `DataContext` extends its existing `team_members` query with email, role, and Auth linkage, so the read-only page does not add another service-role API read path. It shows name, email, role, active state, and `login enabled` versus `assignment only`. Members get a read-only table. Admins get invite/link, rename, role, and activation controls with confirmation for access removal. UI role checks are only presentation; `/api/pipeline` enforces every edit independently.

Migration 051 performs the access cutover. It replaces the read-open policies on these 25 public tables with `for select to authenticated using (public.is_active_team_member())`: `instances`, `campaigns`, `leads`, `events`, `sync_runs`, `messages`, `annotations`, `campaign_steps`, `conversation_coaching`, `coaching_digest`, `briefings`, `playbook`, `briefing_jobs`, `team_members`, `lead_notes`, `pipeline_events`, `saved_searches`, `icps`, `icp_personas`, `icp_industries`, `hypotheses`, `hypothesis_campaigns`, `follow_up_events`, `conversation_follow_up_state`, and `lead_gender_reviews`. During implementation, derive this inventory from `pg_class`/`pg_policies` and fail verification if another exposed RLS table is omitted.

Migration 051 recreates or alters the seven exposed views with invoker security: `campaign_metrics`, `daily_activity`, `campaign_reply_sentiment`, `pipeline_metrics`, `campaign_reply_intent`, `conversation_reply_intent`, and `conversation_latest_message`. Revoke public/anon SELECT and grant SELECT only to `authenticated` where browser access is required. Keep the narrowly scoped `ai_sql_runner` grants and the service-role behavior unchanged. Leave the public `lead-photos` object policy intact and verify the private `agent` bucket is unchanged.

Bootstrap the first admin through a one-time SQL runbook, not an application bypass: invite the user in the Supabase Dashboard, update or insert the matching `team_members` row using the Auth UUID and normalized email, set `role = 'admin'`, and verify `active = true`. The runbook includes a query that proves exactly one linked active admin exists before the frontend/API cutover.

## Implementation phases

1. **Prepare Supabase and additive schema — M**
   - Configure production SMTP, Site URL, explicit redirect allowlist, token-hash invite/recovery email templates, and disabled public signup.
   - Add and apply `050_auth_identity.sql` with identity fields, indexes, constraints, and helper functions; do not change existing read policies yet.
   - Update `SCHEMA_DOC`, frontend types, environment examples, and the first-admin bootstrap runbook.
   - Invite/link the first admin and verify the helper functions for linked active, linked inactive, unlinked, member, and admin identities.

2. **Implement session UX and shared authorization — L**
   - Add `AuthProvider`, login, forgot/reset password, invite acceptance, set-password, unauthorized, and sign-out UI.
   - Mount `DataProvider` only in the `ready` state and clear its cached data when the session/membership disappears.
   - Add `authFetch` and convert every browser API caller, including streaming chat.
   - Add server `requireUser`/`requireMember`/`requireAdmin`, standardize `401`/`403`, and implement the endpoint matrix above.
   - Set `CRON_SECRET`, `NOTIFY_SECRET`, and `MCP_SECRET` before deploying fail-closed handlers.

3. **Bind CRM identity and implement Team Management — L**
   - Remove `pipelineActor` storage/picker and derive all new human audit attribution server-side.
   - Split `/api/pipeline` actions into member and admin allowlists.
   - Implement `invite_member` and `update_member`, idempotent email linking, Auth banning/reactivation, and final-admin safeguards.
   - Add `/team`, read-only member presentation, admin editing controls, route/nav integration, and sign-out/current-user display in the application shell.

4. **Update sync and independent machine access — M**
   - Add local-only `notify_secret` to `sync-agent/config.example.yaml`, agent request headers, config validation, and deployment documentation.
   - Make all cron, notification, and MCP branches fail closed with their dedicated credential.
   - Run `python3 agent.py sync --dry-run` and compare normal extraction counts before any real sync; separately test the authenticated notification ping.

5. **Cut over direct database access — L**
   - Add `051_authenticated_rls.sql` with the complete table policy and view/grant inventory.
   - Before applying it, verify the deployed frontend can sign in as the bootstrap admin, load all dashboard routes, and invoke one member and one admin API action.
   - Deliver migration 051 as a separate deployable changeset; do not run the repo-level `supabase db push` with 051 present until the auth-aware Vercel release has passed the pre-cutover checks.
   - Apply migration 051, then test anon, active member, inactive member, and service-role access immediately.
   - If a critical read path was omitted, roll back only migration 051’s policy/grant changes; migration 050 and the auth-aware app remain backward compatible.

6. **Regression and security verification — M**
   - Run `npm run build`.
   - Test login, logout, refresh/session restoration, invite acceptance, set/reset password, invalid/expired/replayed token links, and deep links.
   - Execute the full endpoint matrix with no token, member token, admin token, inactive-user token, and each machine credential.
   - Enumerate public-schema tables/views from Postgres metadata and compare them with migration 051 rather than relying only on a handwritten list.
   - Verify all dashboard pages and ordinary CRM flows, the Team page, cron, MCP, notification delivery, and public lead photos.
   - Remove `ADMIN_SECRET` from Vercel and confirm no repository reference or browser local-storage key remains.

## Affected files/modules

- New `supabase/migrations/050_auth_identity.sql` and `supabase/migrations/051_authenticated_rls.sql`.
- `frontend/src/lib/supabase.ts`
- New `frontend/src/lib/AuthContext.tsx` and `frontend/src/lib/api.ts`; remove `frontend/src/lib/admin.ts` after call-site conversion.
- `frontend/src/App.tsx`, `frontend/src/main.tsx`, and `frontend/src/components/Layout.tsx`.
- New auth UI components and `frontend/src/pages/Team.tsx`.
- `frontend/src/lib/DataContext.tsx`, `frontend/src/lib/types.ts`, `frontend/src/lib/usePipelineActions.ts`, and `frontend/src/lib/useFollowUpActions.ts`.
- Existing browser API callers in `ConversationDrawer.tsx`, `ImportHistoryPanel.tsx`, `InstanceConfigEditor.tsx`, `CampaignDetail.tsx`, `LeadsExplorer.tsx`, `Review.tsx`, `Playbook.tsx`, `SearchLibrary.tsx`, `Icp.tsx`, `Hypotheses.tsx`, and `frontend/src/lib/importApi.ts`.
- New `frontend/api/_lib/auth.ts` plus updates to `frontend/api/_lib/core.ts`.
- All top-level `frontend/api/*.ts` handlers, with especially substantial action-level changes in `pipeline.ts`, `import.ts`, `classify.ts`, `reclassify.ts`, `briefing.ts`, `notify-replies.ts`, `mcp.ts`, `chat.ts`, and `coach.ts`.
- `sync-agent/agent.py` and `sync-agent/config.example.yaml` for authenticated reply notifications.
- `frontend/.env.example`, `README.md`, and `frontend/vercel.json` documentation/comments; no new top-level Vercel function.

## Risks & how to verify

- **UI-only protection leaves data exposed.** Verify anon REST requests to every table/view fail after lockdown, while signed-in browser reads still work.
- **Views bypass table RLS.** Enumerate exposed views from Postgres metadata, assert `security_invoker = true`, and test each as anon and authenticated.
- **Service-role APIs bypass RLS.** Directly call every endpoint without a token, with a member token, with an admin token, and with an inactive/unlinked user token; confirm the documented matrix.
- **Deployment order causes an outage.** Ship migration 050 and migration 051 as separate changesets: apply 050, bootstrap an admin, configure all machine secrets, deploy auth-aware frontend/APIs, verify login, and only then introduce/apply 051. Keep a migration-051-only policy/grant rollback script in the operator runbook.
- **Invite or recovery callbacks collide with `HashRouter`.** Test clean URLs, nested hash routes, invitation links, recovery links, and refreshes in local, production, and preview environments before rollout.
- **Role escalation through editable metadata or request payloads.** Keep roles in `team_members`, modify them only through an admin-guarded service path, and never trust `user_metadata`, actor, author, or role fields from the client.
- **An admin locks out the team.** Serialize the “at least one active linked admin” check/update in a database RPC or equivalent transaction; test self-deactivation/demotion and concurrent updates.
- **Deactivated users retain a valid JWT or stale browser data.** Make RLS helpers and API guards check live membership, ban the Auth user, clear `DataProvider` on auth loss, and revalidate membership every 60 seconds plus tab visibility changes. Previously rendered data cannot be recalled from memory, but no new data or mutation remains accessible.
- **Machine jobs break when browser auth is introduced.** Test cron, notify, MCP, sync dry-run, and a normal sync separately; machine handlers must not be routed through interactive user auth.
- **Email delivery fails in production.** Configure custom SMTP, sender identity, redirect allowlists, and templates; test actual invite and recovery delivery before inviting the team.
- **Existing assignment-only teammates are accidentally removed.** Keep Auth linkage nullable, migrate without rewriting IDs, and verify current assignments and audit history before and after the schema change.
- **Invitation partially succeeds across Auth and public schemas.** Make invitation retries idempotent by normalized email, preserve a recoverable unlinked team row, and surface the exact failed step to the admin.

## Definition of done

- Public signup is disabled; invited users can set a password, sign in, restore a session after refresh, reset their password, and sign out.
- Logged-out, unlinked, and inactive users cannot load dashboard data or invoke browser-facing API actions.
- Every active authenticated member can read the entire dashboard and the Team page.
- Members can perform ordinary CRM work and use permitted AI tools but receive `403` for admin-only actions.
- Admins can invite and manage team members, roles, and active state from the Team page, with final-admin lockout protection.
- New notes, pipeline events, and follow-up audit events use the authenticated teammate identity and cannot be forged with request fields.
- No browser code stores or prompts for `ADMIN_SECRET`; no service-role or machine secret is exposed through a `VITE_` variable.
- Direct anon reads of protected tables and views fail; authenticated reads succeed; all exposed protected views use invoker security.
- Cron, sync notification, and MCP access work only with their dedicated credentials and fail closed when required configuration is missing.
- `lead-photos` remains publicly accessible as the sole intentional dashboard-data exception, and the private agent bucket remains private.
- The first-admin bootstrap, token-hash email templates, Supabase Auth settings, redirect URLs, SMTP requirements, environment variables, deployment order, and migration-051-only rollback are documented.
- `npm run build` passes and the member/admin/anon/machine authorization matrix is verified against the deployed stack.
