# Tenant migration catalog

This catalog is the only migration input allowed for managed tenant projects.
Do not run repository-root `supabase db push` against a tenant: the historical
`001`-`052` files are internal-workspace history and would be seen as missing.

Materialize a runner-ready catalog into a new or empty directory:

```sh
supabase/tenant-migrations/materialize.sh /tmp/tenant-catalog
```

The result contains:

- `053_tenant_baseline.sql`, copied from the immutable v053 artifact;
- every shared migration from `supabase/migrations/` with version `054` or
  greater, in normal lexical order;
- no internal seed or historical migration.

The deployment runner applies that directory with the Supabase CLI (or an
equivalent runner that writes the standard
`supabase_migrations.schema_migrations` row after each successful file). It
must verify the v053 manifest checksum before apply. Internal projects keep
their existing ledger `001`-`053` and consume the same `054+` files directly
from `supabase/migrations/`.
