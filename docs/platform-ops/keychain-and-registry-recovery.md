# Keychain bootstrap and registry recovery

Status: P3-B local owner runbook

This runbook covers only the local operations registry and macOS Keychain
labels. It does not authorize provider writes, raw provider commands, or tenant
reconciliation. Live read-only reconcile begins after the P4 adapters exist.

## Secret boundary

- Run secret bootstrap in a local Terminal, outside an MCP or chat session.
- Never place a value after a CLI flag, in JSON, an environment variable, a
  shell history entry, a redirected file, or a support message.
- The Keychain service is `lh2-platform`.
- Platform accounts use `platform/<secret-name>`.
- Tenant accounts use `tenant/<immutable-slug>/<secret-name>`.
- SQLite and audit store those labels, version, and rotation time only.
- There is no CLI or future MCP secret-read operation.

Supported platform names in P3-B:

- `registry.backup_passphrase`
- `supabase.management_token`
- `vercel.team_token`

Supported tenant names in P3-B:

- `airtable.imports`
- `anthropic.api_key`
- `cron.secret`
- `mcp.secret`
- `notify.secret`
- `slack.briefings`
- `slack.reply_alerts`
- `smtp.password`
- `smtp.username`
- `supabase.database_password`
- `supabase.service_role_key`

## First bootstrap

From `ops/`:

```bash
npm run ops -- registry init
npm run ops -- secrets set --scope platform --name registry.backup_passphrase
npm run ops -- secrets set --scope platform --name supabase.management_token
npm run ops -- secrets set --scope platform --name vercel.team_token
npm run ops -- registry status
```

The terminal prompts without echo. Successful output contains labels and
versions, never values.

## Backup

Store the encrypted artifact on owner-approved media separate from the Mac:

```bash
npm run ops -- registry backup \
  --output ./backups/registry-YYYY-MM-DD.lh2backup
```

The artifact is mode `0600`, includes an authenticated timestamp and ciphertext
digest, and contains no plaintext SQLite pages. The source registry records the
artifact SHA-256 digest and backup time in a new audited transaction. Because
that transaction happens after the consistent SQLite snapshot, it appears in
the source registry and the next backup, not recursively inside the artifact it
describes.

Keep the recovery passphrase independently available. A registry artifact
without that passphrase is intentionally unrecoverable.

## Replacement-Mac recovery

1. Install the pinned P3-B-or-later operations package on the replacement Mac.
2. Copy one approved `.lh2backup` artifact locally.
3. Use the original stable, non-secret owner UUID:

   ```bash
   npm run ops -- registry restore \
     --input /approved/path/registry.lh2backup \
     --owner-id <stable-owner-uuid>
   ```

4. Enter the recovery passphrase at the no-echo prompt. Restore refuses to
   overwrite an existing registry, verifies AES-GCM authentication, SQLite
   integrity, owner UUID, schema version, registry version, and the full
   hash-linked audit chain before installing the file.
5. Revoke and reissue the Supabase Management and Vercel team tokens in their
   provider consoles.
6. Relink the rotated values:

   ```bash
   npm run ops -- secrets set --scope platform --name supabase.management_token
   npm run ops -- secrets set --scope platform --name vercel.team_token
   ```

7. Relink every required tenant credential with its immutable slug. Do not copy
   old secret values merely because their labels exist in the recovered
   registry.
8. Run `registry status` and `registry audit-verify`.
9. After P4 exists, run its read-only deterministic-resource reconcile. It may
   restore unambiguous observed references only. It must not read provider
   secret env values, adopt ambiguous resources, or write provider state.
10. Create a fresh encrypted backup and move it to approved recovery media.

If authentication, integrity, owner UUID, or audit verification fails, retain
the original artifact, do not overwrite the local registry, and investigate
from a copy.
