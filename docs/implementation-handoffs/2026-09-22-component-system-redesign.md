# Component-system redesign implementation evidence

Accepted scope: `specs/2026-09-22-frontend-component-system-redesign.md`, Phases 0–12. Phase 13, push, deployment, production verification, database changes, and external mutations are not authorized.

Starting revision: `38d139b` (clean working tree). The implementation follows the accepted phase gates; this file records evidence, not a new plan.

## Phase 0 — accepted (2026-09-23)

Acceptance: deterministic AST inventory, reviewed exceptions and selector ownership, complete route/action/state ledger, original gzip baseline, three deliberate violation checks, semantic replacements for the two styling-dependent suites, corrected contract documentation, and green build/full tests/API typecheck/inventory/diff check. Product and visual behavior must remain unchanged.

Starting checks (before Phase 0 edits):

- `npm run build`: passed. Vite's existing large-chunk advisory remains.
- `npm run test`: 83 files, 1,313 tests passed.
- `npm run typecheck:api`: passed.
- Local Gallery on Vite: computed page gutters 24px at 1280×720 and 32px at 1440×900 / 1920×1080; no page horizontal overflow in List chrome at those sizes. This is baseline geometry evidence only. The Gallery header precedes its example; its absolute first-row coordinate is not real-route acceptance.

No implementation phase has been accepted yet. No product-route browser acceptance or production evidence has been collected.

Inventory and contract slice ready (Phase 0 gate remains open for the local API fixture harness):

- AST inventory: 356 raw product controls plus one native-file-input exception; 1,524 compatibility-token occurrences; 452 contextual CSS rules; nine hand-built modal roots.
- Original gzip retained: production JS 650,876 bytes, CSS 40,865 bytes; Gallery JS 22,972 bytes separately.
- Source exclusions prevent evidence scripts/tests/JSON from creating Tailwind utilities. Built CSS comparison removed only five unused test/comment utilities (`@container`, `w-[137px]`, `truncate`, `shadow`, `outline-ring/50`); no shared rule declarations changed.
- Latest production gzip: JS 650,870 bytes, CSS 40,799 bytes; Gallery JS 22,973 bytes separately.
- Build, full suite (84 files / 1,315 tests), API typecheck, inventory, and diff check passed. The inventory mutation test asserts exit codes and uses an OS-temporary fixture.
- Selector candidates are deliberately named candidates: dynamic classes, bare-element selectors, and descendant matches require code/browser review before deletion. Stable rule identities preserve ownership decisions when unrelated rules are removed.
- Library and sequence editing have no client admin gate; sequence publishing does. The route ledger records those current distinctions. No product JSX, API, database, or external system was changed.

### Phase 0 closure (2026-09-23)

Defects found and fixed while closing the gate:

- Bundle budget guard matched chunks by content-hashed filename, so no production JS chunk ever found its baseline row and the 5% / 10%-or-10KB budgets never fired. Chunks now match by scope, type, hash-free name, and entry flag. The two same-named `index.js` baseline rows were disambiguated by marking the 232,558-byte row `"entry": true` (sizes unchanged; no baseline regeneration). A synthetic +20KB on every baseline chunk now fails all 63 production JS chunks; two unit tests pin hash-independent matching and entry/route separation.
- `tests/uiInventory.test.ts` imports the script, which broke `npm run typecheck:api` (TS7016); `scripts/ui-inventory.d.mts` declares the one export.
- Fixture harness: the scenario control echoed the old scenario, the empty scenario kept non-zero totals, and Vercel's rewrite served HTML for Vite modules (white screen). All three fixed in the untracked harness before commit. The suspected `\\n` template-string defect is not present: generated modules and the scenario file contain real newlines, and `--check` asserts the scenario file bytes and runs `node --check` on every generated module.

Gate commands (from `frontend/`, build first): `npm run build` passed; `npm run test` 84 files / 1,317 tests passed; `npm run typecheck:api` passed; `npm run ui:inventory` passed (356 raw controls, 1 allowlisted, 1,524 compatibility-token uses, 452 compatibility selectors, 9 modal roots; production JS 650,870 / CSS 40,799 gzip; Gallery JS 22,973 excluded); `node scripts/ui-fixture-dev.mjs --check` passed; root `git diff --check` passed.

Browser evidence — **local synthetic fixture evidence only** (`node scripts/ui-fixture-dev.mjs`, `vercel dev --local`, synthetic identity, no credentials, GET-only traffic observed; no product writes). Routed pages through the real `AuthContext` / `AuthGate` / `DataContext` / `Layout`, measured in the in-app browser at exact emulated viewports:

| Role / scenario | Route / state | Viewport | Result |
| --- | --- | --- | --- |
| admin, populated | Overview default | 1280×720 | sidebar 232px, gutter 24px, no page overflow-x, no alerts |
| admin, populated | Leads default | 1280×720 | gutter 24px, first result top y=332 (≤340), no overflow-x |
| admin, populated | Overview default | 1440×900 | gutter 32px, no overflow-x |
| admin, populated | Leads default | 1440×900 | gutter 32px, first result y=332, no overflow-x |
| admin, populated | Overview default | 1920×1080 | `.page` padding 32px inside its current 1600px max-width (content left at 276px), no overflow-x |
| admin, populated | Leads default | 1920×1080 | same 1600px cap as Overview; first result y=332, no overflow-x |
| admin, populated | Leads `?q=no-match` | 1280×720 | "No leads match these filters", Clear all, 0 of 1 |
| member, populated | Team | 1280×720 | "Fixture Member / Member"; no member-management buttons |
| member, populated | CSV Import | 1280×720 | "Admin access required" fallback |
| admin, empty | Overview / Leads | 1280×720 | zero totals with "—" rates; Leads empty state, 0 of 0 |
| read-error | Overview | 1280×720 | dashboard banner plus three independent section errors (system totals, performance, account analytics), each with Retry |
| auth error | shell | 1280×720 | "Sign-in is unavailable" card with the error and Try again |

Observations for later phases (current behavior, not changed in Phase 0): Leads, a list route, inherits the analytics 1600px `.page` cap at 1920 (Phase 6); `coaching.digests` is not implemented by the fixture and returns 501, so the Leads coaching digest is not a populated-state proof. Keyboard checks were not run in Phase 0. No interaction or mutation states were exercised.

## Phase 1 — accepted (2026-09-23)

