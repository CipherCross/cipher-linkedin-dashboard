# shadcn/ui + Tailwind v4 migration, and the end of the legacy stylesheet

## Goal

Replace the hand-built visual system with shadcn/ui on Tailwind v4, delete
`frontend/src/styles.css` entirely, and close the component gap that currently
forces every new view to be assembled from raw CSS.

Three outcomes define done:

1. `frontend/src/styles.css` does not exist, and no `.tsx` references a class it
   used to define.
2. Every shared primitive is a shadcn component, still imported from `src/ui`,
   so the ~320 existing call sites do not change in the phase that swaps them.
3. The widget tier the dashboard has never had — combobox, command palette,
   toast, tooltip, dropdown menu, sortable/virtualized data table, date-range
   picker — exists as installed components rather than per-route hand-rolls.

## Non-goals

- Do not upgrade to React 19. React 18.3 stays; Base UI, Radix and shadcn all
  support it, and an upgrade would entangle two unrelated risks.
- Do not introduce dark mode. shadcn ships a `.dark` block; it is deleted on
  arrival and a check keeps it deleted.
- Do not change the palette, type scale, space scale or contrast ratios. This
  is a re-implementation of the existing visual system, not a redesign. A
  screen that looks different afterwards is a defect unless the phase lists the
  change as intended.
- Do not replace Recharts. shadcn charts wrap Recharts; the 11 chart files keep
  their data code and `chartTheme.tsx` keeps its token bindings.
- Do not replace `@dnd-kit` in `SequenceBuilder` / `MessageSequence`.
- Do not migrate `frontend/api/`. Browser-only change.
- Do not change any data read, write, query, schema or funnel semantic. A commit
  here that touches `frontend/api/_lib/data/` or `src/lib/leads.ts` is out of
  scope by definition.
- Do not do a big-bang cutover. At every commit the app builds, the suite is
  green at its recorded baseline, and every route renders.

## Research findings

Measured on the working tree at `3867ff0`. Numbers are counted, not estimated.

### Size of the problem

| | |
| --- | --- |
| `.tsx` files | 99 |
| TS/TSX lines | 33,305 |
| CSS lines total | 6,559 |
| `src/styles.css` (legacy) | 4,578 lines |
| Design tokens in `tokens.css` | 119 |
| Primitives in `src/ui` | 13 modules |
| Files importing from `src/ui` | 24 of 99 |
| Primitive call sites (all `<Primitive` usages) | ~320 |
| Distinct class tokens in JSX | 950 |
| Built bundle, uncompressed | 1.81 MB JS · 204 KB CSS |

### The legacy sheet is route-local, not shared

`styles.css` defines **927 selectors**:

- **143 are not referenced from any `className`** — but see the caveat below.
  The safely-deletable number is **at most 100**, and each needs review.
- **784 are referenced**, with extremely skewed fan-out:

| Files using the selector | Selectors |
| --- | --- |
| 1 | 659 |
| 2 | 69 |
| 3 | 17 |
| 4–17 | 29 |
| 43 / 58 / 64 | 3 (`.card`, `.small`, `.muted`) |

#### Caveat: the counts come from a regex, and it is wrong in both directions

Of 2,025 `className` occurrences, **157 (7.8%) are computed** — ternaries,
template literals, concatenation. The extractor recovers literal fragments from
most of them, but a class assembled from a computed substring is invisible to it.

Checked directly: of the 143 selectors the `className` scan called dead, **43
appear elsewhere in the source text** — `.drp-day`, `.char-warning`,
`.cohort-rate`, `.empty-state` among them. Deleting all 143 in Phase 0, as the
first draft of this spec instructed, **would have deleted live CSS.**

Both checks are loose in opposite directions: the `className` scan under-counts
usage, and a bare text search over-counts it (`.admin`, `.done`, `.completed`
are enum values in strings, not classes). So:

- Every count in this document is **approximately right and precisely wrong**.
  The shape — overwhelmingly single-file — is solid and reproducible. The exact
  integers are not.
- No selector is deleted on the strength of a script. Deletion is per-selector
  and reviewed, starting from the 100 that fail both checks.

**84% of referenced legacy CSS belongs to exactly one file.** This is the most
important fact in this document: the sheet retires route by route, each route's
CSS dying with that route's rewrite, with no coordination between routes and no
window where half a shared system is migrated.

Only **39 selectors reach four or more files**. `.muted` and `.small` are
already defined in `styles/base.css` — legacy only adds compound rules on top.
The genuinely cross-cutting legacy-owned classes are `.card` (43 files) and
`.btn` / `.badge` / `.link-btn` (17 files each). `styles.css:1307` already
records that the legacy button classes *are* the primitive, so all four collapse
into shadcn `Button` / `Badge` / `Panel` in Phase 1.

### Concentration of route-local CSS

Single-file selector counts — this is the literal ordering for Phase 3:

| Route / component | Unique legacy classes | Lines |
| --- | --- | --- |
| `pages/SequenceBuilder.tsx` | 122 | 1,515 |
| `components/ConversationDrawer.tsx` | 40 | 968 |
| `pages/Chat.tsx` | 36 | 372 |
| `components/Layout.tsx` | 33 | 488 |
| `pages/UnifiedApolloCsvImport.tsx` | 32 | 829 |
| `pages/Pipeline.tsx` | 27 | 464 |
| `components/MessageSequence.tsx` | 21 | — |
| `pages/LeadsExplorer.tsx` | 21 | 1,160 |
| `components/AccountCard.tsx` | 19 | — |
| `components/FollowUpPanel.tsx` | 18 | 461 |
| `pages/SearchLibrary.tsx` | 17 | 655 |
| `components/Funnel.tsx` | 16 | — |

`SequenceBuilder` is 122 of 659 single-file selectors — about a fifth of the
route work in one file. It gets its own phase.

Eighty of 99 `.tsx` files reference at least one legacy class.

### Primitive call sites, by primitive

| Primitive | Uses | Files |
| --- | --- | --- |
| `Button` | 95 | 22 |
| `SelectField` | 39 | 10 |
| `PageHeader` | 23 | 21 |
| `Panel` | 23 | 6 |
| `SectionHeader` | 18 | 5 |
| `TextField` | 14 | 8 |
| `IconButton` | 13 | 8 |
| `InlineError` | 10 | 8 |
| `Dialog` / `Badge` | 9 each | 8 / 2 |
| `Toolbar` | 9 | 8 |
| `Tabs` | 7 | 6 |
| `LinkButton` | 7 | 6 |
| `TableFrame` / `SegmentedControl` / `AccountIdentity` | 6 each | 4 / 4 / 3 |
| **`Drawer`** | **0** | **0** |
| **`RefreshingRegion`** | **0** | **0** |

`Drawer` and `RefreshingRegion` are exported, documented in
`docs/ui-standard.md`, and used nowhere. They are deleted in Phase 1, not
ported. `Badge` reaching only 2 files while `.badge` reaches 17 confirms the
24%-adoption finding from a second direction.

