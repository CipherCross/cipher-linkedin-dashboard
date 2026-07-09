# CRM Pipeline Layer

## Context

The dashboard today is read-only analytics over LH2 automation: the funnel ends at `replied_at`, and everything after a reply (calls, proposals, deals) is invisible. The user wants the app to become a working CRM — the team sets per-lead statuses as they work leads, and the manager sees the full funnel from first invite through Client/Lost.

## Goal

Add a manual CRM pipeline layer on top of the existing automated funnel: team-editable per-lead stage + substatus, assignment, notes, and change history, with a kanban board and an extended funnel view. The automated milestone funnel (queued → invited → accepted → replied) stays untouched as ground truth.

## Non-goals

- Real authentication / per-user login (known deferred gap; shared `ADMIN_SECRET` + honor-system "who am I" picker is acceptable this iteration).
- Person-level identity across campaigns — status is per lead row `(campaign_id, profile_url)`.
- Reusing/altering LH2's `leads.status` column, milestone semantics, `stageOf()`, or the SQL views' funnel semantics.
- AI write paths (`ai_execute_sql` stays SELECT-only).
- Touch-device drag-and-drop (desktop internal tool; dropdown fallback covers it).

## Research findings

- `leads.status` already exists but is raw LH2 status, overwritten every sync — cannot be reused.
- Sync agent upserts with PostgREST `merge-duplicates` and a fixed payload: **new columns the agent never sends survive re-sync untouched** — no trigger needed (unlike milestone columns, which needed trigger 026).
- `leads.id` (uuid) is stable across syncs → safe FK for notes/events. Campaign deletion cascades leads → pipeline history dies with them (accepted, documented in migration).
- All writes go through Vercel functions with service-role `db()` + `x-admin-secret` guard (`config.ts` pattern); client uses `adminPost()` (`src/lib/admin.ts`). `frontend/api/` has 10 routed functions; Vercel Hobby caps at 12 → **one new `/api/pipeline` function** with an `action` discriminator.
- `DataContext.tsx` loads all leads into memory (columns whitelisted in `LEAD_COLUMNS`); today's mutation pattern is full `refetch()` — too heavy for frequent status flips → add a local `patchLead()`.
- UI prior art: `LeadsExplorer` (filterable table, URL-persisted filters), `ConversationDrawer` (thread + sentiment + coaching), `Funnel.tsx` (vertical funnel over `Lead[]`). No kanban, no DnD dependency.
- `SCHEMA_DOC` in `api/_lib/core.ts` is the AI layer's only schema knowledge — must be updated with every schema change. `chat.ts`/`mcp.ts` share `tools.ts`.
- Migration 026 + `/api/import-conversation` are built but **not pushed yet**; next migration number is 027; user runs `supabase db push`/deploys themselves.
- External best practice: automated journey position and manual "what does the rep do next" status are different axes — keep both; automated events may promote but never downgrade manual status; monitor days-in-stage for stalls.

## Decisions

