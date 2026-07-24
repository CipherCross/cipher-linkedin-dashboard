# Search Library (shared sourcing searches) + Lead Demographics (age/gender) + Lead Photos

> **Lifecycle correction (2026-07-24):** migration 048 supersedes this
> document's original shared `demo_inferred_at` lifecycle and narrow age formula.
> Age is now database-derived whenever source years change, using the intersection
> of broad education/first-job ranges; gender has an independent, versioned stamp
> and fair per-account backlog. The original sections below remain as the historical
> design record for migrations 041/042.

## Goal

Three additions to the dashboard:

1. **Search Library** — a shared database of named sourcing searches (Apollo, Sales
   Navigator, esun, …) so data sourcers can share filter setups without screen-share
   calls. Browsable/editable on the site, queryable from the Chat copilot, and the AI
   gets a write tool to create and modify searches conversationally.
2. **Lead demographics** — inferred age range and gender per lead (from name,
   headline, university start year, first-job start year — **no photo inference**),
   with confidence, SDR manual override for gender, and demographic stats/filters in
   the UI.
3. **Lead photos** — the sync agent uploads each lead's profile photo from the
   notebooks to Supabase Storage so the UI can show avatars (faster visual lead
   identification in lists and conversations). Display-only; never an inference input.

## Non-goals

- **Photo-based inference** — dropped. Conflicts with Anthropic's usage policy
  (biometric categorization of non-consenting people). Photos ARE synced for UI
  display (Feature 3), but they are never passed to any model — a hard rule, not an
  implementation detail.
- Executing saved searches against the platforms (no Apollo/SalesNav API integration —
  this is a settings *database*, sourcers apply the settings by hand).
- Authentication/authorization overhaul. The app stays read-open + `ADMIN_SECRET`
  writes; the only new auth surface is bearer-gating write tools on `/api/mcp`.
- Non-binary gender modeling beyond `unknown`. Values: `male` / `female` / `unknown`
  (+ confidence + manual override), per the request.
- Age inference shipping before the LH2 data probe (user chose one rollout, probe first).
- Search version history / edit audit log (`updated_at` only; revisit if sourcers
  overwrite each other in practice).

## Research findings

*(Codebase claims below verified by direct file reads, not just the research pass.)*

- **Migrations**: latest is `039` (still unpushed — memory: push 039 before/with new
  ones). Conventions: bigint identity PK, RLS enable + `using (true)` select policy,
  shared `touch_updated_at()` trigger (031). New tables are auto-SELECT-granted to
  `ai_sql_runner` (021 default privileges) → instantly queryable via chat's `run_sql`.
- **AI layer**: `toolDefs` in `frontend/api/_lib/tools.ts:22` is the single registry
  (name/description/zod `inputShape`); the `tools` export (`:77`) wraps it for the AI
  SDK, and `chat.ts` consumes `tools` wholesale — a tool added there appears in chat
  with no chat.ts change. `mcp.ts` registers each tool manually from `toolDefs` inside
  `createMcpHandler`'s callback (`mcp.ts:27-63`) — registration happens **once at
  module scope**, so per-request write gating requires two prebuilt handlers, not a
  per-tool check. `SCHEMA_DOC` (`core.ts`) is the model's only schema knowledge.
  `ai_execute_sql` is SELECT-only and must not be loosened; AI writes go through the
  tool's `execute` calling service-role `db()` directly.
- **`/api/chat` is itself unauthenticated** (open POST). Any write tool in `tools` is
  therefore an open write path via chat regardless of MCP gating — acceptable only
  because the tool's blast radius is bounded (validated columns on one table, size
  caps, soft-delete only). Hard delete stays behind `ADMIN_SECRET`.
- **Write-endpoint prior art** (`playbook.ts`, `pipeline.ts`, both read directly):
  `ADMIN_SECRET` via `x-admin-secret` header, open when unset; `pipeline.ts` is the
  action-dispatch template (`switch (payload.action)` with per-action validators,
  `json()` helper, explicit 400/404/500s). `playbook.ts` today accepts only
  `{content}` — extending it with `action` dispatch is backward-compatible.
