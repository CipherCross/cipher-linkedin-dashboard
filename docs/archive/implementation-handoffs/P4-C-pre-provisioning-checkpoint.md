# P4-C pre-provisioning implementation checkpoint

Status: **local implementation complete; live P4-C acceptance blocked/incomplete**

Recorded: **2026-07-30**

This checkpoint closes the locally finishable implementation work without
claiming the P4-C acceptance gate. It does not replace the future
`docs/implementation-handoffs/P4-C.md`, which may be written only after the
single disposable tenant passes live end-to-end provisioning and verification.

## Completed scope

- Added reviewed SDK-backed ports for the fixed P4-C Supabase, Vercel, Auth,
  SMTP, domain, and pinned-source operations.
- Composed an explicitly selected `--p4c` runtime for only the disposable
  `p4c-lab` tenant.
- Added fixed same-core CLI entrypoints for `tenant preflight`, `tenant plan`,
  `tenant apply`, `tenant resume`, and `tenant verify`.
- Kept the default MCP startup fail-closed and retained the exact 17-tool
  allowlist and existing tool contract digest.
- Pinned the provider owners, source Git SHA, schema artifacts, release
  compatibility, region/tier/compute/backup catalogs, domains, SMTP identity,
  Production-only environment names, disabled integrations, and complete smoke
  ownership.
- Preserved the required ordering: the complete smoke suite is step 11 and the
  first admin invite is step 12.
- Required an authenticated registry backup before any P4-C apply/resume.
- Fixed macOS Keychain writes so values are supplied through the system
  `security` command's interactive input, never process arguments, and are read
  back and compared immediately. Legacy raw Keychain values remain readable;
  new values use a versioned base64url envelope inside Keychain.
- Added safe provider-stage/status diagnostics without returning provider
  bodies or secret values.
- Added P4-C boundary/order tests and expanded the Keychain security test.
- Recorded the deferred provisioning decision and exact resume gate in
  `docs/platform-ops/p4-c-deferred-provisioning-plan.md`.

## Versions and fixed identities

- `@lh2/platform-ops`: `0.5.0`
- MCP server: `0.3.0`
- MCP tool contract:
  `sha256:7d213fd503eed1d50ff601deff4cbfae608073fdbf0f23a61bc26c0e81e12cc7`
- Disposable tenant slug: `p4c-lab`
- Supabase organization slug: `dzfikwgcfdbgxpejzfnk`
- Vercel team: `team_AB0nAOId1mR7gHxPldsG9f2u`
- Production hostname: `p4c-lab.app.ciphercross.dev`
- SMTP sender: `no-reply@mail.ciphercross.dev`
- Pinned source SHA: `bc780bd5006dee3e59bd7fa6604aded601d682b6`
- Baseline v053 SHA-256:
  `4598326891ceccdd9e2c3f2ea2cfe3d4b75d5696d4178735749bd5709529379d`
- Delta 054 SHA-256:
  `0bec3395c9a8a4108940e30b77cadf0c54422d50ae4b1a0c3cdeab39d3a7fa9d`

New runtime dependencies are `supabase-management-js`,
`@supabase/supabase-js`, `@vercel/sdk`, `nodemailer`, and `isomorphic-git`.

## Verification performed

- Full `ops` build and test suite: **39/39 passed**.
- Pinned frontend production build: passed.
- Confirmed the pinned source commit exists and `frontend/` has no diff from
  that revision.
- `git diff --check`: passed.
- Static review found no child-process, raw fetch/HTTP, environment-variable,
  provider-delete, rollback/down-migration, or arbitrary-payload escape hatch in
  the P4-C runtime boundary.
- Live read-only preflight reached every reviewed provider without creating a
  tenant:
  - provider access, domain, region/residency, SMTP/DNS, release compatibility,
    legal review, and pricing passed;
  - tier capacity and backup coverage blocked as designed because the reviewed
    Supabase organization is not on Pro.

Provider snapshots from that preflight are short-lived and must not be reused.
A future plan requires a completely fresh preflight.

## External and local state

- No Supabase tenant project, Vercel tenant project, environment, deployment,
  tenant domain binding, Auth tenant user, support/admin membership, admin
  invitation, schema application, or SMTP smoke message was created.
- No onboarding plan was generated or approved, and no apply/resume/verify
  operation was started.
- The owner-approved `mail.ciphercross.dev` Resend domain and its Vercel DNS
  records predate the blocked preflight and remain preparatory platform state.
- Platform secret values remain only in macOS Keychain; registry/audit contain
  labels and versions, not values.
- Live registry version at this checkpoint is `16`.
- An authenticated encrypted live-registry backup was created at
  `/Users/mykytashevchenko/Documents/LH2 Platform Ops Backups/p4c-deferred-checkpoint-2026-07-30.lh2backup`
  and confirmed by registry status:
  - created at `2026-07-30T12:07:04.612Z`;
  - digest
    `sha256:1a2fc238abbb3f06e1943e9f07327efd7c588ded19bbe40ef09e95b9e0a2a97a`.
  The backup passphrase remains only in macOS Keychain.

## Unresolved acceptance blockers

1. The required Supabase Pro subscription and seven-day daily-backup coverage
   are unavailable at the owner's current budget.
2. Current organization-wide Supabase pricing and project/compute impact must be
   revalidated before planning.
3. Live `preflight → plan → exact owner approval → apply/resume → verify` has not
   run.
4. Baseline, private Storage, Auth/custom SMTP, Production-only environment,
   domain binding, tenant-specific build/deployment, disabled support
   membership, complete smoke suite, and first admin invite remain unverified
   against a disposable tenant.

A possible Supabase replacement is intentionally not evaluated here. If a
separate migration changes the backend contract, this runtime and resume plan
must be reviewed or superseded rather than applied unchanged.

## Rollback and resume point

The logical rollback point is the parent commit immediately before this
checkpoint. There is no tenant/provider rollback because no tenant provisioning
effect occurred. The preparatory Resend/DNS state is not changed by repository
rollback.

To resume the current Supabase-specific P4-C path, follow
`docs/platform-ops/p4-c-deferred-provisioning-plan.md`. Do not begin P5 or P7 and
do not create `docs/implementation-handoffs/P4-C.md` until the live P4-C gate
passes.

## Prompt for a future Supabase-specific resume

> Продолжи незавершенный P4-C по
> `docs/implementation-handoffs/P4-C-pre-provisioning-checkpoint.md` и
> `docs/platform-ops/p4-c-deferred-provisioning-plan.md`. Сначала проверь, что
> Supabase остается утвержденным backend и обязательный Pro/backup budget
> доступен; затем создай и проверь encrypted registry backup и выполни только
> `preflight → plan → exact owner approval → apply/resume → verify`. Не отправляй
> admin invite до прохождения всех smoke tests и не начинай P5/P7.
