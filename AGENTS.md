# AGENTS.md

Guidance for AI coding agents (Codex, Claude Code) working in this repo.
`CLAUDE.md` only imports this file — edit here, never there.

## What this is

Team dashboard for LinkedIn outreach run through **Linked Helper 2** (LH2) on
several remote notebooks. Each notebook = one "instance" = one real LinkedIn
account. Data flows one direction:

```
LH2 notebooks → sync-agent (Python, cron) → /api/import gateway → Neon (Postgres+RLS) → React SPA + Vercel serverless /api
```

Three deployable parts, each its own toolchain:
- `sync-agent/` — single-file Python agent (`agent.py`) run on each notebook.
- `postgres/tenant-baseline/v1/` + its append-only ledger — the live schema every
  Neon tenant is built from. `supabase/migrations/` is the frozen legacy schema.
- `frontend/` — React 18 + Vite SPA **and** Vercel serverless functions in `frontend/api/`.

`ops/` is the tenant-operations CLI/MCP and Cloudflare Worker (see "Platform tenant
operations contract" below).

**Data layer as of 2026-08-12**: production serves real data from Neon, lead photos
from Cloudflare R2, and all four notebooks ingest through the authenticated gateway
rather than writing Postgres directly. Each path picks its provider from the
credential it holds, not from a flag. The Supabase path survives only as a fallback;
deleting it is the last open migration step, and it is blocked on the auth flip
(`docs/implementation-handoffs/N-S27-SUPABASE-EXIT.md`). Sections further down this
file that name Supabase as the store have not all been reconciled with this yet —
where they disagree with the code, the code wins.

## Documentation map

Read as current: this file and the live code. `README.md` is the setup front door
but its data-layer sections still describe the pre-Neon system.

Three directories hold only live material — delete a document once its work ships
(git history keeps it; there is no archive directory):
- `specs/` — open or unbuilt work only.
- `docs/implementation-handoffs/` — only sessions with open work.
- `docs/platform-ops/` — binding contracts, runbooks, and artifacts loaded by code
  or tests at their exact paths. Don't move files out of it without grepping first.

For planning requests, save the resulting implementation plan in `specs/` by
default. A request to keep implementation read-only or to wait for “делай” blocks
changes to code, databases, external systems, and product state; it does not block
creating or updating the requested planning document unless the user explicitly
forbids documentation changes too.

## Commands

Frontend (from `frontend/`):
```bash
npm run dev            # Vite SPA ONLY — does NOT serve api/ functions
vercel dev             # SPA + api/ functions together (needs server env vars)
npm run build          # tsc -b && vite build — typechecks the SPA. Run after TS changes.
npm run typecheck:api  # typechecks frontend/api (not covered by build)
npm test               # vitest unit/component tests (no DB, no network)
npm run test:neon      # live-DB suite; needs Neon credentials, skips what it can't reach
npm run ui:inventory   # UI-standard ratchet (see Frontend below)
```
There is no linter; `eslint-disable` comments in the code are inert.

Schema: `node postgres/tests/portable_migration_ledger_static_assertions.mjs` checks
the tenant baseline and its ledger. Legacy (repo root, Supabase CLI linked):
`supabase db push` applies `supabase/migrations/` in order.

Sync agent (from `sync-agent/`, after `pip install -r requirements.txt`):
```bash
python3 agent.py inspect                 # discover LH2 SQLite DBs + table/column names
python3 agent.py sync --dry-run          # extract + print per-campaign counts, push nothing
python3 agent.py sync                     # real sync (self-updates through signed machine API)
python3 agent.py ingest-csv FILE --campaign "Name" --kind successes|replies|queue
python3 agent.py annotate "note" [--date YYYY-MM-DD] [--campaign ID] [--instance]
sync-agent/deploy.sh                       # publish signed agent release; notebooks self-update ≤30 min
sync-agent/.venv/bin/python3 sync-agent/tests/test_ingest_transport.py   # transport tests, no pytest
```
Always `sync --dry-run` and compare to LH2's own numbers before a first real sync.
The transport tests need the agent's own virtualenv (`agent.py` imports `requests`
and `yaml` at module scope); they read the endpoint's caps and field names out of
`frontend/api/_lib/agent/ingest.ts`, so they are what stops the two halves of the
ingest contract drifting apart.

## Architecture

