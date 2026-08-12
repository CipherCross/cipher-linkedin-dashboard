# P3-A handoff

Status: **complete**

Acceptance gate: **passed — state, locking, failure-injection, and idempotency
tests pass without real provider credentials or writes**

## Completed scope

- Added the isolated TypeScript/Node.js `ops/` package at version `0.1.0`.
- Implemented strict validation of all P2 onboarding, release, and apply JSON
  Schemas using Draft 2020-12 Ajv validation.
- Implemented RFC 8785-compatible canonical JSON and SHA-256 plan digest checks.
- Added semantic validation for:
  - maximum plan TTL and provider/catalog validity;
  - reserved slugs, deterministic resource names, ownership tags, and owner UUID;
  - approved pinned catalogs and selected catalog entries;
  - consecutive migrations from `054`;
  - provider snapshot drift;
  - integer cost ordering and usage ceilings;
  - tier/capability priced components, capability limits, and secret-label rules;
  - recovery profile/retention references.
- Implemented the SQLite logical registry schema v1:
  - registry metadata and monotonic optimistic version;
  - tenants and immutable slugs;
  - immutable plans;
  - operations and closed operation steps;
  - provider resource references;
  - fencing locks;
  - releases and release targets;
  - capability budgets;
  - recovery profiles;
  - Keychain-label-only secret references;
  - hash-linked append-only audit entries.
- Implemented transaction rules so every successful state-changing transaction
  increments the registry version once, while failed transactions roll back.
- Implemented plan/apply/resume idempotency:
  - same key and digest returns/resumes the same operation;
  - same key with another digest conflicts;
  - a consumed plan cannot be reused under another key;
  - stale registry versions and provider snapshots block apply.
- Implemented expiring locks with monotonically increasing fencing tokens,
  heartbeat support, competing-operation conflicts, and stale-fence rejection.
- Implemented the P2 plan, tenant, operation, and step state machines.
- Added closed Supabase and Vercel provider interfaces which accept typed
  allowlisted inputs and secret labels, never secret values or arbitrary payloads.
- Added deterministic in-memory Supabase/Vercel fakes with failure injection
  before effect, after effect, and with unknown outcome.
- Added a resumable onboarding executor for all 13 ordered effects. Provider
  project, build, and deployment references are persisted before the related step
  succeeds. Admin invite remains unreachable until the smoke step succeeds.
- Added registry artifact/export/log patterns to `.gitignore`.

## Changed files and versions

- Added `ops/package.json`, `ops/package-lock.json`, `ops/tsconfig.json`, and
  `ops/README.md`.
- Added `ops/src/core/` for contracts, semantics, state machines, and onboarding
  execution.
- Added `ops/src/state/` for SQLite schema v1, registry transactions, locks, and
  audit.
- Added `ops/src/providers/` for provider interfaces and fakes.
- Added `ops/test/` for fixtures and acceptance tests.
- Updated `.gitignore` for local ops databases, exports, and logs.
- Added this handoff.
- Operations package version: `0.1.0`.
- SQLite registry schema version: `1`.
- Operations contract remains `p2.v1`; onboarding/release/apply schema versions
  remain `1`.
- No Postgres migration, application API, sync protocol, provider adapter, MCP
  tool, CLI, or secret-storage version changed.

## Verification performed

- Ran `npm test` in `ops/`: **16/16 tests passed**.
- The suite covers:
  - strict nested unknown-field rejection;
  - digest, TTL, catalog, migration, cost, budget, and slug validation;
  - stale registry and provider snapshot rejection;
  - onboarding and release idempotency;
  - consumed-plan and same-key/different-digest conflicts;
  - competing-operation lock conflict with full transaction rollback;
  - fencing-token rotation and stale-fence rejection;
  - before/after/unknown provider failure injection;
  - deterministic reconcile without a duplicate provider project;
  - ordered full onboarding and invite-after-smoke enforcement;
  - durable build reference use after executor restart;
  - capability/recovery row persistence;
  - append-only hash-linked audit;
  - SQLite close/reopen durability.
- Ran `git diff --check` successfully.

## External state

- No Supabase, Vercel, DNS, SMTP, Auth, Storage, Git remote, deployment, or other
  provider resource was read, created, changed, or deleted.
- No production provider credential, Keychain value, secret value, or environment
  value was used.
- The only network access was installation of public npm dependencies for the
  new local package.

## Remaining blockers and risks

- P3-A has no acceptance blocker.
- Live provider adapters do not exist yet; only typed interfaces and deterministic
  fakes exist.
- Keychain integration, no-echo secret bootstrap, comprehensive redaction,
  encrypted registry backup/recovery, and the thin CLI are intentionally deferred
  to P3-B.
- The owner MCP server and provider adapters are intentionally deferred to P4.
- The package currently uses Node's built-in `node:sqlite` API and therefore
  requires Node.js 22.5 or newer. Runtime pinning/distribution must preserve this
  requirement.
- Release apply currently shares validated plan/state/idempotency/lock machinery,
  but canary/fan-out provider orchestration remains the later P7 scope.

## Rollback point

P3-A made no external changes. Repository rollback is removal of `ops/`,
`docs/implementation-handoffs/P3-A.md`, and the six `ops/` ignore patterns added
to `.gitignore`. There is no provider or database rollback.

## Prompt for the next session

> Выполни P3-B по `specs/2026-07-29-managed-company-workspaces.md`, используя
> `docs/platform-ops/operations-contract-v1.md`,
> `docs/implementation-handoffs/P3-A.md` и существующий `ops/` package. Добавь
> macOS Keychain adapter, no-echo secrets CLI, централизованную redaction для
> output/error/audit paths, encrypted registry backup/recovery и thin CLI поверх
> того же operations core. Проведи canary-secret leak tests и replacement-Mac
> recovery rehearsal. Не начинай STDIO MCP и live provider adapters из P4.
