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

## Checks

From the repository root:

```bash
node postgres/tests/portable_business_inventory_assertions.mjs
postgres/tests/portable_business_cleanroom.sh
node postgres/tests/portable_identity_roles_rls_inventory_assertions.mjs
postgres/tests/portable_identity_roles_rls_cleanroom.sh
```

The clean-room harness refuses an implicit image pull. Set `POSTGRES_IMAGE` to
an already-installed PostgreSQL image when the default image is unavailable.
