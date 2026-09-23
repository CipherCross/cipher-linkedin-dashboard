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
