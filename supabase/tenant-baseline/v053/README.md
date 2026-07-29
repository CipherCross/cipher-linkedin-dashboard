# Tenant baseline v053

`053_tenant_baseline.sql` is the immutable schema-only cutover artifact for new
managed company workspaces. It represents the final application schema after
historical migration 053. New tenants apply it once, record migration version
`053`, then consume only shared `054+` deltas.

The artifact deliberately contains no business rows, internal cleanup, repair
backfills, `Web 2 Mob` data, or `agent` bucket. Its only provider metadata DML
creates `lead-photos` as a private bucket. The Supabase project must already
provide the standard `public`, `auth`, `storage`, and `supabase_migrations`
schemas plus the `anon`, `authenticated`, and `service_role` roles.

Before apply, verify `manifest.json` and materialize the tenant-only catalog
through `supabase/tenant-migrations/materialize.sh`. Never point repository-root
`supabase db push` at a tenant project.
