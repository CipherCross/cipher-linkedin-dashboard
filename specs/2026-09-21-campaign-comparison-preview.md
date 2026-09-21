# Campaign comparison preview

## Goal

Replace the Campaign comparison row's immediate full-page navigation with a fast, read-only campaign preview dialog. The preview gives the operator enough context to assess a campaign without leaving Overview: the five most recent replied leads with their latest inbound reply text, plus the current copy-bearing sequence messages synced from Linked Helper 2 (LH2).

The full Campaign Detail route remains available as an explicit action, and selecting a lead opens the existing Conversation Drawer for the complete thread.

## Non-goals

- Do not show Builder publish snapshots or compare Builder copy with LH2 copy. The preview source of truth is the current sequence synced from the notebook.
- Do not edit, publish, reorder, or otherwise mutate sequence steps from the preview.
- Do not add pagination, infinite scroll, search, filtering, sentiment editing, CRM actions, or reply composition inside the preview.
- Do not replace or remove the full Campaign Detail page.
- Do not preload preview data for every campaign or add preview detail to the initial Overview payload.
- Do not change campaign metrics, funnel semantics, reply classification, notification behavior, or database schema unless measured evidence proves the existing read model cannot support the bounded operation.
- Do not display automation-only steps, delays, visits, likes, or other non-copy actions in the preview sequence.

## Research findings

- `OverviewAnalytics` currently sends a Campaign comparison row to `/campaign/:id` on click, Enter, or Space. The embedded comparison checkbox already stops row propagation and must retain that behavior.
- The shared `Dialog` already supplies the required modal mechanics: accessible title, initial focus, focus trap, inert background, Escape and backdrop close, body scroll, scroll lock, and focus restoration. Its `lg` size is 880px and `xl` is 1120px.
- Overview receives aggregate campaign metrics only. Its route bootstrap deliberately contains no leads, messages, or sequence steps, so the preview cannot be assembled from current Overview state.
- The existing campaign route snapshot already proves that the data is available: campaign-scoped leads, latest inbound reply bodies, and synced sequence steps. A narrower `leads.searchPage` read also supports campaign filtering, bounded result sizes, latest inbound reply text, and ordering by `replied_at`.
- Reply/message identity must be scoped by `(instance_id, profile_url)`, never by profile URL alone, because the same person can exist under multiple LinkedIn accounts.
- `CampaignStep.template_body` holds synced LH2 sequence copy. Existing sequence rendering treats `InvitePerson` and `MessageToPerson` as copy-bearing steps and collapses automation steps.
- Overview has an exact three-read initial network budget and a two-read concurrency ceiling. Preview data therefore must be fetched lazily only for the campaign the user opens.
- The shared UI standard requires English-only UI, shared primitives, distinct loading/error/empty/refresh states, and visual acceptance at 1280×720, 1440×900, and 1920×1080.
- WAI-ARIA dialog guidance requires focus to move into the modal, stay trapped while it is open, close on Escape, and normally return to the invoking control. The repository's shared `Dialog` already implements this contract.
- An interactive campaign target should remain keyboard-operable. A real row-contained button/link is preferable to adding more implicit table-row behavior, provided checkbox and action controls do not double-activate the preview.

## Decisions

1. **Lead population:** show only leads that have an inbound reply, ordered by the newest latest-inbound message first. A lead without an inbound reply never appears merely because it was recently added or recently acted on.
2. **Lead limit:** return and display at most five leads. There is no preview pagination or “load more” behavior in this iteration.
3. **Campaign activation:** clicking the campaign row's preview target, or activating it by keyboard, opens the dialog instead of navigating. The dialog contains an explicit `View campaign details` action that navigates to the existing `/campaign/:id` route.
4. **Sequence source:** use the current sequence steps synced from the campaign's LH2 notebook. Ignore immutable Builder `compiled_action_chain` data even when it exists.
5. **Sequence filtering:** show copy-bearing synced steps with a non-empty `template_body`, in LH2 step order. This includes connection-request copy and follow-up message copy; automation-only steps and empty templates are omitted.
6. **Lead activation:** clicking or keyboard-activating a lead opens the existing Conversation Drawer for that exact `(instance_id, profile_url)` thread. Closing the drawer returns to the still-open campaign preview; closing the preview returns focus to the campaign that invoked it.
7. **Reply excerpt:** each lead row shows the complete latest inbound reply body within the preview's scrollable body, not an arbitrary character truncation. Long text may wrap; the dialog itself must not create horizontal page overflow.

