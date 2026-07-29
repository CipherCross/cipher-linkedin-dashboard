# P3-B handoff

Status: **complete**

Acceptance gate: **passed — canary secrets stay out of process arguments,
provider success/error outputs, registry, audit, CLI JSON, and encrypted
artifacts; replacement-Mac recovery rehearsal passes**

## Completed scope

- Added centralized value-aware and structured-key redaction.
- Applied the redaction boundary to plans/apply inputs, provider responses,
  provider errors, resource references, operation/step errors, audit detail,
  and CLI output/errors.
- Provider responses containing a registered secret now fail closed before a
  resource reference or step result is committed.
- Added a macOS Keychain adapter using deterministic service/account labels.
  Secret values are written through the final `security -w` prompt input and
  never appear in process arguments.
- Added a closed platform/tenant secret-name catalog.
- Added interactive raw-TTY secret input with no terminal echo and no
  non-interactive fallback.
- Added secret-reference rotation/version persistence and audit. Only labels,
  names, version, and rotation time are stored.
- Added dependency-injected in-memory Keychain and command-runner fakes.
- Added consistent SQLite snapshot backup encrypted with AES-256-GCM and a
  scrypt-derived key, atomic mode-0600 artifact installation, SHA-256 artifact
  metadata, and audited source-registry backup metadata.
- Added fail-closed restore into a new path with authenticated decryption,
  owner/schema/version checks, SQLite integrity verification, and audit-chain
  verification.
- Added the thin `lh2-ops` CLI for registry init/status/audit, no-echo secret
  set/check, encrypted backup/restore, operation get, and core
  start/resume.
- Added the Keychain/bootstrap and replacement-Mac recovery runbook.

## Changed files and versions

- Added `ops/src/core/redaction.ts`.
- Added `ops/src/secrets/` for closed names, Keychain access, no-echo input,
  bootstrap/rotation, and test doubles.
- Added `ops/src/recovery/backup.ts`.
- Added `ops/src/cli/`.
- Extended `ops/src/state/registry.ts` with redaction, secret-reference,
  snapshot, and backup-metadata operations.
- Hardened `ops/src/core/onboarding-executor.ts` around provider response/error
  boundaries.
- Added `ops/test/security.test.ts` and `ops/test/recovery.test.ts`.
- Added `docs/platform-ops/keychain-and-registry-recovery.md`.
- Added backup artifact patterns to `.gitignore`.
- Operations package version: `0.2.0`.
- SQLite registry schema remains version `1`.
- Operations contract remains `p2.v1`; onboarding/release/apply schemas remain
  version `1`.
- No Postgres migration, application API, sync protocol, provider adapter, or
  MCP version changed.

## Verification performed

- Ran `npm test` in `ops/`: **21/21 tests passed**.
- Canary coverage includes:
  - macOS Keychain process arguments;
  - provider error message and details;
  - provider success/resource fields;
  - operation and step error columns;
  - resource references and audit rows;
  - CLI stdout/stderr;
  - raw SQLite bytes;
  - encrypted backup bytes.
- Recovery rehearsal covers a consistent registry backup, source backup
  metadata, replacement-path restore, wrong-passphrase rejection, overwrite
  refusal, owner/schema/version/SQLite/audit checks, and no-echo-style relinking
  of a backup passphrase plus rotated Supabase/Vercel tokens.
- Existing P3-A state, lock, idempotency, failure-injection, and provider tests
  remain green.

## External state

- No Supabase, Vercel, DNS, SMTP, Auth, Storage, Git remote, deployment, or
  production Keychain item was read, created, changed, or deleted.
- No real credential or secret value was used.
- Tests use temporary SQLite files, encrypted artifacts, in-memory secret
  stores, and a recording Keychain command runner.

## Remaining blockers and risks

- Live Supabase/Vercel/Auth/SMTP/domain adapters and read-only provider reconcile
  do not exist yet; they are P4 scope.
- The owner STDIO MCP server, tool schemas/annotations, and approval policy do
  not exist yet; they are P4-A scope.
- Replacement-Mac rehearsal is automated against isolated local artifacts and
  fake Keychain storage. A real disaster-recovery drill with rotated provider
  tokens remains a production-readiness activity once P4 adapters exist.
- The package still requires Node.js 22.5 or newer.

## Rollback point

P3-B made no external changes. Repository rollback is removal of the P3-B
modules/tests/runbook/handoff, restoring the P3-A registry/executor/index/package
files, and removing the two new backup ignore patterns.

## Prompt for the next session

> Выполни P4-A по `specs/2026-07-29-managed-company-workspaces.md`, используя
> `docs/platform-ops/operations-contract-v1.md`,
> `docs/implementation-handoffs/P3-B.md` и существующий `ops/` package. Добавь
> локальный STDIO MCP server как тонкий adapter над тем же operations core,
> строгие input/output schemas, server instructions, tool allowlist и корректные
> read-only/write/destructive annotations с approval policy. Не добавляй raw
> shell/SQL/HTTP/env/DNS, secret-read, provider-delete или down-migration tools и
> не начинай live provider adapters из P4-B.
