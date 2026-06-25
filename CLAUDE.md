# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Team dashboard for LinkedIn outreach run through **Linked Helper 2** (LH2) on
several remote notebooks. Each notebook is an "instance" = one real LinkedIn
account. Data flows one direction:

```
LH2 notebooks → sync-agent (Python, cron) → Supabase (Postgres+RLS) → React SPA + Vercel serverless /api
```

Three deployable parts, each with its own toolchain:
- `sync-agent/` — Python agent (`agent.py`, single file) run on each notebook.
- `supabase/migrations/` — sequential numbered SQL; the schema + views + RLS + AI SQL guard.
- `frontend/` — React 18 + Vite SPA **and** Vercel serverless functions in `frontend/api/`.

## Commands

All frontend commands run from `frontend/`:

```bash
npm install
npm run dev      # Vite dev server — SPA ONLY, does NOT serve api/ functions
vercel dev       # run the SPA + the api/ serverless functions together (needs server env vars)
npm run build    # tsc -b && vite build — this is also the only typecheck (no separate lint step)
npm run preview
```

There are **no tests and no linter** in this repo. `npm run build` (the `tsc -b`
step) is the type-check gate; run it after changing TypeScript.

Supabase schema (from repo root, with the Supabase CLI linked):

```bash
supabase db push                 # apply migrations/*.sql in order
```

Sync agent (from `sync-agent/`, after `pip install -r requirements.txt`):

```bash
python3 agent.py inspect                 # discover LH2 SQLite DBs + print table/column names
python3 agent.py sync --dry-run          # extract + print per-campaign counts, push nothing
python3 agent.py sync                     # real sync (also self-updates from the storage bucket first)
python3 agent.py ingest-csv FILE --campaign "Name" --kind successes|replies|queue
python3 agent.py annotate "note" [--date YYYY-MM-DD] [--campaign ID] [--instance]
sync-agent/deploy.sh                       # publish agent.py to the 'agent' storage bucket; notebooks self-update ≤30 min
```

Always run `sync --dry-run` and compare counts to LH2's own numbers before a first real sync.

## Architecture

### The data model is milestone timestamps on `leads`
The funnel is **not** stored as discrete stages. Each lead row carries milestone
timestamps — `invited_at → connected_at → first_message_at → replied_at` — and a
NULL means that milestone never happened. Everything downstream derives from
these four columns:
- `campaign_metrics` / `daily_activity` (SQL views in `001_init.sql`) — the
  topline numbers, so every client gets identical figures.
- `frontend/src/lib/leads.ts` — client-side recomputation of the same funnel from
  the raw `leads` table, scoped to date ranges / subsets the views can't express
  (`rangeTotals`, `rangedCampaigns`, `stageOf`, `riskOf`). **This logic mirrors
  the SQL views and the agent's `derive_events` — when you change funnel
  semantics, change all three.**
- `events` is append-only and derived from the same milestones (`derive_events`);
  it backs the daily-activity charts only.

### ID and key conventions
- Campaign id = `"<instance_id>:<lh_campaign_id>"` (e.g. `notebook-1:42`). Built
  everywhere a campaign is written.
- A lead's conversation thread key = `leadKey(instance_id, profile_url)` =
  `"instance_id|profile_url"`. `profile_url` is near-unique but always scope by
  instance too — the same person can be reached from two accounts.
- All timestamps are `timestamptz`/UTC; client date math is done in UTC to match
  the view's day slices (`weekStart`, `presetRanges` in `leads.ts`).

### Reasoning about the funnel (matters for any metric/AI change)
Replies **lag** invites by days/weeks. Never compare raw invites-this-week vs
replies-this-week — build cohorts by invite week and compare rates, noting recent
cohorts are still maturing. This is baked into `WEEKLY_FUNNEL_SQL` and the AI
`SCHEMA_DOC` guidance in `core.ts`; preserve it.

### Sync agent (`sync-agent/agent.py`)
Single-file, mapping-driven because LH2 has no API and its on-disk SQLite schema
varies by version. Key behaviors:
- **Mapping-driven extraction**: `config.yaml`'s `mapping:` maps LH2 tables/columns
  (found via `inspect`) to the normalized schema. `leads`/`campaigns`/`owner` use
  per-notebook mapping; `steps` and `messages` use **built-in queries** baked into
  `agent.py` (`STEP_*_SQL`, `MESSAGES_SQL`, `FIRST_MESSAGE_SQL`) that ship via
  `deploy.sh` — no per-notebook config, and they fail safe to empty on schema drift.
