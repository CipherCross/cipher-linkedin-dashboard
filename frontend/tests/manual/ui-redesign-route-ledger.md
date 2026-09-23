# UI redesign route and action ledger

This ledger is the Phase 0 binding inventory for the route tree that exists in
`frontend/src/App.tsx` and `frontend/src/lib/navigation.ts` on the starting
commit. It records the current route/action/state owner so a later visual phase
can prove parity from observed behavior. The phase owner is the accepted
redesign phase; it is not permission to change the route or behavior during
Phase 0.

The application uses a `HashRouter`. The route strings below are the
React-Router paths after the hash, except for the two pre-router hash branches.
`/accounts` is a real redirect route, `/icp`, `/hypotheses`, and
`/neon-activity` are reachable by URL even when absent from the visible rail,
and the wildcard route returns to `/`.

## Pre-router and shell branches

| Entry / state | Current owner | Live actions and state branches | Permission / read-write boundary | Phase owner |
| --- | --- | --- | --- | --- |
| `#/ui-gallery` while `import.meta.env.DEV` | `App` → `ui/Gallery` | Four gallery tabs: Primitives, Compositions, List chrome, Widgets. No auth gate, API read, or write. | Dev-only reference; not production route or authenticated evidence. | Phase 1 |
| Reset hash containing a recovery token | `App` → `ResetPassword` | Password + confirmation fields; submit; validation for minimum length/mismatch; success action returns to sign-in; error branch stays on form. | Recovery flow is reachable before `AuthGate`; no dashboard write beyond the existing password-reset contract. | Phase 2 |
| No recovery token, signed out | `AuthProvider` / `AuthGate` | Existing sign-in/session error and loading states; successful sign-in enters the routed app; recovery link preserves the reset entry path. | The identity path resolves the canonical active actor and role through `/api/identity`; the Supabase path links the session to an active `team_members.auth_user_id` row. Both remain provider-specific behind the shared context. | Phase 2 |
| Authenticated shell | `Layout` + `QuickNavigation` | Sidebar links, collapsible Strategy/Administration groups, show/hide navigation with focus return, sign-out, `⌘K`/quick navigation, global data-error retry. | CSV Import is admin-only in the rail; all route/API authorization remains unchanged. | Phase 2 |
| `csv-import` as ordinary member | `App` → `AdminOnly` | Renders `Admin access required` and explanatory copy; importer is not mounted. | UI gate only; server admin checks remain authoritative. | Phase 2 |

## Routed surfaces

