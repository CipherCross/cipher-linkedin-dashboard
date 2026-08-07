# AGENTS.md

Guidance for Codex working in this repo.

## What this is

Team dashboard for LinkedIn outreach run through **Linked Helper 2** (LH2) on
several remote notebooks. Each notebook = one "instance" = one real LinkedIn
account. Data flows one direction:

```
LH2 notebooks → sync-agent (Python, cron) → Supabase (Postgres+RLS) → React SPA + Vercel serverless /api
```

Three deployable parts, each its own toolchain:
- `sync-agent/` — single-file Python agent (`agent.py`) run on each notebook.
- `supabase/migrations/` — sequential numbered SQL: schema + views + RLS + AI SQL guard.
- `frontend/` — React 18 + Vite SPA **and** Vercel serverless functions in `frontend/api/`.

## Commands

Frontend (from `frontend/`):
```bash
npm run dev      # Vite SPA ONLY — does NOT serve api/ functions
vercel dev       # SPA + api/ functions together (needs server env vars)
npm run build    # tsc -b && vite build — the ONLY typecheck; no lint, no tests. Run after TS changes.
```

Schema (repo root, Supabase CLI linked): `supabase db push` applies migrations in order.

Sync agent (from `sync-agent/`, after `pip install -r requirements.txt`):
```bash
python3 agent.py inspect                 # discover LH2 SQLite DBs + table/column names
python3 agent.py sync --dry-run          # extract + print per-campaign counts, push nothing
python3 agent.py sync                     # real sync (self-updates through signed machine API)
python3 agent.py ingest-csv FILE --campaign "Name" --kind successes|replies|queue
python3 agent.py annotate "note" [--date YYYY-MM-DD] [--campaign ID] [--instance]
sync-agent/deploy.sh                       # publish signed agent release; notebooks self-update ≤30 min
```
Always `sync --dry-run` and compare to LH2's own numbers before a first real sync.

## Architecture

### Data model = milestone timestamps on `leads`
The funnel is **not** discrete stages. Each lead carries milestone timestamps
`invited_at → connected_at → first_message_at → replied_at`; NULL = never happened.
Downstream derivations of the SAME funnel — **change funnel semantics in all three**:
- `campaign_metrics` / `daily_activity` — SQL views in `001_init.sql`, the topline.
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
- **Self-update**: `sync` downloads `agent.py` from private `agent` bucket, atomically swaps +
  re-execs on hash change. All update/config failures are non-fatal — a bad update must never
  break a scheduled sync.
- **Remote config**: `apply_remote_config` merges `instances.config` (edited on Health page via
  `/api/config`) over local `config.yaml`; **remote wins** for allowlisted `REMOTE_CONFIG_KEYS`.
  Bootstrap keys (`supabase_url`, `supabase_service_key`, `instance_id`) and
  the machine credential `ingest_token` and release trust anchor `release_public_key` are local-only.
- **Post-sync notify ping**: after a successful push, `notify_new_replies` POSTs to the
  `notify_url` config key (usually set remotely) so `/api/notify-replies` announces fresh
  inbound replies to Slack. Current agents authenticate with their local-only `ingest_token`;
  the old `notify_secret` is compatibility-only. All failures are swallowed and never break a sync.

### AI layer (`frontend/api/`)
Vercel functions using Vercel AI SDK + `@ai-sdk/anthropic`. Shared core `frontend/api/_lib/`:
- `core.ts` — service-role client (`db()`), `executeSql()` (calls `ai_execute_sql` RPC), and
  `SCHEMA_DOC`. **`SCHEMA_DOC` is the model's only schema knowledge — update it whenever you
  change tables/columns/views.**
- `tools.ts` — `run_sql` / `get_schema` / `weekly_funnel` / `campaign_overview`. `chat.ts`
  (streaming copilot) and `mcp.ts` (`/api/mcp`) expose the **same** ops — keep them in sync.
- `briefing.ts` — Slack-only briefings written in natural **Ukrainian** with Opus 5:
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

**SQL guard**: `ai_execute_sql` (migration 021) is `SECURITY DEFINER`, owned by NOLOGIN
SELECT-only role `ai_sql_runner`, allows only `SELECT`/`WITH`, wraps query in `jsonb_agg`
subquery, 10s timeout, service-role-only. **Don't loosen this to add a write path.**

### Frontend
React 18 + Vite + React Router (`HashRouter`), Recharts, `react-markdown`. `AuthContext.tsx`
gates startup and links the Supabase session to `team_members`; only then does `DataContext.tsx`
fetch everything once + every 5 min via the signed-in client. Pages in
`src/pages/`, presentational pieces in `src/components/`, metric logic in `src/lib/leads.ts`.
Deliberate fetch asymmetry: **inbound** messages fetched in full (paginated past PostgREST's
1000-row cap, since sentiment/intent and durable P3 counts sit beside all-time totals);
outbound windowed to 90 days.

### Visual verification
For frontend and UI work, Codex may automatically open and visibly display the local app
in the in-app browser for visual QA without asking first. This permission covers local
preview navigation, responsive viewport checks, screenshots, and read-only interaction;
it does not authorize entering credentials or making data-changing actions.

### Security posture
- Invite-only Supabase email/password Auth. An Auth user must be linked through
  `team_members.auth_user_id` and active. All active users can read the full
  dashboard; `team_members.role='admin'` gates sensitive API actions.
- Browser API calls use the user's bearer JWT. Cron, sync notification, and MCP
  use separate fail-closed `CRON_SECRET`, `NOTIFY_SECRET`, and `MCP_SECRET`.
- `service_role` lives only in notebooks' `config.yaml` (gitignored) and Vercel
  server env; it bypasses RLS, so Vercel handlers must authorize before `db()`.
- `lead-photos` is private; active authenticated members receive short-lived
  signed URLs through Storage RLS. Signed agent releases live in a separate
  private bucket with read-only server credentials and an operator-only signing key.

## Environment variables
- Browser (`VITE_`-prefixed, safe to expose): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
  Missing → dashboard shows error banner.
- Server-only (Vercel settings, **never** `VITE_`): `ANTHROPIC_API_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (optionally `SUPABASE_URL`), `CRON_SECRET` (guards GET cron paths
  of `/api/classify` + `/api/notify-replies` + `/api/briefing`),
  `SUPABASE_ANON_KEY` (server JWT verification), `NOTIFY_SECRET` (sync-agent ping),
  `MCP_SECRET` (all MCP tools),
  `AIRTABLE_TOKEN` + `AIRTABLE_BASE_ID` (server-only Airtable access for Apollo CSV Contact
  and Company imports; restrict the PAT to the target base and schema-read/record read-write scopes),
  `SLACK_WEBHOOK_URL`,
  `SLACK_REPLIES_WEBHOOK_URL` (optional; new-reply alerts channel, falls back to
  `SLACK_WEBHOOK_URL`), `DASHBOARD_URL` (optional; deep links in reply alerts).

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
