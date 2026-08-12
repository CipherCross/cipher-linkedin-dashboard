# Follow-up worklist and lead-card refresh

## Goal

Give SDRs a reliable daily work queue for LinkedIn follow-ups, with one owned next-follow-up date per LinkedIn conversation and a complete history of what was scheduled, completed, skipped, rescheduled, reassigned, or canceled. Make that workflow fast from both the follow-up queue and the conversation drawer, and redesign pipeline lead cards so the next action and recent conversation context are easier to scan.

The feature must remain separate from the automated LinkedIn funnel milestones and from the existing `following_up` pipeline stage. A scheduled task is an SDR commitment; it is not evidence that a LinkedIn message was sent.

## Non-goals

- Slack, email, browser, or push reminders.
- Follow-up priorities, task queues, bulk completion, or bulk rescheduling.
- Time-of-day scheduling; follow-ups are calendar dates only.
- Per-user timezone preferences. This iteration uses one shared business timezone.
- Automatically changing pipeline stages when a follow-up is scheduled, completed, or skipped.
- Requiring a conversation-history import before every completion.
- Reworking the funnel milestone semantics or the agent's `derive_events` behavior.
- A full redesign of Leads Explorer; it only gains follow-up visibility and filtering in this iteration.
- Authentication or authorization redesign. Existing read-open RLS, guarded CRM writes, and the honor-system actor name remain in place.

## Research findings

