# P1-B handoff

Status: **complete**

Acceptance gate: **passed — empty tenant applies v053 + available deltas with
no internal data or schema drift**

## Completed scope

- Created the immutable schema-only tenant baseline at
  `supabase/tenant-baseline/v053/`.
- Added a manifest pinned to source revision
  `5adb6f6c7127b1be6da0c6edf6e31c90cf9199c9`, cutover `053`, Supabase
  PostgreSQL `17.6.1.127`, the historical catalog digest and artifact checksums.
- Added a tenant migration catalog/materializer that exposes baseline `053`
  plus shared `054+` deltas and never exposes `001`-`052` or internal seeds.
- Extracted the final post-045 `Web 2 Mob` ICP to an idempotent internal-only
  seed with three personas and 23 industries.
- Added a provider-matched clean-room suite for manifest integrity, migration
  ledgers, schema equivalence, exact inventory, RLS, grants, function security,
  empty data, Storage state and internal-marker exclusion.
- Reasserted historical `REVOKE` operations at the end of the baseline. This is
  required because Supabase provider default ACLs run when the objects are
  created, while a schema dump records positive final ACLs but not the earlier
  revocation statements that produced them.

## Changed files and versions

- Added `supabase/tenant-baseline/v053/053_tenant_baseline.sql`.
- Added `supabase/tenant-baseline/v053/manifest.json` and its README.
- Added `supabase/tenant-migrations/catalog.json`,
  `supabase/tenant-migrations/materialize.sh` and its README.
- Added `supabase/seeds/internal/web2mob.sql`.
- Added `supabase/tests/fixtures/provider_bootstrap.sql`.
- Added `supabase/tests/tenant_baseline_assertions.sql`.
- Added `supabase/tests/tenant_baseline_cleanroom.sh`.
- Added this handoff.
- Baseline SQL checksum:
  `sha256:4598326891ceccdd9e2c3f2ea2cfe3d4b75d5696d4178735749bd5709529379d`.
- Internal seed checksum:
  `sha256:f7a3462b33feb17f958c450243b88820ee0ed50c3d469203d2d90581129a7429`.
- No shared migration, application schema version, API or ingest protocol
  version changed. Migration `054` remains reserved for P1-C.

## Verification performed

- Ran `supabase/tests/tenant_baseline_cleanroom.sh` successfully against the
  pinned Supabase PostgreSQL `17.6.1.127` image.
- Applied the tenant materialized catalog to an empty provider-shaped database,
  recorded ledger version `053`, and applied the complete repository history to
  a separate empty database.
- Proved a zero normalized public-schema diff between baseline + all available
  `054+` deltas and historical `001+` migrations.
- Verified exactly 25 public tables, seven `security_invoker` views, 13
  application functions and 12 application triggers.
- Verified every public table has RLS and exactly the authenticated member plus
  AI-reader SELECT policies; `public`/`anon` have no SELECT.
- Verified authenticated and AI grants, AI column restrictions, no AI default
  table grants, service/Auth function boundaries, function owners,
  `SECURITY DEFINER` and hardened search paths.
- Verified the final bounded AI SQL guard and both corrected NUL-free v053
  advisory-lock definitions.
- Verified every business table is empty, `lead-photos` is private, no anonymous
  Storage object policy exists, and no `agent` bucket exists.
- Verified the internal seed is idempotent and produces exactly one ICP, three
  personas and 23 industries.
- Queried the linked internal project read-only: local and remote migration
  ledgers match for every version `001` through `053`.
- Took a read-only linked public-schema dump and proved a zero normalized
  catalog diff against the provider-matched clean full history. Restore-only
  normalization supplied the temporary schema privilege required to transfer
  `ai_execute_sql` ownership and reasserted the historical revokes omitted by
  schema-dump serialization.

## External state

- Read the linked internal Supabase migration ledger and public schema.
- Pulled the pinned Supabase PostgreSQL Docker image for local verification.
- No Supabase database, Storage bucket, Auth user, Vercel project, DNS record or
  other production resource was changed.

## Remaining blockers and risks

- P1-C must add idempotent shared migration `054`, migrate the existing
  internal `lead-photos` bucket from public to private, add authenticated/signed
  photo delivery, and update the UI away from anonymous public URLs.
- The existing internal bucket remains unchanged until P1-C. The v053 tenant
  baseline already provisions new tenant buckets as private.
- Repository-root `supabase db push` remains forbidden for tenants. Tenant
  deployment must use the materialized tenant catalog.
- The published v053 SQL and manifest are immutable. Any later baseline change
  requires a new baseline version and checksum rather than rewriting v053.

## Rollback point

All repository changes are additive. Rollback is removal of the P1-B baseline,
tenant catalog, internal seed, tests and this handoff. No external rollback is
required because external access was read-only.

## Prompt for the next session

> Выполни P1-C по `specs/2026-07-29-managed-company-workspaces.md`, используя
> `docs/platform-ops/tenant-baseline-cutover-v053.md` и
> `docs/implementation-handoffs/P1-B.md`: создай idempotent shared migration
> `054` для private `lead-photos`, переведи delivery на authenticated/signed
> URLs и обнови UI. Проверь новый tenant (bucket уже private) и existing
> internal project (public → private), запрет anonymous reads и показ фото после
> Auth. Не меняй immutable v053 и не начинай P2.