- **`person_external_ids` dedup pitfall**: LH2 stores ~2 'public' rows per person
  (human slug + opaque `AC…` id). Joining it raw double-counts every person and
  inflates aggregates ~1.6×. Every query that touches it dedupes to one slug per
  person (`PEI_ONE_SLUG_SQL`, and the `row_number()` window in the leads mapping).
  When over-counting appears, suspect a mapping that lost this dedup.
- **Idempotent upserts**: every write targets a unique key with
  `resolution=merge-duplicates`; rerunning a sync is always safe.
- **Self-update**: `sync` downloads `agent.py` from the private `agent` storage
  bucket and atomically swaps + re-execs if the hash differs. All update/config
  failures are non-fatal — a bad update must never break a scheduled sync.
- **Remote config**: `apply_remote_config` merges the `instances.config` blob
  (edited on the Health page, written by `/api/config`) over local `config.yaml`;
  **remote wins** for the allowlisted `REMOTE_CONFIG_KEYS`. Bootstrap keys
  (`supabase_url`, `supabase_service_key`, `instance_id`) are local-only.

### AI layer (`frontend/api/`)
All AI endpoints are Vercel functions using the Vercel AI SDK + `@ai-sdk/anthropic`.
The shared core is `frontend/api/_lib/`:
- `core.ts` — the service-role Supabase client (`db()`), `executeSql()` (calls the
  `ai_execute_sql` RPC), and `SCHEMA_DOC` (the schema description the models reason
  over). **`SCHEMA_DOC` is the model's only knowledge of the schema — update it
  whenever you change tables/columns/views.**
- `tools.ts` — the `run_sql` / `get_schema` / `weekly_funnel` / `campaign_overview`
  tools. `chat.ts` (streaming copilot) and `mcp.ts` (MCP server at `/api/mcp`)
  expose the **same** operations — keep the two surfaces in sync.
- `briefing.ts` — the Morning Briefing: reuses the same agentic SQL loop as chat
  to investigate, then a second model coerces it into a schema, stores one row/day
  in `briefings`, and posts to Slack. Output is written in **Ukrainian** by design.
- `classify.ts` (Haiku) labels inbound reply sentiment; `coach.ts` coaches the SDR
  per conversation; both only touch unprocessed rows so they're cheap/idempotent.

**SQL guard**: AI SQL never runs arbitrary statements. `ai_execute_sql` (see
`migrations/021_…`) is `SECURITY DEFINER`, owned by a NOLOGIN SELECT-only role
(`ai_sql_runner`), allows only `SELECT`/`WITH`, wraps the query in a
`jsonb_agg` subquery, and has a 10s timeout. Only the service-role key may call it.
Don't loosen this to add a write path.

### Frontend
React 18 + Vite + React Router (`HashRouter`), Recharts, `react-markdown`.
`DataContext.tsx` fetches everything once (and every 5 min) through the anon
Supabase client and provides it via `useData()`. Pages are in `src/pages/`,
presentational pieces in `src/components/`, all metric logic in `src/lib/leads.ts`.
Note the deliberate fetch asymmetry in `DataContext`: **inbound** messages are
fetched in full (paginated past PostgREST's 1000-row cap) because sentiment counts
sit beside all-time totals; outbound is windowed to 90 days.

### Security posture (current)
- The dashboard is read-only-open: anon key + RLS `using (true)`. Tightening to
  authenticated-only is a known, deferred step — **do not flag missing auth on the
  AI/api endpoints as a bug**; it's tracked separately.
- The `service_role` key lives only in notebooks' `config.yaml` (gitignored) and
  Vercel server env. `service_role` bypasses RLS — that's how all writes happen.

## Environment variables
- Browser (must be prefixed `VITE_`, safe to expose): `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`. Without them the dashboard shows an error banner.
- Server-only (Vercel project settings, **never** `VITE_`-prefixed):
  `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (optionally `SUPABASE_URL`),
  `CRON_SECRET` (guards the GET cron paths of `/api/classify` + `/api/briefing`),
  `ADMIN_SECRET` (guards writes to `/api/config` + `/api/playbook`),
  `SLACK_WEBHOOK_URL` (delivers the briefing to Slack).

Crons (`frontend/vercel.json`): `/api/classify` at 06:00 UTC, `/api/briefing` at
07:00 UTC (after classify, so replies are already sentiment-labelled).
