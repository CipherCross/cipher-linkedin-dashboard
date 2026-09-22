# Frontend component-system consolidation and redesign

## Goal

Use the completed Tailwind/shadcn foundation to give the dashboard one coherent visual language and one maintainable application-component layer. The programme replaces remaining compatibility classes, raw control chrome, duplicate state presentations, and hand-built modal behavior with the canonical `frontend/src/ui` contracts, then applies an explicit page grammar to every routed surface without changing data, permissions, URLs, business meaning, or workflow transitions.

This is a frontend-only, phased redesign. Each work package is small enough for a mid-level full-stack developer to implement, verify, commit, and revert independently. The planning estimate is **44–63 developer-days** for one developer, excluding review latency and the separately authorized production release; it is a sequencing range, not a delivery commitment.

## Non-goals

- No changes to `frontend/api/`, PostgreSQL, sync agents, auth contracts, data queries, metrics, funnel semantics, campaign publishing rules, reply-review business states, or notification behavior.
- No state-architecture rewrite. `DataContext`, route data hooks, URL state, reducers, drafts, dirty guards, autosave, revisions, branches, selections, and conflict ownership remain behaviorally unchanged.
- No removal, renaming, or permission change for an existing route, action, tab, filter, field, status, or error branch. Off-rail routes such as ICPs, Hypotheses, and Neon Activity remain reachable.
- No React, Vite, React Router, Recharts, `@dnd-kit`, Base UI, Tailwind, or shadcn replacement, and no second component library.
- No mobile or tablet redesign. The supported visual-acceptance matrix remains the binding PC matrix: **1280×720, 1440×900, and 1920×1080**. Existing narrow-screen shell behavior is preserved unless a later product decision explicitly removes it, but it is outside visual acceptance.
- No dark theme, density selector, language selector, or new palette/type/spacing system.
- No universal data-grid, form-builder, or page-framework abstraction. Routes continue to own domain columns, data, permissions, state transitions, and mutations.
- No forced conversion of contextual CSS that utilities express poorly: container/media queries, sticky geometry, generated chart DOM, drag transforms, keyframes, pseudo-elements, or the deliberate LinkedIn preview simulation may remain as documented exceptions.
- No production writes during visual acceptance. Save, import, publish, review, pipeline, follow-up, and drag/drop mutation paths are exercised only with existing unit fixtures or an explicitly approved disposable environment.
- No push or deployment because a local phase is complete. Production release is a separate, explicitly authorized phase.

## Research findings

### Current, measured baseline

The working-tree baseline was measured at `main` commit `2473665`. Phase 0 must regenerate it from the implementation starting commit because these are directional planning numbers, not deletion authority.

| Metric | Current footprint |
| --- | ---: |
| TSX files / lines | 110 / 24,567 |
| CSS files / lines | 22 / 4,382 |
| `src/ui/ui.css` | 2,018 lines |
| Compatibility section in `ui.css` | begins at line 604; about 1,415 lines, but is not wholly disposable |
| Canonical `<Button>` call sites | 101 |
| Raw `<button>` elements | 228 |
| Raw `<input>` / `<select>` / `<textarea>` / `<table>` | 79 / 30 / 21 / 17 |
| Hand-built `role="dialog"` roots | 9 |
| Shared `<Dialog>` call sites | 10 |
| Unused `<Drawer>` / `<RefreshingRegion>` call sites | 0 / 0 |

The nine hand-built dialogs are two each in `Icp.tsx`, `Hypotheses.tsx`, and `SequenceBuilder.tsx`, plus `CompanyResolutionModal`, `LostReasonModal`, and `ConversationDrawer`. A raw element is not automatically a defect: file inputs, semantic checkboxes, chart/table markup, pressable rows, and complex editors need either the correct canonical contract or an explicit exception.

### The foundation exists, but its documentation has drifted

- `tokens.css`, the Tailwind token bridge, one layered CSS entrypoint, `src/ui/index.ts`, generated widgets in `src/components/ui`, the development gallery, and cascade/unknown-class guards are already present.
- Product pages correctly treat `src/ui/index.ts` as the normal import seam. Direct generated-widget imports are currently legitimate only inside generated widgets and named application compositions such as `QuickNavigation`, `ToastContext`, `DateRangePicker`, and the development Gallery; Phase 0 records that finite list.
- `docs/ui-standard.md` says `Drawer` and `RefreshingRegion` were removed, while both are still exported and implemented with zero consumers. The implementation must reconcile code and documentation before using either statement as evidence.
- `ui.css` labels the block after line 604 as compatibility CSS, but that block also contains current global form normalization, KPI layouts, banners, skeletons, auth, navigation, and domain-component rules. It cannot be deleted as one block. Every selector needs a consumer and destination before deletion.
- `Toolbar.tsx` describes a `FilterSheet`, but no such exported primitive exists. Replies and Leads currently reproduce the draft/apply footer around `Dialog`; this contract must be defined before further adoption.
- The shared state tier is incomplete. `States.tsx` owns updating and inline failure, while initial loading and empty states live in `Skeleton.tsx` and `EmptyState.tsx`; pending, saved, and conflict presentation are route-local.