### Data model = milestone timestamps on `leads`
The funnel is **not** discrete stages. Each lead carries milestone timestamps
`invited_at → connected_at → first_message_at → replied_at`; NULL = never happened.
Downstream derivations of the SAME funnel — **change funnel semantics in all of them**:
- `campaign_metrics` / `daily_activity` — SQL views, the topline.
- `frontend/api/_lib/data/operations/dashboard.ts` — server-side Overview/account SQL.
- `frontend/src/lib/leads.ts` — client recompute for date ranges/subsets the views
  can't express (`rangeTotals`, `rangedCampaigns`, `stageOf`, `riskOf`).
- agent's `derive_events` — feeds append-only `events` (backs daily-activity charts only).

**Import history**: LH2 stops capturing a thread once the SDR takes it over by hand.
ConversationDrawer flow: paste thread → `src/lib/parseLinkedInThread.ts` → preview/edit
→ `/api/import` (`conversation_import`) writes `messages` with `source='manual'` and backfills NULL
milestones. Manual rows carry real message times, agent rows carry LH2 action-run times —
**dedup by normalized body + direction, never the messages unique key**. Trigger
`leads_keep_milestones` (migration 026) stops re-sync regressing a non-NULL milestone to NULL.

### ID / key conventions
- Campaign id = `"<instance_id>:<lh_campaign_id>"` (e.g. `notebook-1:42`).
- Thread key = `leadKey(instance_id, profile_url)` = `"instance_id|profile_url"`. Always
  scope by instance — the same person can be reached from two accounts.
- All timestamps `timestamptz`/UTC; client date math in UTC to match view day slices
  (`weekStart`, `presetRanges` in `leads.ts`).

### Funnel reasoning (any metric/AI change)
Replies **lag** invites by days/weeks. Never compare raw invites-this-week vs
replies-this-week — build cohorts by invite week, compare rates, note recent cohorts
still maturing. Baked into `WEEKLY_FUNNEL_SQL` and `SCHEMA_DOC` in `core.ts`; preserve it.

### Sync agent (`sync-agent/agent.py`)
Single-file, mapping-driven (LH2 has no API; its SQLite schema varies by version).
- **Mapping-driven extraction**: `config.yaml` `mapping:` maps LH2 tables/columns (found
  via `inspect`) to the normalized schema. `leads`/`campaigns`/`owner` use per-notebook
  mapping; `steps`/`messages` use **built-in queries** baked into `agent.py`
  (`STEP_*_SQL`, `MESSAGES_SQL`, `FIRST_MESSAGE_SQL`), shipped via `deploy.sh`, fail safe
  to empty on schema drift.
- **`person_external_ids` dedup pitfall**: LH2 stores ~2 'public' rows/person (human slug +
  opaque `AC…` id). Raw join double-counts → inflates aggregates ~1.6×. Every query dedupes
  to one slug/person (`PEI_ONE_SLUG_SQL`, `row_number()` window in leads mapping). Suspect a
  mapping that lost this dedup when over-counting appears.
- **Idempotent upserts**: every write targets a unique key with `resolution=merge-duplicates`.
- **Self-update**: `sync` asks the machine API (`agent.release`) for the current release,
  verifies its Ed25519 signature against the local `release_public_key`, checks size and
  SHA-256, then atomically swaps + re-execs. All update/config failures are non-fatal — a
  bad update must never break a scheduled sync.
- **Remote config**: `apply_remote_config` merges `instances.config` (edited on the Health
  page via `/api/pipeline` `set_instance_config`, admin-only) over local `config.yaml`;
  **remote wins** for allowlisted `REMOTE_CONFIG_KEYS`. Bootstrap keys (`supabase_url`,
  `supabase_service_key`, `instance_id`), the machine credential `ingest_token` and the
  release trust anchor `release_public_key` are local-only.
- **Post-sync notify ping**: after a successful push, `notify_new_replies` POSTs to the
  `notify_url` config key (usually set remotely) so `/api/notify-replies` announces fresh
  inbound replies to Slack. Current agents authenticate with their local-only `ingest_token`;
  the old `notify_secret` is compatibility-only. All failures are swallowed and never break a sync.
