# LinkedIn Campaign Dashboard

Team dashboard for LinkedIn outreach run through **Linked Helper 2** (LH2) on
several notebooks — one notebook per real LinkedIn account, each one an
"instance". A sync agent on every notebook reads LH2's local database and sends it
to an authenticated ingest gateway; a React SPA and Vercel serverless functions
serve it back to the team, with an AI copilot and Slack briefings on top.

```
LH2 notebooks → sync-agent (Python, every 30 min) → POST /api/import?op=agent.ingest
             → Neon (Postgres + RLS) → Vercel /api + React SPA     (lead photos: private R2)
```

A notebook never holds a database credential: it authenticates with a token issued
for that one notebook, and database policies decide what it may write.

The same repo runs the owner's deployment and **managed tenants**, each with its
own Neon project, Vercel deployment and machine credentials, provisioned by the
control plane in `ops/`.

## Components

| Path | What it is |
|---|---|
| `frontend/` | React 18 + Vite SPA **and** the Vercel functions in `frontend/api/` |
| `sync-agent/` | Single-file Python agent (`agent.py`), its installers and release tooling |
| `postgres/tenant-baseline/v1/` | The schema every database is built from, plus an append-only ledger |
| `ops/` | Owner-local tenant control plane (CLI, STDIO MCP, Cloudflare Worker) |

## Local development

```bash
cd frontend
npm install
npm run dev             # SPA only — does NOT serve api/
vercel dev              # SPA + api/ functions together (needs server env vars)
npm run build           # tsc -b && vite build — typechecks the SPA
npm run typecheck:api   # typechecks api/ (not covered by build)
npm test                # vitest, offline
npm run ui:inventory    # UI-standard ratchet; read docs/ui-standard.md first
```

Copy `frontend/.env.example` to `.env` for `vercel dev`; it lists every variable.

## Notebook setup

Non-technical users install the agent with the bundled installers
(`sync-agent/install-macos.command`, `sync-agent/install-windows.cmd`; bundles
built by `sync-agent/installer/build-bundles.py`). The installer is two-phase: it
first runs a read-only check and report, and sends data only after a separate
`activate`. The step-by-step guide is `docs/tenant-onboarding/notebook onboarding.md`.

Each notebook needs an `instance_id` and its own machine credential
(`ingest_url` + an `lha.` `ingest_token`), minted by an admin through
`POST /api/identity?op=admin.agentCredentialIssue` — the plaintext is shown once.
`sync-agent/config.example.yaml` documents every other key.

