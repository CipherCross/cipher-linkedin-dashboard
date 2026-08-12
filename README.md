# LinkedIn Campaign Dashboard

Team dashboard for LinkedIn outreach run through **Linked Helper 2** (LH2) on
several remote notebooks — one notebook per real LinkedIn account, each one an
"instance". Every notebook syncs its local LH2 data up through an authenticated
gateway; a React SPA and a set of Vercel serverless functions read it back.

```
notebook 1 ─┐  sync-agent (cron)          Vercel serverless /api
notebook 2 ─┼──▶ POST /api/import ──────▶ ────────────────────▶  Neon (Postgres + RLS)
notebook 3 ─┤     ?op=agent.ingest              │  per-notebook          │
notebook 4 ─┘     machine token                 │  machine token         │ actor-scoped RLS
                                                ▼                        ▼
                                    Cloudflare R2 (private        frontend (React + Vite)
                                    lead photos, signed URLs)     KPIs · funnel · pipeline · AI
```

A notebook never holds a database credential. It authenticates with a token
issued for that one notebook, and the database policies — not application code —
decide what it may write.

**Two kinds of deployment** run this same repo:

- the **owner** deployment (tenant `ciphercross`), which the four original
  notebooks feed;
- **managed tenants** onboarded by the control plane in `ops/` — one Neon
  project, one Vercel Production deployment, one R2 key prefix, and its own
  machine credentials per tenant. `uitop` is live.

## Components

| Path | What it is |
|---|---|
| `postgres/tenant-baseline/v1/` | The live schema: baseline `001`–`010`, role bootstraps, and an append-only migration ledger (`ledger.manifest.json`) |
| `sync-agent/` | Single-file Python agent run on each notebook (`inspect` / `sync` / `ingest-csv` / `annotate`) |
| `frontend/` | React 18 + Vite SPA **and** the 12 Vercel serverless functions in `frontend/api/` |
| `ops/` | Owner-local control plane: SQLite registry, Keychain secrets, 17-tool STDIO MCP, provider adapters, and the Cloudflare Worker that provisions tenants |
| `supabase/` | The frozen legacy schema and tenant path. Historical — see "Migration status" |

## Setup

### 1. Schema

Every tenant database is built from `postgres/tenant-baseline/v1/` through the
ledger tool, which records each applied step with its SHA-256:

```bash
LEDGER_DB=<database> node postgres/tools/portable_migration_ledger.mjs status
LEDGER_DB=<database> node postgres/tools/portable_migration_ledger.mjs apply
LEDGER_DB=<database> node postgres/tools/portable_migration_ledger.mjs verify
```

It reaches PostgreSQL only through `$LEDGER_PSQL` (default `psql`), so no host or
credential is stored in the repo. Re-apply is an idempotent skip; **there are no
down migrations** and reversal is break-glass only. A step whose digest no longer
matches the manifest fails the pre-push gate — corrections ship as a *new* step,
never as an edit to an applied one. Read
`postgres/tenant-baseline/v1/README.md` before touching any of it.

`supabase/migrations/` is frozen legacy. Never run repo-root `supabase db push`
against a tenant project: the historical `001`–`052` files register as missing.

### 2. Sync agent (on each notebook)

```bash
cd sync-agent
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp config.example.yaml config.yaml   # then edit — see below
.venv/bin/python agent.py sync --dry-run   # extract + print counts, push nothing
.venv/bin/python agent.py sync             # first real sync
```

`config.example.yaml` is the authoritative reference for every key; it explains
which ones a given notebook needs. In short: **`instance_id` is always required,
and the destination credentials are an OR** —

- a notebook on the **owner** deployment may still carry `supabase_url` +
  `supabase_service_key`, optionally plus the gateway keys to mirror or cut over;
- a notebook on a **tenant** deployment carries `ingest_url` + `ingest_token` and
  no Supabase keys at all. It runs `ingest_mode: only` whatever the flag says,
  because there is nowhere else for its data to go.

A config with neither destination is refused at startup rather than syncing into
nothing. Mint a token per notebook through the dashboard's
`admin.agentCredentialIssue` operation — the plaintext is shown exactly once.

