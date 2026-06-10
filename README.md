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

## Metrics & dashboard pages

Topline numbers come from the `campaign_metrics` view (so any client gets the
same figures); the deeper analysis is computed client-side from the raw
`leads` table:

- **Overview** — KPIs (invites / accepted / acceptance rate / replies / reply
  rate), daily activity chart, instance health, campaign table.
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
- **Replies** — newest-first follow-up worklist with profile links and the
  reply text itself (when the notebook syncs the optional `mapping.messages`
  query — note this makes reply contents anon-readable until Auth is on).
- **Health** — sync-run history and per-instance freshness.

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
