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