## Approach

### Interaction and dialog hierarchy

Keep Campaign comparison as a semantic table. Give the campaign name (or a dedicated preview control in the campaign cell) an accessible interactive target rather than relying exclusively on an implicitly clickable `<tr>`. Preserve the existing selection checkbox and all row actions by stopping their events so they never open the preview accidentally.

Opening a campaign sets one explicit preview state:

- `closed`
- `loading(campaignId, requestId)`
- `ready(campaignId, requestId, payload)`
- `empty(campaignId, requestId, payload)` when neither replied leads nor copy-bearing sequence messages exist
- `error(campaignId, requestId, error)`

The dialog opens immediately in `loading`, keeps the selected campaign name in its title, and starts one lazy read. A successful payload may have independent empty sections: `No replied leads yet.` and `No synced sequence messages available.` The whole-dialog empty state is reserved for both sections being empty. A failed read keeps the dialog open with `Retry` and `Close`; it must not silently navigate to Campaign Detail.

The `xl` shared `Dialog` is the default because two information-dense sections must remain useful at 1280px. Use a fixed header and footer with one vertically scrollable body. The footer contains a secondary `Close` action and primary `View campaign details` action. Do not nest new card surfaces inside the dialog; use section headings, dividers, and established lead/sequence presentation patterns.

### Preview content

Render sections in this order:

1. **Recent replies** — count label `Latest 5` when five are returned, otherwise the actual count. Each row shows lead identity, company/headline context when available, latest reply time in the established Madrid display timezone, sentiment/intent badges already supported by `LeadReplyIdentity`, and the latest inbound reply body. The whole lead row is a keyboard-operable Conversation Drawer trigger.
2. **Sequence messages** — current LH2-synced copy-bearing steps in ascending step order. Label connection copy `Connection request`; label message copy `Message 1`, `Message 2`, and so on based only on displayed message steps. Preserve variables such as `{firstName}` as literal campaign copy. Do not render telemetry counts, waits, or automation summaries.

Opening the Conversation Drawer must not discard the preview payload. Layering, Escape behavior, and focus return must follow the existing overlay stack: the first Escape closes only the drawer, and the next Escape closes the preview.

### Bounded read contract

Add a narrow authenticated read operation, provisionally `campaign.preview`, rather than extending `overview.accountCampaigns` or loading the entire Campaign Detail snapshot. Input is exactly `campaign_id`; actor/team scope is resolved server-side under the existing dashboard-read authorization path.

Return only:

- campaign identity required for the title and route;
- up to five replied leads with the fields required by the existing identity row and Conversation Drawer key;
- each lead's latest inbound message body and timestamp, sentiment, intent, and existing follow-up metadata needed by the reused presentation;
- current synced campaign steps required to render copy-bearing messages: stable step identifier, step type, order, name when present, and `template_body`.

Server ordering for recent replies is deterministic:

1. latest inbound message `sent_at DESC`;
2. lead `replied_at DESC` as fallback;
3. normalized profile URL ascending as the final tie-break.

The latest inbound message lookup must remain scoped through `leadKey(instance_id, profile_url)`. Rows with a null/blank inbound body are skipped for preview display rather than producing an empty reply card. Fetch no more than five displayable replies; the query may need a bounded candidate window if null-body intent rows coexist with text rows.

