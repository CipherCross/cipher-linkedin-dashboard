# ICP & Hypotheses

## Goal
Give the platform a first-class, fully-editable **ICP** (Ideal Customer Profile) and a
**Hypothesis** layer that groups campaigns under an ICP for statistics. Structure:
`Hypothesis → ICP → campaigns → leads`, with searches also attachable to a hypothesis and
per-industry include/exclude keywords living on the ICP. The Chat copilot and the AI coach both
gain read access to ICP/hypothesis knowledge so their answers and coaching are ICP-aware. The
first ICP ("Web 2 Mob") is seeded from the provided Google Sheet; all later editing is in-app.

## Non-goals
- **No live Google Sheets integration.** The sheet is imported once via a seed migration; the
  in-app editor is source-of-truth thereafter.
- No LH2 / sync-agent changes. Hypothesis assignment is dashboard-side metadata the agent never
  sees or touches.
- No auth work on the new endpoints/pages (read-open + `ADMIN_SECRET` on writes, per repo posture).
- No new SQL views for hypothesis stats this iteration — rolled up client-side (matches the
  demographics/range precedent). Can promote to a view later if the briefing needs it server-side.
- No Markdown free-form ICP body — ICP is fully structured (typed columns + arrays).
- Not wiring ICP into the **Morning Briefing** this round (briefing doesn't load the playbook
  today either); Chat + Coach only.

## Research findings
- **Migrations** (`supabase/migrations/`): sequential `NNN_name.sql`; latest is `042_lead_photos.sql`
  → next is **043**. New-table canon = `040_saved_searches.sql`: `bigint generated always as
  identity` PK, `check(char_length(...))` inline validation, `text[] not null default '{}'`,
  RLS `enable` + `create policy … for select using (true)`, `touch_updated_at` trigger (031),
  unique index for upsert target. **Migration 034 revoked auto-SELECT** → every new table the AI
  reads needs an explicit `grant select on <t> to ai_sql_runner;`.
- **`saved_searches` (040) already exists** with `include_keywords text[]`, `exclude_keywords
  text[]`, `boolean_query`, `filters jsonb`, `platform`, `archived`. Dashboard/AI-created, **not**
  synced from LH2 — safe to add a `hypothesis_id` FK.
- **Campaigns** PK is `text` = `"<instance_id>:<lh_campaign_id>"`, agent-owned. A hypothesis→campaign
  link must be a **separate table** (agent must not clobber it) with `on delete cascade`.
- **Cross-campaign person duplication is a known hazard** (`messenger-campaign-person-dupes`,
  `invite-count-leads-dedup` memories): the same person appears in multiple campaigns, so any
  cross-campaign metric must **dedupe by `leadKey`** or it inflates. Hypothesis stats aggregate
  across campaigns → this applies directly.
- **Playbook is the closest analog to ICP editing**: singleton `playbook` table (022), `POST
  /api/playbook` (`savePlaybook`, `ADMIN_SECRET`-guarded, now also hosts `save_search`/`delete_search`
  via an `action` field), `Playbook.tsx` editor, injected into the AI **coach** via
  `loadPlaybook()` → `systemFor(playbook)` (coach.ts:119/172). The richer CRUD analog is the
  **Search Library** (`saved_searches` + `SearchLibrary.tsx` + `savedSearch.ts` validator +
  `save_search` tool).
- **Vercel Hobby 12-function cap is already hit** (`frontend/api/` has exactly 12 `.ts` functions).
  → **No new API file.** Fold ICP/hypothesis writes into `playbook.ts`'s `action` dispatch.
- **AI schema knowledge = `SCHEMA_DOC` in `core.ts`** (consumed by `chat.ts`, `mcp.ts`,
  `briefing.ts`, `tools.ts get_schema`). Tools are defined once in `tools.ts toolDefs` and
  registered in both `chat.ts` and `mcp.ts` — **keep in sync** (documented invariant).
- **`leads.ts` toolkit to reuse**: `rangeTotals(leads, range, latest?)` computes the funnel over
  any `Lead[]`; `leadKey(instance_id, profile_url)` for dedup; `rangedCampaigns`, `presetRanges`,
  `weekStart` for cohort/range math. Hypothesis rollup = filter leads → dedupe by `leadKey` →
  `rangeTotals`. No new view needed.
- **DataContext** fetches everything once + every 5 min (delta on `updated_at`), exposes
  `useData()`. New small tables use the **tolerated-error** pattern (missing table → `[]`) like
  `saved_searches`/`team_members`. `upsertSavedSearch`/`removeSavedSearch` are the in-place-write
  template. Pages lazy-loaded in `App.tsx`; nav in `Layout.tsx` `LINKS`.