Shared contracts completed; no route adopted a new visual yet (adoption belongs to each route's phase).

- `Dialog` (`src/ui/Overlay.tsx`): `placement="center" | "end"` (end = 560px, full height, `.ui-dialog--end`, replacing `.ui-drawer`); Close is Base UI `Dialog.Close` rendered as `IconButton`; `finalFocusRef` alongside `initialFocusRef`; `busy` refuses Escape, backdrop and Close, disables Close, sets `aria-busy`, and shows a visible `role="status"` `busyMessage` that describes the Close button. `OverlayProps` became `DialogProps`.
- `FilterDialog`: end-placed `Dialog` composition. Route owns the draft; footer counts draft filters; Clear all / Cancel / Apply from `COPY`. Zero route consumers until Phases 6–7 (Leads, Replies, Sentiment) adopt it.
- `EmptyState` moved from `src/components/EmptyState.tsx` into `src/ui/States.tsx` and is exported through `src/ui`; gains `kind="empty" | "no-match"` (`data-empty-kind`). Its `muted small` compatibility tokens became utilities. 17 import sites updated; no rendering change.
- `SaveStatus`: presentational `saved | dirty | saving | conflict | error`, dot plus word, `role="status"`, complete class strings. Not yet adopted (SequenceBuilder's `SaveIndicator` moves in Phase 11).
- Deleted `Drawer` and `RefreshingRegion` after a fresh zero-consumer scan; `docs/ui-standard.md` and the route ledger corrected.
- `ActiveFilters`: its two raw buttons became `IconButton` and `Button`; the remove control keeps its 24px chip geometry, and its hover rule gained `:not(:disabled)` so the IconButton hover no longer overrides it.
- Gallery pins: EmptyState empty/no-match, all five SaveStatus states, busy Dialog, and FilterDialog with a real draft/apply/cancel cycle.

Tests: `uiPrimitives` +9 cases (end placement, busy refusal and description, initial focus, FilterDialog count / Cancel / Escape / Clear all / Apply, EmptyState kinds, SaveStatus wording, ActiveFilters names). Mutation check: removing the busy guard from `handleOpenChange` fails the busy test.

Gate (from `frontend/`, build first): build passed; `npm run test` 84 files / 1,326 tests passed; `typecheck:api` passed; `ui:inventory` passed after `ui:inventory:update` (compatibility tokens 1,524 → 1,522; raw controls, selectors, modal roots unchanged; bundle baseline preserved); fixture `--check` passed; root `git diff --check` passed. Production gzip JS 651,540 (+670 vs Phase 0, +0.1%), CSS 40,910 (+45; the final-phase CSS budget is what binds); Gallery JS 23,589 excluded.

Browser evidence — **local synthetic fixture, headless Chrome (global puppeteer) at exact 1280×720, 1440×900, 1920×1080**, no writes:

| Surface | Result at all three viewports |
| --- | --- |
| Leads → Filters (real route, still centered) | opens with focus on Close inside the dialog; 40× Shift+Tab stays inside; body scroll locked; Escape closes and returns focus to the Filters trigger |
| Gallery FilterDialog | end-docked 560px full height (e.g. x=720 at 1280); `#root` aria-hidden; draft shows "1 filter selected"; Cancel leaves trigger count unchanged; Apply sets it to 1 |
| Gallery busy Dialog | Close disabled, busy note visible; Escape and backdrop click refused (dialog stays, scroll stays locked); closing via its own action returns focus to the trigger |

Known limit: a backdrop click on a busy dialog moves focus to `<body>`; the next Tab returns it to the dialog (trap intact). Keyboard checks beyond the dialog trap were not run.

Next: Phase 2 — shell, auth, reset, access, shared feedback (`App` admin fallback, `AuthContext`, `ResetPassword`, `Layout`, Quick Navigation, ErrorBoundary, Skeleton, toasts).

## Phase 2 — accepted (2026-09-23)

Shell, auth, reset, access, and shared feedback converted.

- **Auth**: new `src/components/AuthCard.tsx` (`AuthCard`, `AuthForm`, `AuthState`, `AuthMessage`) is the single pre-session surface for sign-in, recovery, invitation password, unavailable, unauthorized, and `ResetPassword`. Fields are `TextField`, the one submit is a block primary `Button` with `loading`, secondary links are ghost `Button`s, and form errors render directly above the fields. The recovery success message now has its intended framed style (it previously rendered with only a border colour). Behaviour, copy, handlers and minimum lengths unchanged. `.auth-*` rules deleted from `ui.css` except `.auth-error`, which Team still uses (owner Team.tsx, Phase 3).
- **Layout**: mobile toggle, Hide navigation and Close navigation are `IconButton`s. Hide navigation grows from 32×32 to the standard 44×44 target (measured at 173,14 44×44 vs 185,20 32×32). The group disclosure and the Quick Navigation search-style trigger stay native buttons under named allowlist entries (`nav-section-disclosure`, `quick-nav-search-trigger`). The shell block (brand mark, nav groups, navlinks, sync chip, ≤900px drawer, quick-nav kbd and results) moved verbatim from `ui.css` to the top of `layout.css`, which keeps its cascade position; dead `.nav-toggle`, `.side-user .icon-btn` and custom side-button chrome removed.
- **Feedback**: `ErrorBoundary` actions are `Button`s and its frame and hint use utilities; `PageSkeleton` cards use the same frame utilities as `.card` (identical values); the `App` admin fallback is a `Panel`. `AuthContext` and `AdminOnly` are exported for rendering tests.
- **Tests**: new `tests/shellAccess.test.tsx` (10): sign-in with one primary submit and error-above-fields, recovery round trip, password mismatch refusal, unavailable retry, unauthorized sign-out, initializing/ready, admin gate member/admin, sidebar hide/show focus, group disclosure, member nav hides CSV Import, route error boundary recovery. `resetPasswordScreen` label queries take the required-field asterisk into account (`/^New password/`). Mutation check: removing the focus move in `onHide` fails the sidebar test.

Gate (from `frontend/`, build first): build passed; `npm run test` 85 files / 1,336 tests passed; `typecheck:api` passed; `ui:inventory` passed after update (raw controls 356 → 332 plus 2 new named exceptions; compatibility tokens 1,522 → 1,438 and selectors 452 → 404, mostly shell rules now owned by `layout.css`); fixture `--check` passed; `git diff --check` passed. `css-parity.mjs` against the pre-phase `ui.css` and `layout.css`: no declaration missing that HEAD's build had. Production gzip JS 651,705 (+0.1% vs Phase 0), CSS 40,642 (−223 vs Phase 0).

Browser evidence — **local synthetic fixture, headless Chrome, side by side against a HEAD (`779c4da`) fixture on another port**, at exact 1280×720, 1440×900, 1920×1080:

| Surface | Result |
| --- | --- |
| Shell geometry | sidebar 232px, brand, Go to…, first navlink, group triggers, footer, sign-out, sync chip and page h1 identical to HEAD at all three sizes; only Hide navigation changed (44×44). No page overflow-x. |
| Sidebar hide/show | hide moves focus to Show navigation and sets `aria-hidden`; Enter restores the rail and focuses Go to…; same as HEAD |
| Quick Navigation | Enter on Go to… opens the dialog with focus inside; Escape closes and returns focus to the trigger; same as HEAD |
| Auth (identity failure) | centred 440px card, 28px heading, alert above Try again; 14px shorter than HEAD from the intro spacing |
| Member on CSV Import | "Admin access required" panel at all three sizes; member nav omits CSV Import |
| ≤900px (preserved, not accepted) | at 800px the toggle opens the drawer with focus on Close navigation, and Escape closes it and refocuses the toggle; identical to HEAD |

Not exercised in a browser: the sign-in form itself (the fixture has no signed-out identity state; covered by `shellAccess`), password reset screen (covered by `resetPasswordScreen`), and the screen-level ErrorBoundary.

Next: Phase 3 — Team first (reference directory/table/row-action/dialog), then Health and Neon Activity.

## Phase 3 — accepted (2026-09-23)

Team (reference, by the orchestrator), then Health and Neon Activity (Sonnet worker, reviewed and corrected by the orchestrator).

- **Team** — the directory/table/row-action/dialog reference. The summary is a `Panel` holding a `<dl>`. It shows "—" instead of "0" while the identity roster loads, the confidently-wrong zero the page header warns about. The inline invite card became `InviteDialog`: `Dialog`, `TextField`/`SelectField`, busy while submitting, `useDirtyGuard` on Escape/backdrop/Cancel. The roster is `TableFrame`/`Table` ("Team members"). Role and status use `Badge`/`StatusText`, and "You" is a `Badge`. Row edit stays inline, with labelled `SelectField`/`Checkbox`/`TextField` and `Button`s; Edit is named per row ("Edit Max Member"). Load failure is `InlineError`, empty is `EmptyState`, loading is `UpdatingNote`. Handlers, admin gates, id spaces and the retired Supabase writer (`teamAdminWritesAllowed` always false) are unchanged. `team.css` deleted; `.auth-error`, `.role-badge.admin`, `.status-dot-label.*` and `.team-actions .btn + .btn` removed from `ui.css`.
- **Health**:
  - The Monday-briefing `<details>` flyout became a header `Button` that opens a `Dialog`. It is admin-gated, busy while posting, and has a footer Done/Regenerate and post; the endpoint and states are unchanged.
  - Publishing compatibility and recent sync runs are `Panel`/`SectionHeader`/`TableFrame`/`Table`. Status and canary use `Badge` tones, and the failed-compatibility read is `InlineError` with `EmptyState` for no probes. The error cell is a ghost `Button` disclosure.
  - `InstancePanel` uses `Panel`/`StatusText`.
  - `InstanceConfigEditor` uses `TextField`/`SelectField`/`TextareaField`/`Button`. Its `window.confirm` became `useDirtyGuard`; the `beforeunload` guard is kept. It is single-column after browser review: the two-column layout clipped selects to "Defau" in the 300px rail.
  - The uptime strip stays contextual CSS in `instance-panel.css` under `ui-exception(health-uptime-strip)`.
- **Neon Activity** — dropped a redundant nested `.page` wrapper (it rendered inside Layout's `.page`, doubling padding) and its last `muted` classes.
- **Shared Dialog** — the default initial focus is now the first control in the body, falling back to Close. Team's invite opens on Name and Leads' Filters on Campaign; before, both opened on Close. There is a new `uiPrimitives` case for this.
- Dead shared selectors deleted after grep: `.badge.status-ok`, `.text-danger`, `.dot.warn`, `.table-scroll.tall`.

Tests: new `teamPage` (9), `healthPage` (7), `neonActivityPage`. Mutation checks: showing Add teammate to a member fails `teamPage`; removing Health's briefing admin gate fails `healthPage`.

Gate (from `frontend/`, build first): build passed; `npm run test` 88 files / 1,357 tests passed; `typecheck:api` passed; `ui:inventory` passed after update (raw controls 332 → 297, compatibility tokens 1,438 → 1,332, selectors 404 → 391; Phase 3 files now have zero raw controls, zero compatibility tokens, zero modal roots); fixture `--check` passed; `git diff --check` passed. Production gzip JS 652,863 (+0.3% vs Phase 0), CSS 40,059 (−806 vs Phase 0).

Browser evidence — **local synthetic fixture, headless Chrome, exact 1280×720 / 1440×900 / 1920×1080**, no writes:

| Surface | Result at all three viewports |
| --- | --- |
| Team admin | Add teammate + per-row Edit; 5 columns; gutters 24/32/32; no overflow-x; smallest text 13px |
| Team member | no Add teammate, no Edit, no Actions column |
| Team invite dialog | opens centered with focus on Name; typed draft + Escape → "Discard unsaved changes?"; Keep editing keeps the draft; Discard closes and returns focus to Add teammate |
| Team row edit | Role select, Active checkbox, Save, Cancel in a 72px row |
| Health admin / member / empty | admin: Publishing compatibility (fixture read refused → InlineError), Recent sync runs (EmptyState), Accounts; member: no compatibility panel, "Admin only" config; empty: "No accounts registered" |
| Health briefing dialog | Close / Done / Regenerate and post; Escape returns focus to Monday briefing |
| Health config editor | dirty Close → "Discard unsaved changes?"; single-column fields 224px wide in the rail |
| Neon Activity | h1 + section; fixture has no activity op, so its failure state (InlineError with Retry) is what renders |

Known and left: the account avatar's initials render at 12.92px (Avatar scales them from its 34px size, unchanged from HEAD) — Avatar belongs to Phase 12. Neon Activity's populated/empty rendering is covered by `neonActivityPage` only; the fixture does not implement its read.

Next: Phase 4 — SearchLibrary first (list + dirty-form reference), then Playbook, ICP, Hypotheses (four hand-built dialogs).

## Phase 4 — accepted (2026-09-23)

SearchLibrary (reference) and Playbook by the orchestrator; ICP and Hypotheses by two parallel Sonnet workers with disjoint files, then reviewed, browser-checked and corrected by the orchestrator.

- **Shared library composition** — new `src/components/library.tsx`: `LibraryGroup` (heading + count + card grid), `LibraryCard` (title, row actions, footer; in `onOpen` mode the title is a real button stretched over the card, so a click anywhere opens the viewer while row actions stay separate buttons — this replaces ICP's `role="button"` cards that nested other buttons), `Chip`/`KeywordChips` (exclude carries a visible "−"). `ChipInput` labels itself through `Field` (`label`/`labelHidden`) and uses `Chip`; `CopyButton` is an `IconButton`.
- **SearchLibrary** — `LibraryGroup`/`LibraryCard`. The platform chips become a `SegmentedControl` (single choice, arrow keys); their active state had no styling before. `EmptyState` gets `empty`/`no-match`. The editor fields are `TextField`/`TextareaField`/`ChipInput`; filter rows are a `fieldset` with labelled key/value fields, and save errors show as `InlineError` above the fields. Icon-button names, copy, archive, the delete confirm, payloads and 409/401 branches are unchanged.
- **Playbook** — a sticky mode/save row inside the panel (`SegmentedControl`, `SaveStatus` with "Last saved …/Unsaved changes", Save). The load failure is `InlineError` with Retry, and the editor is a labelled `TextareaField`. The split stays contextual CSS under `ui-exception(playbook-split)`. `chat-md` prose styling stays until Chat (Phase 10).
- **ICP** — both hand-built modals (viewer, editor) are `Dialog`; the editor has `useDirtyGuard` and `busy`. Cards are `LibraryCard` with open mode. Fields are canonical, and personas/industries are fieldsets with labelled rows. Copy uses `CopyButton`. The "+N more" toggle is a ghost `Button`.
- **Hypotheses** — both modals are `Dialog`, the editor with `useDirtyGuard`. The comparison and viewer tables are `TableFrame`/`Table`; sort headers are `Button`s with `aria-sort` on the `th`; the row opens through a real stretched button. Row actions are `IconButton`s named per row ("Edit {name}"): the worker's text buttons pushed Delete past the table frame at 1280, and the orchestrator reverted them to icons.
- **Shared Dialog** — while a dialog is the topmost one, focus that a closing dialog restores into the page behind it (`#root`) is pulled back inside. This fixes ICP viewer → Edit, where the editor opened with focus on the card behind it. Base UI's unmount-time restore does not consult `finalFocus`, so that hook could not be used. A new `uiPrimitives` case covers it, and removing the listener fails the case.
- **CSS** — deleted 36 dead rules from `ui.css` (`.search-*`, `.chip*`, `.filter-chip.active`, `.search-modal`, `.search-form*`, `.kv-editor`, `.col-toggle`, `.icp-view-*`, `.icp-copy-btn`), each grepped for zero consumers first.
- **Allowlist** — `library-card-open`, `chip-input-entry`, `hypothesis-row-open`.
- **Fixture** — synthetic saved searches, ICP/persona/industry, hypotheses, playbook document, empty coaching digests.

Tests: new `searchLibraryPage` (9), `icpPage` (9), `hypothesesPage` (9), `uiPrimitives` +1. Mutation checks: removing ICP's editor `guard()` fails `icpPage`; forcing Hypotheses' `useDirtyGuard(false)` fails `hypothesesPage`; removing the Dialog focus pull-back fails `uiPrimitives`.

Gate (from `frontend/`, build first): build passed; `npm run test` 91 files / 1,385 tests passed; `typecheck:api` passed; `ui:inventory` passed after update (raw controls 297 → 222 plus 3 named exceptions; compatibility tokens 1,332 → 1,008; selectors 391 → 354; **modal roots 9 → 5**; Phase 4 files have zero raw controls and zero modal roots, and one intentional `chat-md`); fixture `--check` passed; `git diff --check` passed. Production gzip JS 653,843 (+0.5% vs Phase 0), CSS 39,711 (−1,154 vs Phase 0).

Browser evidence — **local synthetic fixture, headless Chrome, exact 1280×720 / 1440×900 / 1920×1080**, no writes (the fixture refuses mutations):

| Surface | Result at all three viewports |
| --- | --- |
| Searches list | two platform groups, card widths 323/371/372, gutters 24/32/32; SegmentedControl ArrowRight selects Apollo and filters to 1 card; no text under 13px; no overflow-x |
| Search editor | 880px dialog, focus on Name, body scrolls, footer in view; edited + Escape → discard prompt; Discard returns focus to "Edit this search"; archive shows the fixture's refusal toast "Admin access required." |
| Playbook | sticky bar with Edit/Preview, SaveStatus "Last saved Sep 20", typing shows "· Unsaved changes"; member: textarea and Save disabled |
| ICP | card opens by click anywhere and by Enter on its title; viewer 1120px with footer in view; Escape returns focus to the card; viewer → Edit focuses Name inside the editor; dirty Escape → prompt; Discard returns focus to the card |
| Hypotheses | comparison table with `aria-sort` on Leads; row click opens the viewer; Edit/Archive/Delete all inside the frame (1280: last action right edge 1214 vs frame 1230) |

Known and left (flagged as a separate task, not a presentation defect): selecting a hypothesis writes `?h=`, and `DataContext` restarts the route snapshot on any query change outside Replies/Sentiment. The page flashes to the skeleton and remounts, so closing the viewer returns focus to `<body>`. Fixing it touches DataContext state, which this programme excludes.

Next: Phase 5 — CSV import workflow (UnifiedApolloCsvImport, CompanyResolutionModal, ImportHistoryPanel, import callouts), fixture-only mutation checks.

## Phase 5 — accepted (2026-09-23)

CSV import workflow. The orchestrator did `UnifiedApolloCsvImport` and `CompanyResolutionModal`; a Sonnet worker did `ImportHistoryPanel` and `ImportCalloutCard`, reviewed and corrected by the orchestrator.

- **Importer** — every stage is a `Panel` + `SectionHeader` (`Stage`), and each primary action sits in a sticky `StageActions` bar. Status words are `Badge`s through one `STATUS_TONE` map. The step list uses complete-string state classes and `aria-current="step"`; its active/done styling had already been lost, because the `.csv-import-steps` class was removed in an earlier pass while its CSS stayed. "Added by" is a required `SelectField`. Metadata loading uses `UpdatingNote`; metadata failure and write failure use `InlineError` (Retry / Dismiss). The contacts table is `TableFrame`/`Table` ("Contacts to import", local scroll 560px). Busy buttons use `Button loading`. The state machine, handlers, payloads, retries and file semantics are unchanged; the native file input stays hidden behind Choose CSV under the existing `native-file-input-csv` exception. The file-map and company-action grids and the dashed drop zone stay route CSS under `ui-exception(csv-import-grids)`.
- **CompanyResolutionModal** — the last hand-built modal in this family is now the shared `Dialog`; its private document Escape listener is removed and Dialog owns Escape. It has a labelled search `TextField` that gets initial focus, `UpdatingNote` while searching, `InlineError` on failure, and option rows as `Button`s. The Cancel/Skip labels and plural wording are unchanged.
- **ImportHistoryPanel** — canonical `Button`/`IconButton`/`Checkbox`/`RadioGroup`/`TextField`/`TextareaField`/`Badge`/`InlineError`; the three-step rail uses complete-string state maps. Parse, dedup and save behaviour and the dirty "Back" confirm are unchanged.
- **ImportCalloutCard deleted** — it has had no consumer since `e24b1d3` ("Simplify home…"), so it was removed with its new test rather than kept converted. Its helper `blindSpotLeads` in `lib/leads.ts` is now also unused; it is domain logic, so it is left for Phase 12's dead-code pass.
- **CSS** — all `.csv-*` rules removed from `ui.css` (none had a consumer); the `.import-*` callout, step and dir rules removed; `import-history.css` and its import deleted. The duplicate `!important` `.sr-only` in `ui.css` was removed: `reset.css` owns it, Tailwind generates it, and the duplicate made every `sr-only` count as a compatibility token. In doing that, the adjacent `.btn.danger` rule that was glued onto the same line was restored.
- **Fixture** — `/api/import` answers metadata, previews and company search with synthetic data and refuses `company_commit`/`contact_commit` with 403. The bridge now falls back to `req.body`, because Vercel's Node runtime pre-consumes POST streams, so every fixture POST body used to arrive empty. `--check` asserts both commit refusals. The stale `/tmp/linkedin-ui-fixture-*` roots (a stopped server skips its cleanup) were deleted.

Tests: new `csvImportStates` (5: metadata failure + retry, step `aria-current` and upload gating, picker Dialog name/Escape/skip, contact skip/restore, company-write failure keeps the stage and dismisses) and `importHistoryPanel` (9); the existing `unifiedApolloCsvImport` (3 flows) is unchanged and green. Mutation checks: making the picker's `onRequestClose` a no-op fails `csvImportStates`; the worker disabled the Back guard and `importHistoryPanel` failed.

Gate (from `frontend/`, build first): build passed; `npm run test` 93 files / 1,399 tests passed; `typecheck:api` passed; `ui:inventory` passed after update (raw controls 222 → 187; compatibility tokens 1,008 → 838; selectors 354 → 321; **modal roots 5 → 4**; Phase 5 files have zero raw controls, compatibility tokens and modal roots); fixture `--check` passed; `git diff --check` passed. Production gzip JS 653,507 (+0.4% vs Phase 0), CSS 38,438 (−2,427 vs Phase 0).

Browser evidence — **local synthetic fixture, headless Chrome, exact 1280×720 / 1440×900 / 1920×1080**; the fixture refuses both commits, so no write path exists:

| Surface | Result at all three viewports |
| --- | --- |
| Stage 1 → 2 → 3 | step `aria-current` moves Set up → Review file → Companies; gutters 24/32/32; no text under 13px; no overflow-x |
| Stage 3 sticky actions | Process Companies bar in view (bottom 706 of 720 at 1280) |
| Company picker | 640px Dialog "Choose the Airtable company", focus on the search field; choosing a result closes it, records "Use Fixture Labs · fill blank fields", returns focus to "Choose existing", unresolved count → 0 |
| Process Companies (refused) | InlineError "Local fixture is read-only…" with Dismiss; stays on stage 3 |

**Open, not caused by this phase — Phase 7 entry blocker:** opening the conversation drawer from a Leads row in the fixture intermittently freezes the page (DevTools `Runtime.callFunctionOn` times out; one debugger pause landed in React's `dispatchContinuousEvent`). It reproduces at `38d139b`, before any redesign change, at `17fe04d` and at `9971aee`, so it predates this programme. Because of it, `ImportHistoryPanel` (rendered only inside the drawer) has unit coverage but no browser pass yet. Phase 7 owns `ConversationDrawer` and must diagnose this before accepting the drawer.

Next: Phase 6 — Leads (wide-list reference), Follow-ups, Review: tables, filters (adopt `FilterDialog`), empty/error states, follow-up panels; first result y≤340 at 1280, Follow-ups primary action reachable at 1280, local wide scroll.

## Phase 6 — accepted (2026-09-23)

Search/list operations: Leads, Follow-ups, Review. The orchestrator did the shared `SortHeader` and Leads (the wide-list reference); two Sonnet workers did Follow-ups (with `FollowUpPanel`) and Review (with its three private tables), reviewed and corrected by the orchestrator.

- **Shared contracts**
  - New `SortHeader` in `src/ui/Table.tsx`: a `<th>` carrying `aria-sort`, whose label is a real button with a ↕/↑/↓ mark. The route still owns the key, the direction and the click. It is pinned in `uiPrimitives` and shown in the Gallery's list composition. `CampaignTable`, `CampaignCompareTable`, Overview's `ov-sortable` and Hypotheses' `sortHead` still use their own headers; they move in Phases 9 and 12.
  - `TableFrame` gains `scrollRef` and `busy` (`aria-busy` on the scroll region).
- **Leads**
  - Filters now use `FilterDialog`: end-placed, 560px, one column. The draft/Apply/Cancel handlers are unchanged. Clear all edits only the draft.
  - The table is `Table` with `SortHeader` on the six sortable columns.
  - Rows are no longer `<tr role="button" tabIndex=0>` wrapped around a link, a select and a second link. A row keeps its pointer click. Keyboard and screen-reader users reach it through a real button laid over the row with `pointer-events: none` (`ui-exception(leads-row-open)`, allowlisted). Its focus ring outlines the row, while the links, the stage select and every tooltip underneath keep working.
  - The per-row pipeline select is the canonical `Select`, now named "Pipeline stage for <name>". It had no accessible name before. It keeps its quiet unset look through utilities.
  - The follow-up due date is a `Badge`, using the same tones as the Follow-ups queue. Gender uses `StatusText`.
  - The coaching digest toggle is a `Button` with `aria-expanded`/`aria-controls`. Its error slot is an `InlineError` (test handle `data-digest="error"`, replacing `.banner`). Pattern counts are `Badge`s.
  - Two small fixes. Paging now scrolls the table back to the top; it used to call `scrollTo` on a non-scrolling wrapper. On the server path, a refetch shows `UpdatingNote` instead of flashing "No leads match".
  - Empty and no-match are distinguished ("No leads yet" / "No leads match these filters").
  - `leads-explorer.css` is deleted; the table-height rule is now an arbitrary-variant utility on the frame.
- **Follow-ups**
  - The row is a presentational `FollowUpRow` component. The route formats every value and owns the handlers; the Gallery renders the same component, so the reference can't drift from the page.
  - Due badge tone per bucket; Them/Us as `StatusText`; LinkedIn and Review in Replies as `ExternalLinkButton`/`LinkButton` (ghost, sm); "Open follow-up" is the one primary action at 44px.
  - The four zones wrap instead of clipping.
  - Empty states say `empty` or `no-match`.
- **FollowUpPanel** (inside the drawer)
  - All 13 raw buttons, 2 date inputs, the select and the textarea are canonical fields and buttons.
  - The mutation error is an `InlineError` above the actions and keeps the draft. The history read error is an `InlineError` with Retry.
  - Submit uses `Button loading`.
  - The Skip reason is labelled "Reason", marked required. Every mode, handler, disabled expression and `min` date is unchanged.
- **FollowUpCalloutCard deleted** — zero importers.
- **Review**
  - The cohort, template and leads-added sections are each `Panel` + `SectionHeader` + `TableFrame`/`Table`.
  - The metric toggle is a `SegmentedControl`; the template picker is a `SelectField`; chip removal is an `IconButton`; the WoW delta is a `Badge`.
  - The worker had added a click-to-sort to "Leads added"; the orchestrator reverted it to the original fixed order, and the test now pins that it is not sortable.
  - A doubled gap between adjacent panels (`.ui-panel + .ui-panel` margin plus the flex gap) was fixed on the route.
  - Left for Phase 9, byte-identical: the P3 KPI tiles (`kpi-*`, shared with Overview), `SentimentTrendChart`, and `MessageSequence`'s legacy card.
- **CSS**
  - `follow-up-panel.css` and its import deleted.
  - Removed from `ui.css`, all with zero consumers: every `.follow-panel/-current/-actions-grid/-form/-history/-timeline/-event`, `.follow-group/-list/-item*/-direction`, `.cohort-rate`, `.conv-follow-btn`, and `td .pipe-stage-select.quiet`. Their orphaned comments went with them.
  - `.follow-due`/`.pipe-follow-due`, `.pipe-stage-select`, `.identity-chip`, `.row-clickable`, `.sortable`/`.sort-ind` stay for Pipeline, the campaign workspace and the analytics tables.
- **Fixture** — the populated scenarios now carry one overdue follow-up and its latest message, with `followUpsAvailable: true`, so Follow-ups and the Leads follow-up column render populated. `--check` still passes.

Tests: new `leadsExplorerPage` (6), `followUpsPage` (8), `followUpPanel` (7), `reviewPage` (6), plus one `SortHeader` case in `uiPrimitives`. `leadsExplorerDigest` now uses the `data-digest="error"` handle; `panelReadBranches` is unchanged and green. Mutation checks:
- Committing sheet filters on change, and dropping the page reset on Apply, fail two `leadsExplorerPage` tests.
- Removing the Skip-reason disabled condition fails `followUpPanel`.
- Forcing the default owner to `all` fails `followUpsPage`.
- Removing the Send to Slack disabled condition fails `reviewPage`.

Gate (from `frontend/`, build first): build passed; `npm run test` 97 files / 1,429 tests passed; `typecheck:api` passed after typing one test mock; `ui:inventory` passed after update. Inventory movement:

| Count | Before | After |
| --- | --- | --- |
| Raw controls | 187 | 159 |
| Allowlisted | 6 | 7 |
| Compatibility tokens | 838 | 637 |
| Selectors | 321 | 286 |

Modal roots stay at 4. The Phase 6 files have zero raw controls and zero compatibility tokens, except the allowlisted row button and the Phase-9-owned KPI tile tokens in `Review.tsx`. Fixture `--check` passed; `git diff --check` passed. Production gzip JS 655,486 (+0.7% vs Phase 0), CSS 37,803 (−3,062 vs Phase 0). TSX +538/−517 and CSS +20/−196 lines.

Browser evidence — **local synthetic fixture, headless Chrome, exact 1280×720 / 1440×900 / 1920×1080**:

| Surface | Result |
| --- | --- |
| Leads default | first result top **y=336** at all three (≤340); no page overflow-x; the table scrolls locally at 1280 |
| Leads keyboard | row button covers the row; focus ring solid; Enter opens the conversation drawer |
| Leads filter sheet | 560px end sheet (720–1280), focus on Campaign, Apply visible at 704/720; Escape returns focus to Filters |
| Follow-ups | "Open follow-up" right edge 1243 inside a 1255 row at 1280 (1395/1407, 1831/1843); 44px tall; unchanged with injected long name/campaign/message; no overflow-x |
| FollowUpPanel in the drawer | every control inside the 560px drawer; no horizontal scroll; Skip → "Skip with reason" disabled until a reason, textarea labelled "Reason" and `required` |
| Review / Leads Added | no overflow-x; no text under 13px; header actions fit; five sections evenly spaced after the gap fix |
| Gallery | Compositions shows two `FollowUpRow`s and the list table's `SortHeader`s |

**Open, Phase 7:** the conversation drawer never returns focus to its trigger on close; it has no focus-return code, before or after this phase. Moving it onto the shared Dialog in Phase 7 fixes that. The intermittent drawer freeze recorded in Phase 5 did not reproduce in any of this phase's runs, but it is still Phase 7's entry check.

Next: Phase 7 — Replies and the conversation modal (Replies, ConversationDrawer and its child panels, LostReasonModal on the shared Dialog).

## Phase 7 — accepted (2026-09-23)

Replies and the conversation modal. The orchestrator did `ConversationDrawer`, `ConversationContext`, `LostReasonModal`, `LeadNotesPanel` and the new `ConversationSection`. A Sonnet worker did Replies and the three `conversation/*` panels; the orchestrator reviewed and corrected its output.

- **Entry blocker: the drawer freeze.**
  - Not reproducible. The Phase 5 script that hit it was re-run verbatim: `headless: true`, `127.0.0.1`, element-handle click on the second cell.
  - It was run on both this tree and a worktree of `a2dfc75`, with three other loops alongside it (programmatic clicks, real mouse input with moves, wheel and backdrop close, and open/idle-ping/close). No run hung in 60+ open/close cycles, before or after the conversion.
  - The first sightings happened while parallel workers were running full test suites, so the likeliest cause is a starved machine rather than the page. That is unproven.
  - Opening the drawer never touches the URL, so the uncommitted DataContext fix was not a factor. This phase's own browser pass ends with 26 more open/close cycles with no hang.
- **ConversationDrawer on the shared Dialog.** The hand-built `aria-modal` aside is gone, along with its document Escape listener, its Tab trap, its `body.style.overflow` lock and its 160ms close-animation timer. It is now `Dialog placement="end"` (560px). A new `bodyClassName` prop lets the drawer lay out its own scroll regions, and the popup keeps the slide-in.
  - **Header:** the title is avatar plus name (avatar `aria-hidden`; the accessible name is "Alex Fixture"), and the description is headline · company. The body starts with a meta row: campaign link, account, sentiment and intent chips. Below it an action row holds LinkedIn (`ExternalLinkButton`), Open in Replies (`LinkButton`), Import history (`Button`) and the follow-up toggle (`Button`, `aria-pressed`). Lead details stay a native `<details>`, with `SelectField`s for Stage, Substatus, Owner and Gender; the Reviewed/AI marks are `Badge`s.
  - **Thread:** a named, focusable "Messages" region, where focus starts. Bubbles are utilities; the `.msg`/`.sk-bubble` variants are gone. Edit, save, cancel and delete are `IconButton`s (32px, loading states built in). The edit box is the canonical `Textarea`; its Escape now stops propagation, so it cancels the edit rather than closing the conversation. Delete keeps its native confirmation. A failed thread read is an `InlineError` with Retry instead of a `.banner`.
  - **Focus:** closing returns focus to the exact trigger — verified for the Leads row button and "Open follow-up". The provider now keys the drawer per open, so it starts in the requested view on its first frame. Before, the thread rendered for one frame, took focus, and then vanished.
  - **Import and follow-up views:** these render inside a focusable region, "Import history" or "Follow-up". It is the initial focus in those modes, and it is where focus lands if a view switch removes the focused control. Closing a view returns focus to Messages. Finishing an edit returns focus to that message's Edit button. `.ui-dialog:focus-visible` has no ring, because the popup only takes focus as a fallback.
  - **Reachability fix (pre-existing):** the manual review form is taller than the drawer at 720px and used to push the AI coach and Notes below the drawer's bottom edge. It is now capped at 45% and scrolls on its own; the thread keeps a 120px floor; an open section is capped at 40%. At 1280×720 both section toggles stay inside the drawer, with a section closed or open.
  - **LostReasonModal:** now a small shared `Dialog` rendered inside the drawer, with a required "Reason" field and Cmd/Ctrl+Enter still submitting. Escape closes only the nested dialog and returns focus to Stage. Its own document Escape listener is gone.
  - **AI coach and Notes:** each is a `ConversationSection` — a disclosure `Button` with `aria-expanded`/`aria-controls`, badges and actions beside it — in place of the `.conv-coaching*` markup. Notes uses a labelled `TextareaField`, `IconButton` delete and an `InlineError`.
  - **Sentiment chips:** sentiment, intent, next-action and severity chips keep the domain `badge senti` classes on purpose. Referral is purple, which no `Badge` tone has, and the same chips appear on every reply surface. Converting them is a Phase 12 design decision, not a refactor.
- **Replies (worker)**
  - The filter sheet is `FilterDialog`; the draft, Apply and Clear-all handlers are unchanged. Search is a labelled `TextField type="search"`. Load more is a `Button`.
  - The queue row and the thread's message bubble stay real `<button>`s with rich content (`ui-exception(replies-queue-item)`, `ui-exception(replies-message-bubble)`, both allowlisted). They mark selection with `aria-current` and `aria-pressed` instead of a `.selected` class.
  - The review panel uses `RadioGroup` for sentiment, `Checkbox` with a visible help line for reasons, `SelectField` for buying interest, `TextareaField` for the comment, and `Button`s.
  - The action panel uses `SelectField`, `TextField`, `Checkbox` and `Button`.
  - `replies-inbox.css` lost 67 dead lines; the pane grid and container queries are untouched.
  - The row-style `RadioGroup` wrapped with a 16px row gap on top of each 44px option. The orchestrator made `.ui-radio-group--row` gap column-only, which also tightens Import history's direction choice.
- **CSS**
  - `conversation-drawer.css` and its import are deleted.
  - Removed from `ui.css`, all with zero consumers: `.filter-field`/`.filter-label` (their last users were the drawer and LostReasonModal), `.conv-coaching*`, `.conv-error`, `.conv-account`, `.msg*`, `.sk-bubble*`, the `conv-fade-in`/`conv-fade-out`/`conv-slide-out` keyframes (`conv-slide-in` stays, used by the drawer), and `.conv-drawer` from the print rule. Three orphaned comments went with them.
  - `.conv-close`, `.pipe-modal*`, `.li-link` and `.link-btn` remain for the Sequence builder, AccountCard and the analytics routes.
- **Fixture** — `messages.thread` answers with an outbound, an inbound and an imported message. The `replies.capabilities`/`inbox`/`facets`/`thread`/`reviewHistory` reads answer too, with manual review on and one unreviewed conversation. So Replies, the review form and the drawer's thread all render populated. Saves still hit the refusing write paths; `--check` passes.

Tests: new `conversationDrawer` (5) and `repliesWorkspacePage` (5); the existing six `replies*` suites and `panelReadBranches` are green. Mutation checks: removing the edit box's `stopPropagation` fails `conversationDrawer`; making the Replies filter draft write straight to scope fails `repliesWorkspacePage`.

Gate (from `frontend/`, build first): build passed; `npm run test` 99 files / 1,439 tests passed; `typecheck:api` passed; `ui:inventory` passed after update. Inventory movement:

| Count | Before | After |
| --- | --- | --- |
| Raw controls | 159 | 112 |
| Allowlisted | 7 | 9 |
| Compatibility tokens | 637 | 519 |
| Selectors | 286 | 260 |
| Modal roots | 4 | 2 |

The two remaining modal roots are in `SequenceBuilder` (Phase 11). Fixture `--check` passed; `git diff --check` passed. Production gzip JS 654,399 (+0.5% vs Phase 0), CSS 36,881 (−3,984 vs Phase 0). TS/TSX +749/−700 and CSS +12/−163 lines.

Browser evidence — **local synthetic fixture, headless Chrome, exact 1280×720 / 1440×900 / 1920×1080**:

| Surface | Result |
| --- | --- |
| Replies panes | 1920: queue 320 + thread 854 + inspector 360, Save and Save-and-next at y=963 inside the pane. 1280/1440: queue 320 + thread; "Review reply and next step →" swaps in the inspector (895–1255 / 1047–1407) with both saves inside it (bottom 627/639, 783/795) and "← Back to conversations" offered. No overflow-x; the selected row carries `aria-current="true"` |
| Drawer from Leads (keyboard) | 560px end dialog named "Alex Fixture"; focus starts on Messages; 40 Tabs stay inside; thread scrolled to the newest message; Escape and the backdrop close it and return focus to "Open conversation with Alex Fixture" |
| Drawer lost-reason | Stage → Lost opens "Mark as lost — Alex Fixture" over the drawer with focus in Reason; Mark lost disabled until a reason; Escape closes only it and returns focus to Stage |
| Drawer edit / delete | Edit focuses "Edit imported message"; Escape cancels the edit, keeps the drawer, focus back on Edit; Delete raises the existing native confirmation, and dismissing it keeps the message |
| Drawer layout at 720 | review form 382–614; AI coach and Notes toggles at 623–712 inside the 720 drawer; with Notes open, the section is 600–720 and both toggles remain visible |
| Drawer from Follow-ups | opens in the follow-up view with focus on the "Follow-up" region; "← Conversation" moves focus to Messages; Escape returns focus to "Open follow-up"; 1440/1920 the same, no horizontal scroll |
| Responsiveness | 26 open/close cycles across Leads and Follow-ups (programmatic and real-mouse) with idle pings; no hang |

**Changed on purpose, for review:**
- The drawer no longer plays a slide-out on close; it unmounts, and focus returns at once.
- The review panel's sentiment choice is a radio list, not a two-column pill grid.
- Each reason shows its help text rather than a tooltip.
- The drawer's name link to LinkedIn became an explicit "LinkedIn" button in the action row.

**Open:** closing the drawer with a pasted-but-unsaved import or an edited review still discards the draft without asking. That is unchanged from before, but the dirty-close contract (spec §4) would add a Keep editing / Discard prompt there; it needs a decision on which drafts count. The Pipeline route opens the same drawer and is Phase 8.

Next: Phase 8 — Pipeline and the campaign-leads workspace (Pipeline, `LeadsAndRepliesWorkspace`, shared campaign lead rows, conversation entry points).

## Phase 8 — accepted (2026-09-23)

Pipeline and the campaign-leads workspace. A Sonnet worker did the Pipeline board, which the orchestrator reviewed and corrected. The orchestrator did `LeadsAndRepliesWorkspace`, `LeadReplyIdentity` and the new shared `RowOpenButton`.

**Correction to Phases 5 and 7: the "drawer freeze" was never the app.** In this phase the Pipeline page hung the same way, with `Runtime.callFunctionOn` / `Page.captureScreenshot` timeouts, and so did a HEAD worktree. The hang had these properties:
- the debugger could not pause it;
- plain evaluates still answered;
- `requestAnimationFrame` never fired, on `/leads` as well;
- even a blank `data:` page could not be screenshotted.

The cause is headless Chrome's `headless: 'new'` / `true` mode on macOS, which stops producing frames while the display sleeps; `headless: 'shell'` is unaffected. That explains why the freeze was intermittent, why it "reproduced" at every commit including `38d139b`, and why it vanished again in Phase 7. The Phase 5 entry blocker and the Phase 7 "machine starvation" guess are both superseded. Browser checks from here on run with `headless: 'shell'`. All results below are from shell mode.

- **Shared `RowOpenButton`** (`src/components/RowOpenButton.tsx`) — the Leads row-open overlay button, extracted because a second route now needs it. The row keeps its pointer click. The button, laid over the row with pointer-events off, is the keyboard and screen-reader path. It is one allowlist entry (`row-open-button`, replacing `leads-row-open`), not one per route.
- **Campaign leads workspace**
  - Segment chips (a hand-built `segmented` tablist) → `Tabs` with counts. The search label+input → labelled `TextField type="search"`, with Enter/blur commit unchanged.
  - The `card` + `table-scroll` + raw `<table>` with arbitrary header utilities → `TableFrame`/`TableToolbar`/`Table`. The "Showing the 100 most recent" note moves to the frame hint.
  - Rows are no longer `<tr role="button" tabIndex=0>`; they use `RowOpenButton`.
  - Follow-up due is a `Badge` in the Leads/Follow-ups tones, and "Needs response" is a danger `Badge`. Sender & campaign is `AccountIdentity`.
  - The empty state distinguishes `no-match` (with a Clear filters `Button`) from `empty` ("No leads in this campaign yet").
- **LeadReplyIdentity** (shared by Leads and the workspace) — the name link, company line and reply snippet are utilities (`.row-link`, `muted small`, `.reply-body` gone). The sentiment/intent/milestone/risk chips keep their domain classes, as decided in Phase 7.
- **Pipeline**
  - The card's open target is a ghost `Button` restyled like `FollowUpRow`'s. The orchestrator added `font-normal`, because otherwise every line inside inherited the button's bold.
  - The three Manage-lead selects are canonical `Select`s with their existing names. The owner-blocked reason is now visible text, not only a `title`.
  - Follow-up due → `Badge`; Them/Us → `StatusText`; the "Working as" chip → meta text.
  - The board is a named, focusable "Pipeline board" region that scrolls sideways, with a visible hint. The orchestrator corrected the worker's hint copy, which claimed arrow-key moves; the keyboard path is Manage lead. Full-bleed maths, drag-and-drop, the drag-over highlight, the per-column stripe and the fixed column height are unchanged.
  - `pipeline.css` is deleted; its rules are utilities now.
- **CSS** — removed from `ui.css`, all with zero consumers: `.pipe-board`, `.substatus-chip`/`.pipe-stage-select`/`.pipe-assign-select`, `.pipe-msg-dir`, `.follow-due`/`.pipe-follow-due` (all variants), `.identity-chip` (all), `.pipe-card-message`/`.pipe-card-foot` (already dead), `.pipe-modal-actions` (dead), `.reply-row*` and `.reply-who-top` (dead), plus two empty section headers. `.segmented*`, `.table-scroll`, `.row-clickable`, `.row-link` and `.reply-body` stay; the analytics tables, SentimentTrendChart and NewReplies still use them.

Tests: new `pipelinePage` (5). `campaignWorkspace` gains 2: no `tr[role=button]` plus canonical list chrome, and no-match plus Clear filters. One existing assertion now reads its row as the button's `tr`; the assertion itself is unchanged. Mutation checks:
- Dropping the `lost` interception fails `pipelinePage`.
- Clear filters that keeps the segment fails `campaignWorkspace`.

Gate (from `frontend/`, build first): build passed; `npm run test` 100 files / 1,446 tests passed; `typecheck:api` passed; `ui:inventory` passed after update (raw controls 112 → 104; allowlisted 9; compatibility tokens 519 → 476; selectors 260 → 242; modal roots 2). Fixture `--check` passed; `git diff --check` passed. Production gzip JS 654,667 (+0.6% vs Phase 0), CSS 36,125 (−4,740 vs Phase 0). TS/TSX +197/−160 and CSS +1/−118 lines.

Browser evidence — **local synthetic fixture, headless Chrome `shell` mode, exact 1280×720 / 1440×900 / 1920×1080**:

| Surface | Result at all three |
| --- | --- |
| Pipeline board | named region from x=232 to the viewport edge; scrolls locally; page overflow-x 0; 13 columns, fixed height 480/660/840; the card's Manage-lead selects named "Pipeline stage", "Lead owner" |
| Pipeline card keyboard | focus the card button, Enter opens the conversation drawer, Escape returns focus to the same card button |
| Campaign leads | tabs "All 1 · Replied 1 · P3 0 · Needs follow-up 1 · No reply 0"; searchbox "Search campaign leads"; one row-open button per row; first row at y=385 under the campaign header and tabs; overflow-x 0 |
| Campaign row keyboard | Enter on the row button opens the drawer; Escape returns focus to "Open conversation with Alex Fixture" |

Next: Phase 9 — the analytics and detail family (Overview, AccountDetail, CampaignDetail performance/sequence presentation, SentimentAnalysis, KPI/funnel/chart/table components, DateRangePicker integration).

## Phase 9 — accepted (2026-09-24)

The analytics and detail family: Overview, Account detail, Campaign detail (Performance and Sequence tabs), Sentiment analysis, the KPI/funnel/chart/table components and DateRangePicker. The orchestrator did Overview (the analytics reference), DateRangePicker, the chart palette, the KPI tile, the CSS pruning and the Panel spacing fix. Three Sonnet workers did Campaign detail, Account detail and Sentiment analysis; the orchestrator reviewed every diff.

- **Dead code removed.** `overview/ActiveSequences`, `overview/NewReplies`, `overview/GlobalSummary` and `AccountCard` had no consumer anywhere.
- **Overview**
  - The three sections are `Panel` + `SectionHeader` with their controls as header actions. The three independent reads and ranges, the one-way campaigns latch and the cohort denominators are unchanged.
  - "Refreshing…" → `UpdatingNote`. It shows only when the *same* range is re-read. A range change still drops the old numbers for a skeleton, because old data is never shown under a new scope label. Tests pin both.
  - The account select is a `SelectField` (its name is still "Performance account"). Sort headers are `SortHeader`. The page checkboxes are `Checkbox` with screen-reader-only labels.
  - Campaign-comparison rows were `<tr tabIndex=0 onClick onKeyDown>`. Now the campaign name is a real `Link`, which is the keyboard and screen-reader path, and the row keeps a pointer click to the same URL. This "row that navigates" pattern is the Phase 9 reference; Account detail's campaign table uses it too.
  - The empty and all-removed states are `EmptyState` `empty` / `no-match`.
  - `overview.css` shrank from 362 to 164 lines. It no longer restyles tables (`.overview table/th/td`, `.ov-sortable`, the `.overview .ui-table` override, the dead `.drp*` rules); only the KPI tile, chart and loading layouts remain. The legend dot had `color` but no background, so it had never been visible; it now carries the series colour. A stretched Invited tile got `align-content: start`.
- **DateRangePicker** — the trigger is a secondary `Button` (through Base UI `render`). The presets are ghost `Button`s with `aria-pressed` on the selected one.
- **Chart palette has one owner.** `chartTheme.tsx` gains `SENTIMENT_SERIES`, `INTENT_SERIES`, `REVIEW_SERIES`, `REASON_SERIES`, `GENDER_SERIES` and `SERIES.annotation`/`safeBand`/`limit`. Every local colour map (SentimentTrendChart, WeeklyTrendChart, SentimentDistributionChart, CampaignDetail's gender map, the Overview chart) now imports them. The reply-analysis hexes became tokens, which is an intentional hue change; a test fails on any hex literal returning. WeeklyTrendChart also moves to the shared `GRID`/`AXIS`/`TOOLTIP` (no more dashed grid).
- **KPI tiles have one owner.** Review and the Gallery hand-built `card kpi` tiles. They now use `KpiTile`/`KpiGrid` (new `src/components/KpiTile.tsx`), the same shell KpiCards uses. It is a separate module on purpose: importing KpiCards for a plain tile dragged the sparkline and velocity charts into Review's graph and merged two chunks.
- **Campaign detail (worker)**
  - The compare chips' × is an `IconButton`. The orchestrator raised it from the worker's 20px to 32px.
  - The briefing editor is `TextareaField` + a primary `Button` with `loading`. The Analyze `<details>` is a `Panel`.
  - CampaignCompareTable is on `TableFrame`/`Table`/`SortHeader`, with identical sort behaviour. AddBatchesTable is on `TableFrame`/`Table`.
  - RateVolumeScatter's range buttons → `SegmentedControl`. CampaignRuntimeStatus's chips → `Badge`, with the runtime-vs-provenance distinction and labels unchanged. `campaign-detail.css` is gone.
- **Account detail (worker)**
  - CampaignTable is on `Panel`/`TableFrame`/`Table`/`SortHeader`/`Select`, with the navigating-row pattern. Archived is shown as `Badge` "Archived" / "No" / `Badge` "Unknown".
  - KpiCards and LeadsVelocityChart are on utilities, and the delta chip is a `Badge`. Heatmap and LeadsVelocityChart modes → `SegmentedControl`. Funnel is on `Panel` + utilities, and `funnel.css` is gone.
  - The orchestrator moved "Added this week" into the same gap stack as the charts; it had been touching the next panel.
- **Sentiment analysis (worker)**
  - The comparison table is on `TableFrame`/`Table`. SentimentTrendChart's two pseudo-tablists (one with no roles, one with mismatched `tab` roles) → `SegmentedControl`. "Show every reason" → ghost `Button`.
  - A real bug was fixed: a same-filter refresh hid every result (`visibleResult && !loading`) and showed no loading panel either, so the page went blank. Results now stay under `aria-busy` with an `UpdatingNote`. They are still keyed by filter, so a filter change never shows old data.
  - The fixture gains `replies.analytics`.
- **Panel spacing primitive fix.** `.ui-panel + .ui-panel { margin-top }` also applied inside flex and grid parents that set their own gap. Stacked panels sat 48px apart, and the second column of every two-column panel grid dropped 24px, visible on Campaign Performance, Sentiment, Health and Account. The rule is now `:not(.flex, .grid, .inline-flex, .inline-grid) > .ui-panel + .ui-panel`. `cssCascade` pins it, and the mutation back to the bare selector fails. Review's local `[&>*]:mt-0` workaround from Phase 6 is now redundant but harmless.
- **Bundle naming.** The UI inventory matches chunks by hash-free name. The shared recharts core chunk was named after its first module: `generateCategoricalChart` in Phase 0, then `chartTheme` once every chart imported the palette. That read as 636 → 102,113 bytes of "growth" for what was a rename.
  - `manualChunks` was tried and rejected: it pulled `react-dom`/`react` into the manual chunk and made the entry preload it.
  - The fix is naming only. `vite.config.ts` `chunkFileNames` pins that chunk to its Phase 0 name, so its budget check stays live: 101,322 → 102,150, within budget, and not preloaded by the entry.
- **CSS** — removed from `ui.css`, all with zero consumers after this phase: `.card-head`, `.segmented`/`.segmented-item*`, `.row-clickable*`, `.stack`, `.cmp-chips`/`.cmp-chip*`/`.cmp-bar*`/`.cmp-warn`/`.cmp-avg`, `.compare-grid`, `.two-col`, `.sort-ind`, `.table-scroll*`, `.range-group*`, `.ellipsis`, every `.kpi*`, `.campaign-table-filters*` (`.deployment-filters` kept for SequenceBuilder), `.archive-yes`/`.archive-unknown`, `.runtime-unknown`/`.observation-*`, `.campaign-runtime.compact`, `.li-link`, `.seg-dot*`, `.hot-leads-title`, `.error-cell-btn`, `.sparkline-empty`, plus the orphaned comments they left. `ui.css` went from 1,336 to 1,161 lines.

Tests: new `campaignDetailPage`, `accountDetailPage` (6) and `sentimentAnalysisPage`. `overviewOperations` gains 4:
- scope change drops old numbers, while the other two sections stay unbusy with their own ranges;
- a same-range re-read shows Updating over the current answer;
- the campaign opens through a real link and no `tr[tabindex]` exists;
- account-table sort from the header button.

`cssCascade` gains the Panel-stacking rule. Mutation checks, each observed failing and then restored:
- no UpdatingNote;
- a `tabIndex` back on the row;
- a checkbox click that navigates;
- the bare panel selector;
- plus each worker's own (no-op sort, broken not-found guard, no-op retry, a reintroduced hex).

Gate (from `frontend/`, build first): build passed; `npm run test` 103 files / 1,466 tests passed; `typecheck:api` passed; `ui:inventory` passed after update (raw controls 104 → 75; allowlisted 9; compatibility tokens 476 → 174; selectors 242 → 185; modal roots 2). Fixture `--check` passed; `git diff --check` passed. Production gzip JS 655,270 (+0.7% vs Phase 0; +603 vs Phase 8), CSS 33,599 (−7,266 vs Phase 0). TS/TSX +932/−1,126 and CSS +52/−435 lines.

Browser evidence — **local synthetic fixture, headless Chrome `shell` mode, exact 1280×720 / 1440×900 / 1920×1080**:

| Surface | Result at all three |
| --- | --- |
| Overview | three named sections, none busy at rest; both tables captioned, `aria-sort` on the active column, no focusable rows, one campaign link per row; legend dots visible in the series colours; page overflow-x 0 |
| Account detail | breadcrumb + identity header; KPI tiles; one gap stack (24px between every panel); Heatmap metric radiogroup; campaign table named, 10 sort headers, name link → `/campaign/…` |
| Campaign detail | Performance: funnel beside weekly cohorts, top-aligned (16px column gap), then activity and Analyze; Sequence: provenance, message sequence and a labelled briefing textbox; overflow-x 0 |
| Sentiment analysis | period / trend / compare radiogroups; named comparison table; populated from the new fixture op; overflow-x 0 |
| Review, Health | Review's P3 tiles on the shared KpiTile; Health's side-by-side panels now top-aligned |
| Keyboard | Performance date range: Enter opens its calendar dialog, Escape returns focus to the trigger; Enter on the Overview and Account campaign links navigates; ArrowRight on the Heatmap metric moves both selection and focus |

Not covered by the fixture: an Overview read failure in the browser (covered by `overviewOperations`), and Sentiment analysis's empty scenarios.

Next: Phase 10 — Chat and the Sequence Hub.

## Phase 10 — accepted (2026-09-24)

Chat and the Sequence Hub (the `SequenceLibrary` landing view: Deployments and Build). The editor is untouched; that is Phase 11. A Sonnet worker did Chat, which the orchestrator reviewed. The orchestrator did the hub, the fixture reads, the SegmentedControl count and the CSS pruning.

- **Chat (worker)**
  - Chat's private copy button and CodeBlock's second copy implementation are gone. Both use the shared `CopyButton`, which gains:
    - a `text` thunk, because the code-block copy still reads the rendered `<pre>` at click time;
    - a `showLabel` form (a ghost `Button` whose visible "Copy" word flips to "Copied").
    The ICP/Hypothesis viewers keep the unchanged icon form.
  - The tool-call and "Thinking" toggles are ghost `Button`s with `aria-expanded`/`aria-controls`. The suggestions are secondary `Button`s, "Jump to latest" is a secondary `Button`, and the composer is the `Textarea` primitive named "Message Claude".
  - Send and Stop are `IconButton`s ("Send", "Stop generating") at the composer end. The error banner is `InlineError`, keeping the same server/network copy, the Details disclosure for server errors only, and Retry → `regenerate`.
  - `chat.css` is deleted; the tool-state borders are conditional utilities.
  - Streaming, stop, retry, scroll pinning / jump, sessionStorage persistence and New chat are unchanged.
- **Sequence Hub**
  - The deployment filters moved from a live-updating `Dialog` to `FilterDialog` with a draft. Apply commits all five filters at once; Cancel, Escape and the backdrop leave the table untouched; Clear all resets only the draft; reopening starts from the applied values. This is the spec's filter-overlay contract, as already used by Leads and Replies. The two existing hub tests now press Apply; their assertions are unchanged.
  - Read failures (deployments and builder) are `InlineError` with Retry. "No deployments match" is `EmptyState` `no-match` with Clear filters, distinct from `empty` ("No deployments yet"). The Build empty and no-match states are `EmptyState` with New sequence / Clear search.
  - The deployment table has `scope=col`, `ui-table__num`, a publish-status `Badge` (the tone lives in the domain owner: new `publishStatusTone` in `lib/sequenceBuilder.ts`), "Open builder" as a ghost `LinkButton`, and campaign links on utilities.
  - The Current/Archived switch (hand-built buttons) → `SegmentedControl` with counts.
  - Build cards were `<article role="button" tabIndex=0>` wrapping a nested archive `<button>`. Now the title is a real `Link` (the keyboard path, with the focus ring drawn on the whole card via `:has`), the card click is a pointer convenience, and archive is an `IconButton` named "Archive <sequence>" that never opens the card.
  - The decorative blur blob and hover lift/shadow on the cards are removed (cards carry no decorative shadow).
- **SegmentedControl** now renders `count`, the same as `Tabs`, with a shared count style. Only the hub passes counts so far.
- **Fixture** — `sequences.hub` (a managed sequence with a published and a publishing deployment, plus an external flow with an archive-unknown campaign). `/api/playbook` now answers `list_sequences`, a read over POST, with a current and an archived sequence; every other action is still refused. `--check` asserts both.
- **CSS** — removed, all with zero consumers:
  - from `ui.css`: `.banner*`, `.spin` + `@keyframes spin`, `.chat-send:active`, three dead `.chat-msg.user .chat-body/.chat-role/.chat-msg-actions` rules, `.drp-day*` (left from the pre-react-day-picker picker), `.deployment-filters*`, `.sequence-library-switch button.active`, and the orphaned comments;
  - from `sequence-builder.css`: the library switch, the deployment filter grid and `.deployment-advanced` grid placement.
  `ui.css` went from 1,161 to 1,107 lines.

Tests: new `chatPage` (8). `sequenceBuilderPage` gains 4:
- Apply-only drafts and Cancel;
- atomic Apply + no-match Clear filters;
- a failed hub read shows a retryable alert;
- the Build card is a real link, with no role=button article, segmented counts, and archive from a named button that neither navigates nor keeps the card in Current.

Mutation checks, each observed failing and then restored:
- the draft writing straight through to the table;
- a `tabIndex` back on the card;
- archive without `stopPropagation`;
- plus the worker's three (the Copied label not flipping, Shift+Enter sending, `aria-expanded` hardcoded).

Gate (from `frontend/`, build first): build passed; `npm run test` 104 files / 1,478 tests passed; `typecheck:api` passed; `ui:inventory` passed after update (raw controls 75 → 60; allowlisted 9; compatibility tokens 174 → 135; selectors 185 → 163; modal roots 2). Fixture `--check` passed; `git diff --check` passed. Production gzip JS 655,379 (+0.7% vs Phase 0), CSS 32,956 (−7,909 vs Phase 0). TS/TSX +325/−225 and CSS +13/−95 lines.

Browser evidence — **local synthetic fixture, headless Chrome `shell` mode, exact 1280×720 / 1440×900 / 1920×1080**:

| Surface | Result at all three |
| --- | --- |
| Hub, Deployments | tabs "Deployments 3 · Build 1"; one captioned table with a group banner row per sequence; Published (success) and Creating paused campaigns (info) badges; archive-unknown campaign hidden by default; overflow-x 0 |
| Hub, Build | "Builder sequence status" radiogroup; one card; title link → `/sequences/fixture-sequence`; overflow-x 0 |
| Hub keyboard | Enter on Filters opens the dialog with focus on its first field; a draft change leaves 2 rows; Escape closes it with 2 rows and focus back on Filters; Apply with Archive=All shows 3 rows and "Filters 1"; ArrowRight moves the tab to Build; Tab order is Current → Archive button → card link (ring on the card); Enter opens the editor |
| Chat | empty state with four suggestion buttons; composer named "Message Claude" with Send at its end; overflow-x 0 |

Not covered in the browser: the fixture has no chat endpoint, so streaming, Stop, Retry and jump-to-latest are covered only by `chatPage` and the unchanged `useChat` wiring.

Next: Phase 11 — the Sequence editor and publish workflow.

## Phase 7 follow-up — conversation drawer asks before discarding (2026-09-24)

Decided by the user: closing the conversation drawer over unsaved work asks **Keep editing / Discard changes**, through the shared `useDirtyGuard`.

- **Unsaved work** means either of:
  - an import with pasted or parsed text and no successful save yet (`ImportHistoryPanel` gains `onDirtyChange`);
  - edits to the review form (`ReplyReviewPanel`'s existing `onDirtyChange`), keyed by the inbound message id so a newer reply's fresh form is not mistaken for the edited one.
  A successful review save clears the flag. A refused or failed save (`saveReview` → `null`) keeps it, so closing still asks.
- **Guarded paths:**
  - Escape, the backdrop and Close (the Dialog's `onRequestClose`);
  - the two in-drawer navigation links (campaign, Open in Replies), where navigation waits for the answer and Discard then closes and navigates;
  - Import history and the follow-up toggle, which unmount the review form and so used to drop its draft silently.
- **Unguarded, as before:** Keep editing returns focus to the field, the import's own Cancel/Back stays its explicit discard, and a clean drawer closes at once.

Tests: `conversationDrawer` gains 4:
- a pasted import: Escape asks, Keep editing keeps the text, Close → Discard closes;
- a clean import view closes at once;
- a guarded link holds navigation until Discard;
- an edited review: the Import switch asks, a refused save still asks, a successful save stops asking.

Five mutations each fail a test:
- the guard bypassed on close;
- import never dirty;
- a successful save not clearing;
- the Import switch unguarded;
- the link unguarded.

Browser (fixture, `shell` mode, 1280×720):
- Escape over a pasted import opens "Discard unsaved changes?" with focus on Keep editing.
- A second Escape closes only the prompt, with focus back in the textbox and the paste intact.
- Close → Discard closes the drawer, and focus returns to the row's "Open conversation with Alex Fixture".

Gate: build passed; `npm run test` 104 files / 1,482 tests passed; `typecheck:api` passed; `ui:inventory` passed (unchanged: 60 raw controls, 135 tokens, 163 selectors).

Noted, not changed: Import history is disabled until the thread has loaded, including the second read that manual-review mode triggers. It dedupes against the loaded messages, so this is intentional.

## Phase 11 — accepted (2026-09-24)

The editor below the Hub: header and save state, mode tabs, step and variation controls, branches, preview, the review rail, and the app's last two hand-built modals. Two Sonnet workers did it in parallel on the same file: one did `CommentComposer` and `PublishWizard`, the other the rest. The orchestrator reviewed both diffs, did the fixture, the CSS moves and pruning, the allowlist and the visual fixes below. **State ownership did not move.** The autosave timer, revisions, conflict handling, DnD sensors and `dragEnd`, branch selections, preview selection, publish readiness and snapshot are all byte-identical in their original roots.

- **Dialogs (both are now the shared `Dialog`; modal roots 2 → 0)**
  - `CommentComposer`: small dialog titled "Add comment", with the target as its description. It has a labelled `TextareaField` "Comment", which is where focus starts. Add comment uses `Button loading`. While the request is in flight, `busy` refuses Escape, the backdrop and Close, and says why. A refused save keeps the dialog and the text.
  - `PublishWizard`: 880px dialog, "Publish campaign" · "<name> · revision N", Close named "Close publish campaign".
    - The old modal refused only a backdrop click and a disabled Close while queueing; Escape wasn't handled at all. Now all three go through the Dialog. While busy they are refused with an announced message that also describes the disabled Close.
    - The step status text is the `footerNote`; Cancel/Back/Continue/Queue are `Button`s with unchanged disabled expressions, and Queue uses `loading`.
    - Step rail: ghost `Button`s with `aria-current="step"` and `data-state="complete"` instead of `active`/`complete` classes.
    - Loading → a `role="status"` line; read failure → `InlineError` with "Try again"; no destinations → `EmptyState`; review preview error → `InlineError`; the setup validation callout gains `role="alert"`.
    - Readiness is a `Badge`. Visit/Follow are `Checkbox`es (the fake switch track is gone). Delay inputs are the `Input` primitive with identical attributes. Select all/Clear all is a ghost `Button`.
    - The destination cards and branch tiles keep their rich label around a visually hidden native radio/checkbox. They are allowlisted as `publish-target-card` and `publish-branch-tile`, with `ui-exception` comments.
    - The decorative Send tile and the "Linked Helper" eyebrow in the header are gone. The ≤700px bottom-sheet variant went with the hand-built modal (the app is PC-only).
- **Editor chrome**
  - Compact document header, still sticky: Back, the name as the canonical `Input` (text-lg, semibold), "Edited by", `SaveStatus` (presentational; `SaveIndicator` deleted, and the local `SaveState` type is the one from `src/ui`), then Comment, Comments & history and Publish, all unchanged.
  - The conflict banner is an `InlineError` with "Load newer version". Build/Branches/Preview are `Tabs` with the branch count. "Could not open sequence" is an `InlineError` plus the existing Back button; no retry was added.
- **Canvas**
  - Step actions: `Button sm` for Comment and Make CR; `IconButton` for move up/down and remove (danger).
  - Both drag handles are `IconButton`s receiving dnd-kit's attributes and listeners unchanged (`aria-roledescription="sortable"`; the connection step's handle stays disabled).
  - Variation: name `Input`; token and emoji inserters are `Button sm` (`font-normal`); the body is the `Textarea` primitive, now named "Variation text" (it had no accessible name); Comment is a ghost `Button`; the character count uses conditional utilities; "Move to" is a label around the `Select`.
  - Add variation is a ghost `Button` and Add message a secondary `Button`. Their dashed accent treatment is gone.
- **Branches / Preview / Review rail**
  - Branches: `SectionHeader` with the eyebrow kept; `EmptyState` + "Create branch A"; branch cards are `Panel`s with `Input`, `IconButton` and `Select`s.
  - Preview: `SectionHeader`; the device toggle is a `SegmentedControl` ("Preview device"); controls are `SelectField`s in a `Panel`. The LinkedIn frame is still the documented colour/type exception, now keyed on `data-device`/`data-warn`. Its fake send `<button>` is an `aria-hidden` span.
  - Review rail: Comments/History is a `SegmentedControl` ("Review panel"); "Show resolved" is a `Checkbox`; the empty state is `EmptyState`; thread state moved to `data-resolved`/`data-stale`; replies use a `Textarea` named "Reply" and `Button`s.
- **Orchestrator fixes on top of the workers** (all found in the browser):
  - `Tabs`/`SegmentedControl` labels given as icon + text stacked the icon above the word. Each label is now wrapped in an inline-flex span. The primitives were not changed.
  - "Move to" wrapped onto two lines.
  - The publish rail's focus ring was clipped by the dialog body's `overflow: hidden`, so it is now drawn inset.
  - Two hook classes left with no rule (`linkedin-preview`, `sequence-publish-job-icon`) failed `unknownClasses` and were dropped.
  - The Gallery's "Add variation" reference is now the same ghost `Button`.
  - A test's closure-assigned `let` narrowed to `never` under `typecheck:api`.
- **Publish job strip (changed on purpose)**
  - The old CSS matched `.succeeded`, but the status is `success`, so a successful job never turned green and its check icon span. Success is now green and static.
  - `failed`, `partial_failure` and `conflict` are red, matching the alert icon they already showed. Only the in-progress loader spins.
- **CSS**
  - Moved from the `ui.css` compatibility block to `sequence-builder.css`, all still in use: `.sequence-variation-grid`/`-actions` (and their 700px rules), `.sequence-mini-flow span.connection`, `@keyframes sequence-shimmer`, `.deployment-advanced .ui-field`.
  - Removed from `ui.css`, each with zero consumers by exact class-token grep over `src/**/*.ts(x)` (template literals checked by hand):
    - every `.btn*` and `.btn-accent*`, `.icon-btn`/`.icon-only-btn*`, `.link-btn*`, `.sortable*`, both `.conv-close` rules, `.pipe-modal*`, `.char-warning`, `.empty-state-action .link-btn`, `.conv-demographics .badge`, `.publish-compatibility-card .badge`, `.campaign-source .badge`, and the dead `.btn` in the print hide list;
    - every editor `sequence-*` state rule (`save-state`, `editor-tabs`, `device-toggle`/`review-tabs`, `step-icon`, `comment-thread .stale`, `version-list .btn`, `add-variation`, `publish-head/-steps/-state/-loading/-target.selected/-branch-list .selected/-job-strip`, the spinner clause), `.linkedin-preview.mobile` and `small.warn`;
    - the 1180px and 700px `.sequence-step-actions .btn`, `.sequence-editor-topbar .btn` and `.sequence-library-hero`/`.sequence-section-intro` rules.
  - Also removed from `sequence-builder.css`, all dead after the conversion: `.sequence-device-toggle`, `-review-tabs`, `-editor-tabs`, `-empty-state`, `-save-state`, `-conflict-banner`, `-drag-handle`/`-variation-drag`, `-section-intro`, `-branch-empty`, `-comment-compose`, `-publish-overlay/-modal/-head*/-readiness/-switch*/-validation/-footer*/-submit`, plus their media overrides.
  - `ui.css` 1,107 → 878 lines.
- **Fixture**
  - `/api/playbook` now answers the editor's reads: `get_sequence` (3 steps, 2 branches, 2 versions, one open anchored thread and one resolved), `list_sequence_publish_targets` (one ready and one rejected notebook) and `list_sequence_publish_jobs` (empty).
  - Save, comment and publish stay refused, so the browser checks exercise the refused and error branches.
  - The fixture document gained `sampleData` and the real `{firstName}`/`{companyName}` tokens. `--check` asserts the detail, a 404, the targets, and the refusals.

Tests: new `sequenceEditorDialogs` (8): both dialogs cover focus-in, Escape through `onRequestClose`, busy refusal of Escape/backdrop/Close with the message, and focus return to the trigger. `sequenceBuilderPage` gains 6 editor cases: SaveStatus dirty→saving→saved, "Save failed", tabs + count + device radiogroup, branch selection feeds the save payload and "Preview branch" prepares it, sortable handles with the connection handle disabled, and the review rail + restore. `sequencePublishWizard` is unchanged and green. Mutation checks, each observed failing and then restored:
- the workers' eleven (no `busy` on either dialog, a no-op `onRequestClose`, a disabled textarea for initial focus, a hardcoded SaveStatus, a masked error, a dropped tab count, a no-op device switch, a dropped branch-selection key, an empty Preview-branch click, an enabled connection handle, an off-by-one restore);
- plus the orchestrator's re-run of the PublishWizard `busy` removal.

Gate (from `frontend/`, build first):
- build passed;
- `npm run test` 105 files / 1,494 tests: 1,493 pass, and 1 fails — `supabaseClient` "is built when both values are usable". That test fails identically on a clean worktree of `9ac7dbe`: this machine runs Node 20, which has no native WebSocket for the Supabase client. It is environmental and unrelated.
- `typecheck:api` passed;
- `ui:inventory` passed after a reviewed `--update`;
- fixture `--check` passed; `git diff --check` passed.

| Count | Before | After |
| --- | --- | --- |
| Raw controls | 60 | 0 |
| Allowlisted | 9 | 11 |
| Compatibility tokens | 135 | 37 |
| Selectors | 163 | 75 |
| Modal roots | 2 | 0 |

No selector-ledger entry is still due by Phase 11. Bundle, measured on this machine before and after the phase (Node 20; the absolute numbers differ from the earlier phases' machine): production JS 601,293 → 601,265 gzip, CSS 32,942 → 30,939 (−2,003). TS/TSX +596/−600 lines (+197 for the new suite); CSS +41/−325.

Browser evidence — **local synthetic fixture, `chrome-headless-shell` 154 in `headless: 'shell'` mode, exact 1280×720 / 1440×900 / 1920×1080**:

| Surface | Result at all three |
| --- | --- |
| Header | sticky (the name input stays at y=13 after scrolling 900px, and SaveStatus stays visible); "All changes saved"; tabs "Build · Branches 2 · Preview"; page overflow-x 0; no control under 32px and no text under 13px outside the LinkedIn frame |
| Comment dialog | Enter on Comment opens "Add comment" with focus in the textarea; Escape closes it and focus returns to Comment; a refused submit keeps the dialog and the text and shows the refusal toast |
| Publish dialog | 880px; footer inside the viewport (bottom 695/720, 803/900, 893/1080); Ready and Not-ready destinations both visible; Continue → Setup → Review. With the publish request held: Escape and Close are refused, the busy message is shown and describes the disabled Close. Once released, the refusal toast shows and the dialog stays; Escape then closes it and focus returns to Publish |
| Tabs / Branches | ArrowRight moves the tab and focus to Branches; cards A and B with 6 selects; "Preview branch B" opens Preview with "Branch B" prepared |
| Preview | device radiogroup; the frame is 722/780 wide on web and 390 on mobile after ArrowRight |
| Review rail | "Review panel" radiogroup; one open thread (the resolved one is hidden) |
| Reorder | keyboard (Space, ArrowDown, Space) moves a variation, and focus stays on its handle. "Move step up" reorders the steps. Pointer drag moves a variation to the other step. The resulting autosave is refused → "Save failed", and Publish is disabled |

**Found, not fixed (pre-existing, identical on `9ac7dbe`):** dragging a *step* by its handle does nothing, whether by pointer or by keyboard. Step and variation sortables share one `DndContext` with `closestCenter`, so a step always lands over a variation droppable ("dropped over droppable area v3"), and `dragEnd` finds no step index and ignores it. Move up/down is the working path. The likely fix is a collision filter that only considers droppables of the active item's type. It is a behaviour change, so it was left for a decision.

**Changed on purpose, for review:**
- the publish dialog's Escape now works (and is refused while busy);
- the comment dialog refuses close while its request is in flight;
- the Visit/Follow switches became checkboxes;
- the job strip's success tint now shows;
- the name field has the canonical border;
- the dashed Add variation/Add message styling is gone.

**Environment notes:** the previous machine's puppeteer path and `vercel` CLI are absent on this Mac. The browser run used `puppeteer-core` and `chrome-headless-shell` installed in the session scratchpad, and the fixture ran with a scratchpad-local `vercel` 59 on PATH. Chrome 153 no longer has the old headless mode, so `chrome-headless-shell` is how `headless: 'shell'` works now.

Next: Phase 12 — compatibility deletion, documentation and full acceptance.

## Phase 12 — compatibility deletion, documentation and full acceptance (2026-09-24, accepted after the review below)

The orchestrator did this phase alone; no workers. Two product decisions were the user's, both made at the start:
- reply chips move to `Badge` with a new `purple` tone (for Referral);
- step drag-and-drop gets fixed.

- **Reply chips on `Badge`**
  - `Badge` and `StatusText` gain `purple`. `StatusText` also gains the `accent` tone, which it already accepted but had no style for.
  - The domain owns the tone:
    - `SENTIMENT_META`, `INTENT_META` and `NEXT_ACTION_META` carry `tone` instead of `cls`;
    - `SEVERITY_CLS` becomes `SEVERITY_TONE`;
    - new `STAGE_TONE` and the `ReplyChipTone` type, all in `lib/leads.ts`.
    The mapping keeps every colour: positive→success, objection→warning, neutral→info, referral→purple, negative→danger, auto→neutral; P1/P2/P3→info/warning/success; stage queued/invited/accepted/replied→neutral/accent/success/warning; risk→danger.
  - All 8 `badge senti …` sites (conversation drawer ×5, `LeadReplyIdentity` ×4, the campaign workspace's intent chip) and the stage/risk chips are `Badge`s. In `LeadReplyIdentity` the name and its chips share one wrapping flex row, so a wrapped chip is no longer indented.
- **Step drag fixed (was broken before the redesign).**
  - `BuildCanvas` uses `stepAwareCollision`: a step drag only considers step droppables. A variation drag keeps every droppable, as before, so it can still land on a step.
  - Sensors, state and `dragEnd` are unchanged. Dropping on the connection step is still refused.
- **The `ui.css` compatibility block is gone** (inventory: 75 legacy selectors → 0, 37 legacy token uses → 0). Every rule was either deleted with zero consumers or moved to its owner:
  - to `styles/base.css` (foundation layer): the element defaults (`:where(textarea)`, the native `select` chevron, table cells), reduced motion, print (`.card` → `.ui-panel`, with the dead `.mobile-header`/`.drp`/`.overview-section-*`/`.glass` removed), and the `conv-slide-in`/`auth-spin` keyframes;
  - to the `ui.css` primitives section: `.skeleton` (+ shimmer) and `.empty-state`;
  - to `components/layout.css`: `.navlink:active`;
  - to a new `components/markdown.css` (Chat and the Playbook preview): `.chat-md`;
  - deleted: `.card`, `.badge*`, `.senti*`, `.stage-*`, `.status-*`, `.attention-*`, `.source-external`, `.reply-body*`, `.row-link*`, `.dot*`, `.num`, `.filter-bar`, `.drp-presets`, `.overview-panel*`, `.active-sequence-list`/`.new-reply-*`, `.account-card-*`, `@keyframes toast-in` and the inert `.chat-msg.user`. Chat's `chat-msg <role>` class became `data-role`.
  - `css-parity.mjs` over the 70 moved declarations reported 50 exact matches. All 20 misses were minifier rewrites (`''`→`""`, `inset`→top/right/bottom/left, `translateX`→`translate`, `!important` spacing); every moved block was then confirmed in the built CSS by hand.
- **More zero-consumer CSS found by a full sweep of every stylesheet**, deleted: `.ui-toolbar__group`, `.ui-popover`, `.ui-stale`, `.quick-nav-dialog kbd`, `.quick-nav-result`/`.active` (Quick Navigation's items are generated `CommandItem`s and never carried those classes), and Replies' `.replies-thread-hints`.
- **Temporary adapters and dead UI code removed:**
  - the `--glass-*` token aliases;
  - the domain-copy `WORKFLOW_ACTION_LABELS`/`WORKFLOW_BUCKET_LABELS` in `src/ui/labels.ts`, which is generic copy only;
  - `runtimeStatusOptionLabel`;
  - the reply-analysis `SA_FIGURE`/`SA_GRID_220`/`SA_GRID_260`;
  - `ThreadScrollHint` and its CSS.
  `unknownClasses`' dynamic-prefix allowlist shrank from 9 prefixes to the 2 still used (`ui-status--`, `deployed-step-`).
- **Every exception is named where it lives.** Five allowlisted raw controls had no `ui-exception(<id>)` comment: `native-file-input-csv`, `nav-section-disclosure`, `quick-nav-search-trigger`, `library-card-open` and `hypothesis-row-open`. They have one now. `uiInventory` gains a test that fails if an allowlisted raw control is unmarked, and one that fails if the compatibility marker returns.
- **Primitive fix:** `Tabs`/`SegmentedControl` items are inline-flex with a 4px gap, so an icon + word label stays on one line; count spacing is unchanged at 8px. Phase 11's per-route wrappers were removed, and the Gallery shows an icon-labelled segmented control and the new tones.
- **Found by the matrix, fixed:**
  - the Sequence editor had no `<h1>`. It now has a visually hidden one that follows the name;
  - Account detail's heading was announced as "FA…" because the avatar initials were part of its accessible name. The avatar is now `aria-hidden`, and the test asserts the exact name;
  - Campaign/Account "not found" and "Could not open sequence" had no heading. Each now has a breadcrumbed `PageHeader`;
  - the fixture's Neon Activity read (the one `/api/activity-daily` call with no `op`) answered 400, so the page showed an error. It now returns three daily rows, and `--check` asserts them.
- **Docs:**
  - `docs/ui-standard.md`: where things live, the purple tone and the domain tone owners, the inventory with a table of all 11 named exceptions, the checks, the template-literal consumer-grep caveat and the `headless: 'shell'` note;
  - `CLAUDE.md` no longer calls `styles.css` a shrinking legacy sheet.
- **Left in place on purpose** (dead before the redesign, or domain logic rather than UI compatibility; the dead ones were deleted in the review below): `blindSpotLeads`, `accountStats`, `activeSequences`/`draftSequences`/`sequenceHref`/`sequenceAccounts` (their last UI consumers were deleted in Phases 6–9), plus the CSV download helpers, `acceptLagP90`/`replyLagP90`, `SEQUENCE_PUBLISH_TERMINAL` and `reviewDraftForMessage`. `src/lib/utils.ts` stays: it is the shadcn generator's target.

Tests (5 new): `stepAwareCollision` ×2, the editor's h1, the editor error heading, and the exception markers (plus the no-marker assertion). The Campaign/Account not-found and Account header assertions were tightened. Mutation checks, each observed failing and then restored:
- no step filter;
- an h1 that ignores the name;
- a visible avatar in the heading;
- each of the three not-found headers removed;
- a renamed exception marker.

Gate (from `frontend/`, build first):
- build passed;
- `npm run test` 105 files / 1,500 tests: 1,499 pass. The 1 failure is the environmental `supabaseClient` one (Node 20 lacks WebSocket; it fails identically on `9ac7dbe`).
- `typecheck:api` passed;
- `ui:inventory` passed after a reviewed `--update`, and **`ui:inventory --final` passed**;
- fixture `--check` passed; `git diff --check` passed.

| Count | Phase 11 | Phase 12 |
| --- | --- | --- |
| Raw controls | 0 | 0 |
| Allowlisted (all marked in code) | 11 | 11 |
| Compatibility tokens | 37 | 0 |
| Compatibility selectors | 75 | 0 |
| Modal roots | 0 | 0 |

Bundle on this machine: production JS 601,265 → 601,390 gzip (+125); CSS 30,939 → 30,193 (−746), which is −10,672 against the Phase 0 CSS baseline the `--final` gate checks. TS/TSX +222/−145 and CSS +80/−248 lines. `ui.css` 878 → 673 lines.

Browser evidence — **full matrix, local synthetic fixture, `chrome-headless-shell` 154 in `headless: 'shell'` mode.** 21 routes (including the Gallery, loaded fresh) × 4 scenarios (`populated-admin`, `populated-member`, `empty-admin`, `read-error`) × exact 1280×720 / 1440×900 / 1920×1080 = **252 visits**:
- **page overflow-x 0 on all 252; zero page errors.**
- `read-error`: every route shows the shell's read-failure alert, which replaces the route, so there is no route heading there by design.
- `populated-member`: CSV Import shows "Admin access required".
- `empty-admin`: `EmptyState` on 12 routes.
- Every flagged small target was an inline text link (breadcrumbs, table names) or the allowlisted stretched hypothesis row button. The only sub-13px text was avatar initials (the avatar exception) and the LinkedIn preview frame.
- Re-checked after the heading fixes: all three not-found/error states have their h1 at every viewport, with overflow 0; Neon Activity has no alert.
- The step-drag fix, keyboard and pointer: Space + ArrowUp moves step 3 above step 2 (1280/1440), and pointer drag reorders steps at all three sizes. At 1920, three ArrowUps overshoot onto the connection step and the drop is correctly refused. Variation drag is unchanged.

A long single-browser run crashed Chrome after ~150 visits, which is resource exhaustion. The matrix therefore launches a fresh browser per scenario and viewport; the isolated repro of the "hang" rendered normally.

Next: Phase 13 — production release (separately authorised).

## Phases 11–12 review (2026-09-24)

The orchestrator reviewed the Phase 11 and 12 diffs (Volodymyr's sessions) against the spec and fixed what it found. One Sonnet worker did the dead-code deletion; the orchestrator reviewed its diff.

- **Publish status strip had its own tone logic.** The editor's latest-publish strip coloured `partial_failure` and `conflict` red. The Hub badge shows the same statuses in amber, because `publishStatusTone` (the single owner since Phase 10) calls them warnings.
  - The strip is now a presentational `PublishJobStrip` driven by `publishStatusTone`: success green, warning amber, failed red, in progress keeps the accent with a spinner.
  - The strip was also never coloured before the redesign. Its old CSS keyed on `.succeeded`/`.failed`, and the status value is `success`, so neither class ever matched.
- **Conversation thread sentiment chip was a second colour owner.** `ConversationThread` hand-coded sentiment colours in a nested ternary. It showed Neutral in grey through the orphaned `.sentiment-neutral`/`.sentiment-auto` rule in `replies-inbox.css`; every other reply surface shows it as `info`.
  - It is now a `Badge` with `SENTIMENT_META[sentiment].tone`, and the rule is deleted.
  - The stale `SENTIMENT_META` comment ("`cls` maps to the `.senti.*` colours") is corrected.
- **Dead code deleted** (grep-verified zero consumers in `src`, `api`, `tests` and `scripts`; −248 lines):
  - `leads.ts`: `accountStats`/`AccountStats`, `blindSpotLeads`/`BlindSpotLead`/`WARM_SENTIMENTS`;
  - `sequenceHub.ts`: `activeSequences`, `draftSequences`, `sequenceHref`, `sequenceAccounts`, `RankedSequence`, `recencyOf`;
  - `review.ts`: `acceptLagP90`, `replyLagP90`;
  - `useReplyReviewActions.ts`: `reviewDraftForMessage`;
  - `sequenceBuilder.ts`: `SEQUENCE_PUBLISH_TERMINAL`;
  - `csvImport.ts`: `downloadImportResults`, `downloadCompanyImportResults`.
  Kept, with consumers: `toCsv`, `downloadCsv`, `downloadUnifiedImportResults`.
- **Checked and fine:**
  - CommentComposer focus lands in the textarea (the Dialog focuses the first body field);
  - PublishWizard keeps its busy close refusal;
  - the step-aware collision only narrows step drags;
  - the `Badge` tone mapping keeps every Phase 12 colour.

Tests (+6): `sequencePublishStrip.test.tsx` (5 statuses → tone, label, background) and a thread-chip case in `repliesInboxComponents`. Mutation checks, each observed failing and then restored:
- the strip with the old red-for-conflict mapping (2 cases fail);
- the thread greying Neutral out again (1 fails).

**List-start rule (spec, Definition of done), measured on the fixture with `headless: 'shell'`.** First result top, identical at 1280×720, 1440×900 and 1920×1080 except Replies:

| Route | First result top (px) |
| --- | --- |
| Leads | 336 |
| Pipeline | 254 |
| Follow-ups | 214 |
| Replies | 267 at 1280, 283 wider |
| Playbook | 271 |
| Searches | 292 |
| ICP | 185 |
| Hypotheses | 295 |
| Sequences | 295 |
| Team | 286 |

All are ≤340. Review, Health, Neon Activity, Overview and the detail pages are report pages, not list routes; their first table sits under KPI/summary sections by design.

Gate: build passed; `typecheck:api` passed; `ui:inventory` passed (0 / 11 allowlisted / 0 / 0 / 0; production JS 655,292, CSS 30,143, −10,722 vs Phase 0).

`npm run test`: 106 files / 1,508 tests. Under full-suite parallel load one `uiInventory` mutation test can exceed vitest's 5 s timeout; it takes ~450 ms alone and passes in isolation.

Next: Phase 13 — production release (separately authorised).
