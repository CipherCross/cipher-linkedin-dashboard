# Local owner MCP setup

Status: **P4-C local-only setup; live provisioning deferred**

The owner operations MCP is a local STDIO process. It does not listen on a
network port, does not ship with tenant deployments, and does not accept
credentials through MCP arguments, Codex configuration, environment variables,
or tool results.

The server is a thin adapter over the same `Registry` and plan/apply core used by
`lh2-ops`. Its operations contract is `p2.v1`; the P4-A package version is `0.3.0`.

## Build and pin the trusted server

Use Node.js 22.5 or newer. Check out a reviewed Git SHA into an owner-controlled,
non-writable-by-clients release directory, then run:

```bash
cd <TRUSTED_RELEASE_DIRECTORY>/ops
npm ci
npm test
```

Do not point Codex at a mutable worktree or use `npx`. Record the reviewed Git SHA,
the absolute Node executable, the built `dist/src/mcp/main.js` path, and the tool
contract digest from the accepted implementation handoff. Any schema or annotation
change changes that digest and requires a new review.

The default registry remains:

```text
~/Library/Application Support/LH2 Platform Ops/registry.sqlite
```

Initialize it and bootstrap/rotate secrets only through the no-echo CLI described
in [keychain-and-registry-recovery.md](keychain-and-registry-recovery.md). The MCP
has no secret-set or secret-read tool.

## User-global Codex configuration

Add the server only to the owner's user-global `~/.codex/config.toml`. Do not add
it to repository `.codex/config.toml`, because a project checkout must not be able
to replace the owner control-plane command or policy.

Replace every placeholder with an absolute reviewed path. This configuration
contains no credentials:

```toml
[mcp_servers.lh2_owner_ops]
command = "<ABSOLUTE_NODE_22_EXECUTABLE>"
args = [
  "<ABSOLUTE_TRUSTED_RELEASE>/ops/dist/src/mcp/main.js",
  "--registry",
  "<ABSOLUTE_REGISTRY_PATH>",
  "--p4c",
]
enabled = true
required = true
startup_timeout_sec = 15
tool_timeout_sec = 120
default_tools_approval_mode = "writes"
enabled_tools = [
  "tenant_list",
  "tenant_get",
  "tenant_preflight",
  "tenant_plan_onboarding",
  "tenant_drift",
  "operation_get",
  "release_plan",
  "tenant_prepare_offboarding",
  "tenant_apply_onboarding",
  "tenant_resume_operation",
  "admin_invite",
  "machine_enrollment_create",
  "machine_revoke",
  "support_access_enable",
  "support_access_disable",
  "tenant_suspend",
  "release_apply",
]

[mcp_servers.lh2_owner_ops.tools.machine_revoke]
approval_mode = "prompt"

[mcp_servers.lh2_owner_ops.tools.support_access_disable]
approval_mode = "prompt"

[mcp_servers.lh2_owner_ops.tools.tenant_suspend]
approval_mode = "prompt"
```

`writes` prompts for every tool whose MCP annotation is not read-only. The three
reversible access-removal tools are additionally marked destructive and have
explicit per-tool `prompt` overrides. Annotations and Codex approval are defense
in depth; the operations core still requires an unexpired blocker-free plan,
matching plan and tool-contract digests, current registry version, provider
snapshot match, and a caller-stable idempotency key.

Do not add `env`, `env_vars`, HTTP URL, bearer token, or OAuth configuration to
this local server. The process reads only the local registry path fixed by its
startup arguments. Provider and tenant credentials remain in macOS Keychain under
closed labels.

Codex documents `enabled_tools`, `default_tools_approval_mode = "writes"`, and
per-tool `approval_mode` for local MCP servers in its
[MCP configuration reference](https://learn.chatgpt.com/docs/extend/mcp#configure-with-configtoml).

## Required operator workflow

The server instructions and repository contract require:

```text
preflight
→ plan
→ show the owner digest, effects, blockers, prerequisites, and cost
→ owner approval
→ apply or resume with the same idempotency key
→ operation_get and tenant_get verification
```

Before approving a write, compare `meta.server_version` and
`meta.tool_contract_digest` from a read-only result with the accepted release
record. A write repeats both values and fails closed if the digest differs.

Never use raw provider, SQL, shell, HTTP, DNS, environment, secret, migration
repair/down, or provider-delete commands as a fallback for tenant lifecycle
operations. Physical deletion remains a separate manual break-glass procedure
outside the MCP and operations core.

## P4-C disposable runtime boundary

P4-B keeps the complete P4-A owner tool contract unchanged and adds strict
Supabase, Vercel, Auth, SMTP, domain, and source-revision adapter libraries plus
disposable onboarding preflight/plan/apply/resume. The adapters accept only
closed typed requests and responses.

The local registry-backed tools (`tenant_list`, `tenant_get`, `operation_get`)
work without provider access. The built STDIO entrypoint remains fail-closed by
default. Passing the fixed `--p4c` startup selector composes reviewed SDK-backed
ports for only `p4c-lab`, its pinned provider owners, domains, catalogs, schema
artifacts, release SHA, environment names, disabled integrations, and smoke
suite. It reads credentials only from closed macOS Keychain labels.

P4-C does not add an MCP tool, change a schema, or accept a provider payload.
Release, enrollment, external-company, support-enable, suspension, deletion,
migration repair/down, raw provider, and other later-phase effects remain
unavailable. There is no fallback external effect.

Live provisioning is currently `blocked/incomplete`, not accepted. The
2026-07-30 read-only preflight passed provider access, domain, region/residency,
SMTP/DNS, release compatibility, legal review, and pricing, but correctly
blocked tier capacity and backup coverage because the reviewed Supabase
organization is not on Pro and the owner has deferred that recurring cost. No
tenant resource or admin invitation was created. Resume conditions and the
mandatory `preflight → plan → owner approval → apply/resume → verify` sequence
are recorded in
[p4-c-deferred-provisioning-plan.md](p4-c-deferred-provisioning-plan.md).
The locally completed implementation scope and remaining live gate are recorded
separately in
[P4-C-pre-provisioning-checkpoint.md](../implementation-handoffs/P4-C-pre-provisioning-checkpoint.md).

## Acceptance check

After restarting Codex:

1. Inspect `/mcp` and confirm only `lh2_owner_ops` with the 17 allowlisted tools.
2. Call `tenant_list {}` and compare server version and tool-contract digest with
   the accepted handoff.
3. Confirm an unknown input property is rejected.
4. Confirm packaged `tenant_preflight` fails with `unsupported_contract`
   without `--p4c`, and performs only read-only inspection with `--p4c`.
5. Confirm a mutating call produces a Codex approval prompt.
6. Confirm `machine_revoke`, `support_access_disable`, and `tenant_suspend` are
   shown as destructive and require an explicit prompt.

The automated `ops/test/mcp.test.ts` suite performs the schema, metadata,
annotation, allowlist, digest, idempotency, no-provider, and real STDIO handshake
checks. `ops/test/p4b.test.ts` additionally covers deterministic provider
snapshots/plans, strict adapter output validation, MCP onboarding wiring, and
failure/resume after every provider effect. Neither suite reads a production
Keychain item or calls a live provider. `ops/test/p4c.test.ts` checks the closed
SDK surface, single-disposable scope, Production-only/disabled-integration plan,
complete smoke ownership, and invite-after-smoke ordering.