`ingest_mode` moves a notebook across in stages: `off` → `shadow` (delivered
alongside Supabase, failures are noise) → `dual` (a failure marks the run
`partial`) → `only` (the gateway is the sole destination and a delivery failure
fails the run). Roll out one notebook at a time.

Always run `--dry-run` first and compare per-campaign invited/accepted/replied
counts against LH2's own numbers. One check catches the fault that has actually
happened: divide each campaign's **invited** count by its **invite sends** in the
step table — a ratio above ~1.2 means the leads mapping lost its
`person_external_ids` dedup and is counting every person about twice.
`agent.py inspect` prints every table and column to fix the mapping.

LH2 has **no public API** and its on-disk format varies by version, so there are
two extraction paths:

- **Direct DB read** — copy the table/column names `inspect` prints into the
  `mapping:` section. The DB is opened read-only; LH2 can keep running.
- **CSV export** (always works) — export a campaign's people list from LH2, then:

  ```bash
  .venv/bin/python agent.py ingest-csv export.csv --campaign "SaaS Founders US" --kind successes
  ```

Both paths upsert idempotently, so rerunning is always safe. Schedule it (cron,
every 30 min; Task Scheduler on Windows notebooks):

```cron
*/30 * * * * cd /path/to/sync-agent && .venv/bin/python agent.py sync >> sync.log 2>&1
```

Two commands behave differently on a Supabase-free notebook: `ingest-csv` works
through the same gateway with the same idempotency key and parity check, while
`annotate` refuses — the ingest contract carries no annotations and `app_machine`
holds no grant on that table.

#### Deploying agent updates (no manual copying)

The agent **self-updates** through a signed release channel. At the start of every
scheduled `sync` it asks the authenticated machine API
(`GET /api/import?op=agent.release`, with its own `ingest_token`) for the current
release; the API answers with a signed manifest and a short-lived presigned URL
into a private, versioned R2 release bucket. The agent verifies the Ed25519
signature against the local `release_public_key`, checks size and SHA-256, then
swaps itself out atomically and re-runs.

```bash
set -a; . ~/.config/agent-release.env; set +a   # operator credentials, never committed
sync-agent/deploy.sh                            # signs + publishes; notebooks update within 30 min
```

The channel is live (bucket `lh2-agent-releases`, current release 1.15.1).
**`docs/platform-ops/agent-release-channel.md`** is the runbook: how to cut and
verify a release, and the four things that bite — you roll back by rolling
*forward*, publishing the version the fleet already runs proves nothing, the
signing key is the fleet, and `deploy.sh` runs under bash 3.2.

`deploy.sh` needs the operator-side variables `AGENT_RELEASE_ENDPOINT`,
`AGENT_RELEASE_BUCKET`, the **write**-scoped `AGENT_RELEASE_WRITE_ACCESS_KEY_ID` /
`AGENT_RELEASE_WRITE_SECRET_ACCESS_KEY` pair, and `AGENT_RELEASE_SIGNING_KEY_FILE`.
The dashboard holds only a separate **read**-scoped pair and can never publish.
The release bucket must not be the lead-photos bucket; the code refuses that
configuration.

Watch the rollout on the **Health** page (each instance reports its
`agent_version`). Failures are safe: if the release path is unconfigured, the
signature does not verify, or the download looks wrong, the agent keeps running
its current version and the scheduled sync proceeds. Pin a notebook with
`auto_update: false`.

#### Configuring notebooks online (no SSH)

After the first sync you rarely need to touch a notebook's `config.yaml`.
**Local-only** are `instance_id`, whichever destination credentials it holds
(`supabase_url` / `supabase_service_key`, or `ingest_url` — bootstrapped locally
once — plus `ingest_token`), and the `release_public_key` trust anchor. A token
that could be set from a remote blob would be a way to hand every notebook
somebody else's credential, so it never is.