### Two collisions that will silently break utilities

These are the findings that changed the plan, and both were wrong in its first
draft.

**1. Unlayered CSS beats every Tailwind utility.** In the cascade, unlayered
rules outrank *all* layered rules regardless of specificity. Tailwind v4 puts
everything in layers. All three of `reset.css`, `base.css` and `styles.css` are
currently unlayered. So `base.css`'s `a { color: var(--accent) }` would defeat
`text-*` on every anchor, and its `h1 { font-size: var(--text-page) }` would
defeat `text-sm` on every heading — silently, with no error anywhere. This is
the single largest source of "my Tailwind utilities stopped working" in v4
migrations. **All three sheets must be layered**, not just the legacy one.

**2. Tailwind preflight collides with the curated reset.** `reset.css` is 83
lines of contract-bearing decisions: thin neutral scrollbars, `overflow-x: clip`
on body for the full-bleed `.pipe-board` maths, the single 2px accent focus ring
(the comment explicitly rejects a translucent halo as a 1.4.11 failure),
`.skip-link`, `.sr-only`, and control font inheritance. Preflight overlaps and
partly contradicts it. Tailwind v4 allows preflight to be omitted by importing
its parts individually.

### shadcn's primitive shapes do not match ours

Concrete, from the current Base UI Button docs:

| Ours | shadcn | Gap |
| --- | --- | --- |
| `variant: primary` | `default` | rename |
| `variant: secondary` | `outline` or `secondary` | needs a visual call |
| `variant: ghost` | `ghost` | none |
| `variant: danger` | `destructive` | rename |
| `size: md / sm` | `default / xs / sm / lg / icon / icon-*` | rename + unused sizes |
| `loading` disables **and keeps the width** | `<Spinner />` as a child | wrapper must hold the width itself |
| `icon` prop | `data-icon="inline-start"` | wrapper maps it |
| `block` prop | — | wrapper adds `w-full` |
| `IconButton` 44×44 around a 20px glyph | `size="icon"` is 32×32 with 16px glyphs | theme-level geometry override |

**`LinkButton` cannot be built on Base UI's Button.** Base UI's Button applies
`role="button"`, which clobbers link semantics — and `docs/ui-standard.md`
states outright that "an action is a `<button>`, a navigation is an `<a>`."
`LinkButton` and `ExternalLinkButton` must use the `buttonVariants` helper on a
real `<a>` / react-router `<Link>`. shadcn's own docs recommend exactly this.

The geometry mismatch is systematic, not per-component: the standard sets a
44px control height, 52/68px table rows, and 8/12/16px radii; shadcn defaults to 32px
controls (`h-8`), 36px at `lg`, and 16px glyphs. That is theme configuration in Phase 0,
not 13 separate fixes in Phase 1.

### What the codebase has in its favour

- `lucide-react` is installed and is shadcn's default icon library.
- `recharts` is installed; shadcn charts wrap it.
- Vite 5.4 satisfies `@tailwindcss/vite`'s peer range (`^5.2.0 || ^6 || ^7`).
  **No Vite upgrade required.**
- Test coupling to CSS is low: 98 test files, 26 rendering, ~5 touching class
  names — chiefly `tests/uiPrimitives.test.tsx`.
- `tokens.css` carries its per-surface contrast audit in its header comment, so
  the target ratios are written down rather than reconstructed.

### What will fight the migration

- **`npm run build` (`tsc -b`) is the only check for `src/`, and there is no
  lint.** A mistyped Tailwind class is invisible to every automated check in the
  repo and ships silently. This is a defect class the current CSS approach does
  not have.
- **jsdom cannot see a cascade defect.** The layer ordering above is exactly the
  kind of bug that renders correctly in every unit test and wrong in a browser.
  It must be verified by parsing the built CSS or by driving a real Chrome, and
  the check must be shown failing against the unfixed state before it is trusted.
- **`docs/ui-standard.md` is a binding contract**, not a style guide: tokens are
  the only place a colour may be defined, 13px is a floor, cards have no shadow,
  and there are exactly four exceptions to the no-gradient rule. shadcn defaults
  violate several on arrival.
- **`ui/Gallery.tsx`** (466 lines) is the surface geometry and contrast are
  measured on. It tracks every primitive change, phase by phase.
- **`.sr-only` is defined twice** — `styles.css:3099` and `reset.css:74`.
- **The tree is not clean and other sessions are writing to it.**
  `vite.config.ts` changed during the authoring of this spec.

### External state, 2026-09-21

- shadcn defaults to **Base UI** over Radix since July 2026; Radix is supported,
  not deprecated. Base UI is at 1.8.0.
- shadcn ships an official agent skill (v1.7.0, 17 Sep 2026), an MCP server and
  a registry. `shadcn init` writes `components.json`, adds the `@/*` alias, adds
  the Tailwind plugin to `vite.config.ts`, and replaces the entry CSS.
- shadcn ships **no** date-range picker with presets and **no** data grid. Both
  are assembled: TanStack Table, and `react-day-picker`. Phase 2 owns that.

## Decisions

1. **Base UI, not Radix.** shadcn's default; choosing the non-default costs
   registry compatibility for no benefit here.

