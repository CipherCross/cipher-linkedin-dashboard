# P1-A handoff

Status: **complete**

Acceptance gate: **passed — schema/internal inventory and cutover v053 fixed**

## Completed scope

- Audited every historical migration from `001_init.sql` through
  `053_fix_follow_up_advisory_lock_key.sql`.
- Fixed `053` as the immutable tenant baseline cutover and `054` as the first
  shared delta.
- Approved the tenant schema object inventory, empty-data contract, final RLS and
  AI grant surface, and Storage differences.
- Classified every migration as final schema, superseded transition, historical
  repair, internal cleanup or internal seed.
- Approved extraction of the final `Web 2 Mob` state to an internal-only seed.
- Explicitly excluded the `agent` bucket, internal notebook cleanup and all
  business rows from tenant bootstrap.

The authoritative decision is
[`docs/platform-ops/tenant-baseline-cutover-v053.md`](../platform-ops/tenant-baseline-cutover-v053.md).

## Changed files and versions

- Added `docs/platform-ops/tenant-baseline-cutover-v053.md`.
- Added this P1-A handoff.
- No SQL migration, schema, application or protocol version changed.
- Cutover source revision:
  `5adb6f6c7127b1be6da0c6edf6e31c90cf9199c9`.
- Audited catalog digest:
  `sha256:3acf60b2abc36eb9e701c0e92256ac32596986ee284df77117dcd0310227ff4b`.

## Verification performed

- Enumerated all 53 migration files and reviewed DDL/DML, seeds, cleanups,
  backfills, views, functions, triggers, policies, roles, grants and Storage
  bucket changes.
- Cross-checked the final protected table and view inventories against migrations
  051–052.
- Cross-checked the current function/trigger inventory and migration 053's
  corrected advisory-lock implementation.
- Verified from application code that an empty `playbook` table is supported:
  reads use `maybeSingle()` and the first save upserts the singleton.
- Confirmed the local source revision and deterministic historical catalog digest.
- Reviewed current Supabase CLI baseline/squash semantics. A live linked-project
  migration-list check could not run because no Supabase access token was present;
  no unprovided credential was used.

## External state

No Supabase, Vercel, Auth, Storage, DNS or other external resource was changed.

## Remaining blockers and risks

- P1-B must compare the generated baseline with a live/current schema dump or a
  clean full-history database; static migration audit alone cannot prove absence
  of remote dashboard drift.
- P1-B must verify the internal project's migration ledger contains `001`–`053`
  before publishing v053.
- Supabase schema squash omits DML, including Storage bucket metadata. The P1-B
  artifact must add only the approved private `lead-photos` metadata and must keep
  all business tables empty.
- P1-C remains responsible for signed/authenticated photo delivery and for
  migrating the existing internal bucket from public to private.

## Rollback point

Documentation-only change. Rollback is removal of the two P1-A documents; no
database or runtime rollback is required.

## Prompt for the next session

> Выполни P1-B по `specs/2026-07-29-managed-company-workspaces.md` и строго по
> `docs/platform-ops/tenant-baseline-cutover-v053.md`: создай immutable v053
> schema-only baseline, migration-ledger contract, internal-only Web 2 Mob seed и
> clean-room tests. Не начинай P1-C и не меняй production resources. Проверь
> baseline + deltas на пустой disposable DB, отсутствие internal markers, private
> lead-photos, отсутствие agent bucket, RLS/grants/SECURITY DEFINER и schema diff.
