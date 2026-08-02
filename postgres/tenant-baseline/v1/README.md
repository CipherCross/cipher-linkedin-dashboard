# Portable business schema baseline v1

`001_portable_business_baseline.sql` is the provider-neutral PostgreSQL
business-schema baseline for the N1 migration work. It is derived from the S04
machine-readable v053 inventory and contains only the current business tables,
identity columns, business constraints, indexes, and the seven final business
views.

The source v053 artifact recorded eight view declarations because
`campaign_metrics` was created and later replaced. This baseline declares the
final `campaign_metrics` definition once, so it contains seven view objects.

The baseline intentionally omits the provider identity reference column from
`team_members`; S06 owns canonical users, provider mappings, runtime roles,
actor context, and RLS. It also omits source functions, triggers, policies,
ACLs, provider schemas, Storage metadata, and the historical migration ledger.
Those omissions are explicit deferred scope, not permission for a direct
browser or owner-role data path. Later runtime work must preserve the
server-owned API boundary and use a non-owner, non-`BYPASSRLS` runtime role.

The baseline creates no business rows or secrets. `pgcrypto` is the only
extension required because the existing UUID defaults use `gen_random_uuid()`.

## S06 companion artifact

`002_identity_roles_actor_rls.sql` is applied after the business baseline. It
adds application-owned canonical `users`, the `user_identities` provider
mapping, the canonical `team_members.user_id` link, transaction-local
`app.actor_id` policy context and RLS over all 25 business tables plus the two
new identity tables. It does not modify `001` and does not add stored
functions, triggers or an AI SQL guard; those remain later session scope.

The role contract is separate and explicit: `app_owner` is a non-login,
non-superuser object owner; `app_migration` is a non-superuser login that may
`SET ROLE app_owner` and owns no objects; `app_runtime` is a separate
non-superuser login with no membership in either owner or migration and no
`BYPASSRLS`; `app_readonly` is a read-only group. `app_machine` and
`app_system` are separate no-login, no-grant fail-closed principals. S21 owns
machine identity/ingest and S15 owns system/job identity; S06 does not create
fake team users for either context. Role bootstrap and transfer of the S05
objects to `app_owner` happen before the artifact; the artifact itself is
applied through the `app_migration` session, not through `postgres`.

The runtime roles have no passwords or credentials in SQL. The server-owned API
must set `SET LOCAL app.actor_id` inside each transaction. S03's `user` actor
is the only database-authorized context in S06; tenant binding and member/admin
role checks remain at the server boundary. Machine/system contexts have no
table grants and therefore fail closed. The runtime role is not an object
owner, cannot `SET ROLE` into owner or migration, and does not have
`BYPASSRLS`; anonymous/public schema and table privileges are revoked.

## S07 companion artifact

`003_functions_triggers_ai_guard.sql` is applied after the identity artifact. It
adds the 13 portable stored functions, the 12 business triggers and the
SELECT-only AI SQL guard. It does not modify `001` or `002`.

Functions and triggers are a 1:1 port of the source v053 set. Only the two
helpers that resolved the signed-in principal through a provider claim changed
behaviour: they now read the transaction-local canonical actor and require an
active canonical user with an active membership, matching the S06 policy
contract. `admin_update_team_member` counts the canonical `team_members.user_id`
link where the source counted the provider identity column. Everything else,
including the milestone-preservation trigger, is byte-for-byte business logic
from the source. As an S07 hardening delta every function pins a fixed
`search_path`, including the five source functions that had none, and no
function is executable by `PUBLIC`.

The milestone contract is unchanged: a NULL milestone may be filled forward, a
non-NULL milestone is restored rather than nulled, a repeated sync upsert is
idempotent, and the only sanctioned regress is `delete_manual_message`'s
transaction-local `app.allow_milestone_regress` recompute.

The AI SQL guard keeps the source contract — one `SELECT`/`WITH` statement, an
inner 1000-row cap, a `jsonb_agg` result that is never NULL, and a 10 second
statement timeout — and adds an explicit literal- and comment-aware check so
empty, malformed, multi-statement and mutation input fail closed before anything
is planned. The provider role `ai_sql_runner` is replaced by `app_ai_runner`: a
no-login, non-superuser, non-`BYPASSRLS`, non-owner sandbox that owns only the
guard function and holds SELECT-only grants, column-scoped on `instances` and
`team_members` so `instances.config` and the member contact/role/identity columns
stay unreachable. `app_system`, the server-owned system principal S06 reserved
for S15, is the only role that may execute the guard; its whole privilege set is
schema usage plus that one function. `app_runtime`, `app_readonly`, `PUBLIC` and
any anonymous principal cannot reach it, and no role gains a write path.

The 10 second limit needs the caller's cooperation: PostgreSQL arms
`statement_timeout` when the outer statement begins, so the value the guard sets
on itself cannot abort a call already in flight. S11's transaction wrapper and
S15's AI handlers must issue `SET LOCAL statement_timeout` per transaction. Both
halves of that contract are asserted in the clean-room.

## Checks

From the repository root:

```bash
node postgres/tests/portable_business_inventory_assertions.mjs
postgres/tests/portable_business_cleanroom.sh
node postgres/tests/portable_identity_roles_rls_inventory_assertions.mjs
postgres/tests/portable_identity_roles_rls_cleanroom.sh
node postgres/tests/portable_functions_triggers_ai_guard_inventory_assertions.mjs
postgres/tests/portable_functions_triggers_ai_guard_cleanroom.sh
```

The S07 harness applies all three artifacts in order and replays the S06 catalog
assertions in between, so an identity/RLS regression is caught before the
functions are layered on top.

The clean-room harness refuses an implicit image pull. Set `POSTGRES_IMAGE` to
an already-installed PostgreSQL image when the default image is unavailable.
