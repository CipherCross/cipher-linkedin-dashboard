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
