# LinkedIn Campaign Dashboard

Team dashboard for LinkedIn outreach run through **Linked Helper 2** on 3
remote notebooks (3 instances under one LH2 account). Each notebook syncs its
local LH2 data into **Supabase**; a React frontend computes and displays the
campaign metrics.

```
notebook 1 ─┐  sync-agent (cron)
notebook 2 ─┼──────────────────────▶  Supabase (Postgres + REST + RLS)
notebook 3 ─┘   service-role key            │ anon key, read-only
                                            ▼
                                   frontend (React + Vite)
                          KPIs · funnel per campaign · daily activity
                                 · per-instance sync health
```

## Components

| Path | What it is |
|---|---|
| `supabase/migrations/001_init.sql` | Schema: `instances`, `campaigns`, `leads`, `events`, `sync_runs` + `campaign_metrics` / `daily_activity` views + RLS |
| `sync-agent/` | Python agent run on each notebook (`inspect` / `sync` / `ingest-csv`) |
| `frontend/` | Dashboard (React 18, Vite, TypeScript, Recharts, supabase-js) |

## Setup

### 1. Supabase (once)

1. Create a project at supabase.com.
2. Open the SQL editor and run `supabase/migrations/001_init.sql`
   (or `supabase db push` with the CLI).
3. Note two keys from **Settings → API**: `anon` (frontend) and
   `service_role` (sync agent only — keep it off the frontend).

### 2. Sync agent (on each of the 3 notebooks)

```bash
cd sync-agent
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp config.example.yaml config.yaml   # edit: keys, unique instance_id per notebook
.venv/bin/python agent.py sync --dry-run   # extract + print counts, push nothing
.venv/bin/python agent.py sync             # first real sync
```

The agent auto-discovers the LH2 database (`linked-helper-account-*-main/lh.db`,
most recently active account wins and is printed). Always run `--dry-run`
first and compare the per-campaign invited/accepted/replied counts against
LH2's own numbers — only then schedule the real sync. If the counts look
wrong, `agent.py inspect` prints every table/column to adjust the mapping.

When rolling out to additional notebooks with the same LH2 version, copy a
proven `config.yaml` and change only `instance_id` / `instance_label` —
the mapping and auto-discovery transfer as-is.

Linked Helper 2 has **no public API** and its on-disk format varies by
version, so the agent supports two extraction paths:

- **Direct DB read** — if `inspect` finds SQLite files, copy the printed
  table/column names into the `mapping:` section of `config.yaml`, then run
  `agent.py sync`. The DB is opened read-only; LH2 can keep running.
- **CSV export** (always works) — in LH2 export a campaign's people list
  (Queue / Successes / Replied) to CSV, then:

  ```bash
  .venv/bin/python agent.py ingest-csv export.csv --campaign "SaaS Founders US" --kind successes
  ```

Both paths upsert idempotently — rerunning is always safe. Schedule `sync`
(cron example, every 30 min):

```cron
*/30 * * * * cd /path/to/sync-agent && .venv/bin/python agent.py sync >> sync.log 2>&1
```

On Windows notebooks use Task Scheduler with the same command.

#### Deploying agent updates (no manual copying)

The agent **self-updates**: at the start of every scheduled `sync` it
downloads `agent.py` from the private `agent` storage bucket, swaps itself
out if the hash differs, and re-runs. To roll out a change to all notebooks:

```bash
sync-agent/deploy.sh    # uploads agent.py; notebooks update within 30 min
```

Watch the rollout on the dashboard's **Health** page (each instance reports
its `agent_version`). Failures are safe: if the bucket is unreachable or the
download looks wrong, the agent keeps running its current version. Pin a
notebook with `auto_update: false` in its config.yaml. Only the
service-role key can read the bucket — the anon key gets a 4xx.

#### Configuring notebooks online (no SSH)

After the first sync you rarely need to touch a notebook's `config.yaml` again.
Only the three **bootstrap** keys (`supabase_url`, `supabase_service_key`,
`instance_id`) must live locally; everything else — the label, the displayed
LinkedIn account (`account_*`), the `sync_*` toggles, `lh2_db_path`, even the LH2
`mapping` SQL — can be edited from the dashboard's **Health** page (Accounts
panel → **Configure**). Those overrides are stored in `instances.config`; the
agent fetches and merges them over the local file on every sync and **remote
wins**, so changes apply on the next run (≤30 min). Set `ADMIN_SECRET` on Vercel
to require a secret for saves. Recovery: a bad online value only breaks that one
notebook's sync (the error shows on Health), and `ignore_remote_config: true` in
its local `config.yaml` pins it to the file, ignoring the online overrides.