### Binding constraints from the current product

- `docs/ui-standard.md` requires 1280×720, 1440×900, and 1920×1080. The 1280 width is also protected by Replies CSS/tests and by the list-chrome requirement that the first result begin no lower than y=340.
- Page gutters are 24px **below 1440** and 32px at 1440 and wider. The sidebar is 232px when shown; hiding it must not change route state.
- `npm run build` is the only TypeScript check for `src/`. `npm run test` contains CSS guards that expect a built `dist`, so build precedes the full test suite.
- Vitest/jsdom cannot validate cascade, computed geometry, focus scheduled through `requestAnimationFrame`, container queries, or clipping. There is no Playwright/Cypress harness in the repository. Browser acceptance is therefore a documented manual procedure, not an automated claim.
- The prior authenticated audit covered all internal route types at 1280, but only Overview, Replies, and Follow-ups at 1440 and 1920. It confirmed that real route rendering—not the gallery alone—is required, especially for Replies inspector reachability and Follow-ups clipping.

### Concentration and risk

| Module | Current size / risk | Planning consequence |
| --- | --- | --- |
| `SequenceBuilder.tsx` | 1,515 lines; autosave, revisions, DnD, publish | Last route family; split hub from editor/publish |
| `LeadsExplorer.tsx` | 1,160 lines; URL filters and wide table | Separate list phase with URL/action parity tests |
| `Icp.tsx` | 1,041 lines; nested forms and two dialogs | Migrate viewer and editor together, after Dialog |
| `ConversationDrawer.tsx` | 968 lines; modal, drafts, review transitions | Dedicated Replies phase; preserve focus and dirty state |
| `UnifiedApolloCsvImport.tsx` | 829 lines; multi-step writes | Own phase with fixture-only mutation checks |
| `Hypotheses.tsx` | 760 lines; viewer/editor and analytics | Pair with ICP only after reference forms are accepted |
| `Team.tsx` | 714 lines; permissions and member actions | Lower-risk reference for directory/table/dialog grammar |

The safest reduction is horizontal at first—repair and complete shared contracts—then vertical by bounded route family. Starting with the largest stateful files would move risk faster than it removes duplication.

### External guidance applied