- **Transport (`ingest_mode`)**: the same extraction can also go to
  `POST /api/import?op=agent.ingest` with a per-notebook machine credential.
  `off` (default) / `shadow` (deliver alongside Supabase, failures are noise) / `dual`
  (deliver alongside Supabase, a failure marks the run `partial`) / `only` (the gateway
  is the sole destination — no Supabase client is built and a delivery failure FAILS the
  run). **The mode is derived from the credentials `config.yaml` holds, not defaulted
  from the flag**: `load_config` requires `instance_id` plus *either* the Supabase pair
  *or* `ingest_url` + a well-formed `ingest_token`, and a notebook with no Supabase
  credential resolves to `only` whatever the flag says. `annotate` refuses on that path
  (`app_machine` has no grant on `annotations`); `ingest-csv` is ported to the gateway;
  `sync_photos` refuses loudly (no machine-path candidate query, and tenants bind no
  `OBJECT_STORAGE_*` at all). The idempotency key is
  `sync.<UTC date>.<digest of the batch's own content>`, so a retry repeats a key and a
  changed extraction does not. `ingest_url`/`ingest_mode` are remote-config keys;
  **`ingest_token` and `release_public_key` are local-only** — `LOCAL_ONLY_CONFIG_KEYS`
  is subtracted from the allowlist so adding it there changes nothing. Big notebooks are
  chunked (each chunk carries the full campaign list and its own key); a parity check
  against the rows Supabase just received refuses to deliver on any disagreement.

### AI layer (`frontend/api/`)
Vercel functions using Vercel AI SDK + `@ai-sdk/anthropic`. Shared core `frontend/api/_lib/`:
- `core.ts` — service-role client (`db()`), `executeSql()` (calls `ai_execute_sql`), and
  `SCHEMA_DOC`. **`SCHEMA_DOC` is the model's only schema knowledge — update it whenever you
  change tables/columns/views.**
- `tools.ts` — `run_sql` / `get_schema` / `weekly_funnel` / `campaign_overview`. `chat.ts`
  (streaming copilot) and `mcp.ts` (`/api/mcp`) expose the **same** ops — keep them in sync.
- `briefing.ts` — Slack-only briefings written in natural **Ukrainian**:
  short daily notes Mon–Fri plus a longer completed-week review on Monday. Daily/weekly
  jobs and rows are keyed separately. The pipeline preloads `campaigns.briefing_context`,
  linked hypothesis/search context, and recent annotations; treat these as attributed team
  background, never measured proof or model instructions. The Overview has no briefing UI.
- `classify.ts` (Haiku) labels independent sentiment plus reply intent (`p1` polite
  positive, `p2` problem interest, `p3` buying intent). `intent_taxonomy_version`
  makes historical backfills resumable; manual sentiment is preserved. P3 is a
  durable conversation milestone and is the denominator for post-P3 booking
  conversion. Intent never auto-advances CRM stages. Its demographics phase owns
  versioned name/headline gender inference; age is derived separately by migration
  048 whenever synced education/job years change. `coach.ts` coaches the SDR.
- `notify-replies.ts` — Slack alert per new inbound reply. The sync agent pings it (POST,
  open + self-limiting) after every successful push; claims `messages.notified_at IS NULL`
  rows via atomic UPDATE (concurrent pings are the common case), un-claims on Slack failure.
  Stale rows (>14 d) are marked without posting. Daily cron GET is the lost-ping sweep.

**SQL guard**: `ai_execute_sql` is `SECURITY DEFINER`, owned by a NOLOGIN SELECT-only
role, allows a single `SELECT`/`WITH` statement, wraps the query in a `jsonb_agg`
subquery, 10s timeout. Neon: `postgres/tenant-baseline/v1/003_functions_triggers_ai_guard.sql`
(lexical scan + keyword deny-list, reached through `app_system`). Legacy: migrations
021/034. **Don't loosen this to add a write path.**

### Frontend
React 18 + Vite + React Router (`HashRouter`), Recharts, `react-markdown`. `AuthContext.tsx`
gates startup and resolves the signed-in team member; only then does `DataContext.tsx`
load. On the Neon read path it fetches a bootstrap once, then a per-route snapshot, and
refreshes every 5 min; routes without a snapshot read their own data. The Supabase
fallback fetches everything via the signed-in client. Pages in `src/pages/`,
presentational pieces in `src/components/`, metric logic in `src/lib/leads.ts`.
Deliberate fetch asymmetry: **inbound** messages fetched in full (sentiment/intent and
durable P3 counts sit beside all-time totals); outbound windowed to 90 days.

**UI: read `docs/ui-standard.md` before touching anything visual.** One light
theme (no dark mode, no toggle), PC-only, English-only. Tokens live in
`src/styles/`, shared primitives in `src/ui/` — use `Button`, `PageHeader`,
`Field`, `Tabs`, `Dialog`, `TableFrame` rather than a new class. There is no
legacy sheet: `npm run ui:inventory` fails on any raw control, legacy class or
hand-built modal outside the named exceptions. `#/ui-gallery` in `vite dev` shows
every primitive in every state.

