# LinkedIn Campaign Dashboard

Team dashboard for LinkedIn outreach run through **Linked Helper 2** on remote
notebooks (one instance per LH2 account). Each notebook syncs its local LH2 data
into **Supabase**; a React frontend (behind login + RBAC) computes and displays
the campaign metrics. The app is **distributed to multiple independent teams** —
each team gets its own Supabase project and its own deployment, so data never
mixes (see [Distributing to multiple teams](#distributing-to-multiple-teams)).

```
notebook 1 ─┐  sync-agent (cron)
notebook 2 ─┼──────────────────────▶  Supabase (Postgres + Auth + Storage + RLS)
notebook 3 ─┘   service-role key            │ authenticated reads (RLS)
                                            ▼
                          frontend (React + Vite) + /api (Hono, Node)
                          login + roles: owner · admin · member · viewer
                          KPIs · funnel · activity · AI copilot · sync health
```

## Components

| Path | What it is |
|---|---|
| `supabase/migrations/` | Schema + RLS. `001_init.sql` core tables/views; `014_auth_rbac.sql` adds Auth/RBAC (`profiles`, roles, JWT hook) and locks reads to authenticated users |
| `sync-agent/` | Python agent run on each notebook (`inspect` / `sync` / `ingest-csv`) |
| `frontend/` | Dashboard (React 18, Vite, TypeScript, Recharts, supabase-js) + `api/` endpoints + `server/` (Hono) that serves the SPA and `/api` |
| `infra/` | Hosting + provisioning: Docker image, Caddy proxy, and `provision-team.sh` for onboarding a team. See [`infra/README.md`](infra/README.md) |

## Setup

### 1. Supabase (once per team)

1. Create a project at supabase.com.
2. Apply **all** migrations in order — `supabase db push` with the CLI, or run
   each `supabase/migrations/*.sql` in the SQL editor. `014_auth_rbac.sql` adds
   Auth/RBAC and switches reads to authenticated-only.
3. In **Authentication**: turn **off** public signups (invite-only), set the
   **Site URL** to the team's dashboard URL, and enable the **Custom Access
   Token** hook → `public.custom_access_token_hook` (stamps the `user_role`
   claim used by RBAC).
4. Create the first **admin** user (Authentication → Users) and set their role:
   `update public.profiles set role='admin' where email='…';`
5. Note from **Settings → API**: `anon` key (browser), `service_role` key (sync
   agent + `/api` only — never the browser), and the **JWT secret** (the `/api`
   server verifies user tokens with it).

> `infra/provision-team.sh` automates steps 2–4 — see
> [Distributing to multiple teams](#distributing-to-multiple-teams).

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
wins**, so changes apply on the next run (≤30 min). Saving config is restricted
to **admin** users (the **Configure** editor is hidden for everyone else, and
`/api/config` rejects non-admins). Recovery: a bad online value only breaks that
one notebook's sync (the error shows on Health), and `ignore_remote_config: true`
in its local `config.yaml` pins it to the file, ignoring the online overrides.

### 3. Frontend + API server

```bash
cd frontend
npm install
cp .env.example .env    # Supabase URL/anon/service-role + JWT secret + Anthropic key
npm run dev             # SPA on Vite (uses /config.js from .env)
npm run start           # the Hono server (SPA + /api) on :8080, for full local testing
npm run build           # production SPA bundle in dist/
```

You log in (no anonymous access — RLS requires an authenticated user). For
production each team runs the **container** (`frontend/Dockerfile`: SPA + `/api`
in one Node process) behind the shared Caddy proxy on your VPS. The Supabase URL
+ anon key are injected at **runtime** (`/config.js`), so one image serves every
team — only the env file differs. See [`infra/README.md`](infra/README.md).

### 4. AI chat + MCP layer

The **Chat** page lets you ask Claude analytical questions ("why did the
invite spike not produce replies?"); it answers by running read-only SQL
against Supabase through tools. The same tools are exposed as an MCP server
for external clients (Claude Desktop / Claude Code).

- `supabase/migrations/008_ai_readonly_sql.sql` — `ai_execute_sql(query)` RPC:
  SELECT/WITH only, runs as a select-only role, 10s timeout, callable only
  with the service-role key. Apply with `supabase db push`.
- `frontend/api/chat.ts` — streaming chat endpoint (Vercel AI SDK +
  `claude-opus-4-8`, multi-step tool use). Gated to **member+**.
- `frontend/api/mcp.ts` — MCP server at `https://<deployment>/api/mcp`
  (Streamable HTTP) with `run_sql`, `get_schema`, `weekly_funnel`,
  `campaign_overview`. **Off by default**; set `MCP_TOKEN` to enable, and clients
  send it as a bearer token.
- `frontend/api/classify.ts` — reply classifier (`claude-haiku-4-5`): labels
  each inbound reply `positive` / `neutral` / `negative` / `objection` /
  `referral` / `auto` with a one-line reason, writing back to `messages`. Runs
  daily via the server's in-process cron (guarded by `CRON_SECRET`) and on demand
  from the Replies page button (member+). Only touches rows where `sentiment is
  null`, so it's cheap and idempotent.
- `frontend/api/config.ts` — notebook config writer (service-role), **admin+**.
- `frontend/api/members.ts` — member management (list/create/role/remove),
  **admin+**, via the GoTrue admin API.

Every `/api` call is authorized in `frontend/server/index.ts`: the Hono server
verifies the caller's Supabase JWT (`SUPABASE_JWT_SECRET`) and checks the
`user_role` claim against each route's minimum role (`frontend/api/_lib/auth.ts`).
**Server-only** env vars (no `VITE_` prefix): `ANTHROPIC_API_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` (and optionally `SUPABASE_URL`,
`CRON_SECRET`, `MCP_TOKEN`). Run the full app locally with `npm run start` (serves
both the SPA and `/api`); plain `npm run dev` serves only the SPA.

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
- **Replies** — newest-first follow-up worklist with profile links, the reply
  text, and its classified **decision** (positive / objection / neutral /
  referral / negative / auto) as a colored badge plus filter chips with counts.
  A "Classify new replies" button (and the daily cron) labels any unclassified
  replies. The full conversation thread (both directions) is synced built-in by
  the agent (`sync_messages`, default on); message contents are readable only by
  authenticated members of that team (RLS).
- **Health** — sync-run history and per-instance freshness, plus a per-notebook
  **Configure** editor that writes the online config overrides (see "Configuring
  notebooks online").

Extras: run `agent.py annotate "Switched to template B" [--date YYYY-MM-DD]
[--campaign ID]` from any machine with a config.yaml to drop a purple marker
on the time-series charts and correlate rate changes with changes you made.

Instances display as the **real LinkedIn account** (name, profile link,
photo) once provided: set `account_name` / `account_url` / `account_avatar`
in the notebook's `config.yaml`, or add a `mapping.owner` query so the agent
pulls them from lh.db on every sync (preferred for the photo — LinkedIn
avatar URLs are signed and expire, so a DB-sourced URL stays fresh).

## Auth & RBAC

Login is required; reads need an authenticated user (RLS), and every `/api` call
is re-checked server-side. Roles (`014_auth_rbac.sql`, `profiles.role`):

| Role | Can |
|---|---|
| `viewer` | View all dashboards |
| `member` | + AI Chat / classify replies |
| `admin` | + edit notebook config, manage members |
| `owner` | + cross-team support access (seeded only by the provisioner) |

The role is stamped into the JWT (`user_role`) by the Custom Access Token hook,
so both RLS and the API authorize without an extra query. Admins manage accounts
from the **Members** page; public signup is off (invite-only).

## Security notes

- The `service_role` key lives only in `sync-agent/config.yaml` on the notebooks
  and in each team's container env (both gitignored / off the VPS git). It
  bypasses RLS — that's how the agent and `/api` write — and is **per team**, so
  no key reaches another team's data.
- Reads require a logged-in user in **that project's** user pool, so a leaked URL
  or anon key exposes nothing on its own.
- `/api/mcp` is the most powerful surface (read-only SQL); it's disabled unless
  `MCP_TOKEN` is set per team.

## Distributing to multiple teams

Each team is fully isolated: its **own Supabase project** (separate Postgres,
separate Auth user pool) and its **own container** on your VPS holding only that
team's keys, behind a shared Caddy proxy. Your own dashboard is just another
team's stack that others have no login to. Onboard a team with one script:

```bash
cp infra/templates/team.secrets.env.example infra/tenants/acme.secrets.env
$EDITOR infra/tenants/acme.secrets.env     # Supabase keys, admin creds, subdomain
infra/provision-team.sh acme               # migrate, seed admin, build, run, route + TLS
```

It applies migrations, seeds the first admin, renders + starts the container,
adds the Caddy vhost, and prints the onboarding packet (app URL, admin login, and
the per-notebook bootstrap `config.yaml`). Full ops guide:
[`infra/README.md`](infra/README.md).

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
