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

## Checks

From the repository root:

```bash
node postgres/tests/portable_business_inventory_assertions.mjs
postgres/tests/portable_business_cleanroom.sh
```

The clean-room harness refuses an implicit image pull. Set `POSTGRES_IMAGE` to
an already-installed PostgreSQL image when the default image is unavailable.