- `frontend/src/pages/Pipeline.tsx` contains the existing `PipeCard`. Cards show identity, company, campaign, owner, pipeline age, and quiet stage/substatus/owner controls, but no due date, message context, or primary next action. The 13-column board is already a dense horizontal and vertical scrolling surface.
- `frontend/src/components/ConversationDrawer.tsx` is the established per-conversation workspace. It already resolves a fresh lead from `DataContext`, exposes the thread and CRM fields, and embeds the Paste → Review → Import workflow from `ImportHistoryPanel.tsx`.
- `/api/import-conversation` writes manual messages, deduplicates by normalized body plus direction, and backfills only NULL milestones. It is a separate operation and can partially succeed, so the follow-up flow must make import status explicit rather than pretending import and task completion are one atomic database transaction.
- Manual CRM writes already flow through `frontend/api/pipeline.ts`, with service-role access, optional `ADMIN_SECRET`, validation, event logging, optimistic client patches, reconciliation, rollback, and toasts. The repository also has a documented Vercel function-count constraint, favoring new action variants on this shared CRM endpoint over another top-level function.
- Follow-up state must use the established conversation key, `instance_id + profile_url`, not `lead.id`. The same LinkedIn thread can be represented by several campaign lead rows; those cards must display the same date and the worklist must show the conversation only once.
- The existing `following_up` pipeline stage is inferred from message evidence after an unanswered outbound. It must not be reused as scheduled-task state.
- `DataContext.tsx` fetches dashboard data once and every five minutes, protects optimistic patches from in-flight refreshes, and has a compatibility fallback ladder for evolving schemas. Conversation-scoped follow-up state should be fetched separately and indexed by `leadKey(instance_id, profile_url)` rather than denormalized onto every lead row.
- DataContext's existing optimistic machinery is keyed by `lead.id`, so conversation follow-ups need their own pending-state map keyed by `leadKey`. Its paginated fetch convention must also be used for follow-up state; PostgREST's 1,000-row cap makes an unpaginated “small table” assumption unsafe.
- The dashboard's global message slice is authoritative for inbound messages but limits outbound messages to 90 days. It cannot reliably supply the latest message for every work item, so the follow-up surfaces need a separate read-optimized latest-message projection.
- `ImportHistoryPanel.tsx` is not currently a composable step: it owns its result screen and its callback does not return the import result. The guided workflow requires an explicit drawer state machine and a richer import-completion callback.
- `ConversationContext.tsx` currently opens only a lead, with no destination mode. The worklist needs a supported `openConversation(lead, { mode: 'follow_up' })` contract rather than UI timing hacks.
- `frontend/api/pipeline.ts` uses snake_case request fields. Follow-up actions should keep that convention, while using an atomic database mutation rather than the pipeline endpoint's existing “update succeeded, event logging may fail” behavior.
- The latest migration is `045_web2mob_industries_refresh.sql`; this feature's migration is therefore `046_conversation_follow_ups.sql`.
- Migration 034 revoked automatic future-table access from `ai_sql_runner`. If the AI schema advertises follow-up data, migration 046 must grant that SELECT access explicitly.
- Existing date helpers treat calendar dates as UTC `YYYY-MM-DD` values and message timestamps as viewer-local clocks. Follow-up dates need their own explicit business-date helper so the Today/Overdue boundary is consistent for the team.
- Mature CRM worklists keep overdue items visible, separate the scheduled due date from the actual completion timestamp, and prompt for the next task after completion. They also distinguish Complete, Skip, and Reschedule rather than collapsing them into one state. Relevant prior art: [HubSpot tasks](https://knowledge.hubspot.com/tasks/create-tasks), [HubSpot task views](https://knowledge.hubspot.com/tasks/filter-tasks-and-manage-task-views), and [Dynamics 365 work lists](https://learn.microsoft.com/en-us/dynamics365/sales/connect-with-customers).
- The card currently opens on click but is not keyboard-openable, while drag-and-drop already has a select-control fallback. The refresh must preserve a single-pointer alternative and make all new actions keyboard accessible, following [W3C keyboard guidance](https://www.w3.org/WAI/WCAG21/Understanding/keyboard-accessible.html).

## Decisions

1. **Scope:** A follow-up belongs to the LinkedIn conversation identified by `instance_id + profile_url`. All campaign lead rows for that conversation share the same current due date.
2. **History:** Preserve an append-only audit trail for schedule, reschedule, reassignment, complete, skip, and cancel actions while maintaining one read-optimized current state per conversation.
3. **Completion workflow:** Use a guided drawer flow: optionally import/review recent history, record Complete or Skip, and optionally set the next follow-up date. Import is encouraged but not mandatory, and terminal outcomes may have no next date.
4. **Date semantics:** Store and display a calendar date only, with no time-of-day or browser-local timestamp conversion.
5. **Skip behavior:** Skip is available alongside Complete and Reschedule. A non-empty reason is mandatory and is stored in history. Overdue appears before Today; Upcoming is a secondary section; completed history appears within the conversation rather than in the active queue.
6. **UI scope:** Refresh Pipeline cards, the conversation drawer's header/action area, and add a focused follow-up worklist with dashboard visibility. Leads Explorer receives the due date and related filtering but no broad visual redesign.
7. **Initial exclusions:** No Slack reminders, priorities, bulk actions, or follow-up-driven pipeline-stage transitions in this iteration.
8. **Business timezone:** Every SDR uses the same `Europe/Madrid` Today/Overdue boundary, including SDRs physically located in Ukraine. Stored dates are displayed as calendar dates and are never converted through the browser's local timezone.
9. **Ownership:** Each active conversation-level follow-up has one explicit `team_members` owner. Scheduling prefills the owner from the lead being viewed, the user can change it, and the worklist's “My follow-ups” view uses this owner rather than potentially conflicting campaign-lead assignments.
10. **Last-lead deletion:** Deleting one of several matching lead rows leaves the shared follow-up untouched. Deleting the final matching lead automatically cancels and archives any active follow-up with a system reason, removes it from the worklist, and retains event history until the whole instance is deleted.

## Approach

### Conversation-scoped state and history

Migration `046_conversation_follow_ups.sql` adds an append-only event table, a current-state projection, and an authoritative latest-message view.

`follow_up_events` uses:

- `id bigint generated always as identity primary key`;
- `instance_id text not null references instances(id) on delete cascade`;
- `profile_url text not null`;
- `mutation_id uuid not null` plus `event_ordinal smallint not null`, unique together so one idempotent mutation may emit an outcome event followed by a new scheduling event;
- `event_kind text` constrained to `scheduled`, `rescheduled`, `completed`, `skipped`, `canceled`, or `reassigned`;
- nullable `previous_due_date` and `new_due_date` date values whose allowed combinations are checked per event kind;
- nullable `previous_owner_id` and `new_owner_id`, both `bigint references team_members(id) on delete set null`;
- nullable `previous_owner_name` and `new_owner_name` snapshots so deleting a team-member row does not erase the historical assignment display;
- `state_revision bigint not null`, identifying the projection revision created by that mutation;
- trimmed `actor text not null` with a 120-character limit;
- optional trimmed `reason text` with a 1,000-character limit and a constraint requiring non-blank content for `skipped`;
- `occurred_at timestamptz not null default now()`.

Event value rules are:

- `scheduled`: previous date is NULL; new date and new owner snapshot are present;
- `rescheduled`: previous/new dates are present and different; owner is unchanged;
- `reassigned`: previous/new owner snapshots are present and different; previous/new dates both equal the still-active date;
- `completed`, `skipped`, and `canceled`: previous date is present and new date is NULL.

History ordering is always `occurred_at desc, id desc`. Event rows are never updated or deleted individually from the application.

`conversation_follow_up_state` uses:

- the composite primary key `(instance_id text, profile_url text)`, with `instance_id` referencing `instances(id) on delete cascade`;
- `next_follow_up_date date null`;
- `owner_id bigint null references team_members(id) on delete set null`;
- `revision bigint not null default 0`;
- `last_event_id bigint null references follow_up_events(id) on delete set null`;
- `last_mutation_id uuid null`;
- `created_at`, `updated_at`, `updated_by`, and nullable `archived_at`.

Rows remain after Complete, Skip, or Cancel clears the active date so history and revision continuity are preserved. An active state is exactly `next_follow_up_date is not null and archived_at is null`. User-created schedules require an owner, but `on delete set null` may leave an existing active task Unassigned; it remains actionable, while rescheduling or creating a next follow-up requires choosing a new owner.

`conversation_latest_message` is a read-only, security-invoker projection with one row per exact `(instance_id, profile_url)`. It exposes the newest non-empty message in either direction, ordered by `sent_at desc, id desc`, including direction, body, timestamp, and source. Migration 046 adds the supporting message index needed for that partition/order and verifies the query plan. The view must be fetched paginated; cards must not infer this value from DataContext's 90-day outbound slice.

The stored profile URL is not normalized. Scheduling requires at least one exact matching lead row for `(instance_id, profile_url)`, preventing orphan tasks for arbitrary strings. The tables cannot foreign-key to `leads` because that pair is not unique there.

Apply read-open SELECT policies to both tables, expose the view to the normal dashboard roles, and create no client write policy. Explicitly grant SELECT on the two tables and view to `ai_sql_runner`, because post-migration-034 future-table grants are revoked. Service-role-only writes continue to bypass RLS.

### Atomic mutation contract

Add one transactional RPC for all follow-up mutations. Its logical inputs are:

- `action`;
- exact `instance_id` and `profile_url`;
- nullable `owner_id`, `next_follow_up_date`, and `reason`;
- required trimmed `actor`;
- required `expected_revision`;
- required client-generated `mutation_id` UUID.

The RPC takes a transaction-scoped advisory lock derived from the exact conversation key before reading or creating state. This handles two concurrent first schedules, where `SELECT ... FOR UPDATE` alone cannot lock a row that does not yet exist. It then:

1. Returns the already-recorded result without appending history when the same `mutation_id` is retried for the same conversation/action.
2. Rejects reuse of that mutation ID for different inputs.
3. Confirms at least one exact matching lead still exists.
4. Compares the monotonic `expected_revision`; comparing only dates is insufficient because a date can change away and later return.
5. Validates the action preconditions.
6. Appends one or two ordered events and updates the state projection in the same transaction.
7. Increments the state revision once per mutation, regardless of event count, and returns the authoritative state, emitted events, revision, and whether the result was replayed.

Action rules:

- `schedule` requires no active date, a valid owner, and a date on or after the current Europe/Madrid business date. It unarchives a previously archived row.
- `reschedule` requires an active date, a current owner, and a genuinely different date on or after business today. An Unassigned task must be reassigned first.
- `reassign` requires an active date and a genuinely different valid owner.
- `complete`, `skip`, and `cancel` require an active date.
- `skip` requires a non-blank reason. Manual cancel may include a reason; system cancellation always supplies one.
- Complete or Skip may include the next owner and next date; they are supplied together or both omitted. The next date must be later than the current Europe/Madrid business date because date-only scheduling cannot represent a second follow-up later the same day.
- Complete/Skip with a next date writes ordinal 1 (`completed` or `skipped`) and ordinal 2 (`scheduled`) under the same mutation ID and revision; state points to ordinal 2. Without a next date, it clears the active date but retains the previous owner as historical context.
- Schedule on an already active item, outcome/reschedule/reassign on an inactive item, same-value mutations, invalid dates, and stale revisions are explicit conflicts rather than silently changing action semantics.

The final-lead deletion trigger uses the same internal transaction logic. After a lead deletion, it checks for another exact matching row. If none remains, it records a `canceled` system event with reason `Last associated lead deleted`, clears the active date and owner, and sets `archived_at`. Deleting the whole instance cascades state and history normally. If an exact matching lead is created again later, a new schedule unarchives the projection while retaining earlier history.

This RPC is separate from `ai_execute_sql`, is not exposed as an AI write tool, and must not broaden the SELECT-only AI SQL guard.

### Server and client data flow

Extend the existing CRM write endpoint in `frontend/api/pipeline.ts` with validated actions:

- `schedule_follow_up`
- `reschedule_follow_up`
- `reassign_follow_up`
- `complete_follow_up`
- `skip_follow_up`
- `cancel_follow_up`

Keep the endpoint's existing snake_case payload convention. The shared base request is:

```text
action
instance_id
profile_url
actor
expected_revision
mutation_id
```

Action-specific fields are `owner_id`, `next_follow_up_date`, and `reason`. Dates must be strict Gregorian `YYYY-MM-DD` strings; IDs, lengths, whitespace, action preconditions, and required fields are validated before the RPC. The endpoint maps malformed input to HTTP 400, an unknown/no-longer-existing conversation to 404, stale revision or state conflicts to 409, and unexpected failures to 500. A 409 includes the authoritative current state so the client can refresh the form without discarding imported messages or typed input.

Unlike current pipeline-event logging, follow-up projection and history never have a partial-success response: both commit or both roll back.

Add explicit `FollowUpState`, `FollowUpEvent`, `ConversationLatestMessage`, availability, and mutation-result types to `frontend/src/lib/types.ts`. Extend `DashboardData`, `EMPTY`, and the DataContext return contract.

DataContext fetches current state and latest-message rows in paginated batches beyond PostgREST's 1,000-row limit. Missing-relation errors set `followUpsAvailable=false` without failing leads, messages, Overview, Pipeline, or Leads Explorer. The Follow-ups route and follow-up controls then show a focused “database upgrade required” state, which is distinct from an empty queue.

Index current state and latest messages by `leadKey`. Add a dedicated conversation-state pending-write map, separate from lead-ID `pendingPatches`, and apply it to both full refreshes and five-minute delta refreshes until each mutation settles. The client generates one UUID per user submission and reuses it for any retry after an unknown network outcome.

Fetch follow-up history only when a conversation drawer opens. Use a 50-event keyset page ordered by `(occurred_at, id)` descending, expose Load more, and preserve already loaded rows if a later page fails.

Add shared follow-up helpers for:

- a server/client-consistent `Europe/Madrid` `YYYY-MM-DD` business-date key;
- Overdue, Today, Upcoming, and Unscheduled classification;
- display labels such as `Today`, `3 days overdue`, and `Fri, 31 Jul`;
- deterministic grouping of multiple lead rows into one conversation work item;
- representative card content and a list of associated campaigns/owners without duplicating the task.

Never pass a stored `date` through `new Date(...)` for display. Format its year/month/day components directly. Server validation and client classification must use the same Madrid date rule, even when the browser is in Ukraine.

For duplicate campaign rows, choose representative lead metadata deterministically:

1. Prefer a row whose `assigned_to` equals the follow-up owner.
2. Then prefer the row with the newest available conversation/funnel activity timestamp.
3. Break remaining ties by campaign ID and lead UUID.

Associated campaigns sort by campaign name then ID and display the first two plus a `+N` count. Pipeline cards remain separate lead rows but share the same follow-up badge/state. The worklist contains one conversation item and uses the explicit follow-up owner—not “any associated lead owner”—for My/owner filtering.

### Guided follow-up workflow

Add a follow-up action area to the conversation drawer:

- If no date exists, show **Schedule follow-up** with a date picker.
- If a date exists, show its urgency, explicit owner, and primary **Complete follow-up** action, plus Reschedule, Reassign, Skip, and Cancel as secondary actions.
- Keep a clearly labeled **Open in LinkedIn** link in the drawer header so the SDR can perform the actual outreach before importing and completing the task.
- Complete opens a compact guided panel. It first offers the existing import-history flow, then asks for an optional next date and confirms completion.
- Skip uses the same panel but requires a reason; an optional next date lets the SDR defer after documenting why.
- Cancel clears a future schedule and records the cancellation; it is not presented as completed work.
- Recent follow-up history appears as a small timeline in the drawer, separate from LinkedIn messages and pipeline events.

Extend `ConversationContext.openConversation` to accept an optional `{ mode: 'thread' | 'follow_up' }`, defaulting to `thread`. The worklist passes `follow_up`; ordinary card clicks preserve the current behavior.

Model the drawer explicitly rather than combining `importOpen` and new booleans:

1. Thread mode.
2. Follow-up action selection.
3. Optional import prompt.
4. Import paste/review/save/result.
5. Outcome/next-date form.
6. Submitting.
7. Success or recoverable conflict.

Refactor `ImportHistoryPanel` so `onImported(result)` receives inserted, duplicate, and milestone-backfill results and can return to the parent flow. All-duplicate/zero-insert is still a successful import review. A milestone-backfill failure remains a visible warning because messages may already have committed, but it does not automatically block the outcome step.

If import fails, the panel offers Retry or an explicit Continue without importing. If import succeeds and the SDR closes the drawer before completion, the import remains committed but the follow-up stays active. A mutation conflict after import refreshes the authoritative state and keeps the outcome draft for review. Deleting an imported message later never deletes or rewrites a historical follow-up event.

Changing lead, closing the drawer, or navigating away clears the transient follow-up/import draft after using the existing unsaved-edit confirmation convention. Successful task mutation returns to Thread mode with reconciled state. Import success alone never displays the follow-up as completed.

### Daily worklist

Add a `Follow-ups` route and navigation item. The main view shows:

1. Overdue conversations, oldest due first.
2. Today's conversations.
3. Upcoming conversations, collapsed or visually secondary and sorted by date.

The default owner view is **My follow-ups** when the locally selected “Who am I” actor maps to a team member; otherwise it is **All**. Users can select another owner or Unassigned. Each work item shows the deterministic lead identity, company/headline, associated campaign/account context, explicit follow-up owner, authoritative latest non-empty message direction/snippet/date, due-state badge, and a primary button that opens the conversation drawer directly into the follow-up action area. Complete, Skip, and Reschedule are available from that focused context rather than as easy-to-misclick inline list controls.

Add a compact Overview callout showing overdue/today counts and the first few urgent conversations, with a link to the full worklist. This satisfies the “open the dashboard and see today's work” requirement without turning Overview into a second full task manager.

Define distinct states for: migration unavailable, no active follow-ups, no items for the selected owner/filter, overdue but no Today items, missing latest message, deleted owner/Unassigned, history-load failure, and stale mutation conflict.

### Lead-card refresh

Refactor `PipeCard` around a clearer hierarchy:

- Identity: avatar, name, company/headline.
- Next action: prominent follow-up badge/date with overdue/today/upcoming states and the follow-up owner's identity when it differs from the lead-row owner.
- Context: authoritative latest non-empty message snippet, direction, and date when available.
- Metadata: campaign/account, owner, and days in current pipeline stage.
- Controls: keep opening the conversation as the primary card action; group stage/substatus/owner editing into a stable secondary area rather than reserving several low-contrast select rows on every card.

Do not place nested interactive controls inside a clickable `article`. Use a keyboard-focusable native open control/region and separate native controls with clear labels, focus styles, and event isolation. Preserve drag-and-drop plus the existing non-drag stage-change fallback.

In Leads Explorer, add Next follow-up as a derived row column/comparator and filters for Overdue, Today, Upcoming, and Unscheduled. Do not add `next_follow_up_date` to `Lead` or directly index it through the current `SortKey` path; reuse the conversation-key map and business-date helpers.

### AI/schema awareness

Update `SCHEMA_DOC` in `frontend/api/_lib/core.ts` for the state, events, and latest-message projection and their relationship to leads/messages. Explicitly state that follow-up events are human-entered task history and must not be interpreted as LinkedIn message evidence or funnel milestones. Migration 046 grants `ai_sql_runner` SELECT explicitly; no AI write tool is added.

### Rollout and compatibility

Apply migration 046 before deploying the API/frontend bundle. The frontend still handles the inverse order safely: existing pages remain operational, while Follow-ups and follow-up controls show the migration-unavailable state.

No sync-agent mapping, payload, or deploy change is required because the new state is stored outside `leads`. Verify this with a dry-run and a representative lead upsert. Do not deploy or run a real sync solely for this feature.

## Implementation phases

1. **Schema and transactional action model — M**
   - Add migration 046 with events, state, latest-message projection, indexes, checks, read policies/grants, transactional mutation RPC, advisory locking, idempotency, deletion trigger, and migration verification queries.
   - Test first schedule, reschedule, reassign, complete-with/without-next-date, skip-reason enforcement, cancel, mutation replay, stale revision, duplicate leads, last-lead deletion, and same-conversation concurrency directly against Supabase.

2. **Shared data model and write integration — M**
   - Add exact frontend types/helpers, paginated DataContext loading, availability state, latest-message indexing, snake_case endpoint action variants, API error mapping, conversation-key optimistic reconciliation, and keyset history loading.
   - Verify 1,001+ rows, mutation replay after an unknown response, refresh protection, migration-unavailable behavior, 409 recovery, and consistent state across duplicate campaign leads.

3. **Daily worklist and Overview callout — M**
   - Add route/navigation/skeleton registration, My/All/owner filters, Overdue/Today/Upcoming grouping, deterministic conversation aggregation, work items, explicit empty/error/unavailable states, and Overview preview.
   - Verify Europe/Madrid boundaries from both EU and Ukrainian browser timezones, shared ownership, duplicate campaigns, missing messages, deleted owners, and that overdue items never disappear.

4. **Conversation workflow and history — L**
   - Extend the conversation-open contract; add scheduling, reassigning, the explicit drawer/import state machine, complete/skip flow, reschedule/cancel actions, required skip reason, optional next date, and paginated history.
   - Verify all-duplicate import, committed messages plus milestone warning, import failure/retry/continue, close-after-import, conflict-after-import, draft discard, and terminal completion without a new date.

5. **Pipeline lead-card refresh — L**
   - Refactor card layout and interaction hierarchy, add due-state and latest-message context, consolidate secondary controls, and improve keyboard/touch behavior.
   - Verify drag/drop, dropdown stage movement, conversation opening, owner/stage/substatus controls, lost-reason modal, drawer focus behavior, board density, and long/missing content at common viewport widths.

6. **Leads Explorer and integration polish — S**
   - Add a derived follow-up row/comparator/filter, update AI schema documentation and grants, finalize copy/accessibility labels, and run end-to-end regression checks.

7. **Migration-first rollout — S**
   - Apply and verify migration 046, then deploy the API/frontend bundle.
   - Confirm pre-migration fallback, post-migration availability, Vercel function behavior, five-minute refreshes, and a dry-run/representative sync upsert that leaves follow-up tables untouched.

## Affected files/modules

- `supabase/migrations/046_conversation_follow_ups.sql` — event/state schema, latest-message projection, RLS/grants, constraints, indexes, transactional RPC, idempotency/concurrency handling, and final-lead deletion trigger.
- `frontend/api/pipeline.ts` — follow-up action validation and RPC calls.
- `frontend/api/_lib/core.ts` — `SCHEMA_DOC` additions and semantics.
- `frontend/src/lib/types.ts` — state, event, latest-message, availability, and mutation result types plus `DashboardData`/`EMPTY` changes.
- `frontend/src/lib/DataContext.tsx` — paginated state/latest-message fetch, availability, conversation-key indexes, independent optimistic patching, and refresh reconciliation.
- `frontend/src/lib/leads.ts` and/or a new `frontend/src/lib/followUps.ts` — conversation grouping, business-date classification, labels, and filters.
- A new `frontend/src/lib/useFollowUpActions.ts` — mutation UUIDs, client mutations, conflict handling, rollback, reconciliation, and toast errors.
- `frontend/src/lib/ConversationContext.tsx` — explicit thread/follow-up open mode.
- `frontend/src/components/ConversationDrawer.tsx` — drawer workflow state machine, scheduling/completion entry point, owner control, and history.
- `frontend/src/components/ImportHistoryPanel.tsx` — result-bearing callback and parent-flow integration.
- New focused follow-up workflow/history components under `frontend/src/components/`.
- New `frontend/src/pages/FollowUps.tsx` — daily worklist.
- `frontend/src/pages/Overview.tsx` and a new follow-up callout component — urgent preview and counts.
- `frontend/src/pages/Pipeline.tsx` — refreshed `PipeCard` composition and follow-up state.
- `frontend/src/pages/LeadsExplorer.tsx` — derived follow-up column, comparator, and filters.
- `frontend/src/App.tsx` — route registration.
- `frontend/src/components/Layout.tsx` — `LINKS` navigation entry and `/follow-ups` skeleton variant.
- `frontend/src/styles.css` — worklist, guided workflow, timeline, card, responsive, focus, and due-state styling.

## Risks & how to verify

- **Conversation duplication:** Several campaign lead rows may share one thread and disagree on metadata or assignment. Seed duplicates and verify deterministic presentation, one worklist item, one explicit follow-up owner, one state row, and the same date on every related card.
- **Concurrent first schedule:** A missing state row cannot be protected by row locking. Verify transaction advisory locking serializes two first schedules and only one valid mutation commits.
- **Stale and replayed updates:** Dates can change away and back, and a timeout may happen after commit. Verify monotonic revisions catch the ABA case, mutation UUID replay never duplicates history, reused IDs with different inputs fail, and a 409 returns authoritative state.
- **Partial import workflow:** Message import and follow-up completion cannot share one database transaction. Verify the UI never reports completion after an import failure unless the SDR explicitly chooses to continue without importing.
- **Calendar boundary errors:** A `date` has no timezone, but Today does. Test just before/after midnight and DST transitions using `Europe/Madrid`; display the stored date without converting it through a timestamp.
- **Owner deletion/conflict:** Follow-up ownership is independent from duplicate lead assignments. Verify team-member deletion leaves the item visible as Unassigned, new schedules require an owner, reassignment is audited, and My filters never infer ownership from associated lead rows.
- **Lead deletion lifecycle:** Verify deleting one of many exact matching leads does nothing, deleting the last one records system cancellation and archives state, recreating a lead permits a new schedule with retained history, and deleting the instance cascades everything.
- **Sync regression:** The sync agent must neither write nor erase follow-up state. Verify a dry-run and representative lead upsert leave the conversation tables untouched.
- **Meaning collision:** Ensure `following_up`, message milestones, and follow-up task state remain separately named and rendered. Verify AI schema guidance and analytics do not count task events as outreach activity.
- **Incorrect latest-message context:** The general dashboard message slice omits outbound messages older than 90 days. Verify cards/worklists use the authoritative latest-message projection, including old outbound-only conversations and equal-timestamp tie breaking.
- **Pagination:** Verify 1,001+ state, latest-message, and history rows; initial data is not truncated and keyset Load more remains stable if a new event arrives.
- **Guided-flow state loss:** Verify lead switching, drawer close, route navigation, successful import, all-duplicate import, backfill warning, mutation success, and mutation conflict transition or discard state deliberately.
- **Card interaction regressions:** Test mouse, keyboard, and touch-equivalent controls for open, drag/drop fallback, stage, substatus, owner, and follow-up entry. Ensure no nested interactive-element violations.
- **Schema compatibility:** A database without migration 046 must keep every existing page usable, report Follow-ups as unavailable rather than empty, and recover automatically after the migration/refresh.
- **AI permissions:** Verify chat/MCP can SELECT the advertised follow-up objects but cannot mutate them, and that `instances.config` and the AI SQL guard remain unchanged.
- **Type/runtime coverage:** `npm run build` typechecks only `frontend/src`, not `frontend/api`. Run it, add/use a separate no-emit API TypeScript check where the existing toolchain permits, validate through the Vercel development flow, and smoke-test all follow-up actions against a migrated test database.

## Definition of done

- A user can schedule a date-only follow-up for any LinkedIn conversation.
- Scheduling requires one explicit follow-up owner and an exact matching lead; owner changes are audited independently from campaign-lead assignments.
- Every campaign lead card for that conversation displays the same next-follow-up date and urgency.
- Overview exposes overdue/today counts and urgent items; the Follow-ups page shows one deduplicated item per conversation, grouped Overdue → Today → Upcoming.
- My/owner filters use the conversation follow-up owner, and a deleted owner produces a visible Unassigned item rather than losing the task.
- Overdue items remain actionable until completed, skipped, rescheduled, or canceled.
- Complete and Skip can optionally schedule the next date in the same atomic follow-up mutation.
- Skip cannot be submitted without a non-blank reason.
- The conversation drawer supports optional history import before completion and handles import failures without falsely completing the task.
- The drawer shows the append-only follow-up history with actor, action, dates, reason, and timestamp.
- Pipeline cards are easier to scan, expose message/follow-up context, preserve all existing CRM behavior, and are keyboard operable.
- Leads Explorer can display, sort, and filter by follow-up state.
- Follow-up actions do not alter funnel milestones, outreach events, or pipeline stages.
- Current state is optimistic but protected from in-flight refreshes and reconciled with the server; revision conflicts, committed-response retries, and failed writes are visible and recoverable without duplicate history.
- Complete/Skip plus schedule-next commits projection and ordered history together or not at all.
- Cards and worklists use the authoritative latest non-empty message in either direction rather than the dashboard's windowed outbound slice.
- Europe/Madrid defines Today/Overdue consistently for browsers in both the user's and SDRs' physical timezones.
- Deleting the last matching lead system-cancels and archives the active task while retaining its history; deleting one of several leads does not.
- Follow-up state, latest-message data, and history remain complete beyond 1,000 rows.
- Before migration 046, existing dashboard pages remain usable and follow-up surfaces say unavailable rather than incorrectly showing an empty queue.
- RLS and server-side guards match the existing security posture, and no AI write path is introduced.
- Migration/concurrency/idempotency checks, `npm run build`, API TypeScript/runtime checks, server-function smoke tests, and manual desktop/mobile/accessibility checks pass.
