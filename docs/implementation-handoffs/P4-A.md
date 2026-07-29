# P4-A handoff

Status: **complete**

Acceptance gate: **passed — the local STDIO server exposes only the reviewed
17-tool allowlist; every root and nested input/output object is closed; read,
write, and reversible-destructive annotations plus the Codex `writes` approval
policy are verified**

## Completed scope

- Added the owner-only local STDIO MCP server using the official TypeScript MCP
  SDK. It has no HTTP transport or network listener.
- Added cross-tool server instructions enforcing
  `preflight → plan → owner review/approval → apply/resume → verify` and stating
  that instructions/annotations are not authorization.
- Added strict Zod input and output schemas for all owner tools named by the
  platform spec. Unknown root or nested properties are rejected.
- Added a single machine-readable tool allowlist and policy catalog with
  `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`.
- Marked `machine_revoke`, `support_access_disable`, and `tenant_suspend` as
  destructive because they remove access, even though their effects are
  reversible and cannot delete provider resources.
- Added the Codex approval policy contract:
  `default_tools_approval_mode = "writes"` plus explicit per-tool `prompt`
  overrides for the three destructive tools.
- Added a deterministic SHA-256 tool-contract digest over names, annotations,
  and generated input/output JSON Schemas. Every successful result returns the
  server version and digest; writes fail closed on a mismatch before reaching
  the registry core.
- Added the registry-backed MCP adapter for tenant list/get, operation status,
  and onboarding apply/resume. Apply/resume calls the existing registry
  plan/digest/version/idempotency/snapshot core and records actor `owner-mcp`.
- Added allowlisted tenant, operation, step-error, and resource-reference read
  methods to `Registry`; no MCP code reads SQLite through the test-only escape
  hatch.
- Provider-dependent P4-B and later capabilities fail closed with
  `unsupported_contract`; P4-A contains no live provider adapter or fallback
  effect.
- Added the user-global Codex setup runbook with a pinned absolute server
  command, complete `enabled_tools`, timeouts, no credentials/env forwarding,
  and approval overrides. No user-global config was changed by this session.

## Tool contract

- Read-only:
  `tenant_list`, `tenant_get`, `tenant_preflight`,
  `tenant_plan_onboarding`, `tenant_drift`, `operation_get`, `release_plan`,
  `tenant_prepare_offboarding`.
- Approval-gated writes:
  `tenant_apply_onboarding`, `tenant_resume_operation`, `admin_invite`,
  `machine_enrollment_create`, `machine_revoke`, `support_access_enable`,
  `support_access_disable`, `tenant_suspend`, `release_apply`.
- Destructive-marked reversible writes:
  `machine_revoke`, `support_access_disable`, `tenant_suspend`.
- Tool contract digest:
  `sha256:7d213fd503eed1d50ff601deff4cbfae608073fdbf0f23a61bc26c0e81e12cc7`.

There are no raw shell, SQL, HTTP, DNS, env read/set, arbitrary provider payload,
secret read/return, provider delete, migration repair, or down-migration tools.

## Changed files and versions

- Added `ops/src/mcp/adapter.ts`, `main.ts`, `policy.ts`, `schemas.ts`, and
  `server.ts`.
- Added `ops/test/mcp.test.ts`.
- Added `ops/src/state/location.ts` and extended
  `ops/src/state/registry.ts` with safe structured read methods.
- Updated `ops/src/cli/cli.ts` to share the registry location/owner lookup.
- Updated `ops/src/index.ts`, `ops/package.json`, and `ops/package-lock.json`.
- Added `docs/platform-ops/local-owner-mcp.md`.
- Updated `ops/README.md`.
- Operations package version: `0.3.0`.
- MCP SDK/server and test client version: `2.0.0`.
- Operations contract remains `p2.v1`.
- Onboarding/release/apply schema versions remain `1`.
- SQLite registry schema remains version `1`.
- No Postgres migration, frontend API, sync protocol, provider adapter, or
  tenant deployment changed.

## Verification performed

- Ran `npm test` in `ops/`: **31/31 tests passed**.
- P4-A coverage verifies:
  - real local STDIO child-process handshake;
  - exact 17-tool allowlist and server instructions;
  - closed root and nested input/output JSON Schemas;
  - exact read/write/destructive/idempotent annotations;
  - `writes` default and destructive per-tool prompt policy, including
    machine-checked parity with the setup runbook;
  - absence of dangerous tool names and arbitrary
    command/query/URL/payload/secret-value input fields;
  - rejection of unknown input properties before dispatch;
  - matching tool-contract digest on writes;
  - delegation to existing registry apply/idempotency behavior;
  - zero provider references created by P4-A apply/start;
  - fail-closed P4-B capabilities without live provider calls.
- Existing P3-A/P3-B provider-fake, failure-injection, state, idempotency,
  redaction, Keychain, recovery, CLI, and schema tests remain green.
- Ran `git diff --check`: passed.

## External state

- No Supabase, Vercel, DNS, SMTP, Auth, Storage, Git remote, deployment,
  production registry, or production Keychain item was read or changed.
- No credential or secret value was used.
- No network listener or remote MCP transport was created.
- The owner's `~/.codex/config.toml` was not changed.
- Tests use in-memory or temporary SQLite registries and a local STDIO child
  process only.
- The official MCP SDK packages were downloaded into the ignored local
  `ops/node_modules` and pinned in `ops/package-lock.json`.

## Remaining blockers and risks

- Live Supabase/Vercel/Auth/SMTP/domain read/write adapters and provider snapshot
  reconcile do not exist. They are P4-B scope.
- `tenant_preflight`, `tenant_plan_onboarding`, `tenant_drift`,
  `release_plan`, offboarding planning, invitation, enrollment, revoke,
  support, suspend, and release execution return `unsupported_contract` until
  their owning operations-core phase is implemented.
- The production STDIO adapter intentionally supplies no provider snapshots;
  therefore onboarding apply fails closed on snapshot validation until P4-B
  injects the approved read-only snapshot capability.
- The setup runbook must be applied manually to an immutable reviewed release
  path on the trusted owner Mac. P4-A does not install or enable itself.
- MCP annotations and Codex prompts remain defense in depth, not authorization.
  The operations core must continue to enforce plan, digest, registry version,
  drift, state, lock, and idempotency rules server-side.

## Rollback point

P4-A made no external provider changes. Repository rollback is removal of this
P4-A commit: delete `ops/src/mcp/`, its tests and setup/handoff docs; restore the
P3-B package, registry/CLI/index files, and package version `0.2.0`. The registry
schema does not require a down migration.

## Prompt for the next session

> Выполни P4-B по `specs/2026-07-29-managed-company-workspaces.md`, используя
> `docs/platform-ops/operations-contract-v1.md`,
> `docs/implementation-handoffs/P4-A.md` и существующий `ops/` package.
> Реализуй только строгие Supabase/Vercel/Auth/SMTP/domain provider adapters,
> read-only provider preflight/snapshots и resumable onboarding core для
> disposable tenant с детерминированным dry-run plan и failure injection.
> Подключи их к уже зафиксированным MCP schemas без расширения tool allowlist.
> Не создавай live external tenant, не добавляй raw shell/SQL/HTTP/env/DNS,
> secret-read, provider-delete, migration-repair или down-migration paths и не
> начинай end-to-end provisioning из P4-C.