1. **Stages** (user's custom model): First Contact → reply triage (Interested / Neutral / Negative with soft no | hard no | lost) → Negotiations about Call → Call booked → Call done (Proposal / Later / Not a fit) → Proposal In Progress → Proposal Presented (waiting for decision / contract / needs changes) → Client (Contracted) or Lost (with reason).
2. **Scope**: per lead row — new columns on `leads`.
3. **UI**: kanban board page with drag-and-drop **plus** inline status editing in LeadsExplorer rows and ConversationDrawer.
4. **Extras — all in scope**: assignment to teammates (lightweight `team_members`, no auth), per-lead timestamped notes, auto-advance rules (never downgrade manual settings), status change history (`pipeline_events` audit log).

## Approach

### Data encoding (kanban columns = main stages)

| rank | slug | label | substatuses |
|---|---|---|---|
| 0 | `first_contact` | First Contact | — |
| 1 | `interested` / `neutral` / `negative` | reply-triage tier | negative: `soft_no`, `hard_no`, `lost` |
| 2 | `negotiations_call` | Negotiations about Call | — |
| 3 | `call_booked` | Call Booked | — |
| 4 | `call_done` | Call Done | `proposal`, `later`, `not_a_fit` |
| 5 | `proposal_in_progress` | Proposal In Progress | — |
| 6 | `proposal_presented` | Proposal Presented | `waiting_decision`, `contract`, `needs_changes` |
| 7 | `client` / `lost` | terminal | lost: free-text `lost_reason` |

`NULL pipeline_stage` = untriaged (not in the manual pipeline). Stage↔substatus pairing enforced in the API (single write path); flat CHECK constraints on both slug lists in the DB as backstop. Rank powers "never downgrade" and the extended funnel.

### Schema — migration `027_pipeline.sql`

- `team_members` (id, name unique, active, created_at) — deactivate, never delete.
- `leads` += `pipeline_stage`, `pipeline_substatus`, `lost_reason`, `pipeline_stage_changed_at`, `assigned_to → team_members(id) on delete set null` + CHECKs + partial indexes. Agent never sends these columns → survive re-sync.
- `lead_notes` (lead_id FK cascade, author text, body, created_at).
- `pipeline_events` (lead_id FK cascade, kind `stage|assignment`, actor text — member name or `'auto'`, from/to stage+substatus+assignee names, lost_reason, occurred_at).
- RLS enabled, anon SELECT `using (true)` on all three (matches read-only-open posture; writes via service role only).

### Migration `028_pipeline_auto_advance.sql` (Phase 5)

- `pipeline_auto_advance()` — SECURITY DEFINER, service-role-only, **set-based & idempotent**: replied leads with stage NULL/`first_contact` get a triage stage from their latest classified inbound sentiment (positive→interested, negative→negative, else→neutral; `auto` skipped), logging `actor='auto'` events. Never downgrades (only touches NULL/rank-0 rows). Doubles as launch backfill. Called (42883-tolerant) at the end of `classify.ts` (cron + Replies button) and `reclassify.ts` — chosen over a DB trigger because sentiment arrives via later UPDATE and the RPC is testable/self-healing.
- `pipeline_metrics` view: stage×substatus×campaign counts + `stale_14d` + oldest-in-stage.

### API — `frontend/api/pipeline.ts` (one POST function, `config.ts` pattern)

Actions: `set_stage` (validates pairing; `lost_reason` only for lost; `pipeline_stage_changed_at` bumps only on stage change; no-op short-circuit; `stage:null` removes from pipeline; logs event), `assign`, `add_note`, `delete_note`, `add_member`, `set_member_active`. Event-insert failure reported as `event_error`, not a failed call (mirrors `milestone_error` in import-conversation). Shared constants in `api/_lib/pipeline.ts`, mirrored in `src/lib/pipeline.ts` with keep-in-sync comment (repo convention). Reads never go through the function — anon key + RLS.

### Frontend

- `src/lib/pipeline.ts`: `PIPELINE_STAGES` (id, label, color, rank, substatuses), `pipelineRank()`, `daysInStage()`.
- `DataContext.tsx`: `LEAD_COLUMNS` += 5 columns **with 42703 fallback** to the old list (pre-migration DB still renders; clone the existing `isMissingSourceColumn` pattern); fetch `team_members` + `pipeline_events`; expose `patchLead(id, partial)` — local patch, no refetch (known benign race with the 5-min poll).
- `src/lib/usePipelineActions.ts`: optimistic `patchLead` → `adminPost('/api/pipeline')` → revert + toast on failure. Owns who-am-I actor (localStorage `pipelineActor`, picker fed by team_members, inline add-member).
- **`src/pages/Pipeline.tsx`** (new, + route/nav): leftmost "Untriaged replies" intake lane (`replied_at && !pipeline_stage`), then 11 stage columns; **native HTML5 DnD** (no new dependency; card `draggable` + column `onDrop` → `set_stage`; must call `dataTransfer.setData` for Safari); per-card stage `<select>` in kebab menu as keyboard/touch fallback. Drop on `lost` → lost-reason modal; substatus stages get a chip picker post-drop. Card click opens ConversationDrawer. URL-persisted filters (`inst`, `camp`, `who`, `q`).
- `LeadsExplorer.tsx`: "Pipeline" column with compact stage select (`stopPropagation` so row click still opens drawer), `pipe`/`who` filters, CSV export gains the new fields.
- `ConversationDrawer.tsx`: derive live lead from `data.leads` (prop is a stale snapshot); stage/substatus/assignee selects; new `LeadNotesPanel.tsx` (on-demand fetch, add/delete, styled after `conv-coaching`).
- `Funnel.tsx`: append "Manual pipeline" section under Replied — happy-path checkpoints (Interested → Negotiations → Call booked → Call done → Proposal presented → Client), "ever reached" = current rank ≥ checkpoint **or** any `pipeline_events.to_stage` at/above it (so a now-Lost lead still counts as having reached Call done). Opt-in prop; hidden when unused.

### AI layer

`SCHEMA_DOC` += new columns/tables/view + slug vocabulary + guidance (NULL stage = untriaged, never "dropped"; call/proposal/client questions use pipeline data, not milestones; time-in-stage = gaps between stage events). New canned tool `pipeline_overview` in `tools.ts` (mirrored in `mcp.ts` if needed). No new function, no write path.

## Implementation phases

Migrations are written by us but **pushed by the user** (`supabase db push` applies pending 026 + 027 together; nothing deploys to Vercel before the push).

| # | Phase | Size | Contents |
|---|---|---|---|
| 0 | Save spec | S | Write this spec to `specs/2026-07-09-crm-pipeline.md`. |
| 1 | Schema | S | `027_pipeline.sql`. User pushes. |
| 2 | Write API | M | `api/pipeline.ts`, `api/_lib/pipeline.ts`, `SCHEMA_DOC` additions. |
| 3 | Kanban core | L | `src/lib/pipeline.ts`, types, DataContext changes, `usePipelineActions`, who-am-I, `Pipeline.tsx`, route + nav. |
| 4 | Inline editing + notes + funnel | M | LeadsExplorer column/filter/CSV, ConversationDrawer controls, `LeadNotesPanel.tsx`, `Funnel.tsx` extension. |
| 5 | Auto-advance | M | `028_pipeline_auto_advance.sql` (user pushes), then `classify.ts`/`reclassify.ts` call the RPC (42883-tolerant). |
| 6 | AI polish | S | `pipeline_metrics` in `SCHEMA_DOC`, `pipeline_overview` tool (+ mcp mirror). |

## Affected files/modules

New: `supabase/migrations/027_pipeline.sql`, `028_pipeline_auto_advance.sql`, `frontend/api/pipeline.ts`, `frontend/api/_lib/pipeline.ts`, `frontend/src/lib/pipeline.ts`, `frontend/src/lib/usePipelineActions.ts`, `frontend/src/pages/Pipeline.tsx`, `frontend/src/components/LeadNotesPanel.tsx`, `specs/2026-07-09-crm-pipeline.md`.

Modified: `frontend/src/lib/DataContext.tsx`, `frontend/src/lib/types.ts`, `frontend/src/pages/LeadsExplorer.tsx`, `frontend/src/components/ConversationDrawer.tsx`, `frontend/src/components/Funnel.tsx`, `frontend/src/App.tsx`, `frontend/src/components/Layout.tsx`, `frontend/api/_lib/core.ts`, `frontend/api/_lib/tools.ts`, `frontend/api/classify.ts`, `frontend/api/reclassify.ts` (+ `frontend/api/mcp.ts` if tools aren't shared).

## Risks & how to verify

- **Sync clobber** (the big one): after Phase 1 push, hand-set a lead's stage in SQL editor, wait for/trigger a real sync, confirm stage survived. (Analysis says yes — agent payload omits new columns — but verify on real data.)
- **API correctness**: `vercel dev` + curl every action — 401 without secret, 400 on bad slug/pairing, 404 on unknown lead, no-op short-circuit. `npm run build` does **not** typecheck `api/` — run `npx tsc --noEmit` on the api files separately.
- **Optimistic updates**: drag a card, wait out one 5-min poll, confirm no visual revert; kill the API mid-flight and confirm revert + toast.
- **HTML5 DnD Safari quirks**: must call `setData` in dragstart; test drag in Safari and Chrome. Touch: documented fallback via dropdown.
- **Pre-migration resilience**: frontend with new `LEAD_COLUMNS` against a pre-027 DB must fall back (42703) and still render.
- **Auto-advance**: run classify twice — second run advances 0 (idempotent); set a lead to `client`, rerun — untouched (never downgrades); `actor='auto'` events present.
- **AI layer**: ask /chat about the pipeline; confirm it uses new tables and doesn't interpret NULL stage as "dropped".

## Definition of done

- [ ] Migrations 027 (+028) applied; hand-set pipeline fields survive a real sync cycle.
- [ ] Team can set stage/substatus/assignee from Kanban board, LeadsExplorer row, and ConversationDrawer; changes appear in `pipeline_events` with actor.
- [ ] Kanban board shows untriaged-replies lane + 11 stage columns, drag-and-drop works in Chrome + Safari, lost requires a reason.
- [ ] Notes can be added/deleted per lead in the drawer and persist.
- [ ] Funnel view shows automated stages + manual "ever reached" checkpoints through Client.
- [ ] Classify cron auto-triages fresh replies without ever downgrading a manual stage.
- [ ] `npm run build` passes; api/ typechecks clean; `SCHEMA_DOC` reflects all schema changes.
- [ ] Spec saved at `specs/2026-07-09-crm-pipeline.md`.
