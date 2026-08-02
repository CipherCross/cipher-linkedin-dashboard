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

## S08 migration ledger and restore procedure

S08 does not add a fourth baseline step. It adds the machinery that applies the
three existing ones repeatably and moves the result between clusters.

`ledger.manifest.json` is the repo-side source of truth: it declares the
canonical order `001 → 002 → 003`, pins the SHA-256 of every artifact, names the
apply principal and records the control-plane role-bootstrap dependency.
`app_ledger.applied_migration` inside each tenant database is the source of truth
for what that database actually received. Any disagreement between the two is
drift.

- `000_control_plane_role_bootstrap.sql` — the prerequisite. Part A creates the
  seven roles and their memberships; roles are cluster objects and are safely
  re-runnable. Part B grants the database-scoped capabilities the baseline needs
  and runs again for every database. It contains no credential.
- `000_migration_ledger.sql` — creates the `app_ledger` schema and its two
  append-only tables. It lives outside `public` deliberately: `public` is the
  business inventory that S05, S06 and S07 assert against, and a bookkeeping
  table there would silently redefine those counts. No role but `app_owner` has
  any privilege on it.
- `restore_window_open.sql` / `restore_window_close.sql` — the restore
  procedure. See below; the close file refuses to succeed if the window is
  still open.

Apply with the runner, never by hand:

```bash
LEDGER_DB=<database> node postgres/tools/portable_migration_ledger.mjs apply
LEDGER_DB=<database> node postgres/tools/portable_migration_ledger.mjs verify
LEDGER_DB=<database> node postgres/tools/portable_migration_ledger.mjs status
```

The runner connects as the non-superuser `app_migration` login and applies every
step under `SET ROLE app_owner`, one transaction per step, so a half-applied step
can never look applied. It reaches PostgreSQL only through `$LEDGER_PSQL`
(default `psql`), so no host, port or credential is ever stored here.

**Re-apply is an idempotent skip.** A step already recorded with a matching
digest is skipped and the run exits successfully — the baseline SQL is not
internally idempotent, so re-executing it would fail. Every other disagreement is
a hard failure: a changed artifact, a digest that differs from the ledger, a
skipped step, steps applied out of order, a missing role bootstrap or a superuser
apply principal. There are no down migrations; reversal stays a break-glass
action outside this ledger.

### Dump and restore

```bash
pg_dump    --username app_migration --role app_owner --format=custom
pg_restore --username app_migration --role app_owner --exit-on-error
```

Both run as the ordinary non-superuser login. `pg_dumpall --roles-only` is never
used: roles are created on the target by the control-plane bootstrap, so no role
definition or credential travels between clusters.

A restore needs the window, and it is not optional. Because the AI guard is
deliberately owned by `app_ai_runner` — a role that owns nothing else and has no
`CREATE` — a plain `pg_restore` cannot re-establish its ownership or its ACL. The
ownership statement fails outright; worse, the `REVOKE ... FROM PUBLIC` and
`GRANT ... TO app_system` statements only emit a *warning*, so the guard comes
back executable by `PUBLIC` and without its `app_system` grant while
`--exit-on-error` reports success. Open the window, restore, close it, and treat
any `pg_restore` warning as a failure.

## Checks

From the repository root:

```bash
node postgres/tests/portable_business_inventory_assertions.mjs
postgres/tests/portable_business_cleanroom.sh
node postgres/tests/portable_identity_roles_rls_inventory_assertions.mjs
postgres/tests/portable_identity_roles_rls_cleanroom.sh
node postgres/tests/portable_functions_triggers_ai_guard_inventory_assertions.mjs
postgres/tests/portable_functions_triggers_ai_guard_cleanroom.sh
node postgres/tests/portable_migration_ledger_static_assertions.mjs
postgres/tests/portable_migration_ledger_tests.sh
postgres/tests/portable_dump_restore_cleanroom.sh
```

The S07 harness applies all three artifacts in order and replays the S06 catalog
assertions in between, so an identity/RLS regression is caught before the
functions are layered on top.

The S08 dump/restore harness uses three separate clusters: two independent clean
applies whose inventories must be identical, and a third that receives the dump
and is reconciled against the source.

The clean-room harnesses refuse an implicit image pull. Set `POSTGRES_IMAGE` to
an already-installed PostgreSQL image when the default image is unavailable.
