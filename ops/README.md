# Platform operations core

Owner-local operations package for the managed workspace control plane.

P3-A provides the strict plan/apply contract, SQLite registry and audit,
state/idempotency/locking core, typed provider boundaries, and deterministic
provider fakes.

P3-B adds:

- a macOS Keychain adapter whose secret-write process arguments contain labels
  only; the value is supplied through the system `security` command's
  interactive input using a versioned base64url envelope and verified
  immediately after storage;
- a closed secret-name catalog and deterministic
  `lh2-platform/{platform|tenant/...}` Keychain labels;
- interactive no-echo secret bootstrap with label/version-only registry and
  audit rows;
- central redaction for provider responses, errors, audit data, registry error
  columns, and CLI JSON;
- authenticated encrypted registry backup and fail-closed restore using
  AES-256-GCM with a scrypt-derived key;
- a thin `lh2-ops` CLI over the same registry, secret, recovery, and operation
  core.

P4-A adds an owner-only local STDIO MCP adapter over the same registry and
plan/apply core. It publishes a closed 17-tool allowlist with strict input/output
schemas, server instructions, write/destructive annotations, redacted results,
and a tool-contract digest.

P4-B adds strict Supabase, Vercel, Auth, SMTP, domain, and source-revision
adapters over narrow typed control-plane ports. It also adds read-only provider
preflight/snapshots, deterministic disposable-tenant dry-run planning, and a
one-step-at-a-time resumable onboarding core wired to the existing MCP schemas.
P4-C adds the explicitly selected `--p4c` runtime. It composes reviewed
Supabase Management, Supabase JS, Vercel, SMTP, and local Git SDK-backed ports
for exactly one disposable tenant, `p4c-lab`. The runtime pins the provider
owners, domains, region/tier/compute/backup catalog, immutable v053 baseline,
054 delta, source SHA, Production-only environment names, disabled integration
budgets, and complete smoke ownership. The default MCP startup remains
provider-free and fail-closed. `--p4c` and the S26-only
`--s26 --s26-config /absolute/path/to/config.json` selectors are mutually
exclusive. The S26 configuration contains approved non-secret provider scopes,
catalogs, profile data, HTTPS bases, and Keychain label names only.

The Supabase-era P4-C provisioning path was never completed and **must not be
resumed**; it was superseded by the `--s26` runtime, which has since onboarded a
real tenant (`uitop`) end to end against live Neon, Vercel and Resend. The two
checkpoint documents for the abandoned path are archived at
[`P4-C-pre-provisioning-checkpoint.md`](../docs/archive/implementation-handoffs/P4-C-pre-provisioning-checkpoint.md)
and
[`p4-c-deferred-provisioning-plan.md`](../docs/archive/platform-ops/p4-c-deferred-provisioning-plan.md).

Requires Node.js 22.5 or newer because it uses the built-in `node:sqlite` API.

```bash
npm install
npm test
```

## CLI

Build once, then invoke `lh2-ops` through npm:

```bash
npm run ops -- registry init
npm run ops -- registry status
npm run ops -- secrets set --scope platform --name registry.backup_passphrase
npm run ops -- secrets set --scope platform --name supabase.management_token
npm run ops -- secrets set --scope platform --name vercel.team_token
npm run ops -- secrets set --scope platform --name smtp.username
npm run ops -- secrets set --scope platform --name smtp.password
npm run ops -- registry backup --output ./backups/registry.lh2backup
npm run ops -- tenant preflight
npm run ops -- tenant plan
```

The default registry lives at:

```text
~/Library/Application Support/LH2 Platform Ops/registry.sqlite
```

Secret values are never accepted through arguments, environment variables,
JSON, stdin redirection, or output. `secrets set` requires an interactive TTY
and reads without terminal echo. The CLI has no secret-read command.

For recovery and token rotation, follow
[`docs/platform-ops/keychain-and-registry-recovery.md`](../docs/platform-ops/keychain-and-registry-recovery.md).

## Owner MCP

The built entrypoint is:

```text
dist/src/mcp/main.js
```

It accepts an optional registry path and an explicit provider runtime selector:

```bash
node dist/src/mcp/main.js --registry "/absolute/path/registry.sqlite" --p4c
node dist/src/mcp/main.js --registry "/absolute/path/registry.sqlite" --s26 --s26-config "/absolute/path/s26-owner-runtime.json"
```

STDOUT is reserved for MCP protocol messages. Errors are redacted and written to
STDERR. The server has no HTTP transport, remote listener, environment forwarding,
secret read, raw command/query/request, provider delete, migration repair, or down
migration surface.

Follow
[`docs/platform-ops/local-owner-mcp.md`](../docs/platform-ops/local-owner-mcp.md)
for the user-global Codex allowlist and approval policy. Provider-dependent tools
without an explicit provider runtime fail closed. The P4-B library binds
`tenant_preflight`, `tenant_plan_onboarding`, `tenant_apply_onboarding`, and
`tenant_resume_operation` to the fixed P4-A schemas without adding tools. P4-C
uses those same tools and schemas; it does not widen the 17-tool MCP allowlist or
its contract digest.
