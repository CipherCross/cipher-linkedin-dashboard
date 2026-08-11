# LinkedIn Campaign Dashboard

Team dashboard for LinkedIn outreach run through **Linked Helper 2** on 3
remote notebooks (3 instances under one LH2 account). Each notebook syncs its
local LH2 data into **Supabase**; a React frontend computes and displays the
campaign metrics.

```
notebook 1 ─┐  sync-agent (cron)
notebook 2 ─┼──────────────────────▶  Supabase (Postgres + REST + RLS)
notebook 3 ─┘   service-role key            │ user JWT + authenticated RLS
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

The agent **self-updates** through a signed release channel. At the start of
every scheduled `sync` it asks the dashboard's authenticated machine API
(`GET /api/import?op=agent.release`, with its own `ingest_token`) for the
current release; the API answers with a signed manifest and a short-lived
presigned URL into a **private, versioned S3-compatible release bucket**
(Cloudflare R2). The agent verifies the Ed25519 signature against the
`release_public_key` in its config, checks the size and SHA-256, then swaps
itself out atomically and re-runs. To roll out a change to all notebooks:

```bash
sync-agent/deploy.sh    # signs + publishes a release; notebooks update within 30 min
```

`deploy.sh` needs the operator-side release variables — `AGENT_RELEASE_ENDPOINT`,
`AGENT_RELEASE_BUCKET`, the **write**-scoped `AGENT_RELEASE_WRITE_ACCESS_KEY_ID`
/ `AGENT_RELEASE_WRITE_SECRET_ACCESS_KEY` pair, and `AGENT_RELEASE_SIGNING_KEY_FILE`.
The dashboard holds only a separate **read**-scoped pair
(`AGENT_RELEASE_ACCESS_KEY_ID` / `AGENT_RELEASE_SECRET_ACCESS_KEY`) and can
never publish. The release bucket must not be the lead-photos bucket; the code
refuses that configuration.

Watch the rollout on the dashboard's **Health** page (each instance reports
its `agent_version`). Failures are safe: if the release path is unconfigured,
the signature does not verify or the download looks wrong, the agent keeps
running its current version and the scheduled sync proceeds. Pin a notebook
with `auto_update: false` in its config.yaml.

#### Configuring notebooks online (no SSH)

After the first sync you rarely need to touch a notebook's `config.yaml` again.
The three **bootstrap** keys (`supabase_url`, `supabase_service_key`,
`instance_id`) and the optional machine credential `notify_secret` must live
locally; operational settings — the label, the displayed
LinkedIn account (`account_*`), the `sync_*` toggles, `lh2_db_path`, even the LH2
`mapping` SQL — can be edited from the dashboard's **Health** page (Accounts
panel → **Configure**). Those overrides are stored in `instances.config`; the
agent fetches and merges them over the local file on every sync and **remote
wins**, so changes apply on the next run (≤30 min). Saving requires a signed-in
dashboard admin. Recovery: a bad online value only breaks that one
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

Without `.env` the dashboard shows an error screen — both variables are
required. The browser key is safe to expose; invite-only Supabase Auth plus RLS
restrict dashboard reads to active `team_members`. Before deployment, follow
[the auth rollout runbook](docs/auth-rollout.md). Deploy `dist/` anywhere static
(Vercel, Netlify, Cloudflare Pages).

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
  Its second phase evaluates name/headline gender in fair per-account batches;
  migration 048 derives age independently whenever synced education/job years
  change. The API reports demographic processed/failed/remaining counts, and
  `?mode=demographics` drains that backlog without spending time on replies.
  Manual gender actions append the prior prediction and correction to
  `lead_gender_reviews`, so accuracy and confidence calibration can be evaluated.
  Runs daily via the `vercel.json` cron and on demand from the Leads page.
- Booking conversion uses unique conversations booked strictly after first P3;
  the mature rate excludes P3 cohorts newer than 14 days. P3 ghosting requires
  a recorded post-P3 outbound, no later booking/reply, and 30 days of silence.

- `frontend/api/config.ts` — notebook config writer (service-role). Persists the
  per-instance override blob edited on the Health page; the sync agent merges it
  over its local `config.yaml` on the next run. See "Configuring notebooks online".

- `frontend/api/briefing.ts` — two **Slack-only LinkedIn briefings**, both written
  in concise, natural Ukrainian with `claude-opus-5`. A short operational note runs
  Monday–Friday at **07:30 UTC**; a longer review of the completed Monday–Sunday
  period runs Monday at **07:00 UTC**. Daily and weekly rows/jobs are keyed
  independently, so Monday's two posts cannot overwrite each other. The generator
  preloads team-written campaign context, linked hypothesis/search context, and
  recent annotations before interpreting results; causal explanations are
  attributed to that context rather than inferred from rates. Briefings persist for
  continuity and retries but have no dashboard card. GET crons are guarded by
  `CRON_SECRET`; the admin-role POST recovery path regenerates without reposting
  to Slack.
- `frontend/api/playbook.ts` also handles the admin-role
  **Briefing context** editor on Campaign Detail. The write is folded into this
  existing endpoint to stay within Vercel Hobby's 12-function limit. Use the field
  for durable facts metrics cannot show, such as re-engagement batches,
  cross-account overlap, audience exclusions, or temporary experiments. It is
  internal strategy text visible to authenticated teammates; never
  store secrets or personal data there.

Set **server-only** env vars on the Vercel project (no `VITE_` prefix):
`ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` (and
optionally `SUPABASE_URL`; it falls back to `VITE_SUPABASE_URL`),
required `CRON_SECRET` for scheduled `/api/classify` + `/api/notify-replies` +
briefing jobs, required `NOTIFY_SECRET` matching each notebook's local
`notify_secret`, required `MCP_SECRET` for every MCP tool,
`SLACK_WEBHOOK_URL` to deliver the
weekday and weekly briefings to Slack,
`SLACK_REPLIES_WEBHOOK_URL` to route new-reply alerts from `/api/notify-replies`
to their own channel — falls back to `SLACK_WEBHOOK_URL` when unset — and
`DASHBOARD_URL` to turn lead names in those alerts into dashboard deep links,
plus `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` for the Apollo CSV Contact and Company importers).
Restrict the Airtable personal access token to the Web 2 Mob base with only
schema-read and record read/write scopes. The token is server-only and must
never use a `VITE_` prefix.
Locally, plain `npm run dev` does not serve
`api/` — use `vercel dev` from `frontend/` to run the functions too.

## Metrics & dashboard pages

Topline numbers come from the `campaign_metrics` view (so any client gets the
same figures); the deeper analysis is computed client-side from the raw
`leads` table:

- **Overview** — KPIs (invites / accepted / acceptance rate / replies / reply
  rate), daily activity chart, instance health, campaign table. AI briefings are
  delivered only in Slack.
- **Campaign detail** (click a campaign) — funnel with pending-invite count,
  weekly invite cohorts (acceptance by send week), invite→accept and
  accept→reply time histograms, campaign-scoped activity, performance by
  audience segment (headline keywords) and top companies, plus side-by-side
  campaign comparison and the team-editable context supplied to AI briefings.
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
- The dashboard uses invite-only Supabase email/password Auth. An Auth user
  must be linked to an active `team_members` row; admin role checks protect
  sensitive APIs in addition to authenticated RLS.
- Cron, notebook notification, and MCP callers use separate fail-closed machine
  credentials. Lead photos remain intentionally public.

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