Everything else — the label, the displayed LinkedIn account (`account_*`), the
`sync_*` toggles, `lh2_db_path`, `exclude_campaigns`, `notify_url`, `ingest_mode`,
even the LH2 `mapping` SQL — is editable from the **Health** page (Accounts panel
→ **Configure**). Overrides live in `instances.config`; the agent merges them over
the local file on every sync and **remote wins**, so changes apply within 30 min.
Saving requires a signed-in admin. Two escape hatches: a bad online value only
breaks that one notebook's sync (the error shows on Health), and
`ignore_remote_config: true` pins a notebook to its file. Note the Health editor
404s until a notebook's first successful sync has created its `instances` row —
which is why the very first mode change is always a local edit.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev             # SPA only — does NOT serve api/
vercel dev              # SPA + api/ functions together (needs server env vars)
npm run build           # tsc -b && vite build → dist/
npm run typecheck:api   # api/ is NOT covered by npm run build
npm test                # offline suites (vitest + jsdom)
```

There are exactly **three** browser variables, all optional:

| Variable | Effect when unset |
|---|---|
| `VITE_AUTH_PATH` | Defaults to `supabase`. Only the exact string `identity` selects the self-hosted Better Auth path |
| `VITE_SUPABASE_URL` | The Supabase client is `null`; reads fall back to the Neon path and photos to `disabled` |
| `VITE_SUPABASE_ANON_KEY` | Same |

The app boots with both Supabase values absent. They are still required for
**sign-in** on any deployment that has not set `VITE_AUTH_PATH=identity` — which
today includes the owner's. See "Migration status".

### 4. AI, MCP, and the SQL guard

The **Chat** page answers analytical questions ("why did the invite spike not
produce replies?") by running read-only SQL through tools. The same ops are
exposed as an MCP server for external clients.

- `postgres/tenant-baseline/v1/003_functions_triggers_ai_guard.sql` —
  `public.ai_execute_sql(query)`, `SECURITY DEFINER`, owned by the NOLOGIN,
  SELECT-only, non-BYPASSRLS role `app_ai_runner`, `EXECUTE` granted to
  `app_system` alone. `SELECT`/`WITH` only, one statement, mutation and DDL
  keywords rejected, `statement_timeout` 10 s, an inner `limit 1000` before
  `jsonb_agg`, column-scoped grants and per-table RLS on top. The API passes the
  SQL as a **bound parameter**, never interpolated
  (`frontend/api/_lib/data/operations/ai.ts`). **Don't loosen this to add a write
  path** — the AI system role's five-relation write path is a separate ledger
  step and never grants `DELETE`.
- `frontend/api/chat.ts` — streaming copilot (Vercel AI SDK, `claude-opus-4-8`).
- `frontend/api/mcp.ts` — MCP server at `https://<deployment>/api/mcp`
  (Streamable HTTP) with `run_sql`, `get_schema`, `weekly_funnel`,
  `campaign_overview`. Keep it in sync with `chat.ts`; they expose the same ops.
- `frontend/api/classify.ts` (`claude-haiku-4-5`) — labels each inbound reply on
  two independent dimensions: sentiment (`positive` / `neutral` / `negative` /
  `objection` / `referral` / `auto`) and commercial intent (`P1` polite positive /
  `P2` problem interest / `P3` buying intent). The taxonomy version is stored even
  when intent is null, making historical backfills resumable and idempotent;
  manual sentiment corrections are preserved. A second phase evaluates
  name/headline gender in fair per-account batches, and age is derived
  independently whenever synced education/job years change. `?mode=demographics`
  drains that backlog without spending time on replies. Manual gender actions
  append the prior prediction to `lead_gender_reviews` so calibration can be
  measured. Intent never auto-advances CRM stages.
- Booking conversion counts unique conversations booked strictly after first P3;
  the mature rate excludes P3 cohorts newer than 14 days. P3 ghosting requires a
  recorded post-P3 outbound, no later booking or reply, and 30 days of silence.
- `frontend/api/briefing.ts` — two **Slack-only** briefings, in concise natural
  Ukrainian with `claude-opus-5` (separate investigate / verify / structure
  passes). A short operational note runs Mon–Fri 07:30 UTC; a longer review of the
  completed Mon–Sun period runs Monday 07:00 UTC. Daily and weekly rows and jobs
  are keyed independently, so Monday's two posts cannot overwrite each other. The
  generator preloads team-written campaign context, linked hypothesis/search
  context, and recent annotations; causal claims are attributed to that context
  rather than inferred from rates. There is no dashboard briefing card.