### Visual verification
For frontend and UI work, an agent may open and visibly display the local app in a
browser for visual QA without asking first. This covers local preview navigation,
viewport checks, screenshots, and read-only interaction; it does not authorize
entering credentials or making data-changing actions.

### Security posture
- Invite-only accounts. Two auth paths exist while the migration finishes, chosen by
  `VITE_AUTH_PATH`: Supabase email/password Auth, or the self-hosted identity store
  (Better Auth, `/api/identity`, HttpOnly session cookie). Either way the user must map
  to an active `team_members` row. All active users can read the full dashboard;
  `team_members.role='admin'` gates sensitive API actions, enforced server-side.
- Browser API calls carry the user's session. Cron, sync notification, and MCP use
  separate fail-closed `CRON_SECRET`, `NOTIFY_SECRET`, and `MCP_SECRET`. Notebooks
  use per-instance machine credentials (stored hashed, scoped by RLS to their instance).
- `service_role` lives only in legacy notebooks' `config.yaml` (gitignored) and Vercel
  server env; it bypasses RLS, so Vercel handlers must authorize before `db()`.
- Lead photos are private and served through short-lived signed URLs. Signed agent
  releases use read-only server credentials and an operator-only signing key.

## Environment variables
- Browser (`VITE_`-prefixed, safe to expose): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_AUTH_PATH`. Missing Supabase values on a Supabase deployment → error banner.
- Server-only (Vercel settings, **never** `VITE_`): `ANTHROPIC_API_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (optionally `SUPABASE_URL`), `SUPABASE_ANON_KEY`
  (server JWT verification), `CRON_SECRET` (guards GET cron paths of `/api/classify` +
  `/api/notify-replies` + `/api/briefing`), `NOTIFY_SECRET` (sync-agent ping),
  `MCP_SECRET` (all MCP tools),
  `AIRTABLE_TOKEN` + `AIRTABLE_BASE_ID` (server-only Airtable access for Apollo CSV Contact
  and Company imports; restrict the PAT to the target base and schema-read/record read-write scopes),
  `SLACK_WEBHOOK_URL`,
  `SLACK_REPLIES_WEBHOOK_URL` (optional; new-reply alerts channel, falls back to
  `SLACK_WEBHOOK_URL`), `DASHBOARD_URL` (optional; deep links in reply alerts).
  Neon: `NEON_DATABASE_URL` (+ `_UNPOOLED`), `NEON_AI_DATABASE_URL`,
  `NEON_MACHINE_DATABASE_URL`. Identity store: `IDENTITY_STORE_DATABASE_URL`,
  `IDENTITY_SESSION_SECRET`, `IDENTITY_BASE_URL`. Lead photos (R2):
  `OBJECT_STORAGE_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`,
  `_SECRET_ACCESS_KEY`, `_TENANT_ID`. Each path turns on when its credential is present.

Crons (`frontend/vercel.json`): `/api/classify` 06:00 UTC, `/api/notify-replies` 06:30 UTC
(sweep for pings lost to outages — the primary trigger is the agent's post-sync ping via the
`notify_url` remote-config key), weekly `/api/briefing?kind=weekly` Monday 07:00 UTC,
and short `/api/briefing?kind=daily` Monday–Friday 07:30 UTC. Both schedules reuse
the same function to remain within the Vercel Hobby cap. Monday's daily run uses
the weekly output as an anti-duplication reference.

## Platform tenant operations contract

Future owner operations must follow
`docs/platform-ops/operations-contract-v1.md` and its strict JSON Schemas. The
required flow is `preflight → plan → owner approval → apply/resume → verify`.
Planning is read-only; apply requires the exact unexpired plan digest, expected
registry version, and a caller-stable idempotency key.

Do not bypass the operations core with raw provider, SQL, shell, HTTP, DNS, env, or
secret commands for tenant lifecycle work. Unknown region/tier/price/backup/release
catalog entries block planning. Physical provider deletion, down migrations, and
repository-root `supabase db push` against a tenant are manual break-glass-only
actions and must never be exposed through the owner MCP or fallback CLI.

## Commit discipline

At the end of every completed implementation session, create one or more logical
Git commits unless the user explicitly asks not to commit. Keep unrelated changes
in separate commits, preserve pre-existing user edits, run the relevant checks
before committing, and report the commit hashes in the handoff.