- **The sheet** = one ICP ("Web 2 Mob", web→mobile dev shop targeting wellness/health-tech):
  product context, company criteria (28 countries, headcount `5-50`, age `2015–2025`, Apollo
  industry list, dev-team availability/location), a ~130-term include-keyword list + a ~90-term
  exclude-keyword list, and **3 buyer personas** (Management / Product / Technical) each with job
  titles, age `25–50`, location "same as company office", LinkedIn activity rules (personal photo,
  `>250` connections, `<5000` followers).

## Decisions
1. **ICP storage = fully structured.** `icps` + `icp_personas` + `icp_industries`, all fields as
   typed columns/arrays; no Markdown escape hatch.
2. **ICP cardinality = multiple named, reusable.** `hypotheses.icp_id → icps.id` (one ICP ⇐ many
   hypotheses).
3. **Industry/keywords = both.** `icp_industries` = definition (industry + `include_keywords[]` /
   `exclude_keywords[]`); `saved_searches.hypothesis_id` = execution.
4. **Import = seed now, edit in-app.** Migration 043 seeds "Web 2 Mob" from the pulled sheet.
5. **Searches↔hypothesis** = `saved_searches.hypothesis_id` FK (many searches → one hypothesis).
6. **Hypothesis stats** = client-side rollup in `leads.ts`, **deduped by `leadKey`** across the
   hypothesis's campaigns.
7. **Campaign↔hypothesis** = a campaign belongs to **at most one** hypothesis
   (`hypothesis_campaigns` join, `unique(campaign_id)`).