- `frontend/api/coach.ts` — per-conversation coaching (`claude-sonnet-4-6`) and a
  cross-conversation digest (`claude-opus-4-8`), grounded in the **Playbook**.
- `frontend/api/notify-replies.ts` — one Slack alert per new inbound reply. The
  agent pings it after every successful push; it claims `notified_at IS NULL` rows
  by atomic UPDATE (concurrent pings are normal) and un-claims on Slack failure.
  Rows older than 14 days are marked without posting. The daily cron is the
  lost-ping sweep, not the primary trigger.
- `frontend/api/playbook.ts` also serves the admin-only **Briefing context**
  editor on Campaign Detail, folded in to stay under the function cap. Use it for
  durable facts metrics cannot show — re-engagement batches, cross-account
  overlap, audience exclusions, temporary experiments. It is internal strategy
  text visible to authenticated teammates; never put secrets or personal data in it.

#### Server environment variables

Set on the Vercel project, **never** with a `VITE_` prefix.

| Group | Variables |
|---|---|
| Data layer | `NEON_DATABASE_URL` (required on the Neon path), `NEON_AI_DATABASE_URL` (AI layer's own `app_system` principal), `NEON_MACHINE_DATABASE_URL` (the ingest gateway; without it ingest answers 503 rather than half-working), optional `NEON_DATABASE_URL_UNPOOLED` |
| Provider flags | `NEON_READS_DEFAULT`, `NEON_WRITES_DEFAULT`, `NEON_AI_PATH_DEFAULT`, `NEON_PHOTOS_DEFAULT` — all optional; see below |
| Identity | `IDENTITY_STORE_DATABASE_URL`, `IDENTITY_SESSION_SECRET` (≥32 chars, must differ from the DB URL), `IDENTITY_BASE_URL` (its scheme decides `useSecureCookies`), optional `RESEND_API_KEY` + `RESEND_FROM_IDENTITY` for reset mail |
| Object storage | `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY`, `OBJECT_STORAGE_TENANT_ID` (no default, deliberately), optional `OBJECT_STORAGE_REGION` (`auto`) |
| Agent releases | read-scoped `AGENT_RELEASE_ACCESS_KEY_ID` / `AGENT_RELEASE_SECRET_ACCESS_KEY`, `AGENT_RELEASE_ENDPOINT`, `AGENT_RELEASE_BUCKET`, optional `AGENT_RELEASE_REGION` |
| Tenancy | `APP_TENANT_ID` — must equal `OBJECT_STORAGE_TENANT_ID` when both are set |
| AI | `ANTHROPIC_API_KEY` |
| Machine secrets | `CRON_SECRET` (GET cron paths of `/api/classify`, `/api/notify-replies`, `/api/briefing`, and identity session pruning), `NOTIFY_SECRET` (older agents only), `MCP_SECRET` (every MCP tool). All fail closed: missing → 500, mismatch → 401 |
| Slack | `SLACK_WEBHOOK_URL`, optional `SLACK_REPLIES_WEBHOOK_URL` (falls back to it), optional `DASHBOARD_URL` for deep links |
| Airtable | `AIRTABLE_TOKEN` + `AIRTABLE_BASE_ID` for the Apollo CSV importers. Restrict the PAT to the target base with schema-read and record read/write only |
| Legacy | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, optional `SUPABASE_URL` — still required while a deployment is on the Supabase path |

**The provider flags are derived, not assumed.** Leave one unset and it resolves
to `neon` only if the deployment actually holds the credential that path needs,
and to `supabase` if it does not. There are exactly two legal values, and an
unrecognised one is **refused** rather than interpreted — guessing would choose a
database. The decision is per path because the credentials are: a deployment can
legitimately hold the AI credential and not the main one. Corollary learned the
hard way: **a credential's presence is not evidence of intent**, so never bind a
Neon URL to a live deployment for a smoke test.

Crons live in `frontend/vercel.json`: `/api/classify` 06:00 UTC,
`/api/notify-replies` 06:30 UTC, `/api/briefing?kind=weekly` Monday 07:00 UTC,
`/api/briefing?kind=daily` Mon–Fri 07:30 UTC.

`frontend/api/` holds **exactly 12** functions — the Vercel Hobby cap, dead on.
That cap is structural, not incidental: `reclassify` is a rewrite onto
`classify.ts`, every machine operation rides `import.ts` behind `?op=`, and the
Briefing-context write lives in `playbook.ts`. Adding a file means removing one.

## Pages

Topline numbers come from server-side aggregates so every client sees the same
figures; range- and subset-specific analysis is recomputed client-side in
`frontend/src/lib/leads.ts`.

| Route | What it shows |
|---|---|
| `/` **Overview** | Account cards, global KPIs and funnel, date-range picker, import and follow-up callouts |
| `/campaign/:id` **Campaign detail** | KPIs, funnel, weekly invite cohorts, lead-additions chart and add-batch table, message sequence with per-step reply rates, age and gender distribution, side-by-side comparison, and the team-editable briefing context |
| `/account/:id` **Account detail** | Per-instance KPIs, campaign table, day×hour response heatmap, warm-up/limit tracker against LinkedIn's ~100–200/wk safe zone |
| `/leads` **Leads** | Filterable/sortable explorer with avatars, stage and risk flags (invite pending 14d+, accepted but no reply 14d+), sentiment and durable P1/P2/P3 intent badges, lost-reason capture, CSV export. Filters live in the URL, so views are shareable. `/replies` redirects here |
| `/pipeline` **Pipeline** | CRM kanban with days-in-stage and lost reasons |
| `/follow-ups` **Follow-ups** | Follow-up worklist in buckets, with the audit identity of each action |
| `/review` **Review** | Manager weekly review: cohort-matured funnel comparison, sentiment trend, leads-added table, template comparison, send-to-Slack |
| `/playbook` **Playbook** | The single global Markdown playbook that grounds coaching |
| `/searches` **Search library** | Saved searches with chips, editor, archive/restore |
| `/icp` **ICP** | ICP definitions with personas and sub-industries |
| `/hypotheses` **Hypotheses** | Hypotheses with linked campaigns and their funnels |
| `/team` **Team** | Team directory; renders the identity or Supabase variant per authenticator |
| `/csv-import` **CSV import** (admin) | Apollo people and company CSV upload: fixed field mapping, duplicate detection, existing-company matching, batched creation in Airtable. Requires `Added by`; never creates a Company or updates an existing Contact. Up to 500 rows / 5 MB, results kept for the browser session only |
| `/chat` **Chat** | AI copilot with streamed markdown, reasoning, and visible tool calls |
| `/health` **Health** | Sync-run history, per-instance freshness and errors, plus the per-notebook **Configure** editor |

One more route exists without a nav entry: `/neon-activity`, a single read-only
daily-activity chart served straight from Neon through `/api/activity-daily`. It
is a provider-path probe, not a product page.

Extras: `agent.py annotate "Switched to template B" [--date YYYY-MM-DD]
[--campaign ID]` drops a marker on the time-series charts so rate changes can be
correlated with changes you made. Instances display as the real LinkedIn account
(name, link, photo) once `account_*` is set or a `mapping.owner` query supplies
them — prefer the query, since LinkedIn avatar URLs are signed and expire.

## Security posture

- **No notebook holds a database credential** on the gateway path. Each has a
  token scoped to itself; `agent_credential_resolve` re-derives revocation,
  expiry and tenant on every request with no caching, and wrong-tenant or revoked
  writes are refused by database policy rather than application code. Ingest is
  idempotent per `(credential, idempotency key)` with a payload digest, in an
  all-or-nothing transaction whose batch row is written last.
- **Lead photos are private.** They live in a private R2 bucket under a
  per-tenant key prefix. The browser sends **lead ids** — never keys or paths — to
  `/api/activity-daily?op=leads.photoUrls`; the server reads the rows the actor
  may see, derives the key itself, and returns 5-minute signed URLs, at most 100
  per call. Signed URLs are cleared on sign-out. Photo delivery can be `disabled`
  outright, which is what the control plane binds for onboarded tenants.
- **Reads are actor-scoped.** Every Neon transaction sets `app.actor_id` with
  `SET LOCAL`, and RLS decides what that actor sees. A raw query with no actor set
  returns zero rows — which reads like an empty database and is not one.
- **Authentication is invite-only.** A user must be linked to an active
  `team_members` row; `role='admin'` gates sensitive API actions on top of RLS.
- `service_role` and other bypass credentials exist only in server env and in
  legacy notebook configs (gitignored). Handlers authorize before touching them.
- The owner control plane in `ops/` has no secret-read command, no HTTP listener,
  and no raw query, provider-delete, migration-repair, or down-migration surface.
  Secrets come from macOS Keychain through an interactive no-echo prompt; a
  registry backup without its passphrase is intentionally unrecoverable.

Tenant lifecycle work must follow `docs/platform-ops/operations-contract-v1.md`
and its JSON Schemas: `preflight → plan → owner approval → apply/resume → verify`.
Planning is read-only; apply requires the exact unexpired plan digest. Do not
reach around the operations core with raw provider, SQL, shell, DNS or secret
commands.

## Migration status

Production runs on Neon and R2. One step remains: **deleting the Supabase path.**
It is blocked, and the order matters —

1. `VITE_AUTH_PATH` is unset, so everyone still signs in through Supabase.
2. Flipping it today would lock all members out: their identity account rows carry
   placeholder hashes, there are no identity sessions, and the reset-mail
   credentials are unbound on Production, so a reset link is silently discarded.
3. Required sequence: bind the mail credentials → prove one real password reset
   end to end → flip `VITE_AUTH_PATH=identity` → then delete the Supabase code,
   env values, and project.

`docs/implementation-handoffs/N-S27-SUPABASE-EXIT.md` is the live plan and holds
the file-by-file dependency inventory. Note that the two stores already disagree
on one thing by design: the gateway resolves `events.occurred_at` conflicts with
`LEAST`, where Supabase kept the newest.

## Tests

There is no lint step. `npm run build` is the SPA typecheck and does **not** cover
`frontend/api/` — run `npm run typecheck:api` for that.

```bash
cd frontend && npm test              # offline: vitest + jsdom
cd frontend && npm run test:neon     # against the shared Neon dev project (mutates it)
cd frontend && npm run test:cleanroom
cd ops && npm test                   # control plane, 128 assertions
node postgres/tests/portable_migration_ledger_static_assertions.mjs   # from the repo root
sync-agent/.venv/bin/python3 sync-agent/tests/test_ingest_transport.py
```

Three traps worth knowing before you trust a result: `test:neon` needs three
credential files sourced under `set -a` or it reports failures that look like
regressions; it writes to a **shared** project seeded with synthetic fixtures, so
never assume an empty relation and never touch another suite's rows; and the
ledger assertions must run from the repository root or they fail with
`MODULE_NOT_FOUND`, which looks like a broken harness.

## Alternatives considered

1. **Cloud-native LH2 alternatives** (HeyReach, Expandi, Dripify, La Growth
   Machine) — multi-account, cloud-hosted, dashboards and APIs out of the box.
   Removes the sync problem entirely, costs more per seat, loses LH2's feature
   set. Worth revisiting past ~5 senders per team.
2. **A BI tool instead of an SPA** (Metabase / Grafana on the same Postgres) —
   zero frontend code, but not LinkedIn-funnel-aware and not multi-tenant. The
   schema still works this way for ad-hoc exploration.
3. **Google Sheets pipeline** — LH2 CSV → Apps Script → Looker Studio. Cheapest,
   but manual exports, fragile parsing, no dedup. `ingest-csv` gives the same
   low-effort entry point with proper dedup and a real database underneath.
4. **A gateway endpoint instead of notebooks holding a service key** — this was
   the deferred option, and it is now the primary transport (`agent.ingest`).

The design keeps LH2 untouched and degrades gracefully: if an LH2 update breaks
the DB mapping, the CSV path keeps data flowing, and a failed release, config
fetch, photo mirror or Slack ping can never break a scheduled sync.