| Route | Current component / source | Actions and state branches observed in live code | Permission / read-write boundary | Phase owner |
| --- | --- | --- | --- | --- |
| `/` | `Overview.tsx` | Page header opens `/sequences`; three independent system/performance/campaign ranges; section-level loading, refresh, and error branches; account/campaign drilldowns and bounded preview. | Authenticated reads; no briefing UI or mutation. | Phase 9 |
| `/campaign/:id` | `CampaignDetail.tsx` | Breadcrumbs; tabs `Leads & replies`, `Performance`, `Sequence`; performance date range and comparison selector; remove comparison; sequence provenance/deployed snapshot; briefing context edit/save; not-found back link. | Authenticated reads; briefing context save keeps current API/action. | Phase 9 |
| `/accounts` | `Navigate` in `App.tsx` | Immediate replace redirect to `/`. | No data read/write. | Phase 2 |
| `/account/:id` | `AccountDetail.tsx` | Breadcrumb/back links; account date range and campaign links; not-found `Back to overview`; added-this-week and campaign table views. | Authenticated read. | Phase 9 |
| `/leads` | `LeadsExplorer.tsx` | Search; account/primary filters; end filter Dialog with Clear all/Cancel/Apply; sentiment tabs; columns toggle; demographics update; export; pagination; row conversation open; coaching digest expand/refresh. | Demographics update/export retain current admin and server refusal/error behavior. | Phase 6 |
| `/pipeline` | `Pipeline.tsx` | Search/filter controls; board/list lead selection; stage, substatus, and owner controls; stop/refusal branch when a write is blocked; conversation open. | Pipeline writes retain current member permissions and refusal reason. | Phase 8 |
| `/follow-ups` | `FollowUps.tsx` | Search and filters; due-date groups; row opens follow-up conversation/action surface; lead and reply links; empty and no-match branches. | Madrid operational-date semantics and existing schedule/reschedule/complete/skip/cancel/refusal behavior remain. | Phase 6 |
| `/replies` | `Replies.tsx` | Queue tabs and filter Dialog; refresh; search/clear; conversation selection; older/newer/load-more paging; import history; review inspector; Save/Save and next; dirty navigation confirmation; outbound-only latest-inbound action. | Review and workflow writes preserve current role checks, draft retention, conflict branch, and server enforcement. | Phase 7 |
| `/sentiment-analysis` | `SentimentAnalysis.tsx` | Period/mode controls; refresh; More filters Dialog/Done; retry; review-queue drilldown; Show every reason. | Authenticated reads; existing analytics intervals/denominators unchanged. | Phase 9 |
| `/review` | `Review.tsx` | Review tabs; period/mode selection; lead/reply drilldowns; digest generation/send action with loading/error/disabled branches; sentiment-analysis link. | Digest action keeps current permission/error behavior; no production mutation in visual acceptance. | Phase 6 |
| `/csv-import` | `AdminOnly` → `CsvImport.tsx` | Four-stage import state machine: upload, file review, company resolution, contact review/results; retry and resolution branches. | Admin-only; fixture/disposable writes only for acceptance. | Phase 5 |
| `/playbook` | `Playbook.tsx` | Load/error state; editor textarea; save button; dirty/pending/success/failure presentation; reload on read failure. | Admin-only save remains absent/disabled as currently implemented; read remains available. | Phase 4 |
| `/searches` | `SearchLibrary.tsx` | Search/filter/list; create/edit viewer; archive/restore/delete/copy actions; dirty editor guard; empty/no-match/read-failure states. | No client admin gate on library editing; existing confirmations and 401/403 write-refusal handling remain. | Phase 4 |
| `/icp` | `Icp.tsx` (legacy/off-rail) | ICP list/viewer/editor; create/edit; archive/restore/delete/copy; campaign association and hand-built dialogs; local validation/error branches. Dirty-close parity is a migration requirement to verify, not a current shared guard claim. | No client admin gate on editing; existing API authorization/refusal handling remains; route stays URL-reachable. | Phase 4 |
| `/hypotheses` | `Hypotheses.tsx` (legacy/off-rail) | Hypothesis list/viewer/editor; create/edit; archive/restore/delete/copy; campaign links and analytics; hand-built dialogs and local validation/error branches. Dirty-close parity is a migration requirement to verify, not a current shared guard claim. | No client admin gate on editing; existing API authorization/refusal handling remains; route stays URL-reachable. | Phase 4 |
| `/sequences` | `SequenceBuilder.tsx` hub mode | Deployments/Build tabs; search; filter Dialog; archive-state controls; retry/empty/no-match; open builder; create blank sequence; archive/restore. | Hub create/edit/archive has no client admin gate; existing API write-refusal handling remains. | Phase 10 |
| `/sequences/:id` | `SequenceBuilder.tsx` editor mode | Compact document header; Edit/Branches/Preview modes; autosave/save/error/conflict; add/remove/reorder steps and variations; comments; preview; publish readiness/wizard; dirty navigation. | Publish controls/target reads/job history are admin-gated; ordinary editor controls retain their existing availability and API write-refusal behavior. | Phase 11 |
| `/health` | `Health.tsx` | Sync summary and recent sync runs; publishing compatibility read/error/empty; weekly briefing rerun with loading/error/success. | Admin-only briefing rerun and config actions keep current permission/refusal behavior. | Phase 3 |
| `/team` | `Team.tsx` | Invite teammate form; edit member; role/status actions; cancel/save; load/error/partial-directory states. | Management requires isAdmin plus provider-specific canManage; ordinary members retain directory reads. Server enforcement remains unchanged. | Phase 3 |
| `/chat` | `Chat.tsx` | New chat; suggested prompts; stream; stop/send; retry/regenerate; jump to latest; copy message/code; server-error branch. | Authenticated AI read/write contract stays unchanged; no new request for presentation. | Phase 10 |
| `/neon-activity` | `NeonActivity.tsx` (off-rail diagnostic) | Reload; instance/search filters; loading/error/empty/table states. | Authenticated read-only diagnostic route; remains URL-reachable. | Phase 3 |
| `*` | `App.tsx` wildcard | Replace redirect to `/`. | No data read/write. | Phase 2 |

## Phase 0 discrepancies and stable test handles

| ID | Current truth | Follow-up owner |
| --- | --- | --- |
| `phase0-drawer-export` | `src/ui/Overlay.tsx` implements `Drawer` and `src/ui/index.ts` exports it; current route consumer count is zero. `ConversationDrawer` is a separate product component and does consume modal behavior. | Done in Phase 1: zero consumers confirmed, primitive and export deleted; end placement lives on `Dialog`. |
| `phase0-refreshing-region-export` | `src/ui/States.tsx` implements `RefreshingRegion` and `src/ui/index.ts` exports it; current consumer count is zero. Routes currently use `UpdatingNote`/local state directly. | Done in Phase 1: zero consumers confirmed, deleted; UpdatingNote plus aria-busy is the refresh contract. |
| `phase0-filter-sheet-name` | `Toolbar.tsx` comments describe a `FilterSheet`, but no `FilterSheet` export exists. Leads, Replies, Sentiment Analysis, and Sequence Builder currently compose `Dialog` locally. | Phase 1 defines the composition contract before later route migration. |
| `phase0-gutter-contract` | Binding geometry is 24px below 1440px and 32px at 1440px and wider. The implementation's base token is 32px with a `@media (max-width: 1439px)` override in `base.css`; browser checks must verify exact computed values at 1280, 1440, and 1920. | Phase 0 records; route visual owners verify in their phase. |
| `phase0-gallery-y` | Gallery List chrome is a reference composition, not a real route. Its page header/tabs put the sample row at a different absolute y; it cannot prove the real list route's `y ≤ 340` requirement. | Phase 0 checklist; Phase 6 measures Leads/Follow-ups/Review on the route. |
| `phase0-selector-handles` | The two focused suites now query roles/names first. Existing non-styling `data-*` handles remain where they identify a structural table, campaign source, or deployed snapshot; no retired CSS class is used as a test handle. | Phase 0 focused tests; later inventory ratchet. |