8. **(refined) Prose sheet fields** — list-like fields (`purchase_triggers`, `features`,
   `apollo_industries`, `company_countries`, keyword lists, `job_titles`) are `text[]`
   (one item per element, chip-edited in UI); single-value prose (`background`, `funding`,
   `dev_team_availability`, `dev_team_location`, `company_headcount`, `company_age`,
   `product_stage`, `monetization`, personas' `location`/`profile_status`) are plain `text`.
   No rich text.
9. **(refined) Two keyword scopes coexist.** `icps.include_keywords`/`exclude_keywords` = the
   ICP-wide lists (seeded from the sheet). `icp_industries.*_keywords` = per-industry
   *refinements* (start empty; user fills). The UI labels them distinctly; there is **no**
   auto-merge — they are stored and shown separately (a `run_sql`/analyst can union them ad-hoc).

## Approach

### Data model (migration 043)
```
icps                     one row per ICP (seed: "Web 2 Mob")
  id bigint PK identity, name text  [unique(lower(name))], airtable_url text,
  main_product, core_sphere, secondary_sphere, product_stage, monetization, features_note text,
  purchase_triggers text[], features text[],
  company_countries text[], company_headcount text, company_age text,
  apollo_industries text[], funding text,
  dev_team_availability text, dev_team_location text,
  include_keywords text[], exclude_keywords text[],
  archived bool default false, created_at, updated_at

icp_personas             N per ICP (seed: management, product, technical)
  id, icp_id FK→icps on delete cascade, kind text,   -- free text label, not an enum
  job_titles text[], age_range text, location text, background text,
  profile_status text, connections_note text, followers_note text,
  sort int default 0, created_at, updated_at

icp_industries           N per ICP (definition side of "Both")
  id, icp_id FK→icps on delete cascade, name text,
  include_keywords text[] default '{}', exclude_keywords text[] default '{}',
  created_at, updated_at,  unique(icp_id, lower(name))

hypotheses
  id bigint PK identity, name text [unique(lower(name))],
  icp_id FK→icps on delete set null, description text,
  archived bool default false, created_at, updated_at

hypothesis_campaigns     join, at-most-one hypothesis per campaign
  hypothesis_id FK→hypotheses on delete cascade,
  campaign_id text FK→campaigns on delete cascade, created_at,
  primary key(hypothesis_id, campaign_id), unique(campaign_id)

saved_searches  += hypothesis_id bigint FK→hypotheses on delete set null
```
Every new table: RLS enable + `for select using (true)`, `grant select … to ai_sql_runner`,
`touch_updated_at` trigger, upsert-target unique index. Length `check()` caps on text fields and a
sane array-length guard mirroring `040`.

**Seed mapping (sheet → columns), same migration, idempotent `on conflict do nothing`:**

| Sheet row | Column |
|---|---|
| Companies & Leads search (airtable link) | `icps.airtable_url` |
| Main product | `main_product` |
| Core Sphere / Secondary Sphere | `core_sphere` / `secondary_sphere` |
| Product stage / Monetization | `product_stage` / `monetization` |
| Features | `features text[]` (split) |
| Purchase triggers (1..6) | `purchase_triggers text[]` |
| Company country | `company_countries text[]` (28 entries) |
| Company headcount / age | `company_headcount` / `company_age` |
| Industry (Apollo) | `apollo_industries text[]` **and** seed one `icp_industries` row per name |
| Funding | `funding` |
| Availability / location of dev team | `dev_team_availability` / `dev_team_location` |
| Keywords / Exclude Keywords | `icps.include_keywords[]` / `icps.exclude_keywords[]` |
| Buyer persona: Management/Product/Technical | 3 `icp_personas` rows (`kind`, `job_titles[]`, `age_range`, `location`, `profile_status`, `connections_note`, `followers_note`) |

### Write path (no new API file)
Extend `frontend/api/playbook.ts` `action` dispatch (service-role `db()`, `ADMIN_SECRET` guard):
`save_icp` / `delete_icp`, `save_icp_persona` / `delete_icp_persona`, `save_icp_industry` /
`delete_icp_industry`, `save_hypothesis` / `delete_hypothesis`, `set_hypothesis_campaigns`
(replace a hypothesis's campaign set atomically), `assign_search` (set/clear
`saved_searches.hypothesis_id`). Shared validators in new `frontend/api/_lib/icp.ts` (mirrors
`savedSearch.ts`): length/array caps, `set_hypothesis_campaigns` validates campaign ids exist.
Client calls via existing `adminPost()`.

### AI layer
- **`SCHEMA_DOC` (core.ts)**: add a TABLES block for all new tables + `saved_searches.hypothesis_id`,
  plus ANALYSIS GUIDANCE: *hypothesis funnel = `hypothesis_campaigns` → `campaigns` → `leads`;
  **dedupe people across campaigns**; replies lag invites (reuse cohort rules).*
- **New tool `hypothesis_overview`** (+ optional `icp_overview`): `SQL` const in `core.ts`,
  `toolDefs` entry in `tools.ts`, `tool({…executeSql})`, and `server.tool(…)` in `mcp.ts` — both
  surfaces in sync. Returns per-hypothesis ICP name + invited/connected/replied + rates.
- **Chat (`chat.ts`)**: two-tier access — (a) always-on: inject a **compact ICP+hypothesis roster**
  into `SYSTEM` (names + one-line summary each, cheap) so the copilot is ICP-aware without a tool
  call; (b) depth on demand via `run_sql` / `hypothesis_overview`.
- **Coach (`coach.ts`)**: build a `campaign_id → ICP text` map once (via `hypothesis_campaigns` →
  `hypotheses` → `icps`/`personas`/`industries`, formatted compact) and append the ICP for the
  conversation's campaign into the system prompt alongside the playbook — extend
  `loadPlaybook`/`systemFor(playbook, icpText)`. Per-conversation, so only the matching ICP.

### Frontend
- `types.ts`: `Icp`, `IcpPersona`, `IcpIndustry`, `Hypothesis`, `HypothesisCampaign`; extend
  `DashboardData` + `EMPTY`.
- `DataContext.tsx`: fetch the 5 new tables (tolerated-error), add to `setData`/`stableSlice`;
  add `upsertIcp`/`removeIcp`/`upsertHypothesis`/`removeHypothesis`/`assignCampaigns` mutators
  (mirror `upsertSavedSearch`).
- **`leads.ts` — `hypothesisTotals(hyp, hypCampaigns, leads, range?, latest?)`**: select the
  hypothesis's `campaign_id`s → filter leads → **dedupe by `leadKey`** → `rangeTotals`. Also
  `hypothesisCampaignBreakdown()` for the per-campaign table.
- **ICP page** (`pages/Icp.tsx`, route `/icp`, nav in `Layout.tsx`, `Target`/`Crosshair` icon):
  ICP list + structured editor with sections — Product context, Company criteria, ICP keyword
  chips, **Personas** (add/remove sub-forms), **Industries** (add/remove, each with its own
  include/exclude keyword chips). Reuse Search Library's chip input.
- **Hypotheses page** (`pages/Hypotheses.tsx`, route `/hypotheses`, nav, `FlaskConical` icon):
  list + create/edit (name, pick ICP, multi-select campaigns, attach searches) + **analytics**
  (below).

### Hypothesis analytics (the payoff)
Per hypothesis, computed client-side from `leads.ts`:
- **Funnel card**: invited → connected → replied counts + connect-rate / reply-rate, **deduped by
  `leadKey`** across its campaigns; date-range filter (reuse `presetRanges`).
- **Per-campaign breakdown** table (which campaigns under the hypothesis drive results).
- **Comparison view**: a sortable table of all hypotheses side-by-side (ICP, #campaigns, #leads,
  connect%, reply%) so hypotheses can be ranked.
- Cohort caveat surfaced in UI copy (recent invite cohorts still maturing — CLAUDE.md funnel rule).

## Implementation phases
1. **Migration 043 + seed** (M) — tables, RLS, grants, triggers, indexes,
   `saved_searches.hypothesis_id`, seed Web 2 Mob per the mapping table. Verify via `db push` + `select`.
2. **AI read layer** (M) — `SCHEMA_DOC`, `hypothesis_overview` in `core.ts`/`tools.ts`/`mcp.ts`,
   chat roster injection, coach ICP injection.
3. **Write endpoint + validators** (M) — `playbook.ts` actions + `_lib/icp.ts`; `adminPost` round-trip.
4. **Frontend data layer** (M) — types, DataContext fetch + mutators, `leads.ts` rollup helpers.
5. **ICP page** (L) — structured editor with dynamic personas/industries + chip inputs.
6. **Hypotheses page + analytics** (M/L) — assignment UI + funnel/breakdown/comparison.

Phases 1→2→3 are backend, independently shippable; 4 unblocks 5 & 6.

## Affected files/modules
- `supabase/migrations/043_icp_and_hypotheses.sql` *(new)*
- `frontend/api/playbook.ts`, `frontend/api/_lib/icp.ts` *(new)*, `frontend/api/coach.ts`
- `frontend/api/_lib/core.ts`, `frontend/api/_lib/tools.ts`, `frontend/api/mcp.ts`, `frontend/api/chat.ts`
- `frontend/src/lib/types.ts`, `frontend/src/lib/DataContext.tsx`, `frontend/src/lib/leads.ts`,
  `frontend/src/lib/admin.ts` (if new call helpers)
- `frontend/src/pages/Icp.tsx` *(new)*, `frontend/src/pages/Hypotheses.tsx` *(new)*,
  `frontend/src/App.tsx`, `frontend/src/components/Layout.tsx`

## Risks & how to verify
- **Inflated hypothesis stats from cross-campaign dupes** (known hazard): `hypothesisTotals`
  dedupes by `leadKey`. Verify: a person in two of a hypothesis's campaigns counts once; spot-check
  a hypothesis total ≤ sum of its campaign totals.
- **AI can't read new tables** (034 fail-closed): `grant select … to ai_sql_runner` on every table.
  Verify: chat `run_sql select count(*) from icps` succeeds, not permission-denied.
- **Delta-refresh breakage**: `touch_updated_at` on every table. Verify: edit an ICP → DataContext
  picks it up within a refresh, no full reload.
- **Agent re-sync clobbering assignments**: link lives in `hypothesis_campaigns`, not on
  `campaigns`; agent has no reference. Verify: `grep hypothesis sync-agent/agent.py` → none.
- **Vercel 12-cap**: no new `frontend/api/*.ts`. Verify: `ls frontend/api/*.ts | grep -v _lib | wc -l` == 12.
- **api not typechecked by `npm run build`**: typecheck `frontend/api` separately (per memory).
- **chat/mcp tool drift**: `hypothesis_overview` added to both. Verify: `/api/mcp` `tools/list`
  and chat both expose it.
- **Seed fidelity**: long keyword arrays — verify seeded counts match the sheet (~130 include /
  ~90 exclude, 28 countries, 3 personas).

## Definition of done
- [ ] `supabase db push` applies 043 cleanly; `icps`/`icp_personas`/`icp_industries` seeded with
      "Web 2 Mob" + 3 personas + Apollo industries; `hypotheses`, `hypothesis_campaigns`,
      `saved_searches.hypothesis_id` exist with RLS, grants, triggers.
- [ ] Chat is ICP-aware without a tool call (roster in prompt) and can answer "funnel by hypothesis"
      via `hypothesis_overview`/`run_sql`; AI coach references the conversation's ICP.
- [ ] `/icp` lists ICPs and fully edits every field incl. dynamic personas and per-industry
      include/exclude keywords; saves via `ADMIN_SECRET`-guarded `playbook.ts` action, reflects in-place.
- [ ] `/hypotheses` creates a hypothesis, picks an ICP, assigns campaigns + searches, and shows a
      **leadKey-deduped** funnel, per-campaign breakdown, and cross-hypothesis comparison.
- [ ] `npm run build` passes; `frontend/api` typechecks; `frontend/api/*.ts` count still 12.
- [ ] No sync-agent changes; assignments survive a re-sync.
```