Filter sequence steps on the server or shared data adapter to copy-bearing LH2 step types with non-blank `template_body`, then return them in stable LH2 order. The UI should still defensively omit blank templates without reinterpreting step order.

Target response size is at most 32KB under ordinary reply and sequence lengths. Preserve existing dashboard-read telemetry and include the operation name, total duration, database stages, response bytes, request ID, and errors in the same form as other named operations.

### Request lifecycle and cache behavior

- Opening a campaign issues at most one preview read for that campaign.
- Maintain a small session-memory cache keyed by `campaign_id` for the lifetime of the mounted Overview. Reopening an already-ready campaign renders cached data immediately and starts no automatic refetch in this iteration.
- `Retry` after an error always starts a new request.
- If the user closes the dialog or opens another campaign before completion, abort the obsolete browser request where supported and ignore every response whose `(campaignId, requestId)` no longer matches active state.
- Cancellation is client lifecycle control, not proof that an already-started database statement stopped.
- Preview reads are excluded from the initial three-read Overview budget because they occur only after explicit user interaction. Opening one preview must create exactly one detail read and no per-lead reads.
- Conversation Drawer may use its established lazy thread read when a lead is selected; do not preload five full conversations with the preview.

### Accessibility and navigation

- The preview trigger exposes a clear accessible name such as `Preview <campaign name>`.
- Enter and Space activate the preview target without also toggling the selection checkbox or firing the `View campaign details` action.
- Initial focus lands on the dialog heading or first meaningful action according to the shared `Dialog` contract.
- Loading and error changes are announced through the established status/error patterns without moving focus unexpectedly.
- `View campaign details` uses the existing encoded campaign route, closes the dialog through normal unmount/navigation, and does not mutate comparison selection or hidden-row state.
- After ordinary preview close, focus returns to the same campaign trigger if it still exists. If filtering/removal made it unavailable, focus returns to the Campaign comparison heading or toolbar.

## Implementation phases

1. **Preview read contract — M**
   - Add the typed `campaign.preview` input/output contract and authenticated server operation.
   - Query at most five latest displayable inbound replies with instance-scoped identity and deterministic ordering.
   - Return LH2-synced copy-bearing steps only, in stable step order.
   - Add data-operation tests for tenant isolation, duplicate profiles across instances, null/blank message bodies, deterministic ties, five-row limit, and sequence filtering.

2. **Dialog and Overview integration — M**
   - Replace Campaign comparison's direct row navigation with an accessible preview trigger while preserving checkbox, remove, sort, pagination, and full-detail behavior.
   - Add the `xl` shared Dialog with independent Recent replies and Sequence messages sections, agreed empty/error/loading states, and footer actions.
   - Reuse `LeadReplyIdentity` and established sequence typography where their contracts fit; extract small shared presentational pieces instead of duplicating route-specific markup.

3. **Conversation Drawer and request lifecycle — M**
   - Open the existing Conversation Drawer from a preview lead using `(instance_id, profile_url)`.
   - Preserve the preview beneath the drawer and verify overlay ordering, two-step Escape behavior, scroll locking, and focus restoration.
   - Add request cancellation, stale-response protection, retry, and mounted-Overview session caching keyed by campaign ID.

4. **Regression and visual acceptance — M**
   - Add interaction coverage for mouse/keyboard open, checkbox non-activation, loading, partial/whole empty, error/retry, cached reopen, stale responses, Campaign Detail navigation, and Conversation Drawer activation.
   - Verify the initial Overview still performs exactly three reads and one preview interaction adds exactly one preview read with no per-lead reads.
   - Run the frontend build and focused data/UI tests.
   - Visually verify short and long campaign names, five long replies, long variable-rich sequence copy, both independent empty sections, loading, error, nested drawer, and focus return at 1280×720, 1440×900, and 1920×1080.

## Affected files/modules

