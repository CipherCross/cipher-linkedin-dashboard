# Platform operations core

Owner-local operations package for the managed workspace control plane.

P3-A provides the strict plan/apply contract, SQLite registry and audit,
state/idempotency/locking core, typed provider boundaries, and deterministic
provider fakes.

P3-B adds:

- a macOS Keychain adapter whose secret-write process arguments contain labels
  only; the value is supplied to the final `security -w` prompt over standard
  input;
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

There is deliberately no live provider adapter or MCP server yet.

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
npm run ops -- registry backup --output ./backups/registry.lh2backup
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