### 3. Frontend

```bash
cd frontend
npm install
cp .env.example .env    # set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev             # local
npm run build           # production bundle in dist/
```

Without `.env` the dashboard shows an error banner and no data — both
variables are required. Deploy `dist/` anywhere static (Vercel, Netlify,
Cloudflare Pages); the anon key is safe to expose because RLS only allows
reads.

### 4. AI chat + MCP layer

The **Chat** page lets you ask Claude analytical questions ("why did the
invite spike not produce replies?"); it answers by running read-only SQL
against Supabase through tools. The same tools are exposed as an MCP server
for external clients (Claude Desktop / Claude Code).

- `supabase/migrations/008_ai_readonly_sql.sql` — `ai_execute_sql(query)` RPC:
  SELECT/WITH only, runs as a select-only role, 10s timeout, callable only
  with the service-role key. Apply with `supabase db push`.
- `frontend/api/chat.ts` — streaming chat endpoint (Vercel AI SDK +
  `claude-opus-4-8`, multi-step tool use).
- `frontend/api/mcp.ts` — MCP server at `https://<deployment>/api/mcp`
  (Streamable HTTP) with `run_sql`, `get_schema`, `weekly_funnel`,
  `campaign_overview`.
- `frontend/api/classify.ts` — reply classifier (`claude-haiku-4-5`): labels
  each inbound reply on two independent dimensions: sentiment (`positive` /
  `neutral` / `negative` / `objection` / `referral` / `auto`) and commercial
  intent (`P1` polite positive / `P2` problem interest / `P3` buying intent).
  The taxonomy version is stored even when intent is null, making the historical
  backfill resumable and idempotent. Manual sentiment corrections are preserved.
  Runs daily via the `vercel.json` cron and on demand from the Leads page.
- Booking conversion uses unique conversations booked strictly after first P3;
  the mature rate excludes P3 cohorts newer than 14 days. P3 ghosting requires
  a recorded post-P3 outbound, no later booking/reply, and 30 days of silence.

- `frontend/api/config.ts` — notebook config writer (service-role). Persists the
  per-instance override blob edited on the Health page; the sync agent merges it
  over its local `config.yaml` on the next run. See "Configuring notebooks online".

- `frontend/api/briefing.ts` — the **Morning Briefing**. Reuses the same agentic SQL
  loop as `/api/chat` (same `_lib/tools.ts`) to investigate the whole pipeline on its
  own, then structures the result and stores one row per day in `briefings`
  (`008`-style read-only RLS; see `016_briefings.sql`). Runs daily at **07:00 UTC**
  via the `vercel.json` cron — after the 06:00 `classify` cron, so replies are
  sentiment/intent-labelled first — and on demand from the **Refresh briefing** button on
  the Overview card. If `SLACK_WEBHOOK_URL` is set it also posts the briefing to
  Slack (Block Kit); without it the briefing still stores and shows on the dashboard.
  The GET (cron) path is guarded by `CRON_SECRET`; the manual POST is open and
  idempotent (upsert on the date).

Set **server-only** env vars on the Vercel project (no `VITE_` prefix):
`ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (and optionally `SUPABASE_URL`,
`CRON_SECRET` to lock the daily `/api/classify` + `/api/notify-replies` +
`/api/briefing` crons, `ADMIN_SECRET` to gate `/api/config` config writes,
`SLACK_WEBHOOK_URL` to deliver the Morning Briefing to Slack,
`SLACK_REPLIES_WEBHOOK_URL` to route new-reply alerts from `/api/notify-replies`
to their own channel — falls back to `SLACK_WEBHOOK_URL` when unset — and
`DASHBOARD_URL` to turn lead names in those alerts into dashboard deep links,
plus `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` for the Apollo CSV Contact importer).
Restrict the Airtable personal access token to the Web 2 Mob base with only
schema-read and record read/write scopes. The token is server-only and must
never use a `VITE_` prefix.
Locally, plain `npm run dev` does not serve
`api/` — use `vercel dev` from `frontend/` to run the functions too.

## Metrics & dashboard pages

Topline numbers come from the `campaign_metrics` view (so any client gets the
same figures); the deeper analysis is computed client-side from the raw
`leads` table:

- **Overview** — the **Morning Briefing** card (today's AI digest: headline,
  what changed, risks, and the 3 actions to take — see `/api/briefing`), KPIs
  (invites / accepted / acceptance rate / replies / reply rate), daily activity
  chart, instance health, campaign table.
- **Campaign detail** (click a campaign) — funnel with pending-invite count,
  weekly invite cohorts (acceptance by send week), invite→accept and
  accept→reply time histograms, campaign-scoped activity, performance by
  audience segment (headline keywords) and top companies, plus side-by-side
  campaign comparison.
- **Accounts** — per-instance comparison (invites 7d, pending, rates), and a
  per-account detail page with a warm-up/limit tracker (weekly invites vs
  LinkedIn's ~100–200/wk safe zone) and a day×hour response heatmap.
- **Leads** — filterable/sortable explorer (instance, campaign, stage, text
  search), at-risk flags (invite pending 14d+, accepted but no reply 14d+),
  CSV export; filters live in the URL so views are shareable.
- **Replies in Leads** — newest-first follow-up worklist with profile links,
  reply text, independent sentiment badges, and durable P1/P2/P3 intent badges
  and filters. P3 means concrete buying intent; P3→Booked and P3 ghosting use
  recorded conversation/pipeline chronology rather than all positive sentiment.
  A "Classify replies" button (and the daily cron) drains new replies and any
  historical rows missing the current taxonomy. The full conversation thread is
  synced built-in by
  the agent (`sync_messages`, default on) — which makes message contents
  anon-readable until Auth is on.
- **Health** — sync-run history and per-instance freshness, plus a per-notebook
  **Configure** editor that writes the online config overrides (see "Configuring
  notebooks online").
- **CSV Import** — Apollo people CSV upload with fixed field mapping, duplicate
  detection, existing-company matching/manual selection, and batched creation in
  Airtable Contacts. Requires the SDR to choose `Added by`; it never creates a
  Company or updates an existing Contact. The MVP accepts up to 500 rows / 5 MB
  and keeps results only for the current browser session.

Extras: run `agent.py annotate "Switched to template B" [--date YYYY-MM-DD]
[--campaign ID]` from any machine with a config.yaml to drop a purple marker
on the time-series charts and correlate rate changes with changes you made.

Instances display as the **real LinkedIn account** (name, profile link,
photo) once provided: set `account_name` / `account_url` / `account_avatar`
in the notebook's `config.yaml`, or add a `mapping.owner` query so the agent
pulls them from lh.db on every sync (preferred for the photo — LinkedIn
avatar URLs are signed and expire, so a DB-sourced URL stays fresh).

## Security notes

- The `service_role` key lives only in `sync-agent/config.yaml` on the
  notebooks (gitignored). It bypasses RLS, which is how the agent writes.
- The dashboard is currently readable by anyone holding the anon key + URL.
  To lock it to your team: enable Supabase Auth, change each RLS policy from
  `using (true)` to `using (auth.role() = 'authenticated')`, and add a login
  screen (supabase-js `signInWithPassword` or magic link).

## Alternative approaches considered

1. **Cloud-native LH2 alternatives (HeyReach, Expandi, Dripify, La Growth
   Machine)** — these are multi-account, cloud-hosted, and ship dashboards +
   APIs/webhooks out of the box. Migrating removes the whole sync problem,
   but costs more per seat and you lose LH2's pricing/feature set. Worth it
   if the team grows past ~5 senders.
2. **Skip the custom frontend: Supabase + Metabase/Grafana** — point Metabase
   at the same Postgres and build charts with zero frontend code. Less
   polished and not LinkedIn-funnel-aware, and you explicitly wanted a real
   frontend, so this repo ships one — but the schema works with Metabase too
   if you ever want ad-hoc exploration.
3. **Google Sheets pipeline** — LH2 CSV exports → Apps Script → Looker
   Studio. Cheapest, no servers, but manual exports, fragile parsing, no
   dedup. The `ingest-csv` command here gives you the same low-effort entry
   point with proper dedup and a real database underneath.
4. **Supabase Edge Function ingestion endpoint** — instead of notebooks
   holding the service-role key, they'd POST to an Edge Function with a
   shared secret that validates/writes. Better key hygiene; add later without
   touching the schema (the agent already isolates all writes in one class).

The chosen design (local agent → Supabase → SPA) keeps LH2 untouched, costs
~$0 (Supabase free tier covers this volume), and degrades gracefully: even if
the DB mapping breaks after an LH2 update, the CSV path keeps data flowing.
