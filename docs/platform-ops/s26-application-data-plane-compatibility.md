# S26 application data-plane compatibility

Date: 2026-08-10

Status: **GA route selected and authentication boundary repaired locally; the
S26 deployment contract remains blocked and no provider action is authorized**

## Official Neon capability decision

The current official Neon documentation was reviewed on 2026-08-10.

| Requirement | Neon Data API evidence | Decision |
|---|---|---|
| Production maturity | The [Data API overview](https://neon.com/docs/data-api/overview) explicitly labels the feature **Beta**. | Fails the S26 GA-only gate. |
| Authenticated browser access | The Data API accepts JWT-authenticated browser and edge requests. | Functionally available, but only inside the rejected Beta product. |
| Better Auth / JWKS | The Data API supports Neon-managed Better Auth or an external JWKS. [Neon-managed Better Auth](https://neon.com/docs/auth/overview) is itself explicitly **Beta**. | The managed option fails the GA-only gate; the repository's already-reviewed self-hosted Better Auth remains the identity candidate. |
| Existing RLS | Data API requests can run with JWT claims under Postgres RLS. | Functionally available, but does not override the maturity failure. |
| Server/admin access | A server can use database credentials separately from the browser API. S26 must keep distinct least-privilege `app_runtime`, `app_system`, `app_machine`, and `identity_store` principals; it must not create a browser-visible admin credential. | Use direct server-side Postgres connections, not a Data API admin-key analogue. |
| Automated provisioning | Neon documents a Data API control-plane endpoint and programmatic enable/refresh operations. The surface is still the Beta Data API and is branch/database constrained. | Not admissible for the closed production operation contract. |

The selected GA-only data route is therefore Vercel server functions using
normal Neon Postgres connections and the repository's named-operation
`DataStore`. Neon's official [serverless driver documentation](https://neon.com/docs/serverless/serverless-driver)
labels driver 1.0 GA and supports Vercel-style serverless runtimes. The current
application adapter uses the standard PostgreSQL `pg` protocol against Neon;
changing driver packages is not required to establish the security boundary and
must not be coupled to this repair without its own measured compatibility work.
No browser receives a database URL.

## Supabase runtime dependency map

### Browser

| Surface | Supabase dependency | Existing/repaired application path |
|---|---|---|
| `src/lib/supabase.ts` | Constructs the legacy browser client from `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. | Remains only for the default legacy path. |
| `src/lib/AuthContext.tsx` | Legacy sign-in, session verification, password setup, and membership lookup. | `VITE_AUTH_PATH=identity` already selects the self-hosted Better Auth cookie flow through `/api/identity`. |
| `src/lib/api.ts` | Legacy API calls attach the Supabase access token. | Identity mode sends only the same-origin HttpOnly cookie. |
| `src/lib/DataContext.tsx` | Legacy direct PostgREST dashboard reads. | `NEON_READS_DEFAULT=neon` selects the authenticated named-operation API. |
| `ConversationDrawer`, `LeadNotesPanel`, `FollowUpPanel`, `LeadsExplorer`, `Playbook`, and `leadPhotos` | Legacy page-local PostgREST and Storage reads. | Each already has an application-API branch; photo signing additionally requires the separately configured object-store boundary. |
| Roster-keyed mutations | Supabase and Neon `team_members.id` values are not interchangeable. | Neon roster writes remain refused until every named write operation exists against the same store. |

### Vercel server functions

| Surface | Supabase dependency | Neon/application state after this repair |
|---|---|---|
| `_lib/auth.ts` | Supabase JWT verification and membership/admin lookup. | Retained for legacy deployments only. `_lib/identity/application.ts` now selects exactly one authenticator; identity mode accepts the Better Auth cookie and disables bearer fallback. |
| `_lib/core.ts` | Supabase service-role client, legacy AI SQL RPC, and the optional chat roster preload. | Named Neon reads/tools already exist. Chat no longer constructs the service-role client for the optional preload on the Neon AI path. |
| `activity-daily.ts` | Previously resolved only a Supabase bearer even when serving Neon data. | Uses the deployment-selected application authenticator and actor-scoped RLS transaction. |
| `_lib/neonWrites.ts` | Previously resolved only the transitional Supabase bearer. | Uses the same identity-only cookie boundary when selected. All registered writes retain actor publication and RLS. |
| `pipeline.ts` | Legacy service-role mutations. | Stage, notes, gender, and instance-config Neon operations are reachable under Better Auth. Assignment, six follow-up actions, and four legacy member mutations return 503 before any Supabase client is constructed. |
| `playbook.ts` | Legacy admin guard and service-role writes. | All existing Neon library operations authenticate and re-check admin against Neon without constructing the legacy client. |
| `import.ts` | Legacy admin guard; conversation writes formerly became unreachable without Supabase auth. | Human imports use the identity/Neon admin boundary when Neon writes are selected; fixed Airtable handlers remain server-side. Machine operations remain separately credentialed. |
| `coach.ts`, `classify.ts`, `briefing.ts` | Legacy human guards and/or service-role data. | Existing Neon branches now reach the common cookie-aware writer. Cron paths remain machine-secret gated and use `app_system`. |
| `chat.ts` | Legacy member guard and service-role ICP preload. | Neon AI mode authenticates through Better Auth and uses Neon tools; the optional Supabase-only preload is omitted. |
| `review-digest.ts` | Legacy admin guard only; no database access. | Identity deployments resolve admin through the canonical Neon actor. |
| `notify-replies.ts`, `mcp.ts`, agent operations in `import.ts` | Separate machine secrets and legacy service-role paths. | Existing Neon machine/system paths remain selected by their closed flags and distinct credentials. They are not browser/application-admin paths. |
| Supabase Storage | Lead-photo object access and signed URLs. | The application already has an S3-compatible private-object adapter, but S26 does not yet have an approved automated lifecycle for tenant-scoped R2 application credentials. The control-plane Worker must not proxy object reads. |

## Preserved security boundary

- Browser requests never receive a Postgres credential or an admin-shaped key.
- Better Auth identifies a provider subject; `identity_resolve_actor` in the
  tenant database decides active membership and role.
- Identity mode does not accept the transitional Supabase bearer as fallback.
- Every Neon application transaction publishes the resolved actor and continues
  through the existing RLS and named-operation allowlists.
- Machine, AI/system, application, and identity credentials remain distinct.
- Unsupported Neon writes fail before a Supabase client or cross-provider member
  id can be used.
- Errors and logs expose only stable classes, never database URLs, provider
  responses, tokens, cookies, or credential values.

## Exact remaining blocker

Removing the Supabase-shaped S26 hosting profile is not yet safe. Three linked
pieces require a reviewed implementation and, for the third, an owner decision:

1. Add transactional named Neon operations and parity tests for lead assignment
   and all six follow-up actions. Retire or explicitly redirect the four legacy
   `pipeline.ts` member mutations to the already-existing `/api/identity` team
   administration vocabulary. Until then the Neon application path intentionally
   returns 503 for these actions.
2. Version the closed hosting environment contract away from
   `PUBLIC_DATA_API_*`, `DATA_API_*`, and `VITE_/SUPABASE_*`. It must bind the
   actual least-privilege role URLs (`NEON_DATABASE_URL`,
   `NEON_AI_DATABASE_URL`, `NEON_MACHINE_DATABASE_URL`, and
   `IDENTITY_STORE_DATABASE_URL`), `IDENTITY_SESSION_SECRET`,
   `IDENTITY_BASE_URL`, `VITE_AUTH_PATH=identity`, and the exact Neon read/write/AI
   flags. The bridge must derive each role URI only during exact approved apply,
   return metadata only, and the plan/binding/build digests must cover every
   name/class/source.
3. Decide the application-photo posture. Either approve a non-proxy automated
   lifecycle for tenant-scoped R2 S3 credentials and bind the existing storage
   variables, or explicitly approve initials-only operation with
   `NEON_PHOTOS_DEFAULT` disabled for the disposable S26 drill. The current
   Worker R2 binding is a control/recovery capability and must not become a
   general application data API.

These are application/closed-contract changes, not provider effects. Until all
three are resolved and tested, data preflight must stay false and the existing
`provider_readiness_blocked` refusal must remain in place. Mocked tests and the
local identity repair are not live readiness evidence.