- `frontend/src/components/overview/OverviewAnalytics.tsx` — preview trigger, dialog integration, selection/action event boundaries.
- `frontend/src/pages/Overview.tsx` — lazy preview orchestration and state placement if it remains page-owned.
- `frontend/src/lib/dashboardReads.ts` — typed `campaign.preview` client read.
- `frontend/src/lib/types.ts` — minimal preview payload types if no narrower operation-local type module exists.
- `frontend/api/_lib/data/operations/` — bounded preview query and response mapping.
- `frontend/api/_lib/data/operations/routeSnapshots.ts` — shared query/helper extraction only if needed; do not make Overview load the full route snapshot.
- `frontend/src/components/leads-and-replies/LeadReplyIdentity.tsx` — reuse or narrowly generalize lead/reply presentation.
- `frontend/src/components/MessageSequence.tsx` — reuse or extract copy-only sequence presentation without changing Campaign Detail semantics.
- `frontend/src/ui/Overlay.tsx` and `frontend/src/ui/ui.css` — reuse; modify only if a verified nested-overlay defect requires it.
- `frontend/tests/overviewOperations.test.tsx` — Overview request budget and preview interaction coverage.
- Focused dashboard-read/data-operation tests alongside the existing operation test suite.

## Risks & how to verify

- **Wrong reply belongs to a same-profile lead on another account.** Verify fixtures containing the same profile URL under two instance IDs and assert that each preview returns only its own thread.
- **The apparent latest message has no body.** Verify that null/blank intent-support rows cannot suppress the most recent actual inbound reply text and that only displayable replies count toward the limit of five.
- **Preview shows stale or Builder copy.** Verify the payload is derived only from current synced `CampaignStep`/LH2 rows and never from `compiled_action_chain`.
- **Opening/closing quickly paints the wrong campaign.** Use deferred responses for campaigns A and B; open A, then B, resolve A last, and assert that only B renders.
- **Nested overlays break Escape, focus, or scroll lock.** Exercise the preview plus Conversation Drawer using keyboard-only interaction and assert drawer-first close, preview preservation, final focus return, and no unlocked background scroll.
- **Table controls accidentally open the modal.** Test checkbox, remove, archive filter, sort headers, pagination, and Campaign Detail action independently; none may double-trigger preview.
- **Overview performance regresses.** Assert no preview read occurs before user activation and exactly one bounded request occurs after activation. Inspect operation duration and response bytes with production-shaped data.
- **Long user content breaks the layout.** Visually test unbroken URLs/tokens, multiline replies, and variable-rich templates at every supported viewport; scrolling must remain inside the dialog/page primitives without page-level horizontal overflow.
- **Empty and failure states look identical.** Test independent no-replies/no-sequence states, whole empty, initial loading, retryable error, and successful retry with exact copy and stable dialog geometry.

## Definition of done

- Activating a Campaign comparison campaign opens an accessible preview dialog and does not navigate immediately.
- The preview shows at most five leads whose latest displayable inbound replies are newest, with correct instance-scoped identity, reply text, and time.
- The preview shows only current LH2-synced copy-bearing sequence messages with non-empty templates, in stable step order; Builder data and automation-only steps are absent.
- Selecting a preview lead opens the correct existing Conversation Drawer, and closing it returns to the still-open campaign preview.
- `View campaign details` navigates to the existing full Campaign Detail route.
- Loading, independent section empties, whole empty, error/retry, stale-response, and cached-reopen behavior match this plan.
- Checkbox/remove/sort/filter/pagination interactions retain their existing behavior and never open the preview accidentally.
- Initial Overview network behavior remains at three reads; no preview request happens until explicit activation; one preview open produces one bounded preview read and no per-lead reads.
- Keyboard activation, focus trap, nested Escape behavior, focus return, and accessible names pass focused interaction tests.
- The frontend build and relevant data/UI tests pass.
- Visual QA passes at 1280×720, 1440×900, and 1920×1080 with populated, long-content, loading, empty, error, and nested-drawer states and no page-level overflow.
