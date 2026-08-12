# P1-C handoff

Status: **complete**

Acceptance gate: **passed — anonymous lead-photo reads are denied and the
authenticated production dashboard renders photos through short-lived signed
URLs**

## Completed scope

- Added idempotent shared migration `054_private_lead_photos.sql`.
- Converged both supported starting states:
  - a new v053 tenant, whose `lead-photos` bucket is already private;
  - the existing internal project, whose bucket was public after migration 042.
- Added one Storage `SELECT` policy limited to `authenticated` users for whom
  `public.is_active_team_member()` is true. The sync agent's service-role upload
  path is unchanged.
- Replaced deterministic `/object/public/lead-photos/...` URLs in the frontend
  with Supabase Storage signed URLs with a five-minute TTL.
- Added path validation, concurrent-request deduplication, expiry-aware caching,
  and cache clearing on logout, user change, invalid claims, inactive membership,
  and password-setup states.
- Preserved initials fallback and fixed avatar dimensions while URL signing or
  image loading is pending.
- Extended the provider-shaped clean-room fixture and tests to exercise active,
  inactive, and anonymous Storage reads for both baseline+delta and full-history
  databases.
- Updated current agent/config/auth documentation from public to private photo
  delivery. Historical specifications and migration 042 were left unchanged.
- Tightened the Docker clean-room mount from the whole repository to the
  read-only `supabase/` directory.

## Changed files and versions

- Added `supabase/migrations/054_private_lead_photos.sql`.
- Added `supabase/tests/private_lead_photos_access.sql`.
- Updated:
  - `supabase/tests/fixtures/provider_bootstrap.sql`;
  - `supabase/tests/tenant_baseline_assertions.sql`;
  - `supabase/tests/tenant_baseline_cleanroom.sh`.
- Added `frontend/src/lib/leadPhotos.ts` and
  `frontend/tests/leadPhotos.test.ts`.
- Updated:
  - `frontend/src/components/Avatar.tsx`;
  - `frontend/src/lib/AuthContext.tsx`;
  - `frontend/src/lib/leads.ts`;
  - `frontend/src/lib/types.ts`;
  - `frontend/tsconfig.tsbuildinfo`.
- Updated `sync-agent/agent.py`, `sync-agent/config.example.yaml`, `AGENTS.md`,
  and `docs/auth-rollout.md`.
- Migration 054 checksum:
  `sha256:0bec3395c9a8a4108940e30b77cadf0c54422d50ae4b1a0c3cdeab39d3a7fa9d`.
- The immutable v053 baseline checksum remains:
  `sha256:4598326891ceccdd9e2c3f2ea2cfe3d4b75d5696d4178735749bd5709529379d`.
- No application schema version, API contract, ingest protocol version, table,
  column, view, or AI schema-document surface changed.

## Verification performed

- Ran `supabase/tests/tenant_baseline_cleanroom.sh` successfully against the
  pinned Supabase PostgreSQL `17.6.1.127` image.
- Applied baseline `053` + shared delta `054` to a provider-shaped empty tenant
  and the complete `001`–`054` history to a second database.
- Verified the normalized public schemas remain identical.
- Verified the bucket is private and the expected authenticated Storage policy
  exists.
- Verified an active authenticated member can read a test photo while an
  inactive member and `anon` receive zero rows.
- Verified the tenant materializer emits exactly `053_tenant_baseline.sql` plus
  `054_private_lead_photos.sql`.
- Verified the immutable v053 checksum did not change.
- Ran frontend tests: 8 files, 40 tests passed.
- Ran the local production build successfully.
- Compiled `sync-agent/agent.py` with `py_compile`.
- Ran `git diff --check`.
- Vercel preview and production builds completed with status `Ready`.
- Opened the production dashboard with an existing authenticated browser
  session. The Leads table produced three private signed photo URLs, zero public
  photo URLs, and at least one visible loaded avatar in the viewport.
- Probed the old anonymous public URL for that same existing object without an
  Auth header; it returned HTTP 400 with JSON instead of image bytes.
- Confirmed the linked Supabase migration ledger matches locally through `054`.

## External state

- Applied migration `054` to the linked internal Supabase project.
- Created preview deployment
  `dpl_GTAsyMsbuzu6FvXqeNLSppt6MDYG`.
- Promoted the verified source to production deployment
  `dpl_E4GJbttPKGrWKEX85w67WnGPfFCY`.
- Production aliases point to the new deployment, including
  `https://cipher-linkedin-dashboard.vercel.app`.
- No Auth users, Storage objects, DNS records, sync-agent releases, Git commits,
  branches, or repository remotes were created or changed.
- No login credentials were entered or copied.

## Remaining blockers and risks

- P1-C has no unresolved acceptance blocker.
- Authenticated production verification used the already signed-in browser
  session. It confirmed actual signed delivery, but did not exercise a second
  member or a freshly invited user in production; those role boundaries are
  covered by the clean-room SQL checks.
- The Vercel build logs contain a non-fatal pre-existing TypeScript diagnostic
  for `api/briefing.ts:277` (`String.replaceAll` and the function compiler's
  library target). The deployment still completed as `Ready`; this is outside
  P1-C but should be removed in a later maintenance change.
- Existing five-minute signed URLs remain usable until their individual expiry
  after a member is deactivated. New URLs are denied immediately by the Storage
  policy, and the frontend clears its cache when membership revalidation fails.

## Rollback point

- Repository rollback is removal of migration 054, the signed-photo frontend,
  tests, and documentation changes.
- External rollback is coordinated: restore the previous production deployment
  `dpl_F7rKRTJoFcGiTPTNXGX5DdLFjWU4`, remove the migration-054 Storage policy,
  and set `lead-photos.public = true`. That rollback reopens anonymous access and
  is therefore a security regression; prefer a forward fix unless the dashboard
  is otherwise unusable.

## Prompt for the next session

> Выполни P2 по `specs/2026-07-29-managed-company-workspaces.md`, используя
> `docs/platform-ops/tenant-baseline-cutover-v053.md` и
> `docs/implementation-handoffs/P1-C.md`: зафиксируй operations/state/cost/
> recovery contracts без production provider writes. Определи plan schemas,
> state transitions, naming/tags, region/tier/SMTP/backup prerequisites,
> capability budgets, RPO/RTO и forbidden/destructive actions. Не начинай
> implementation `ops/`, не меняй production resources и не расширяй P2 до P3.