Manual setup, from `sync-agent/`:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp config.example.yaml config.yaml         # set instance_id, ingest_url, ingest_token
.venv/bin/python agent.py inspect          # list LH2 databases, tables and columns
.venv/bin/python agent.py sync --dry-run   # extract and print per-campaign counts, send nothing
.venv/bin/python agent.py sync             # real sync
.venv/bin/python agent.py ingest-csv export.csv --campaign "Name" --kind successes
```

**Always dry-run first** and compare per-campaign invited/accepted/replied counts
with LH2's own numbers. An invited count ~1.6× too high means the leads mapping
lost its `person_external_ids` one-slug-per-person dedup.

After the first sync most settings (label, account display, `sync_*` toggles, the
LH2 mapping, `notify_url`) can be edited per notebook on the **Health** page
(**Configure**, admin only); remote values win over `config.yaml`.
`instance_id`, `ingest_token` and `release_public_key` stay local-only.

## Agent releases

Notebooks self-update through a signed release channel: before each sync the agent
fetches the current release via `GET /api/import?op=agent.release`, verifies its
Ed25519 signature against the local `release_public_key`, checks size and
SHA-256, and swaps itself atomically. Any failure keeps the current version and
the sync proceeds.

To ship a change: bump `AGENT_VERSION` in `agent.py` and commit; repoint
`sync-agent/installer/release.json` at that commit (version, commit, raw URL,
sha256, bytes) and push; then, with the operator credentials loaded, run
`sync-agent/deploy.sh`. Notebooks pick it up within 30 minutes; watch
`agent_version` on the Health page. The runbook, including why you roll back by
rolling forward, is `docs/platform-ops/agent-release-channel.md`.

## Schema

Every database is built from `postgres/tenant-baseline/v1/` by the ledger tool,
which records each applied step with its SHA-256:

```bash
LEDGER_DB=<database> node postgres/tools/portable_migration_ledger.mjs status|apply|verify
node postgres/tests/portable_migration_ledger_static_assertions.mjs   # from the repo root
```

The ledger is append-only: never edit an applied step, add a new one. There are no
down migrations. Read `postgres/tenant-baseline/v1/README.md` before changing it.

## Environment variables

Set on the Vercel project; server values must **never** carry a `VITE_` prefix.
`frontend/.env.example` lists every name. In short:

- **Neon**: `NEON_DATABASE_URL` (+ `_UNPOOLED`), `NEON_AI_DATABASE_URL` (AI and
  crons), `NEON_MACHINE_DATABASE_URL` (ingest gateway).
- **Identity**: `IDENTITY_STORE_DATABASE_URL`, `IDENTITY_SESSION_SECRET`,
  `IDENTITY_BASE_URL`; `RESEND_API_KEY` + `RESEND_FROM_IDENTITY` to deliver
  invite and reset mail.
- **Photos (R2)**: `OBJECT_STORAGE_*`; without them photos fall back to initials.
- **Agent releases**: read-scoped `AGENT_RELEASE_*`. **Tenancy**: `APP_TENANT_ID`.
- **Secrets**: `CRON_SECRET`, `NOTIFY_SECRET`, `MCP_SECRET` — each fails closed.
- **Integrations**: `ANTHROPIC_API_KEY`, `SLACK_WEBHOOK_URL`
  (`SLACK_REPLIES_WEBHOOK_URL`, `DASHBOARD_URL` optional), `AIRTABLE_TOKEN` +
  `AIRTABLE_BASE_ID` for CSV import.

A missing Neon or identity credential fails with a named 500, never a silent
fallback. Crons (`frontend/vercel.json`): `/api/classify` 06:00 UTC,
`/api/notify-replies` 06:30 UTC, `/api/briefing?kind=weekly` Monday 07:00 UTC,
`/api/briefing?kind=daily` Mon–Fri 07:30 UTC. `frontend/api/` holds exactly 12
functions, the Vercel Hobby cap — adding one means merging another.

## Pages

- **Main**: Overview, Sequences, Follow-ups, Replies, Pipeline, Leads, CSV Import
  (admin), Chat (AI copilot over read-only SQL).
- **Strategy**: Review, Sentiment Analysis, Playbook, Searches.
- **Administration**: Team, Health (sync runs, freshness, per-notebook Configure).
- Drill-downs: `/campaign/:id`, `/account/:id`. ICP and Hypotheses are still routed
  but off the navigation.

Topline numbers come from server-side SQL; range- and subset-specific numbers are
recomputed client-side in `frontend/src/lib/leads.ts`. Reply sentiment and
P1/P2/P3 intent are labelled by the team, not by a model.

## Security posture

- **Invite-only sign-in** through the self-hosted identity store (Better Auth,
  HttpOnly session cookie). A user must map to an active `team_members` row;
  `role='admin'` gates sensitive actions and is enforced server-side.
- **Reads are actor-scoped.** Every Neon transaction sets the actor and RLS
  decides what it sees; handlers resolve the actor before any query.
- **Notebooks use per-instance machine credentials**, stored hashed and
  re-checked (revocation, expiry, tenant) on every request.
- **Machine secrets fail closed**: `CRON_SECRET`, `NOTIFY_SECRET` and
  `MCP_SECRET` answer 500 when unset and 401 on mismatch.
- **The AI runs SELECT-only SQL** through `ai_execute_sql`
  (`postgres/tenant-baseline/v1/003_functions_triggers_ai_guard.sql`). Don't
  loosen it to add a write path.
- **Lead photos are private**, served as short-lived signed URLs. Agent releases
  are signed by an operator-only key; the dashboard holds only a read credential.
- Tenant lifecycle work follows `docs/platform-ops/operations-contract-v1.md`
  (`preflight → plan → owner approval → apply/resume → verify`), never raw
  provider, SQL or secret commands.

## Tests

```bash
cd frontend && npm test && npm run typecheck:api && npm run build
cd frontend && npm run test:neon       # live Neon; source a credential file under set -a first
cd ops && npm test
node postgres/tests/portable_migration_ledger_static_assertions.mjs   # from the repo root
sync-agent/.venv/bin/python3 sync-agent/tests/test_ingest_transport.py
sync-agent/.venv/bin/python3 sync-agent/tests/test_installers.py
```

There is no linter. `test:neon` writes to a shared project seeded with fixtures,
so never assume an empty table. Agent developer guidance lives in `AGENTS.md`.