2. **`tokens.css` stays the source of truth; shadcn's variables alias it.**
   Define shadcn's variables *in terms of* the existing ones — `--primary:
   var(--accent)`, `--destructive: var(--danger)` — rather than re-authoring 119
   audited tokens into OKLCH. This keeps the contrast audit valid, keeps the
   standard's "nothing else may define a colour" literally true, and keeps a
   future palette change in one file. The mapping table is Phase 0's main
   deliverable.

3. **Override shadcn's control geometry at theme level, once.** 44px control
   height, 44×44 icon buttons around a 20px glyph, 52/68px table rows, 8/12/16px
   radii, 13px type floor. Done in the theme in Phase 0 so Phase 1 is renaming,
   not re-measuring.

4. **`src/ui/index.ts` is the seam and its exported API does not change.**
   Phase 1 swaps implementations behind the barrel; the ~320 call sites in 24
   files are untouched. Where shadcn's prop shape differs, the difference is
   absorbed in a wrapper inside `src/ui`, never pushed to call sites.

5. **`LinkButton` / `ExternalLinkButton` are built on `buttonVariants` + a real
   anchor, never on Base UI's Button.** Base UI's `role="button"` would break
   the standard's action-vs-navigation rule. A test asserts a `LinkButton`
   renders an `<a>` with no `role` override.

6. **All three existing sheets are layered. Declared order:**
   `@layer theme, base, foundation, components, legacy, utilities;`
   with `reset.css` + `base.css` in `foundation` and `styles.css` in `legacy`.
   Tailwind utilities then win over everything without `!important` anywhere, so
   a half-migrated route is predictable instead of a specificity fight. Note the
   consequence: a stray `outline-none` utility can now defeat the focus ring.
   That is correct — an explicit opt-out — but it is new, and the focus ring
   gets its own test.

7. **Preflight is kept; `foundation` outranks it.** ~~Omit preflight.~~
   **Superseded by the spike:** shadcn's CLI detects Tailwind by the literal
   `@import "tailwindcss"`, so omitting preflight breaks `init` and every
   `shadcn add`. Use the canonical import and rely on layer order — preflight
   lands in `@layer base`, below `foundation`, so `reset.css` and `base.css` win
   on everything they define. One-time audit of preflight rules the reset does
   not cover.

8. **Delete dead CSS before porting anything — but review it by hand.** At most
   100 selectors fail both the `className` scan and a bare text search; those are
   the candidates, reviewed individually, not deleted in bulk by script. The
   `Drawer` and `RefreshingRegion` dead exports go at the same time. A script
   proposes; a human disposes. This plan already got this wrong once.

9. **No dark mode.** shadcn's `.dark` block is deleted and a check fails the
   build if it returns — every `shadcn add` will try to reintroduce it.

10. **A route is migrated only when its legacy selector count reaches zero.**
    "Mostly migrated" is how 4,578 lines accumulated. The count is
    machine-checkable and is the acceptance number.

11. **Route order is by isolation, not importance.** Low-count, low-traffic
    routes first to settle the idioms; the `Layout` shell and `SequenceBuilder`
    last.

12. **Every phase is independently revertable.** Each ends on a commit where
    build, suite and all routes are green. A phase that cannot be reverted
    without touching a later phase's files has been scoped wrong.

## Approach

The migration runs bottom-up: foundation, then primitives, then the missing
widget tier, then routes, then deletion. Each layer is stable before the next
depends on it.

The seam that makes this safe is `src/ui/index.ts`. Because every shared
primitive is already behind that barrel, Phase 1 can replace 13 implementations
without editing a single consumer. And because 84% of the legacy sheet is
single-file, Phase 3 can proceed route by route in any order within a tier,
which also means it parallelises across sessions if wanted.

Two guards are built in Phase 0 and run for the whole migration:

- **Unknown-utility guard.** Extract every class token from `className` string
  literals at build time and diff it against the class set Tailwind actually
  generated into the CSS bundle, minus the known legacy and component sets. A
  token in neither is a typo and fails the build. This is the only new
  automated check the migration introduces and it is not optional — without it
  the repo has no way at all to catch a misspelled utility.
- **Cascade guard.** Parse the built CSS and assert layer order, that no rule is
  unlayered, that `.dark` is absent, and that the focus-ring rule survives.
  jsdom cannot see any of this. Per the repo's own hard-won rule, the guard is
  first run against the *unfixed* state and shown to fail; a cascade test that
  has never failed is not evidence.


## Spike findings — 2026-09-21, branch `spike/shadcn-tailwind`

Executed, not researched. Every claim below was run against the real repo and,
where visual, verified in a live browser. The branch is kept but is **not for
merge**; its value is this section.

### Confirmed as planned

- **Tailwind 4.3.3 installs clean on Vite 5.4.21 + React 18.3.1**, zero peer
  warnings. No Vite upgrade, no React upgrade. Build passes.
- **shadcn CLI 4.21.0 works on this project** with Base UI (`-b base`).
- **`shadcn init` is non-destructive.** It *appends* to the CSS entry and left
  the hand-written layer declaration and imports intact. It refuses to run at
  all until the CSS entry and `@/*` alias exist, and it touches nothing when it
  refuses.
- **The layer order works.** With `reset.css` / `base.css` in `foundation`,
  shadcn's `@layer base` rules (`body { @apply bg-background }`) correctly lose.
- **Base UI's `role="button"` is real** — `useButton.mjs:177`:
  `isNativeButton ? { type: 'button' } : { role: 'button' }`. Decision 5 stands,
  now verified in source rather than from a doc summary.

### Decision 7 is wrong and must change

**shadcn's CLI detects Tailwind by looking for the literal `@import
"tailwindcss"`.** The split import that omits preflight —
`@import "tailwindcss/theme.css"` + `utilities.css` — makes `init` fail with
"No Tailwind CSS configuration found", and would break every subsequent
`shadcn add`. Verified both ways: split import fails, canonical import succeeds
immediately.

**Replacement decision: keep the canonical `@import "tailwindcss"`, accept
preflight, and let `foundation` outrank it.** Preflight lands in `@layer base`,
which sits below `foundation`, so `reset.css` and `base.css` win on every rule
they define. This is strictly better than the original plan: the CLI stays
happy and the curated reset still wins. The residue to audit is preflight rules
that `reset.css` does *not* cover, which is a one-time read of preflight's
output, not an ongoing cost.

### Token collisions — the biggest find

`shadcn init` writes an **unlayered** `:root` block. Unlayered outranks
`foundation`, so it silently captured three of the 119 tokens:

| Token | tokens.css | shadcn | Result |
| --- | --- | --- | --- |
| `--accent` | `#2563eb` | `oklch(0.97 0 0)` | brand blue → near-white |
| `--border` | `#d0d5dd` | `oklch(0.922 0 0)` | separator recoloured |
| `--muted` | `var(--text-muted)` | `oklch(0.97 0 0)` | muted text → near-white |

Confirmed in the built CSS (ours at byte 29,020 inside `@layer foundation`,
shadcn's at 211,081 unlayered) and then in a live browser:
`getComputedStyle(document.documentElement).getPropertyValue('--accent')`
returned `oklch(0.97 0 0)`.

**Visible effect: the primary button went invisible** — white label on a
near-white fill. This is the failure mode the whole cascade section warns about,
reproduced in ten minutes.

Note this is not merely a name clash. shadcn's `--accent` *means* "subtle hover
surface"; ours means "brand blue". Aliasing them together would be wrong in both
directions.

**Fix, verified working:** prefix shadcn's three colliding names to `--sh-*` in
its `:root`, and repoint its `@theme inline` mapping at the prefixed names
(`--color-accent: var(--sh-accent)`). After the fix the browser reports
`--accent: #2563eb`, `--border: #d0d5dd`, `--muted: #596579`, shadcn's own
`--sh-accent` intact, and the gallery palette renders correctly with its audited
contrast ratios. **Decision 2 survives, with this mechanism added.**

### Generated component reality vs. the standard

From the actual generated `button.tsx`, not the docs:

- **Default height is `h-8` = 32px**, `lg` is `h-9` = 36px. The standard
  requires **44px**, so *every* size is wrong, not just the default. The spec
  previously said 36px; that was also wrong.
- **`icon` is `size-8` = 32×32 with `size-4` = 16px glyphs.** Standard: 44×44
  around a 20px glyph.
- **`focus-visible:ring-3 focus-visible:ring-ring/50`** — precisely the
  translucent halo `reset.css` rejects in a comment as a 1.4.11 failure on light
  surfaces. Shipped by default in every generated component.
- **`destructive` is `bg-destructive/10 text-destructive`** — a subtle tinted
  button, not the solid one `danger` currently is. A semantic difference, not a
  rename. Open question 3 now covers `danger` as well as `secondary`.
- **`active:not-aria-[haspopup]:translate-y-px`** — a press transform the
  standard's no-lift rule did not contemplate.
- **Roughly eight `dark:` variants per component.** Inert without a `.dark`
  ancestor, but they arrive in every file `shadcn add` writes and the `.dark`
  block regenerates each time. The Decision 9 check is not optional.
- **The preset pulls in Geist** (`@fontsource-variable/geist`) and sets
  `--font-sans: 'Geist Variable'`. Must be reverted to Inter on every init.

### Bundle

| | Baseline | After Phase 0 | Δ |
| --- | --- | --- | --- |
| JS raw | 1,808,091 | 1,808,091 | +0.0% |
| JS gz | 525,591 | 524,588 | −0.2% |
| CSS raw | 208,832 | 234,606 | **+12.3%** |
| CSS gz | 33,652 | 39,227 | **+16.6%** |

**The JS number is not evidence** — the generated Button is not imported
anywhere yet, so it tree-shook out entirely. JS cost remains unmeasured and the
+10% budget is still unvalidated.

CSS is +16.6% gzipped with **zero utilities in use**; that is Tailwind's floor.
It will rise as utilities are adopted and fall as the 4,578 legacy lines leave.
The "CSS must shrink" target in Definition of done is retained but is now known
to be a real constraint rather than a safe assumption.

### The unknown-utility guard is viable but is real work

Prototyped. A regex version flags **139 tokens, of which roughly 80% are noise** —
it scrapes JS expression fragments (`===`, `col.id`, `className`,
`SEVERITY_CLS[iss.severity]`) out of `className` expressions. Too noisy to gate
a build.

It needs a proper AST pass (walk `JSXAttribute` named `className`, take only
`StringLiteral` and the literal quasis of template literals) plus an explicit
allowlist for dynamically-completed prefixes — `compatibility-` in `Health.tsx`
is a real example of a class name assembled at runtime. That is a half-day of
work, not the throwaway script the Approach section implied. **It remains
non-optional**, because it is the only possible defence against a typo'd
utility, but it must be budgeted.

Bonus: even the crude version found five genuinely dead class references in
current code — `chart-card`, `active-sequences`, `chat-msg-copy`,
`access-denied`, `conv-demo-gender` — all applied in JSX with zero matching CSS
rules. Pre-existing rot, harmless, and evidence the guard catches real things.

### Operational notes

- `shadcn init -y` alone still prompts for a preset; pass `-p <name>`
  (`nova`, `vega`, `maia`, `lyra`, `mira`, `luma`, `sera`, `rhea`). `base-nova`
  is not a valid preset name despite `--defaults` describing it that way.
- `init` adds `@base-ui/react`, `class-variance-authority`, `cn`,
  `tw-animate-css`, `shadcn`, and the Geist font to `package.json`.
- The spike left Tailwind in `node_modules` on the working branch. Run
  `npm install` in `frontend/` to resync if anything looks odd.

### Effect on confidence

Phase 0 moves from "planned" to "demonstrated" — it has been performed end to
end, including the parts that were wrong. Phases 1–4 are unchanged in
confidence; nothing in the spike measured route-migration velocity, so the
8–12 session estimate for Phase 3 remains the softest number in this document.

## Implementation phases

Sizes are estimates in working sessions, given so the shape of the cost is
visible; they are not commitments.

### Phase 0 — Foundations · ~1–2 sessions

No component changes, no visual change. Zero pixel diff is the acceptance
criterion.

- Install `tailwindcss`, `@tailwindcss/vite`; plugin into `vite.config.ts`;
  `@/*` alias into `tsconfig.json` and Vite resolve.
- Run `shadcn init` against Base UI. Reconcile rather than accept what it
  writes: keep `tokens.css`, delete the `.dark` block, do not let it overwrite
  the `main.tsx` import chain.
- Author the shadcn-variable → `tokens.css` mapping (Decision 2).
- Override control geometry in the theme (Decision 3).
- Import Tailwind canonically; verify `foundation` outranks preflight (Decision 7).
- Namespace shadcn's three colliding tokens to `--sh-*` (see Spike findings).
- Layer all three sheets in the declared order (Decision 6).
- Review and delete dead selectors (≤100 candidates) and the two dead exports.
- Build both guards; demonstrate the cascade guard failing pre-fix.

Exit: `npm run build` passes · suite green at baseline · browser pass over the
gallery at 1280×720 shows no pixel change · both guards green, cascade guard
shown red against the unfixed state first.

### Phase 1 — Primitives behind the existing barrel · ~3–4 sessions

Replace the 13 `src/ui` modules with shadcn components, preserving every export.
`tests/uiPrimitives.test.tsx` pins behaviour and should need few changes; where
it does, the change is scrutinised, because that test is the contract.

The four widest legacy classes collapse here: `.btn` / `.link-btn` (17 files
each) into `Button`, `.badge` (17) into `Badge`, `.card` (43) into `Panel`.
`LinkButton` per Decision 5, with its own anchor-semantics test.

`Gallery.tsx` moves in lockstep and is re-measured in a browser.

Exit: the four widest legacy selectors are gone from every call site · every
primitive renders in every state at the audited contrast · no call site outside
`src/ui` was edited.

### Phase 2 — The tier that was missing · ~3–4 sessions

The phase that answers the original complaint. Install and wrap in `src/ui`,
domain-free per the standard:

| Component | Replaces |
| --- | --- |
| `Command` | hand-rolled `QuickNavigation` |
| `Combobox` / searchable `Select` | nothing — new capability |
| `Popover` / `Tooltip` / `DropdownMenu` | outside-click + `keydown` duplicated across 5 files |
| `Sonner` (toast) | the `.toast` rules in legacy |
| Data table on TanStack Table | sorting duplicated across 6 files; adds virtualization |
| Date-range picker on `react-day-picker` | the 312-line `DateRangePicker.tsx` and its `.drp-*` rules |

Each replacement deletes the code it supersedes **in the same commit**. A commit
that adds a component without removing its predecessor is not accepted — that is
how a migration becomes an accretion.

Exit: `DateRangePicker.tsx`, the five outside-click hand-rolls and the six sort
implementations are gone.

### Phase 3 — Route-by-route legacy removal · ~8–12 sessions

Ordered by isolation. Each route is one commit or a short series, and its legacy
selector count must reach zero before it closes.

1. Low-count leaf components and the analytics routes.
2. `Funnel` (16), `AccountCard` (19), `MessageSequence` (21), `FollowUpPanel` (18).
3. `SearchLibrary` (17), `Pipeline` (27), `LeadsExplorer` (21).
4. `UnifiedApolloCsvImport` (32), `Chat` (36), `ConversationDrawer` (40).
5. `Layout` (33) — the shell, once every route inside it is settled.
6. `SequenceBuilder` (122) — its own phase, 1,515 lines.

Exit: no `.tsx` references any selector defined in `styles.css`.

### Phase 4 — Delete legacy and rewrite the contract · ~1–2 sessions

- Delete `frontend/src/styles.css` and its `main.tsx` import.
- Resolve `overview.css`, `replies-inbox.css`, `sentiment-analysis.css` per
  open question 2.
- Resolve the duplicate `.sr-only`.
- **Rewrite `docs/ui-standard.md`.** Its load-order section, "where things
  live" table, primitive table and "what is not allowed" list all describe a
  system that no longer exists. A stale binding contract is worse than none.
- Re-run the contrast audit in a browser against the gallery; update the
  computed ratios in the `tokens.css` header comment.

Exit: `styles.css` does not exist · `docs/ui-standard.md` describes the system
that does.

**Total: roughly 16–24 sessions.**

## Status — 2026-09-21

### Phase 0 · DONE, deployed to production at `c2460f5`

Verified live on `app.ciphercross.dev`: Tailwind cascade layers present,
`--accent: #2563eb`, `--border: #d0d5dd`, `--muted: #596579`.

Acceptance was **26 of 271 elements changed on the gallery**, not zero. All 26
are preflight's `button, input, select, textarea { font: inherit }` moving
controls off the UA's 13.3px/normal onto the app's 16/24 — which is what
docs/ui-standard.md specifies, so the pre-Tailwind rendering was the deviation.
None are visible: icon buttons stay 44x44 around a 20px glyph.

Four defects in shadcn's own output, each measured before being fixed:

1. **Token capture.** `shadcn init` writes an UNLAYERED `:root`, outranking
   tokens.css in `foundation`. It took `--accent`, `--border`, `--muted`; its
   `--accent` is a near-white hover surface, so the primary button rendered
   white-on-white. Fixed by prefixing its names to `--sh-*`. **Seven
   collisions, not the three the spike found** — the spike only compared
   `:root` and missed `@theme inline`, which also holds `--font-sans` and the
   `--radius-*` scale.
2. **The layer split inverted the cascade.** ui.css in `components` and
   styles.css in `legacy` made every route rule beat every primitive rule,
   because a layer beats specificity outright. Measured: the danger border
   vanished off an invalid input, the grey fill off a disabled one, and a
   textarea collapsed 120px -> 66px. **Decision 6 was wrong as written**: the
   two sheets must share ONE layer, ui.css first, so specificity decides as it
   did before layering.
3. `* { @apply border-border }` changed the computed border-colour of 217 of
   271 elements away from currentColor for no gain. Removed.
4. `outline-ring/50` is the translucent halo reset.css rejects as a 1.4.11
   failure. Removed, with the `.dark` block and the Geist webfont.

**Decision 7 changed twice.** Omitting preflight breaks the shadcn CLI, which
detects Tailwind by the literal `@import "tailwindcss"`. But the replacement —
"keep preflight, `foundation` outranks it" — is only true for what `foundation`
actually declares; reset.css sets font-*family* on controls, not size or
line-height, so preflight's `font: inherit` passes straight through. That is
the source of all 26 remaining diffs.

Both guards shipped and are mutation-tested:
- `tests/cssCascade.test.ts` — all eight defects above re-introduced, each
  caught by its own assertion.
- `tests/unknownClasses.test.ts` — TS AST walk, not regex (the regex version
  was 80% false positives). Found a real defect immediately:
  `.ui-updating__spinner` had no rule, so the updating spinner never turned.
  Its allowlist of 30 pre-existing dead class names is a ratchet that may only
  shrink; emptying it is a precondition for retiring styles.css.

### Phase 1a · DONE, deployed at `0549984`

- **Token bridge.** `@theme inline` exposes tokens.css as real utilities
  (`bg-app-accent`, `rounded-control`, `h-control`). Every entry *references*
  its token — confirmed in built CSS as
  `.bg-app-accent{background-color:var(--accent)}` — so tokens.css stays the
  only definition site. The `app-` prefix is deliberate: renaming shadcn's own
  names would break the output of every future `shadcn add`.
- **Button and IconButton on Base UI**, props and `ui.css` classes unchanged.
  `LinkButton`/`ExternalLinkButton` deliberately are NOT, per Decision 5 —
  confirmed in source at `useButton.mjs:177`.

**Phase 1 strategy, revised.** Base UI supplies *behaviour*; `ui.css` keeps
supplying *appearance* until each route converts to utilities in Phase 3. This
gets the focus-trap / roving-tabindex / ARIA wins at no visual risk, and avoids
a single high-risk restyling of all 13 primitives at once.

### Phase 1b · Overlay — DONE, deployed at `4b9854f`

Dialog and Drawer are Base UI. 146 lines out, 35 in: the Tab-cycling focus
trap, the module-level open-overlay depth counter, the manual `inert`
toggling, the scroll-lock bookkeeping and the portal all gone. Props, markup
and CSS unchanged, so all nine call sites and `useDirtyGuard` were untouched.

**The structural worry in the first draft was wrong.** `Dialog.Backdrop` is not
required. Keeping `ui-scrim` as a flex wrapper INSIDE `Dialog.Portal`, with
`Dialog.Popup` as its child, needs no CSS change at all — verified at 534x640,
16px radius, `rgba(16,24,40,0.45)` scrim, 24px gutter, body scrolling between a
fixed header and footer. Clicking the scrim is outside the popup, so Base UI
dismisses on it.

**This was reverted once, wrongly.** The revert in `514b7eb` was based on a bad
measurement: the dialog had been opened from a body-focused state with no
trigger to restore to, and with the browser pane hidden so `requestAnimationFrame`
never ran. Re-measured with a real trigger and a visible pane, focus enters the
dialog and returns to the trigger on close. **Lesson for the rest of this
migration: when a browser check contradicts the library's own source, suspect
the harness before the library.**

One accepted trade-off, not a defect: Base UI queues initial focus through rAF,
where the hand-rolled version focused synchronously on purpose because a frame
never arrives in a background tab. Accepted — the queued focus is guarded by an
`open` check and still applies when the tab is shown, and a dialog in a hidden
tab cannot be typed into. The reasoning sits in the test so it is re-examined if
Base UI's scheduling changes.

Two primitive assertions were rewritten rather than deleted: `aria-modal` became
the background's `aria-hidden` (Base UI hides siblings instead; the two are
alternatives and this is what the standard's "inert background" wording asks
for), and the scroll-lock assertion moved out of jsdom to the browser check,
because jsdom computes no layout and would have passed while the page
misbehaved.

### Phase 2 · Widget tier — DONE, deployed at `b65b187` and `87dcd64`

Installed and demonstrated on a new **Widgets** tab in `#/ui-gallery`: popover,
tooltip, dropdown menu, command palette, combobox, calendar, toasts.

**shadcn's semantic palette now resolves to `tokens.css`** — `--background`,
`--foreground`, `--popover`, `--primary`, `--destructive`, `--ring`, the sidebar
set and the chart ramp. Anything a future `shadcn add` writes inherits the app's
colours with no hand-restyling. Mapped by meaning, not by name: shadcn's
`--accent` is a hover surface where ours is brand blue, its `--muted` is a
surface where ours is muted TEXT.

**A Phase 0 decision needed narrowing.** Dropping shadcn's global
`* { @apply border-border }` was right unscoped — it changed 217 of 271 elements
away from `currentColor`. But shadcn's own components rely on it: several set a
border width and no colour, and without a default the popover drew a dark
`currentColor` outline. Now scoped to `[data-slot]`, which every shadcn
component carries and nothing hand-written here does — the exact boundary
between their components and ours.

Sonner is de-themed: `next-themes` uninstalled, theme fixed to light, severity
colours bound to our tokens, and every severity ships an icon so colour never
travels alone.

**Quick Navigation is the first hand-rolled widget retired.** 218 lines to ~110,
and **126 lines out of `styles.css` — the first time the legacy sheet has ever
shrunk.** It stops owning a second focus trap, its own scroll lock, its own
`inert` toggling, its own portal and its own active-descendant bookkeeping.
Filtering is *not* delegated to cmdk (`shouldFilter={false}`), so
`filterQuickNavigationDestinations` still ranks, caps and matches the meta line
— what the palette finds is unchanged, and all three contract tests pass as
written.

Accessibility subtlety worth keeping: cmdk points the input's `aria-labelledby`
at its own hidden label, and `aria-labelledby` beats `aria-label` in name
computation, so an `aria-label` on the input is silently ignored. The name must
be set through cmdk's `label` prop.

### Phase 3 · Route migration — recipe proven, `334d38c`

`NeonActivity` is off the legacy sheet. Small on purpose: it carried one legacy
class, and `.filters` was used by no other file, so the rule left with the route.

**The recipe, every step machine-checkable:**

1. Replace the legacy class with token-bridge utilities.
2. Delete the rule from `styles.css`.
3. Diff the generated CSS against the rule just deleted.
4. Suite green; the unknown-class guard fails on any class applied without a rule.

Step 3 held exactly, including that the spacing utilities resolve to the *same
tokens* rather than copied pixels (`.gap-app-lg{gap:var(--space-lg)}`). A
descendant rule converts through an arbitrary variant without reintroducing a
global selector: `[&_.ui-field]:min-w-[220px]` generates
`…\]\:min-w-\[220px\] .ui-field{min-width:220px}`.

`styles.css`: **4,578 → 4,450 lines.**

### Bundle, measured honestly

The gallery is a lazy chunk behind an `import.meta.env.DEV` route guard, so it
ships in the deploy but is never requested in production. Summing every chunk
overstates the cost by 79.7 KB gz.

| | vs baseline |
| --- | --- |
| JS gz, excluding the dev-only chunk | **+2.8%** |
| CSS gz | **+31.6%** (+10.6 KB) |

CSS is the number to watch. It should fall below baseline as the remaining
4,450 legacy lines go.

### Next, in order

1. **`DateRangePicker`** (312 lines, 6 consumers) — the largest hand-rolled
   widget left. Not attempted here: `tests/dateRangePickerAccessibility.test.tsx`
   pins implementation details (`data-day="1"`, exact focus targets) that a
   Popover + react-day-picker rebuild will not reproduce, so the test has to be
   rewritten deliberately alongside it. Keep the `Props` shape and the
   `rangeButtonLabel` export, and keep local-calendar date math — never
   `toISOString()` — so no timezone shift creeps into the range values.
2. **Phase 1c** — `Tabs`/`SegmentedControl` and `Field`'s
   Select/Checkbox/RadioGroup. Lower priority than it looks: `Tabs` already
   implements the APG pattern correctly with tests, so the marginal gain is
   small.
3. **Phase 3 proper** — the remaining twenty routes, in the isolation order
   below, `SequenceBuilder` (122 selectors) last and alone.
4. **Phase 4** — delete `styles.css`, empty the dead-class ratchet, rewrite
   `docs/ui-standard.md`, re-run the contrast audit.

### Remaining order

Phase 1b (Overlay) -> 1c (Tabs, Field's Select/Checkbox/RadioGroup, where Base
UI adds real keyboard behaviour) -> Phase 2 (the missing widget tier) -> Phase 3
(routes) -> Phase 4 (delete styles.css, rewrite the standard).

## Route-sheet conversion — state at 2026-09-21

`styles.css` is gone. Eighteen of twenty-four route sheets are converted to
utilities and deleted; each remaining sheet holds only what has no utility
form. Everything through `SentimentAnalysis` is on `main` and deployed.
`CampaignDetail` and `ConversationDrawer` are on
`feat/shadcn-route-sheets-final`, pushed and unmerged.

### Six shapes that do not convert

These are why no sheet reaches zero lines, and they are not laziness:

1. **Variant carriers.** `.gender-cell.manual`, `.msg.out`, `.pipe-col.drag-over`.
   A modifier resolves by specificity, which utilities do not have.
2. **Modifier styling a descendant.** `.funnel-row--pipeline .funnel-track`.
   The variant and the declaration live on different elements.
3. **Grouped selectors.** `.sa-bar-row, .sa-reason-row, .sa-trend-row`. The
   point of the construct is one block serving several elements; the sharing
   moves to a constants module instead.
4. **`@keyframes`.** No utility form. Tailwind references them by name.
5. **Non-ASCII `content`.** Tailwind will not take a raw glyph in an arbitrary
   value, so a `::before` disclosure triangle stays CSS.
6. **BEM `__` in an arbitrary variant.** `_` is Tailwind's space placeholder, so
   a double underscore cannot round-trip.

### The trap that actually bites

Deleting a **base** rule while keeping its variants. The class stays present in
the stylesheet, so `tests/unknownClasses.test.ts` stays green while the element
renders unstyled. It happened twice in `ConversationDrawer` — `.msg-bubble` and
`.msg-meta` both lost their padding — and was found only by diffing generated
CSS against the rules removed.

A guard for this was written and removed: page-namespaced conventions
(`.overview .ov-avatar`) and descendant-only rules (`.cmp-avg td`) are
structurally identical to the defect, so it needed an allowlist longer than its
findings. **`scripts/css-declares.mjs` is the check that works** — run it with
the declarations from every rule being deleted.

### The six remaining, measured

Density of that trap, not line count, is what predicts trouble:

| sheet | rules | duplicate selectors | variant carriers | base+context traps |
| --- | --- | --- | --- | --- |
| `overview.css` | 105 | 0 | 1 | **1** |
| `replies-inbox.css` | 100 | 0 | 7 | 11 |
| `chat.css` | 52 | 2 | 3 | 8 |
| `apollo-csv-import.css` | 42 | 5 | 3 | 6 |
| `layout.css` | 70 | 8 | 2 | 14 |
| `sequence-builder.css` | 289 | **30** | 4 | **54** |

**That ranking is wrong, and measuring it properly is the first thing to do.**
Trap density predicts where a conversion will silently break something. It does
not predict whether a rule can convert at all, and on that second question
`overview.css` is among the hardest, not the easiest: of its 112 rules only 42
are a mechanical `.overview .x { … }`. The other 70 include

* `.ov-plot .recharts-line-curve`, `.ov-plot .recharts-cartesian-grid line` —
  **DOM that Recharts generates.** There is no element to put a class on. This
  is a hard floor: overview.css can never reach zero lines.
* `.overview table`, `.overview th`, `.overview td`, `.overview tbody tr:hover`
  — page-scoped ELEMENT selectors, which is the whole reason the namespace
  exists. Converting them means classing every cell a `.map()` emits.
* `.ov-campaign-frame .ui-table th:nth-child(2)` and
  `.ui-identity__avatar` — reaching into `src/ui`'s internals from a route.
  That is a design smell worth fixing on its own terms, not by translation.
* `:has(.drp-pop:not([hidden]))` and the `[aria-sort] button::after` sort
  indicators — expressible as variants, but long ones.

So the right next step is to measure **convertible rules**, not line count or
trap count, for each of the six. The one-line check is: what fraction of a
sheet's selectors are a single class on a single element?

`sequence-builder.css` is in its own category: 30 selectors declared more than
once (later wins — `Pipeline` had four and one contradicted its own comment)
and 54 instances of the base+context trap. `ConversationDrawer` had eleven and
produced two regressions. Convert it with a rendered Sequence Builder open, not
from the stylesheet.

### Convertibility, measured

Fraction of each sheet's rules whose selector is a single class on a single
element — no descendant, no element selector, no pseudo, no attribute. That is
the share that converts to utilities mechanically.

| sheet | rules | convertible |
| --- | --- | --- |
| `layout.css` | 71 | **77%** |
| `chat.css` | 51 | 69% |
| `replies-inbox.css` | 108 | 68% |
| `apollo-csv-import.css` | 42 | 60% |
| `sequence-builder.css` | 287 | 50% |
| `overview.css` | 112 | **41%** |

This inverts the trap-density ranking above: `layout.css` is the best next
target and `overview.css` the worst.

**No sheet reaches 100%, and that is structural rather than unfinished work.**
Between a quarter and three-fifths of each of these files styles something a
utility cannot reach: DOM generated by Recharts, page-scoped element selectors
on tables a `.map()` emits, variant carriers, `@keyframes`, and another
module's BEM internals. "Every route on utilities" therefore has a ceiling
here, and the honest target is *the convertible fraction*, not zero CSS.

Two of those causes are worth fixing rather than translating:

* Routes reaching into `src/ui` internals (`.ui-table th:nth-child(2)`,
  `.ui-identity__avatar`) should become props on the primitive.
* Recharts styling belongs with `chartTheme.tsx`, not in a route sheet.

### `layout.css` is the app shell, and parity cannot verify it

It measured most convertible (77%) and it is the one I would convert last
without a browser. It is the sidebar — a mistake affects every route at once —
and it carries four breakpoint families:

| query | purpose |
| --- | --- |
| `min-width: 901px` | desktop |
| `min-width: 901px and max-height: 820px` | short desktop |
| `min-width: 901px and max-height: 700px` | **fires at 1280x720**, a stated acceptance target |
| `max-width: 900px` | mobile |

Twelve of its selectors have between two and five stacked declarations spread
across those, and several read as contradictions until the media context is
restored: `.side-mobile-close` is `display: none` twice at top level and
`inline-flex` under `max-width: 900px`; `.sidebar-inner` has three different
paddings.

**`scripts/css-parity.mjs` has a blind spot here.** It verifies a declaration
still exists *somewhere* in the built CSS. It does not verify which media query
it landed in. Put `padding-block: 10px 8px` behind `max-[900px]:` instead of
`max-h-[820px]:` and parity reports success while the sidebar renders wrong at
1280x720 — on every route simultaneously.

**Extending the tool to compare media context was attempted and abandoned.**
The approach — key each declaration by its normalised media condition — is
sound, and two obstacles compound past what a short fix handles:

1. Tailwind emits `max-[560px]:` as `not all and (min-width:560px)`. Those are
   the same authored intent but differ by a pixel in the spec, so any
   normalisation has to decide whether to adjust the bound. Adjusting it made
   *every* media declaration fail to match, which silently disabled the whole
   check while it still reported a total.
2. The declaration text changes too. `grid-cols-1` emits
   `grid-template-columns: repeat(1, minmax(0, 1fr))` where the original sheet
   said `1fr`. So a media-aware check cannot compare declarations literally —
   it has to normalise values as well as conditions, and every value rewrite
   Tailwind performs becomes a case to handle.

The second point is the real cost: the check needs a value-equivalence table,
not just a condition parser. That is worth building, but it is its own task
rather than a prerequisite bolted onto this one.

Until it exists, `layout.css` and the two `max-height: 720px` rules in
`replies-inbox.css` are done with the app open at 1280x720, 1440x900 and
1920x1080 — which is what docs/ui-standard.md already requires for geometry.
`scripts/css-parity.mjs` remains correct at the declaration level and has
caught two real errors (`.msg-bubble`'s padding, `.csv-map-row`'s column
proportions); it just cannot speak to placement.

### The four that remain all fail the same way

Each was categorised by a static reading of its CSS, and each turned out to
carry a property that reading could not see. That is the pattern, not bad luck:

| sheet | what the metric said | what it actually has |
| --- | --- | --- |
| `overview.css` | 1 trap — "cleanest" | 41% convertible; styles DOM **Recharts generates**, which has no element to class |
| `layout.css` | 77% convertible — "easiest" | the app shell, four breakpoint families, one firing at 1280x720 |
| `replies-inbox.css` | 68% convertible — "ordinary" | `container-type: inline-size` + `@container (max-width: 1239px)`, plus `@media (max-height: 720px)` |
| `sequence-builder.css` | 50% convertible | 30 stacked selectors, 54 base-rule traps |

**All four hinge on placement**, measured rather than assumed — which media or
container query each declaration lands in:

| sheet | placement dependency |
| --- | --- |
| `layout.css` | 12 stacked selectors across 4 breakpoint families |
| `sequence-builder.css` | **35 of its 40** stacked selectors span a media query, over 4 breakpoints |
| `overview.css` | 7 of 8 span `max-width: 1279px` or `forced-colors: active` |
| `replies-inbox.css` | `@container (max-width: 1239px)` plus `@media (max-height: 720px)` |

Two of those cannot be verified here by any means: `forced-colors: active` is
Windows High Contrast, and a container query is invisible to jsdom by the
repo's own earlier finding.

Placement is exactly what `scripts/css-parity.mjs` cannot check (see above).
The twenty sheets already converted were not like this — most had no media
query at all, and the few that did had one, below the PC-only target range.

So the remaining work is not "four more of the same". It is four files whose
correctness is only observable in a rendered browser at the three acceptance
viewports, which is what `docs/ui-standard.md` already requires of geometry and
what `vercel.json:38` currently prevents.

**Correction — these do not need a browser.** Placement is visible in the built
CSS: find the emitted `@media`/`@container` block and check the declaration is
inside it. What failed earlier was trying to build a *general* normaliser for
Tailwind's rewrites (`max-[560px]:` becomes `not all and (min-width:560px)`,
`grid-cols-1` becomes `repeat(1,minmax(0,1fr))`). Per-rule inspection needs no
normaliser, and there are only a handful of such rules per sheet:

| sheet | placement-sensitive rules to inspect |
| --- | --- |
| `replies-inbox.css` | 2 — and its container-query block is 6/7 variant carriers, so it stays as CSS anyway |
| `overview.css` | ~10 |
| `layout.css` | ~25 |
| `sequence-builder.css` | ~60 |

**The real constraint is care, not capability.** `replies-inbox.css` alone is
108 rules across five files. The two regressions in this migration —
`.msg-bubble` and `.msg-meta` losing their base rules — happened while
trimming a sheet quickly, and were invisible to every guard. These four are
larger and denser than that one.

So: convert them one sheet per session, with `css-parity.mjs` gating the
deletion and a direct read of each emitted media block. Not "with a browser
open" — with room to be careful.

### Before continuing

`vercel.json:38` redirects every `cipher-linkedin-dashboard.*.vercel.app` host
to `app.ciphercross.dev`, so preview deployments cannot be opened — the reason
everything so far went straight to production. Narrowing that pattern to the
production alias is one line and is what makes the remaining four verifiable.

## Risks & how to verify

| Risk | Verification |
| --- | --- |
| A mistyped Tailwind class ships silently | Unknown-utility guard, Phase 0; the repo has no other mechanism. **The guard itself is unproven** — Tailwind v4 arbitrary values and computed classes may make a naive diff too noisy to gate a build. Prove it in the Phase 0 spike before relying on it |
| Bulk-deleting "dead" CSS removes live rules | Per-selector review, Decision 8; the regex was already caught doing this |
| Unlayered CSS silently defeats utilities | Cascade guard, shown failing pre-fix; jsdom cannot see it |
| Omitting preflight breaks shadcn component assumptions | Gallery browser pass at Phase 0 exit; fallback in Decision 7 |
| `shadcn add` reintroduces `.dark` or raw colour literals | Build-failing check, Phase 0 |
| Base UI's `role="button"` breaks link semantics | Anchor-semantics test on `LinkButton`, Phase 1 |
| Contrast audit silently breaks | Token aliasing keeps audited values rendering; re-verified Phase 4 |
| Control geometry drifts from the 44px standard | Theme-level override, Phase 0; gallery measured each phase exit |
| Visual drift accumulates unnoticed across 21 routes | Gallery re-measured at every phase exit, not only at the end |
| Bundle grows | Baseline 1.81 MB JS / 204 KB CSS uncompressed. Budget: JS +10% max at Phase 4; CSS must **shrink** — 4,578 lines of legacy are leaving |
| `SequenceBuilder` blows up the schedule | Scheduled alone, last, after every idiom is settled |
| Parallel sessions collide | Phase 0 rewrites `vite.config.ts`, `tsconfig.json`, `main.tsx`. See open question 1 |
| `useDirtyGuard` breaks against Base UI Dialog close semantics | Only 2 call sites; both exercised by hand and by test in Phase 1 |

## Definition of done

- `frontend/src/styles.css` does not exist.
- No `.tsx` references any selector it defined; the machine check returns zero.
- All 13 primitives are shadcn-backed and exported from `src/ui` under their
  current names, minus `Drawer` and `RefreshingRegion`, which are deleted.
- The Phase 2 widget tier exists and its hand-rolled predecessors are gone.
- `npm run build`, `npm run test` and `npm run typecheck:api` all pass.
- Both guards pass, and the cascade guard has a recorded failing run against the
  unfixed state.
- Gallery measured in a browser at 1280×720, 1440×900 and 1920×1080; contrast
  ratios re-computed and written into `tokens.css`.
- `docs/ui-standard.md` describes the shipped system.
- Bundle within budget: JS ≤ +10% of 1.81 MB, CSS below 204 KB.

## Affected files/modules

**Rewritten:** all 13 modules in `frontend/src/ui/` · `ui/ui.css` ·
`ui/Gallery.tsx` · `docs/ui-standard.md`

**Deleted:** `frontend/src/styles.css` · `ui/Overlay.tsx`'s `Drawer` ·
`ui/States.tsx`'s `RefreshingRegion` · `components/DateRangePicker.tsx` ·
`components/QuickNavigation.tsx` (superseded by `Command`)

**Configuration:** `vite.config.ts` · `tsconfig.json` · `src/main.tsx` ·
`package.json` · new `components.json`

**Layered, not rewritten:** `styles/tokens.css` (gains the shadcn alias block) ·
`styles/reset.css` · `styles/base.css`

**Touched in Phase 3:** 80 of 99 `.tsx` files — every file carrying a legacy
class.

**Untouched by design:** `frontend/api/**` · `src/lib/leads.ts` ·
`src/lib/DataContext.tsx` data code · all 11 Recharts data paths ·
`@dnd-kit` usage.

## Open questions

1. **Does the uncommitted work land first?** The tree carries 12 modified and 6
   untracked files from the Overview comparison work, plus at least one edit
   made by another session while this spec was being written. Phase 0 rewrites
   `vite.config.ts`, `tsconfig.json` and `main.tsx`. Confirm the tree is
   committed and pushed, and that no other session is mid-flight, before Phase 0
   starts.
2. **Do the three route-local stylesheets survive?** `overview.css`,
   `replies-inbox.css` and `sentiment-analysis.css` total 1,045 lines and are
   not legacy by the standard's own definition. Decide in Phase 4 whether
   route-local CSS stays a legitimate pattern or everything becomes utilities.
3. **Does `secondary` map to shadcn's `outline` or its `secondary`?** A visual
   call against the current button, made once in Phase 1 and then applied to all
   50 call sites.
4. **Is the gallery still the acceptance surface?** shadcn documents every
   component's states itself. The gallery's remaining value is that it shows
   *our* compositions at *our* geometry — confirm that is worth 466 lines.