- **Vercel Hobby 12-function cap**: `frontend/api/` has exactly 12 function files.
  No new files — fold into existing endpoints.
- **classify.ts** (read directly): Haiku `claude-haiku-4-5`, `BATCH=60`/`GROUP=10`,
  selects `sentiment IS NULL` rows, `generateObject` with a `ref`-validated results
  array (in-range, no duplicates — hallucinated refs can't hit the wrong row), writes
  `classified_model`, then best-effort `autoAdvancePipeline` even on empty batch.
  GET is `CRON_SECRET`-guarded, POST deliberately open (self-limiting). This is the
  exact template for the demographics job, including where a second phase hangs.
- **Human override prior art**: `reclassify.ts` writes `classified_model='manual'`;
  batch job filters on NULL so overrides are never re-touched.
- **DataContext** (read directly): `LEAD_COLUMNS_BASE` + pipeline columns in
  `LEAD_COLUMNS`; `fetchAllLeads` retries **once, straight to BASE** on a
  missing-column error (`DataContext.tsx:46-69`) — adding demographics columns
  naively would make a demo-migration-pending DB silently lose the pipeline columns
  too. Needs a retry ladder. Small tables load in `smallP` (`:287-316`);
  `team_members` shows the tolerated-error pattern (missing table → empty list, not a
  failed load).
- **Sync agent** (read directly): talks to Supabase with raw `requests` (no SDK) —
  self-update already GETs `/storage/v1/object/agent/agent.py` with the service key
  (`agent.py:171`), so photo upload is the same plumbing, different verb/bucket. All
  post-sync extras (`notify_new_replies`) swallow every failure. `config.example.yaml`
  documents that LinkedIn media URLs (`media.licdn.com`) are signed and **expire after
  a few weeks** (`:57-59`), and the optional `owner` mapping already refreshes the
  account avatar each sync — precedent for treating LinkedIn image URLs as perishable.
  Leads come from `person_in_campaigns_history` + deduped `person_external_ids` +
  `person_original_mini_profile` (only `full_name`/`headline` mapped today); whether
  LH2 stores education/positions/photos is build-dependent → probe with
  `agent.py inspect`. Current agent version 1.11.0.
- **Name→gender accuracy** (external): ~90–95% on Western names, poor on East-Asian
  names/initials — confidence + `unknown` + human override is accepted practice.
- **Saved-search shape** (external): Sales Navigator = boolean AND/OR/NOT keyword
  strings + structured include/exclude facets; Apollo = named shareable searches with
  titles/location/seniority/technology/keyword filters. Platforms differ too much for
  column-per-filter → a few first-class columns + flexible `jsonb`.

## Decisions

| Question | Answer |
|---|---|
| Photo signal for age/gender inference? | **Dropped** (AUP conflict). Text signals only. |
| Age inputs given missing education/job data? | **Wait for LH2 probe first** — one rollout after `agent.py inspect` shows what's extractable. No name-only interim release. |
| Where does the AI write tool live? | **Chat AND MCP** — MCP write capability gated by `Authorization: Bearer <ADMIN_SECRET>`; unauthenticated MCP clients see read-only tools. |
| Where do demographics surface? | **All three**: lead rows with editable gender (LeadsExplorer + ConversationDrawer), per-campaign demographics charts (CampaignDetail), LeadsExplorer filters. |
| Lead photos? (added after initial plan) | **Sync from notebooks for UI display** — agent captures avatar bytes at sync time into Supabase Storage (URLs expire; bytes are the deliverable). Never used for inference. |

Defaults adopted without asking (flag if wrong):

- **Filter model**: hybrid — `include_keywords text[]`, `exclude_keywords text[]`,
  free-form `boolean_query text`, `filters jsonb` for platform-specific settings,
  free-text `notes`. `platform` is free text with UI suggestions (Apollo / Sales
  Navigator / esun), not a hard enum — "and others" rules out an enum.
- **Author attribution**: free-text `author` (no auth to derive it from); same
  convention as `lead_notes.author` / pipeline `actor`.
- **Delete semantics**: AI and page can `archive` (soft, reversible); hard delete is a
  page-only, `ADMIN_SECRET`-guarded action.
- **Age storage**: `birth_year_min`/`birth_year_max` ints (stable over time; UI
  renders "≈30–35" from the current year). Deterministic math, no model: education
  start → birth ∈ [start−19, start−18]; else first job start → [start−23, start−21];
  sanity window 1930 ≤ birth ≤ (current year − 15), else NULL.
- **Only gender uses a model** (Haiku, name + headline text). Age is arithmetic.
- **Endpoint folding** (12-function cap): Search Library CRUD → `/api/playbook`
  (action dispatch, back-compatible); demographics inference → `/api/classify` second
  phase; gender override → `/api/pipeline` `set_gender` action; photo upload → agent
  writes Storage directly (no endpoint at all).
- **Photo storage**: public bucket `lead-photos` (read-open posture; these avatars are
  public on LinkedIn), path `<instance_id>/<sanitized_slug>.jpg`, uploaded by the
  agent with its service key.

## F2a probe findings (2026-07-20, notebook-1, LH2 2.122.3, DB schema v214)

Probe ran read-only against a copy of notebook-1's `lh.db` (account 524650; 1 675 people).
Distilled facts that shape F2b/F2c/F3a:

- **Education**: `person_education(person_id → people.id, school_name, start_year int,
  start_month int|null, …)`, one row per school. Use `MIN(start_year) WHERE start_year > 0`.
  Coverage: 75% of persons have a parseable start year; `start_month` often NULL — use the
  year only.
- **Positions**: `person_positions(person_id, title, start ISO-text, start_year int,
  is_default, …)`. FULL job history (avg 8.5 rows/person, max 40); `is_default=1` marks the
  current role. Use integer `start_year` directly (ignore the ISO `start` text).
  `MIN(start_year)` = first job. Coverage: 95%.
- **Garbage years exist** (1900/1970 placeholders; observed range 1900–2026): reject
  `start_year < 1950` or `> current year` BEFORE taking MIN (agent-side), in addition to the
  1930-floor birth-year sanity window in the inference job.
- **Join**: both tables key on the same `people.id` space as
  `person_external_ids.person_id`; the existing one-public-slug-per-person dedup CTE
  (`type_group='public'`, prefer non-`AC…`, `rowid DESC`) covers 1 625/1 675 persons and
  joins all three signals cleanly (verified with a 10-row proof query).
- **Photos**: `person_original_mini_profile.avatar` = 800×800 licdn URL (**prefer**);
  `person_mini_profile.avatar` = 100×100 fallback. ~97% coverage. **No local image cache
  exists** (0 usable image files on disk) and stored URLs are signed + expiring (a stored
  test URL already 403s) → download at sync time from a fresh DB read and mirror the bytes
  to Storage, exactly as the spec's F3a assumes. One person lacks a mini-profile row →
  LEFT JOIN and tolerate NULLs.
- `person_certifications` / `person_volunteers` carry start-year columns but are EMPTY on
  this build — do not wire up.
- A second `lh.db` on the machine (account 524178) is near-empty; extraction stays pointed
  at the configured `lh2_db_path` — no multi-DB discovery needed.

## Approach

### Feature 1 — Search Library

**Migration 040 — `saved_searches`:**

```sql
create table saved_searches (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 120),
  platform text not null check (char_length(platform) between 1 and 60),
  description text,
  include_keywords text[] not null default '{}',
  exclude_keywords text[] not null default '{}',
  boolean_query text,              -- free-form AND/OR/NOT string, pasteable into the platform
  filters jsonb not null default '{}'::jsonb,  -- platform-specific settings, key -> value
  notes text,
  author text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index saved_searches_platform_name on saved_searches (platform, lower(name));
-- RLS: enable + "read saved_searches" for select using (true)   (001 convention)
-- trigger touch_saved_searches_updated_at → public.touch_updated_at()   (031 convention)
```

The unique `(platform, lower(name))` index gives the AI tool and the page a natural
upsert target and stops silent same-name duplicates.

**`/api/playbook` action dispatch** (back-compatible; adopts `pipeline.ts`'s switch
shape). All actions `ADMIN_SECRET`-guarded exactly as today:

- `POST {content}` — unchanged legacy playbook save (no `action` key → old path).
- `POST {action:'save_search', search:{id?, name, platform, description?,
  include_keywords?, exclude_keywords?, boolean_query?, filters?, notes?, author?,
  archived?}}` — insert when `id` absent, update when present. Returns `{ok, search}`
  (the full row) so the page can merge without refetch. 404 on unknown id, 409 on
  (platform, name) collision.
- `POST {action:'delete_search', id}` — hard delete. Page-only; the AI tool cannot
  reach this.

Validation caps (shared constants, used by both the endpoint and the AI tool):
name ≤120, platform ≤60, description/notes ≤2 000 each, ≤50 keywords per array ×
≤120 chars each, boolean_query ≤5 000, `filters` — flat object, ≤40 keys,
string/number/boolean/string[] values, serialized ≤20 000 bytes, author ≤100.

**AI tool `save_search`** (in `toolDefs` + `tools`; chat picks it up automatically):

```ts
inputShape: {
  id: z.number().int().positive().optional()
    .describe('Omit to create; pass to modify an existing search.'),
  name: z.string().min(1).max(120),
  platform: z.string().min(1).max(60)
    .describe("e.g. 'Apollo', 'Sales Navigator', 'esun' — free text"),
  description: z.string().max(2000).optional(),
  include_keywords: z.array(z.string().max(120)).max(50).optional(),
  exclude_keywords: z.array(z.string().max(120)).max(50).optional(),
  boolean_query: z.string().max(5000).optional()
    .describe('Platform-syntax boolean string, e.g. ("VP Sales" OR "Head of Sales") NOT intern'),
  filters: z.record(z.union([z.string(), z.number(), z.boolean(),
    z.array(z.string())])).optional(),
  notes: z.string().max(2000).optional(),
  author: z.string().max(100).optional()
    .describe('Who this search belongs to, if the user said'),
  archived: z.boolean().optional(),
}
```

`execute` writes via service-role `db()` (the `ai_execute_sql` guard stays untouched)
with the same caps, and returns the saved row. Update semantics: only provided fields
change (partial patch). Tool description tells the model to `run_sql` the existing
row first when modifying, and to confirm details with the user before creating.
No separate read tool — `run_sql` reaches the table automatically; `SCHEMA_DOC` gains
a `saved_searches` section (columns, "the live set is archived=false", "searches are
platform recipes, not query history").

**MCP gating** (`mcp.ts`): build two handlers at module scope —
`readOnlyHandler` (today's five tools) and `adminHandler` (same + `save_search`).
Exported `GET/POST/DELETE` check
`req.headers.get('authorization') === 'Bearer ' + process.env.ADMIN_SECRET` and
dispatch; unset `ADMIN_SECRET` → always read-only (fail closed, unlike the HTTP
endpoints — an open MCP write path is not acceptable even on an unconfigured
project). Comment documents the deliberate read/write split in the shared-tools
convention.

**Chat-side note**: `/api/chat` is open, so `save_search` via chat is an
unauthenticated write. Accepted (auth deferral is the project's standing posture)
because the tool is bounded: one table, validated fields, size caps, no delete.
Documented in the tool's comment so a future auth pass knows to revisit.

**Frontend — `SearchLibrary.tsx`** (route `/searches`, nav "Searches" in
`Layout.tsx`, lazy import in `App.tsx`):
- List: cards grouped by platform, platform filter chips, text search over
  name/description/keywords, archived toggle (hidden by default).
- Detail/edit: form matching the schema — tag-style inputs for keyword arrays,
  textarea for `boolean_query` with a **copy button** (the whole point is pasting
  into the platform fast), key→value rows editor for `filters`, notes, author.
- Saves via `adminPost('/api/playbook', {action:'save_search', search})` (existing
  401→prompt→retry flow); archive = same action with `archived:true`; hard delete
  behind a confirm.
- Data: `saved_searches` joins `smallP` in `DataContext.tsx` with the
  `team_members`-style tolerated error (missing table → `[]`, never a failed load);
  `SavedSearch` type in `types.ts`; `DashboardData.savedSearches`.

### Feature 2 — Lead demographics

**Phase 0 — probe (blocking, user-assisted)**: run `python3 agent.py inspect` on ≥1
notebook per LH2 version. Looking for: education tables (school + start year),
position/experience tables (job start years), and avatar URL columns / local image
cache (feeds Feature 3). Record findings in this spec before F2b starts. If
education/positions are absent on all builds, age ships as mostly-NULL and the UI
copy says "insufficient data" rather than guessing from headline text.

**Migration 041 — `leads` columns:**

```sql
alter table leads
  add column education_start_year  int  check (education_start_year  between 1950 and 2100),
  add column first_job_start_year  int  check (first_job_start_year  between 1950 and 2100),
  add column birth_year_min        int,
  add column birth_year_max        int,
  add column gender                text check (gender in ('male','female','unknown')),
  add column gender_confidence     real check (gender_confidence between 0 and 1),
  add column demo_inferred_at      timestamptz,
  add column demo_model            text;   -- 'claude-haiku-4-5' | 'manual'
```

No view changes: campaign charts compute client-side from leads (matches how
`leads.ts` already derives range metrics). `SCHEMA_DOC` documents the columns +
"demo_model='manual' means an SDR-reviewed override; migration 048 later clarified
that this prevents re-inference but does not prove self-identified gender".

**Sync agent**: new built-in fail-safe queries (the `STEP_*_SQL` pattern — empty
result on schema drift, never an exception) producing per-lead
`education_start_year` / `first_job_start_year`, shaped by whatever the probe found;
per-notebook `mapping:` override hook like `messages`. Values merge into the leads
upsert. Guard: the milestone-protection trigger idea (026) doesn't apply here, but
re-sync must not clobber — agent sends these columns only when non-NULL.
Verify with `sync --dry-run` per notebook flavor before `deploy.sh` (user-run).

**Inference — second phase in `classify.ts`** (runs after sentiment, both GET and
POST paths, and also when the sentiment batch is empty — same slot as
`autoAdvancePipeline`):

- Select `id, full_name, headline, education_start_year, first_job_start_year` where
  `demo_inferred_at IS NULL`, capped `DEMO_BATCH=100`, oldest `added_at` first.
  **Never selects photo columns — the no-photos-to-models rule is enforced here.**
- Age: deterministic math per the decision table above; written regardless of what
  gender inference does.
- Gender: `generateObject` (Haiku, groups of 25) over `{ref, full_name, headline}`;
  prompt requires `unknown` with low confidence when the name is ambiguous,
  initials-only, or from a naming culture the model can't call reliably. Same
  ref-validation as sentiment (in-range, deduped).
- Write `birth_year_min/max, gender, gender_confidence, demo_inferred_at=now,
  demo_model=MODEL` per lead. Leads with no name AND no year signals still get
  `demo_inferred_at` stamped (gender='unknown') so the job converges to a no-op.
- Idempotent: filters on `demo_inferred_at IS NULL`, so re-runs and the daily cron
  never re-touch processed or manual rows. Response gains `{demographics: n}`.

**Override — `set_gender` action in `pipeline.ts`** (admin-guarded like all its
actions): `{action:'set_gender', lead_id, gender: 'male'|'female'|'unknown'|null,
actor?}`. Non-null → writes `gender, gender_confidence=1, demo_model='manual',
demo_inferred_at=now`. `null` → clears all five demographic inference fields so the
next classify run re-infers (undo). No pipeline_events row (not a pipeline change).

**UI** (dedupe by `leadKey` for any cross-campaign aggregate — memory:
notebook-1:4 duplicates people across campaigns):
- `DataContext.tsx`: extend `LEAD_COLUMNS` with the new columns via a **retry
  ladder** — full list → pipeline list → base — replacing today's single fall-to-BASE
  retry, so a DB with pipeline-but-not-demo migrations keeps its pipeline columns.
  `Lead` type gains the optional fields.
- LeadsExplorer: "Age" (rendered range, e.g. "30–35") and "Gender" columns (e.g.
  "F ·72%", tooltip "inferred by AI — click to confirm"; manual rows show "F ✓");
  filter dropdowns for gender and age bucket.
- ConversationDrawer: demographics line + inline gender select →
  `adminPost('/api/pipeline', {action:'set_gender', …})`, optimistic patch via the
  existing `patchLead`.
- CampaignDetail: age histogram (5-year buckets from birth-year midpoint) + gender
  split bar, leadKey-deduped, "n unknown" shown explicitly rather than dropped.

**Ethics note (in-product)**: labels are statistical inferences for internal outreach
analytics; always rendered as inferred-with-confidence until an SDR confirms;
name-based gender skews inaccurate for non-Western names — `unknown` is a
first-class value, not a failure.

### Feature 3 — Lead photos (UI display only)

**Migration 042:**

```sql
insert into storage.buckets (id, name, public)
values ('lead-photos', 'lead-photos', true)
on conflict (id) do nothing;

alter table leads
  add column photo_path      text,        -- bucket-relative: <instance_id>/<slug>.jpg
  add column photo_synced_at timestamptz;
```

Public bucket read needs no storage RLS policy; agent writes use the service key
(bypasses RLS).

**Sync agent — `sync_photos` step** (after the leads push; every failure swallowed,
`notify_new_replies` pattern; config toggle `sync_photos: true`, added to
`REMOTE_CONFIG_KEYS` so it's Health-page controllable):
- Candidates: this instance's leads with `photo_synced_at IS NULL`, capped
  `PHOTO_CAP=200` per run so the initial backfill spreads over a few scheduled syncs.
- Source per lead, from the Phase 0 probe: LH2's local image cache file if one
  exists, else HTTP-download the mini-profile avatar URL **at sync time, while the
  signed URL is fresh** (they expire in weeks — a stored URL is worthless, bytes are
  the deliverable). 10 s timeout per download; dead/missing avatar → mark
  `photo_synced_at` anyway with `photo_path` NULL (skip quietly, converge; a future
  `--refresh-photos` flag can re-attempt).
- Upload: `POST {supabase_url}/storage/v1/object/lead-photos/{instance_id}/{slug}.jpg`
  with `Authorization: Bearer <service_key>`, `x-upsert: true`,
  `content-type: image/jpeg` — same raw-`requests` plumbing as self-update, different
  bucket/verb. Then PATCH the lead's `photo_path` + `photo_synced_at`.
- `slug` = the lead's own deduped `profile_url` slug (the `pei.external_id` the leads
  mapping already selects), sanitized to `[A-Za-z0-9_-]` (percent-decode, replace the
  rest) — derived from the **leads** table's slug so the path always joins back to
  the row that references it (memory: leads vs messages slugs can differ).
- Agent version bump; `deploy.sh` + fleet self-update (user-run).

**Frontend**: `leadPhotoUrl(lead)` helper in `leads.ts` →
`{VITE_SUPABASE_URL}/storage/v1/object/public/lead-photos/{photo_path}`, null-safe.
Small `Avatar` component (photo, initials fallback from `full_name`, fixed sizes)
used in LeadsExplorer rows, ConversationDrawer header, Pipeline cards.
`photo_path,photo_synced_at` join the demographics rung of the `LEAD_COLUMNS` ladder
(they ship in adjacent migrations; one rung covers both).

**Hard rule**: `photo_path` never appears in any model input. The classify
demographics query selects text columns explicitly (no `select *`), and the
SCHEMA_DOC entry for `photo_path` says "UI display only — never fetch for
inference/classification".

## Implementation phases

1. **F1a — schema + SCHEMA_DOC** (S): migration 040; `saved_searches` section in
   `SCHEMA_DOC`. *Verify*: `run_sql` from chat can select the table; unique index
   rejects a duplicate (platform, name).
2. **F1b — CRUD + AI tool + MCP gating** (M): `playbook.ts` dispatch; shared
   validation module; `save_search` in `tools.ts`; dual-handler `mcp.ts`. *Verify*:
   legacy `{content}` still saves; bad payloads 400; unauthenticated MCP lists 5
   tools, bearer-authed lists 6; `frontend/api` typechecks (separate `tsc`, memory:
   build skips api/); file count still 12.
3. **F1c — Search Library page** (M): page, route, nav, DataContext + types.
   *Verify*: create/edit/archive round-trips; renders on a DB without migration 040
   (empty state, no crash); copy-button copies boolean_query verbatim.
4. **F2a — LH2 probe** (S, user-assisted; blocks F2b and F3a): `inspect` per LH2
   version; findings recorded in this spec (education, positions, photo source).
5. **F2b — schema + agent extraction** (M): migration 041; built-in year queries +
   mapping override hook; `sync --dry-run` per notebook flavor. *Verify*: dry-run
   year counts are plausible (spot-check 10 leads against LH2 UI); drifted-schema
   notebook syncs clean with empty years.
6. **F2c — inference job** (M): demographics phase in `classify.ts`. *Verify*:
   two consecutive runs → second is a no-op; spot-check ~30 leads for gender
   plausibility and confidence spread; rows with `demo_model='manual'` untouched;
   payload provably contains no photo fields.
7. **F2d — override + UI** (M/L): `set_gender`; retry-ladder in DataContext;
   LeadsExplorer columns/filters; ConversationDrawer editor; CampaignDetail charts.
   *Verify*: override survives a sync + a classify run; `null` gender re-infers;
   pre-041 DB still shows pipeline columns (ladder works); chart totals ≤ unique
   leadKey count.
8. **F3a — photo sync** (M): migration 042; agent `sync_photos`; one-notebook
   verification before fleet deploy. *Verify*: sync duration stays sane with the
   cap; `photo_synced_at` count grows across runs; a dead avatar URL doesn't error
   the sync; re-run doesn't re-upload.
9. **F3b — avatars in UI** (S): helper + `Avatar` component, wired into
   LeadsExplorer / ConversationDrawer / Pipeline. *Verify*: initials fallback for
   NULL `photo_path`; no layout shift; public URL loads without auth.

F1 (1–3), F2 (4–7), F3 (8–9) are independently shippable tracks; F2a's probe also
feeds F3a. Migrations 040/041/042 queue behind unpushed 039 — all `supabase db push`
/ `deploy.sh` / Vercel deploys are user-run (memory: no prod push without ask).

## Affected files/modules

- `supabase/migrations/040_saved_searches.sql`, `041_lead_demographics.sql`,
  `042_lead_photos.sql` (new)
- `frontend/api/_lib/core.ts` (SCHEMA_DOC), `_lib/tools.ts` (+ shared saved-search
  validation, importable by playbook.ts), `mcp.ts` (dual handler), `playbook.ts`
  (action dispatch), `classify.ts` (demographics phase), `pipeline.ts` (`set_gender`)
- `frontend/src/pages/SearchLibrary.tsx` (new), `LeadsExplorer.tsx`,
  `CampaignDetail.tsx`, `Pipeline.tsx`; `components/ConversationDrawer.tsx`,
  `components/Layout.tsx`, `components/Avatar.tsx` (new); `src/App.tsx`;
  `src/lib/DataContext.tsx` (smallP + LEAD_COLUMNS ladder), `types.ts`, `leads.ts`
  (photo URL helper, age-range render helper)
- `sync-agent/agent.py` (year extraction, `sync_photos`, version bump,
  `REMOTE_CONFIG_KEYS`), `config.example.yaml` (document `sync_photos` + year
  mapping hook)

## Risks & how to verify

- **LH2 lacks education/position/photo data** → age mostly NULL, photos absent.
  Mitigated by probing first (decided); the schema and UI degrade gracefully
  (explicit "unknown"/initials states) either way.
- **MCP gating regression** exposes a public write path. Fail-closed design (no
  `ADMIN_SECRET` → read-only); verify tool lists with and without the bearer header
  after every mcp.ts change.
- **Open chat write path**: `save_search` callable by anyone who can POST
  `/api/chat`. Accepted under the project's deferred-auth posture; bounded to one
  table with caps and no hard delete; comment marks it for the future auth pass.
- **12-function cap**: no new `frontend/api/*.ts` top-level files; verify count = 12.
- **`npm run build` doesn't typecheck `api/`** — run `tsc` on `frontend/api`
  separately after every server change.
- **LEAD_COLUMNS fallback**: without the retry ladder, a pre-041 DB would lose
  pipeline columns when the demo columns 400. Ladder is part of F2d's definition;
  verify against a DB without 041/042.
- **Agent regression**: new extraction/photo code must be fail-safe (empty/skip on
  drift, all photo errors swallowed) — a photo or year failure must never break a
  scheduled sync. Verify `sync --dry-run` per notebook before real sync; watch
  `sync_runs` after fleet deploy.
- **Photo sync load**: thousands of downloads on first backfill — `PHOTO_CAP=200`
  spreads it; verify sync duration stays acceptable on the busiest notebook.
- **Slug mismatch** (memory): `photo_path` derives from the leads table's own slug,
  so the join can't miss; messages-side slugs are irrelevant here.
- **Photos leaking into inference**: enforced by explicit column selects in
  classify + SCHEMA_DOC warning; re-check at F2c review.
- **Gender accuracy/ethics**: confidence + `unknown` + override + "inferred"
  labeling; spot-check ~30 leads across naming cultures before trusting charts.
- **Cross-campaign double counting**: demographics charts dedupe by `leadKey`;
  verify totals ≤ unique lead count (memory: notebook-1:4).
- **Concurrent edits in Search Library**: last-write-wins on a shared row; accepted
  for now (non-goal notes version history as the future answer).

## Definition of done

- [ ] `saved_searches` live; RLS read-open; documented in `SCHEMA_DOC`; duplicate
      (platform, name) rejected.
- [ ] Search Library page: create, edit, archive, hard-delete (confirmed + admin),
      filter by platform, copy boolean query; admin-secret flow identical to Playbook.
- [ ] Chat answers "what searches do we have for Apollo?" via `run_sql` and
      creates/modifies a search via `save_search` on request.
- [ ] Unauthenticated `/api/mcp` lists no write tool; bearer-authed MCP does; unset
      `ADMIN_SECRET` → MCP read-only.
- [ ] LH2 probe findings recorded; education/first-job start years synced where LH2
      provides them; `sync --dry-run` verified per notebook flavor.
- [ ] Demographics job fills birth-year range + gender/confidence for unprocessed
      leads; converges to no-op; never touches `demo_model='manual'` rows; model
      input contains no photo data.
- [ ] SDR corrects gender from ConversationDrawer; correction survives re-sync and
      re-classification; clearing re-infers.
- [ ] LeadsExplorer shows/filters age range + gender; CampaignDetail shows
      leadKey-deduped breakdowns with explicit "unknown" counts.
- [ ] Agent uploads photos (capped, idempotent, never breaks a sync); avatars with
      initials fallback in LeadsExplorer, ConversationDrawer, Pipeline.
- [ ] Pre-migration DBs still render every page (smallP tolerated errors +
      LEAD_COLUMNS ladder).
- [ ] `npm run build` passes; `frontend/api` typechecks clean; `frontend/api/` still
      has exactly 12 function files.