- [Tailwind source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files) requires complete, statically discoverable class strings. Variant maps use complete strings, and the inventory reuses the TypeScript-AST approach from `unknownClasses.test.ts` instead of regex.
- [shadcn/ui](https://ui.shadcn.com/docs) provides editable local component code rather than a runtime design-system boundary. Generated widget internals remain behind application-level contracts.
- [Base UI Dialog](https://base-ui.com/react/components/dialog) owns modal focus trapping, scroll locking, Escape/outside interaction, and focus restoration. It also requires a Dialog Close part inside modal popups for touch-screen-reader escape; the current ordinary `IconButton` close needs correction before nine modal migrations depend on it.
- [Testing Library query priorities](https://testing-library.com/docs/queries/about/) support role/name-first tests. Existing class-selector dependencies must be replaced with semantic queries or a stable `data-testid` only when semantics cannot identify the target.

## Decisions

1. **No new product clarification is required.** The existing plan, live code, `AGENTS.md`, and `docs/ui-standard.md` resolve scope. Where prose and code disagree, Phase 0 records the discrepancy; current code remains the behavioral source until the binding document is corrected.
2. **1280×720 remains supported.** Dropping it would contradict the binding standard and existing regressions. Acceptance is exactly 1280×720, 1440×900, and 1920×1080.
3. **Behavior is frozen; presentation is not.** Hierarchy, grouping, density, and action placement may change only as specified below. Data meaning, labels, available actions, permissions, URLs, state transitions, and network behavior do not.
4. **`src/ui` is the application seam.** Generated code stays in `src/components/ui`. Product routes import from `src/ui`; direct generated-widget imports are allowed only for the finite infrastructure/composition allowlist recorded in Phase 0.
5. **The page grammar has four families.** Overview/detail, search/list, workspace, and editor are composition rules, not four new framework components.
6. **One visible action hierarchy.** A PageHeader may have at most one filled primary action. Page-level secondary actions sit beside it or in the first Toolbar; row actions stay in the row/menu; destructive actions require their existing confirmation and are never promoted merely for visual consistency.
7. **Two visible containment levels maximum.** A page may contain framed sections. A row, KPI, chart, or nested panel inside a framed section does not also receive border + fill + shadow unless selection or status meaning requires it.
8. **Filter overlays use a positioned Dialog contract.** Search and at most two primary selectors stay on the page. Additional filters open in an end-positioned modal Dialog, 560px wide at most, with fixed header/footer and a scrolling body. It is not a persistent workspace pane and is not named `Drawer`.
9. **CSS is allowed by responsibility.** Compatibility aliases and duplicated component styling must disappear. Contextual selectors/geometry may remain only with a ledger entry and an adjacent `ui-exception(<id>)` comment.
10. **No arbitrary line-count quota.** Progress is measured by retired duplication categories, zero-consumer selector deletion, route contracts completed, and the exception ledger. Net TSX/CSS and gzip changes are reported, not optimized at the expense of behavior.
11. **Evidence levels remain separate.** Unit/build success, built-CSS inspection, local/gallery rendering, authenticated preview rendering, production rendering, and real mutation/downstream proof are never conflated.
12. **Release remains separately authorized.** The implementation can finish and be locally/preview verified without push, deploy, or production writes.

## Approach

### 1. Establish an executable baseline and ratchet

Phase 0 adds:

- `frontend/scripts/ui-inventory.mjs` — a TypeScript-AST scan with deterministic sorted output;
- `frontend/ui-inventory-baseline.json` — the current findings and bundle-size baseline;
- `frontend/ui-inventory-allowlist.json` — semantic exceptions;
- `npm run ui:inventory` — check mode, non-zero on a new violation or increased count;
- `npm run ui:inventory:update` — explicit baseline regeneration for a reviewed migration commit.

The inventory reports:

- raw interactive/table elements outside `src/ui`, `src/components/ui`, and allowed semantic owners;
- product imports that bypass `src/ui`;
- `.btn`, `.link-btn`, `.card`, `.badge`, and other named compatibility tokens;
- `role="dialog"`, `aria-modal`, and known modal-root patterns outside the shared overlay;
- compatibility selectors and every statically discoverable consumer;
- TSX/CSS lines and built JS/CSS gzip by entry/route chunk; the dev-only Gallery chunk is excluded from production totals.

It does **not** guess semantic duplication such as tone maps or copy helpers. Those are named in the route/component ledger and reviewed manually.

Each allowlist entry has this stable shape:

```json
{
  "id": "native-file-input-csv",
  "kind": "raw-control",
  "path": "src/pages/UnifiedApolloCsvImport.tsx",
  "symbol": "UnifiedApolloCsvImport",
  "owner": "frontend/import",
  "reason": "Native file input hidden behind the canonical upload action",
  "verification": "Keyboard activation and announced filename",
  "removeByPhase": null
}
```

Line numbers are evidence, not identifiers, because they drift. `removeByPhase` must name a phase for temporary compatibility entries. Phase 0 proves the guard by introducing one raw control, one legacy token, and one forbidden direct import in a temporary patch, observing failures, then reverting the patch before commit.

### 2. Define the canonical presentation contracts before adoption

The application tier owns these contracts:

| Responsibility | Canonical owner / required change |
| --- | --- |
| Actions and links | `Button`, `LinkButton`, `ExternalLinkButton`, `IconButton`; action remains `<button>`, navigation remains a link |
| Fields | `Field` and typed field wrappers; visible/wired label, help, error, `aria-invalid` |
| Status and identity | `Badge`, `StatusText`, `AccountIdentity`; color always travels with text |
| Page/section hierarchy | `PageHeader`, `Panel`, `SectionHeader` |
| Lists/tables | `Toolbar`, `ActiveFilters`, `TableFrame`, `TableToolbar`, `Table`; route owns columns/filter/sort/page |
| Overlays | `Dialog` gains `placement="center"` or `placement="end"`; uses Base UI Close; supports busy close refusal and explicit initial/final focus |
| Filter overlay | A small `FilterDialog` composition around end-positioned `Dialog`; route owns draft values and Apply logic |
| Initial load | Existing route-shaped `PageSkeleton`; remains shell-owned |
| Refresh | `UpdatingNote` plus `aria-busy`; old results stay labelled with their old scope until replacement |
| Empty / no match | `EmptyState` moves behind/re-exports through `src/ui` with explicit `empty` and `no-match` copy |
| Failure | `InlineError` for reads; route mutation errors retain draft and actions |
| Save/conflict | `SaveStatus` is presentational only and receives the existing route state; it never owns autosave or conflict resolution |
| Dirty close | `useDirtyGuard`; same Keep editing / Discard changes behavior for Escape, backdrop, Close, and navigation |

`Drawer` and `RefreshingRegion` are deleted if the Phase 0 scan still finds zero consumers; `docs/ui-standard.md` is corrected in the same commit. Persistent panes remain ordinary, non-modal regions. The named `ConversationDrawer` is a modal conversation surface today and may keep its product name while moving to the shared modal behavior.

Domain meaning does not move into primitives:

- reply-review labels/intent/sentiment remain in `lib/replyReview.ts` and its existing adapters;
- pipeline/stage labels remain in `lib/leads.ts` or their current domain module;
- chart colors and data-series presentation remain in `components/chartTheme.tsx`;
- `src/ui/labels.ts` contains generic application copy only.

Repeated local maps import their domain owner; they are not combined into one untyped global map.

### 3. Apply objective page grammar

Shared geometry and placement:

- Sidebar: 232px shown; existing hide/show command and focus restoration remain.
- Page gutter: 24px at 1280; 32px at 1440 and 1920.
- Analytics maximum width: 1600px; list/workspace routes use the available content width.
- Control height: 44px; icon target: 44×44 around a 20px glyph.
- Type floor: 13px. Body/controls: 16/24px; table text: 14/20px.
- Radius: 8px controls, 12px sections, 16px dialogs; pill only for badges/chips.
- Cards have no decorative shadow. One overlay shadow is allowed on popup/dialog/end sheet.
- A list route reads PageHeader → Toolbar → ActiveFilters → results. With default filters, the first result's top position is y≤340 at 1280×720.
- Wide tables/boards scroll inside a named local region with a visible hint; they do not shrink text or create page-level horizontal overflow.
- A workspace uses the remaining viewport height for named, independently scrollable panes. Primary controls and the selected item remain reachable without relying on viewport width to reveal a hidden inspector.
- An editor uses compact document context, mode tabs, primary canvas, and an optional secondary pane. Save/publish state remains visible while content scrolls.

Reference compositions and action placement:

| Family / surfaces | Final anatomy | Behavior that must not change |
| --- | --- | --- |
| Shell and access: `Layout`, Quick Navigation, sign-in, reset, non-admin | Stable sidebar/top-level content; centered single-surface auth card; errors directly above the affected form; one primary submit | Route registry, admin gates, collapsed groups, focus return, recovery links, sign-out |
| Overview | PageHeader → System totals with its own range → Performance with account + its own range → Account analytics/campaign comparison with its own range | Three independent ranges/reads; cohort denominators; bounded lazy preview; section-level refresh/error isolation |
| Account detail | Breadcrumb PageHeader + identity/date → KPI/funnel context → Added this week → campaign table | Account scope, date math, links, campaign rows |
| Campaign detail | Breadcrumb/context PageHeader → Leads & replies / Performance / Sequence tabs; tab content order stays as today | Runtime vs provenance remain distinct; URL tab/range/compare state; campaign-step and briefing meaning |
| Sentiment / Review | PageHeader → period/mode control → overlay filters → metric/analysis sections → drill-down actions | UTC analytical intervals; existing denominators; Slack action permissions and disabled reasons |
| Leads | PageHeader → search/account/Filters Toolbar → ActiveFilters → sentiment tabs → table → selected-lead conversation surface | URL filters, selection, pagination/sort, column toggle, gender review, digest and export behavior |
| Follow-ups | PageHeader → primary filters → due-date groups → selected follow-up details/actions | Madrid operational dates, open action reachability, owner scope, write refusal/error states |
| Team / Health / Neon Activity | PageHeader → summary/context → one table/list section → row actions or detail dialog | Admin/member permissions, sync/publish states, diagnostic read behavior |
| Searches / ICPs / Hypotheses | PageHeader → search/filter Toolbar → list/comparison → viewer → editor Dialog | Off-rail routes stay reachable; dirty guard; archive/restore/delete/copy; existing analytics |
| Playbook | PageHeader → mode control → one editing surface → sticky save/status row | Admin gate, dirty/save/error behavior, stored content |
| CSV Import | PageHeader → importer → upload → file review → company resolution → contact review → results | Existing four-stage state machine, file semantics, retries, no production mutation in acceptance |
| Replies | PageHeader/tabs/filter action → queue list → conversation → review inspector, all reachable at 1280 | Draft filter Apply/Cancel, selection, conversation draft, review transitions, cached paging, dirty navigation |
| Pipeline / campaign leads | PageHeader + compact controls → horizontally scrollable board or lead list → conversation modal | Stage/substatus/owner semantics, selection, local scrolling, write refusals |
| Chat | PageHeader → message stream → composer; copy stays on message/code blocks; stop/send stay at composer end | Streaming, retry, stop, scroll/jump-to-latest, prompt/data behavior |
| Sequence hub | PageHeader → Deployments/Build tabs → toolbar/filter overlay → deployment table or sequence library | Filters, archive/restore, navigation, current/archived scope |
| Sequence editor | Compact document header/save state → Edit/Branches/Preview modes → canvas → comments/publish overlays | Autosave, revisions, DnD keyboard/pointer behavior, branch selections, preview, publish readiness and snapshot |
| Gallery | Primitives → Compositions → List chrome → Widgets | No API/session, dev-only route, every contract/state represented |

The first completed route in each family is its reference implementation: Team for directory/table/dialog, SearchLibrary for list + dirty form, Leads for wide list, Replies for workspace, Overview for analytics, and Sequence Hub for editor navigation. Propagation begins only after that reference passes this spec’s checklist in phase review; no additional product-design decision is delegated to the implementer.

### 4. Preserve behavior with explicit transition contracts

- **Filter overlay:** applied values → open draft → edit any field → Apply commits every filter key atomically and resets cursor/page; Cancel/Escape/backdrop leave URL, data, selection, and scroll unchanged; Clear all changes the draft only until Apply.
- **Dirty form:** clean close is immediate; dirty Close/Escape/backdrop/navigation offers `Keep editing` and `Discard changes`; Keep editing returns focus; pending submission cannot double-submit; failure retains the draft; success uses the route’s current close/navigation behavior.
- **Scope change:** layout never changes selection. A new account/filter that excludes the selected item resolves dirty state first, then updates scope and selection atomically. Old data is never shown under the new scope label.
- **Background refresh:** headings, controls, and current results remain stable and visibly `Updating…`; completion replaces only the relevant region and does not reset unrelated tabs, scroll, selections, or drafts.
- **Dialog:** focus enters at the intended control, cycles inside, Escape/outside follows the same close guard, background interaction is unavailable, scroll is locked, and focus returns to the exact trigger. Busy dialogs refuse accidental close but still expose an accessible explanation.
- **Table/list:** sorting, paging, filters, selected row, keyboard activation, and row action propagation retain their existing behavior. A pressable row uses link/button semantics or a documented exception, not visual Button chrome around the entire row.
- **Editor:** presentational extraction receives explicit values/callbacks from the existing state root. It never creates a second draft, save timer, revision, branch, DnD, publish, or conflict source.
- **Permissions:** admin-only actions remain absent/disabled exactly as today, with the current server enforcement untouched. A visual refactor must not make an unauthorized action merely look unavailable while leaving it callable.

### 5. Convert and delete safely

Each bounded conversion unit follows this order:

1. Record current actions, labels, states, keyboard behavior, network calls, and selector consumers.
2. Add/adjust the canonical primitive contract and its Gallery/test coverage before migrating routes.
3. Replace call sites without changing handlers, disabled/loading logic, ARIA, URL state, or data ownership.
4. Move contextual rules to the nearest route/component stylesheet. Add `/* ui-exception(<id>): reason; verify: check */` beside every retained exception and a matching ledger entry.
5. Delete a shared selector only after the inventory proves its final consumer moved. If another route still consumes it, keep it with a named `removeByPhase` entry.
6. Build first, then run focused tests and the inventory. For deleted route-sheet declarations, run `css-parity.mjs` and directly inspect placement-sensitive `@media`/`@container` output; declaration presence alone does not prove placement.
7. Render the affected states at all three viewports, record the manual checklist, and commit the bounded unit.

No commit may leave two implementations of the same visual role on one route. A temporary adapter may survive only until the named next phase and must have an allowlist entry.

### 6. Verification and performance budgets

Per conversion commit, from `frontend/` unless noted:

1. `npm run build`;
2. focused Vitest files for the changed primitive/route;
3. `npm run ui:inventory`;
4. relevant CSS parity/placement checks;
5. `git diff --check` from the repository root;
6. browser checklist for the affected route/states at 1280×720, 1440×900, and 1920×1080.

At every phase gate:

1. `npm run build`;
2. `npm run test`;
3. `npm run typecheck:api`;
4. `npm run ui:inventory`;
5. full affected-family keyboard and browser checklist;
6. a short phase report: consumers migrated, selectors/dependencies removed, exceptions added/removed, TSX/CSS delta, production JS/CSS gzip delta, and evidence level.

Focused test ownership is explicit; a phase adds the named missing page-level suite rather than claiming unrelated domain tests as UI proof:

| Work package | Existing focused suites to retain | Page-level coverage to add or extend |
| --- | --- | --- |
| Primitives / CSS | `uiPrimitives`, `cssCascade`, `unknownClasses`, `dateRangePickerAccessibility`, `toastPersistence` | inventory mutation tests; Dialog center/end/focus/busy tests |
| Shell / auth | `navigation`, `quickNavigation`, `applicationAuth`, `resetPasswordScreen`, `errorBanner`, `visiblePolling` | admin fallback and sidebar hide/show focus test |
| Team / Health / Neon Activity | identity and roster suites | `teamPage`, `healthPage`, `neonActivityPage` UI contracts |
| Search / Playbook / ICP / Hypotheses | `playbookPage` | `searchLibraryPage` and `icpHypothesesPages` viewer/editor/dirty contracts |
| CSV Import | `unifiedApolloCsvImport`, `companyImport`, `contactImport`, `csvImport` | Company resolution modal focus/close contract |
| Leads / Follow-ups / Review | `leadsExplorerDigest`, `panelReadBranches`, `overviewOperations` | filter atomicity, Follow-ups action reachability contract, Review action parity |
| Replies / conversation | `repliesInboxActions`, `repliesInboxCaching`, `repliesInboxComponents`, `repliesInboxPagination`, `repliesInboxUiContract`, `repliesWorkspaceCss`, `replyReview` | shared Dialog migration and dirty focus-return cases |
| Pipeline / campaign leads | `pipelineLegacyMemberRedirect`, `campaignWorkspace` | board overflow, row activation, write-refusal UI contract |
| Analytics / detail | `overviewAnalytics`, `overviewOperations`, `sentimentAnalysis`, `weeklyTrendChart`, `campaignRuntimeStatus`, `campaignWorkspace` | independent section refresh/error and three-range preservation |
| Chat / sequences | `chatRosterPrompt`, `sequenceBuilderPage`, `sequenceBuilder`, `sequencePublishWizard`, `sequencePublishFixture` | Chat stream controls and editor Dialog migration cases |

Required manual state coverage is initial load, populated default, long labels/messages, empty, no-match, read failure, and background refresh wherever the route supports that state. Mutation surfaces additionally cover clean, dirty, pending, success, failure, conflict, and permission-refused branches with fixtures. Admin and ordinary-member views are both checked for Team, CSV Import, Health actions, Playbook, and any other permission-gated action.

Phase 0 records the exact gzip baseline. Afterward:

- no new runtime UI dependency without a separate approved decision;
- production entry JS may not grow more than 5% from Phase 0 without an explained exception;
- an affected route chunk may not grow more than the larger of 10% or 10KB gzip without an explained exception;
- final production CSS gzip must be at or below the Phase 0 baseline;
- the dev-only Gallery chunk is reported separately and excluded;
- no phase adds an API request, expands a query, or changes polling merely to support presentation.

Phase 0 adds the reusable checklist template at `frontend/tests/manual/ui-redesign-checklist.md`. A completed copy is attached to the phase handoff; screenshots containing customer data are not committed. Each row records commit, environment, role, route/state, viewport, keyboard result, visual result, and issue link. API-backed routes use `vercel dev` with safe local fixtures or an authenticated read-only preview; `vite dev` is sufficient only for the Gallery. Authenticated production evidence is collected only in the separately authorized release phase.

## Implementation phases

1. **Phase 0 — Contract repair, inventory, and evidence harness (M, 2–3 days).** Add the AST inventory, baseline, allowlist, scripts, selector-owner ledger, route/action/state checklist, and bundle baseline. Reconcile the 1280/gutter contract and the `Drawer`/`RefreshingRegion` documentation drift. Replace existing CSS-selector test handles in `panelReadBranches.test.tsx` and `campaignWorkspace.test.tsx`. Exit: deliberate inventory mutations fail; the unmodified baseline passes; no visual/product change.

2. **Phase 1 — Complete and harden shared contracts (M, 3–4 days).** Correct Dialog Close/focus behavior; add center/end placement and the FilterDialog composition; unify EmptyState through `src/ui`; define SaveStatus presentation; remove still-unused Drawer/RefreshingRegion; convert Toolbar’s own raw buttons; pin all states in Gallery and primitive tests. Exit: every later phase can use a documented primitive without inventing overlay/state behavior.

3. **Phase 2 — Shell, auth, reset, access, and shared feedback (M, 2–3 days).** Convert `App` admin fallback, `AuthContext`, `ResetPassword`, `Layout`, Quick Navigation integration, ErrorBoundary, Skeleton, toast/feedback, and shell actions. Preserve the current ≤900px path without accepting it visually. Exit: sign-in, recovery/reset, admin/non-admin, sidebar hide/show, grouped navigation, quick navigation, error, initial loading, and focus return pass focused tests and the three-PC shell check.

4. **Phase 3 — Reference directory and diagnostic routes (M, 3–4 days).** Convert Team first, then Health and Neon Activity. Establish the directory/table/row-action/dialog reference. Exit: no legacy aliases or hand-built form chrome in these routes; admin/member and diagnostic empty/error states are covered.

5. **Phase 4 — Library and form routes (L, 4–6 days).** Convert SearchLibrary first, then Playbook, ICP, and Hypotheses. Replace four hand-built ICP/Hypotheses dialogs only after SearchLibrary proves the shared Dialog/dirty behavior. Consolidate CopyButton use and domain-owned labels/tones. Exit: viewer/editor/archive/copy/dirty/save/failure behavior passes; off-rail routes remain directly reachable.

6. **Phase 5 — CSV import workflow (M, 3–4 days).** Convert UnifiedApolloCsvImport, CompanyResolutionModal, ImportHistoryPanel, and import callouts as one state-machine surface. Preserve the native file-input exception and every retry/resolution/result branch. Exit: fixture-only upload/preview/resolve/commit success and failure tests pass; no production write is used for acceptance.

7. **Phase 6 — Search/list operations (L, 4–6 days).** Convert Leads, Follow-ups, Review, their tables, filters, empty/error states, and follow-up panels. Leads is the wide-list reference; keep URL filter atomicity and selection. Exit: first result y≤340 at 1280 default state, Follow-ups primary action is fully reachable at 1280, and wide content scrolls locally.

8. **Phase 7 — Replies and conversation modal (L, 4–6 days).** Convert Replies, ConversationDrawer, conversation child panels, and LostReasonModal. Move the drawer’s modal behavior to the shared Dialog contract without changing its product name or review state root. Exit: queue, thread, and inspector are visible/reachable at 1280/1440/1920; paging cache, dirty navigation, filter draft, focus return, and review transitions pass.

9. **Phase 8 — Pipeline and campaign-leads workspace (M/L, 3–5 days).** Convert Pipeline, `LeadsAndRepliesWorkspace`, shared campaign lead rows, and their conversation entry points. Exit: local horizontal scrolling, card selection, owner/stage/substatus controls, write-refusal states, and conversation opening pass without page overflow.

10. **Phase 9 — Analytics and detail family (L, 5–7 days).** Convert Overview, AccountDetail, CampaignDetail performance/sequence presentation, SentimentAnalysis, KPI/funnel/chart/table components, and DateRangePicker integration. Preserve the three Overview read/range boundaries, cohort denominators, UTC labels, runtime/provenance distinction, and bounded lazy campaign preview. Exit: each analytics section independently proves initial/loading/refresh/empty/error; chart palette has one owner; all three viewports pass.

11. **Phase 10 — Chat and Sequence Hub (M, 3–4 days).** Convert Chat message actions/composer and the Sequence Hub’s Deployments/Build landing states. Consolidate Chat’s private copy action. Exit: stream/stop/retry/jump behavior and sequence list/deployment filters/archive/navigation pass; no editor state is changed yet.

12. **Phase 11 — Sequence editor and publish workflow (L, 5–7 days).** Convert editor header, step/variation controls, branch builder, comments, preview, two remaining hand-built dialogs, and publish wizard presentation. State ownership and DnD sensors remain in the current root. Exit: autosave, saved/error/conflict, revision, keyboard/pointer reorder, branch selection, preview, readiness, busy close, and publish fixture suites pass.

13. **Phase 12 — Compatibility deletion, documentation, and full acceptance (M, 3–4 days).** Remove the final zero-consumer aliases, compatibility marker block, dead exports/helpers/imports, stale direct-import entries, and temporary adapters. Move retained contextual rules to their owners. Update `docs/ui-standard.md`, the Gallery, and final inventory. Run the complete route/state/role/viewport matrix and final performance report. Exit: every exception is intentional and named; all commands and browser checks are green.

14. **Phase 13 — Production release (S/M, 1–2 days, separately authorized).** Push/deploy the approved commit, confirm Vercel `Ready` and production aliases, and repeat authenticated read-only smoke checks for shell/auth role, one route per family, Replies, and Sequence Editor at all three viewports. Inspect fresh affected request logs. Production mutation checks remain out of scope without separate safe-fixture authorization.

Phases 3–11 depend on Phases 0–2. After Team and SearchLibrary establish reference compositions, later route phases are independently shippable and revertible. A phase may be split into smaller commits, but one route cannot be left with a half-migrated visual role at the phase gate.

## Affected files/modules

### Foundation and application UI

- `frontend/src/index.css`
- `frontend/src/styles/tokens.css`, `base.css`, and `reset.css`
- `frontend/src/ui/index.ts` and `ui.css`
- `frontend/src/ui/{Button,Field,Badge,Identity,Overlay,PageHeader,Panel,States,Table,Tabs,Toolbar,Gallery,useDirtyGuard}.tsx`
- `frontend/src/components/ui/*` only when generated behavior must be corrected behind the application seam
- `frontend/src/components/{DateRangePicker,EmptyState,Skeleton,ErrorBoundary,CopyButton,QuickNavigation}.tsx`
- `frontend/src/lib/ToastContext.tsx`

### Shell, auth, and routes

- `frontend/src/App.tsx`
- `frontend/src/lib/AuthContext.tsx`
- `frontend/src/lib/navigation.ts`
- `frontend/src/components/Layout.tsx` and `layout.css`
- every routed page under `frontend/src/pages/`, including ResetPassword, the off-rail ICP/Hypotheses/Neon Activity pages, and their route-local stylesheets

### Shared product compositions

- `frontend/src/components/ConversationDrawer.tsx` and conversation child modules
- `frontend/src/components/leads-and-replies/*`
- `frontend/src/components/overview/*`
- `frontend/src/components/reply-analysis/*`
- `frontend/src/components/{FollowUpPanel,CompanyResolutionModal,LostReasonModal,ImportHistoryPanel,InstanceConfigEditor,MessageSequence,KpiCards,Funnel,CampaignTable,CampaignCompareTable,CohortComparisonTable}.tsx`
- chart components and `frontend/src/components/chartTheme.tsx`
- remaining component stylesheets listed by `frontend/src/index.css`

### Guards, evidence, tests, and documentation

- new `frontend/scripts/ui-inventory.mjs`
- new `frontend/ui-inventory-baseline.json` and `frontend/ui-inventory-allowlist.json`
- existing `frontend/scripts/{css-declares,css-parity}.mjs`
- `frontend/package.json`
- primitive, route, overlay, auth, accessibility, CSS-cascade, and unknown-class tests under `frontend/tests/`
- `docs/ui-standard.md`
- this spec for final status/evidence links only; implementation decisions above are not reopened during delivery

`frontend/api/`, `postgres/`, and `sync-agent/` are outside the affected-file boundary. A test-only import-path update is allowed only when runtime behavior is unchanged and is called out in the phase commit.

## Risks & how to verify

| Risk | Control | Required proof |
| --- | --- | --- |
| Baseline/document claims are stale | Regenerate from starting commit; code is behavioral source | Committed deterministic inventory plus corrected standard |
| AST inventory mistakes semantic exceptions | Candidate scan + explicit stable allowlist; never auto-delete | Mutation test and reviewer-readable occurrence list |
| Shared CSS is deleted before its final consumer | Selector-owner ledger and `removeByPhase` | Zero consumers before deletion; CSS parity + placement inspection |
| Tailwind drops dynamic classes | Complete strings in variant maps | Build + unknown-class guard + generated CSS check |
| Layer/specificity regression | Preserve one declared layer order | Cascade tests and computed browser states |
| Dialog migration breaks focus/drafts | Harden shared Dialog first; use one close guard | Tab/Shift+Tab, Escape, outside click, busy, dirty, final focus tests |
| Pressable rows acquire inappropriate Button chrome | Preserve semantic row/link contract or allowlist exception | Role/name/keyboard checks and visual comparison |
| Redesign hides or demotes actions | Route action ledger; exact placement rules | Before/after action parity per route and role |
| 1280 controls clip or inspector disappears | 1280 remains first-class; local scroll regions | Full affected-route 1280 check with long content |
| Hidden/auth routes are omitted | Every App route and pre-router surface has one phase owner | Route matrix has no unowned surface |
| Sequence/Replies duplicate state | Presentation remains controlled by current owner | Existing autosave/review/dirty/paging suites plus focused interactions |
| Tests depend on styling classes | Role/name first; stable test id only if needed | Inventory reports no dependency on retired classes |
| “Maximum deletion” creates hollow abstractions | Reuse or binding contract required | Phase report lists each new abstraction and consumers |
| Bundle grows despite CSS removal | Phase 0 gzip baseline and phase budgets | Per-phase entry/route/CSS report |
| Local proof is reported as production proof | Evidence table records environment and proof type | Separate local, preview, production, and mutation results |

## Definition of done

- Phase 0 and final inventory reports show exact deltas for raw elements, forbidden imports, compatibility tokens, modal roots, selector consumers, TSX/CSS lines, and production gzip.
- `docs/ui-standard.md`, Gallery, exports, and live code agree; no claim says an exported/implemented primitive was removed when it was not.
- Product routes import application contracts through `src/ui`; the generated-widget direct-import allowlist contains only named infrastructure/composition owners.
- Product call sites contain no raw control/table implementation that duplicates an existing canonical contract. Remaining native elements have stable allowlist entries with reason and verification.
- `.btn`, `.link-btn`, `.card`, `.badge`, and other compatibility aliases have zero product consumers and their compatibility declarations are deleted.
- `ui.css` contains only current cross-route application contracts. Route/domain geometry lives with its owner, uses tokens, and has a matching `ui-exception(<id>)` ledger entry where utilities are insufficient.
- All nine hand-built modal roots use the hardened shared Dialog behavior or are explicitly documented as non-modal regions. Dialog Close, focus trap/restoration, dirty close, and busy behavior pass.
- Copy actions, generic state presentation, identity display, and each domain’s label/tone mapping have one named owner; enum meaning and chart/data semantics are unchanged.
- Every App route, auth/reset/non-admin state, shell, hidden route, and dev Gallery belongs to exactly one completed phase and conforms to its specified composition.
- Overview still has three independent range/read regions; reply rate remains `replied / connected`; UTC analytics and Madrid operational time remain visibly distinguished.
- Sequence Builder, Replies, ConversationDrawer, CSV Import, and Pipeline keep their existing state/data owners and pass the named autosave, dirty, conflict, selection, paging, DnD, revision, permission, and publish/import fixture checks.
- The full PC matrix passes at 1280×720, 1440×900, and 1920×1080. Default list results start by y=340 at 1280; primary actions and Replies inspector remain reachable; text respects the 13px floor; wide content scrolls locally; no unintended page-level horizontal overflow exists.
- Keyboard focus, accessible names, heading order, table/scroll-region names, non-color status cues, disabled reasons, errors, Dialog behavior, and reduced-motion behavior pass the shared contracts.
- No new API request, query expansion, polling behavior, runtime UI dependency, or production write was introduced. Bundle budgets pass or have an explicit approved exception.
- Final `npm run build`, `npm run test`, `npm run typecheck:api`, `npm run ui:inventory`, CSS checks, and `git diff --check` are green on the final implementation commit.
- The exception ledger contains only intentional permanent cases. No temporary adapter, stale selector, expired allowlist entry, or removal issue remains.
- Each phase is independently revertible and its handoff distinguishes local tests, local/browser rendering, authenticated preview, production rendering, and any separately authorized mutation/downstream evidence.
