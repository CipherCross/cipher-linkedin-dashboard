# Component-system redesign implementation evidence

Accepted scope: `specs/2026-09-22-frontend-component-system-redesign.md`, Phases 0–12. Phase 13, push, deployment, production verification, database changes, and external mutations are not authorized.

Starting revision: `38d139b` (clean working tree). The implementation follows the accepted phase gates; this file records evidence, not a new plan.

## Phase 0 — in progress

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
