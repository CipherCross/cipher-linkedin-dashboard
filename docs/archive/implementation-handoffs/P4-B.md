# P4-B handoff

Status: **complete**

Acceptance gate: **passed — the disposable onboarding dry-run is deterministic;
read-only provider snapshots are drift-checked; injected failure after every
provider effect quarantines the tenant and resumes to success without duplicate
Supabase/Vercel projects or a duplicate admin invite**

## Completed scope

- Added strict Supabase, Vercel, Auth, SMTP, domain, and source-revision adapters
  over narrow typed control-plane ports.
- Adapter inputs contain only allowlisted business/resource fields and Keychain
  labels. Adapter outputs are runtime-validated as closed objects and are
  redacted before crossing the provider boundary.
- Added read-only preflight across the five contract snapshot kinds:
  `supabase`, `vercel`, `dns`, `smtp`, and `source_repository`.
- Provider snapshots contain only allowlisted observations, deterministic
  SHA-256 digests, bounded validity, and no raw response or secret value.
- Added the nine required onboarding prerequisites and fail-closed blockers for
  provider access, naming, domain, residency, tier/capacity, SMTP/DNS, backup,
  release compatibility, legal review, and pricing.
- Added a deterministic disposable-tenant planner:
  - fixed resource names, tenant UUID, cron slot, ownership markers, and hostname;
  - pinned catalogs, Git SHA, baseline/deltas, versions, effects, costs, budgets,
    recovery profile, Auth/SMTP policy, and smoke-test gates;
  - identical inputs, catalogs, provider snapshots, and clock produce an
    identical spec and plan digest;
  - repeat planning reuses the same current-registry plan instead of storing a
    duplicate.
- Added a disposable-only resumable onboarding core. Each MCP apply/resume call
  advances at most one of the fixed 13 steps and returns control for
  `operation_get`.
- Split Auth, SMTP, private Storage, and domain effects into their owning strict
  adapters while preserving the fixed 13-step contract.
- Hardened resume from a failed smoke step so `quarantined → verifying` is not
  followed by an invalid duplicate `verifying → verifying` transition.
- Revalidates provider snapshots, including current validity through the plan
  expiry, before every apply/resume attempt.
- Made fake provider effects idempotent by deterministic intent, including
  support membership, domain binding, build/deploy, smoke checks, and company
  admin invite.
- Wired `tenant_preflight`, `tenant_plan_onboarding`,
  `tenant_apply_onboarding`, and `tenant_resume_operation` to the new core
  through the already-reviewed MCP schemas.
- Kept the exact 17-tool allowlist, annotations, server instructions, schemas,
  and tool-contract digest unchanged.
- Kept the packaged STDIO entrypoint fail-closed: no provider runtime or
  credential is installed automatically. P4-C must explicitly compose reviewed
  provider SDK ports before any end-to-end disposable provisioning.

## Security and scope boundary

- No live Supabase, Vercel, Auth, SMTP, DNS, source repository, deployment, or
  tenant was read or changed.
- No provider credential, Keychain value, secret value, environment value, or
  admin invitation was used.
- No raw shell, SQL, HTTP, DNS, environment read/set, arbitrary provider payload,
  secret-read/return, provider-delete, migration-repair, or down-migration path
  was added.
- There is no automatic cleanup, delete, rollback, or random-suffix adoption.
- The P4-B apply core rejects non-disposable/non-canary plans.
- Release orchestration, machine enrollment, support/suspend effects, and
  end-to-end provisioning remain outside this session.

## Changed files and versions

- Added `ops/src/providers/adapters.ts`.
- Expanded `ops/src/providers/interfaces.ts` with the closed provider ports and
  split provider capabilities.
- Added `ops/src/core/provider-preflight.ts`,
  `ops/src/core/onboarding-planner.ts`, and
  `ops/src/core/onboarding-core.ts`.
- Extended `ops/src/core/onboarding-executor.ts`,
  `ops/src/core/semantic-validation.ts`, and
  `ops/src/state/registry.ts`.
- Connected the core in `ops/src/mcp/adapter.ts`; the MCP schema definitions and
  policy shape are unchanged.
- Extended deterministic provider fakes and existing provider/security fixtures.
- Added `ops/test/p4b.test.ts`.
- Updated `ops/README.md` and `docs/platform-ops/local-owner-mcp.md`.
- Operations package version: `0.4.0`.
- MCP server/schema version remains `0.3.0`.
- MCP tool-contract digest remains
  `sha256:7d213fd503eed1d50ff601deff4cbfae608073fdbf0f23a61bc26c0e81e12cc7`.
- Operations contract remains `p2.v1`.
- Onboarding/release/apply schema versions remain `1`.
- SQLite registry schema remains version `1`.

## Verification performed

- Ran `npm test` in `ops/`: **36/36 tests passed**.
- P4-B coverage verifies:
  - no raw or destructive execution path in the new adapter/core sources;
  - strict rejection of an unknown provider response field;
  - read-only preflight leaves registry and provider resources unchanged;
  - deterministic dry-run spec and digest;
  - exactly five provider snapshots and nine prerequisites;
  - unchanged MCP tool-contract digest and schemas;
  - idempotent repeated planning;
  - one-step-at-a-time MCP apply through all 13 steps;
  - failure injection after every one of 17 provider effects;
  - `failed/quarantined` state before reviewed resume;
  - no duplicate Supabase/Vercel project or company-admin invite after resume;
  - audit-chain integrity after every failure/resume scenario.
- Existing P3/P4-A registry, locking, idempotency, redaction, recovery, CLI, MCP,
  and real STDIO handshake coverage remains green.
- Ran `git diff --check` successfully.

## External state

No external provider, network, tenant, deployment, DNS record, Auth user, SMTP
message, Keychain item, or environment configuration was accessed or changed.
All P4-B acceptance runs used in-memory provider ports and temporary/in-memory
SQLite state.

## Remaining P4-C work

- Implement and review the actual provider SDK-backed ports without widening the
  typed adapter boundary.
- Explicitly compose the packaged STDIO runtime with Keychain-backed credentials.
- Provision one internal/disposable tenant end to end.
- Apply the immutable baseline and shared deltas, configure private Storage,
  Auth/SMTP, Production-only env, domain, tenant-specific build/deployment,
  support/admin bootstrap, and the full smoke suite.
- Verify no invite is sent before every required smoke gate passes.

P4-C must not add external-company provisioning, raw provider escape hatches,
provider deletion, migration repair/down, or any release/machine work owned by
later phases.

## Rollback point

P4-B made no external changes. Repository rollback is removal of the P4-B
adapter/preflight/planner/core/test/handoff files and restoration of the modified
`ops` interfaces, executor, registry, MCP adapter, fakes, documentation, and
package version to P4-A. There is no provider or tenant rollback.

## Prompt for the next session

> Выполни P4-C по `specs/2026-07-29-managed-company-workspaces.md`, используя
> `docs/platform-ops/operations-contract-v1.md`,
> `docs/implementation-handoffs/P4-B.md` и существующий `ops/` package.
> Реализуй reviewed SDK-backed provider ports и проведи end-to-end provisioning
> только одного disposable tenant через зафиксированный
> `preflight → plan → approval → apply/resume → verify` flow. Проверь baseline,
> private Storage, Auth/custom SMTP, Production-only env, domain, tenant-specific
> build/deployment, disabled support membership, smoke suite и первый admin invite.
> Не создавай внешнюю компанию, не расширяй MCP allowlist и не добавляй raw
> shell/SQL/HTTP/env/DNS, secret-read, provider-delete, migration-repair или
> down-migration paths; не начинай P5/P7.
