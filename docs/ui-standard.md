# UI standard

The dashboard has one visual system. This file is what it is; the reasoning and
the audit that produced it are in
`specs/2026-09-14-ui-cleanup-standardization.md`.

Three facts frame everything below:

- **One light theme.** There is no dark mode, no theme toggle and no
  `[data-theme]` selector. `index.html` paints light before the bundle loads.
- **PC only.** Targets are 1280×720, 1440×900 and 1920×1080. Narrow layouts are
  not designed for and not part of acceptance.
- **English only.** Every system string — labels, `aria-label`, placeholder,
  validation, toast, empty state — is English. User content (message bodies,
  campaign names, playbooks, people's names) is never translated.

## Where things live

| Path | What it holds |
| --- | --- |
| `frontend/src/index.css` | **The only CSS entry.** Declares the cascade layers and imports every stylesheet. Nothing else is imported from a component. |
| `frontend/src/styles/tokens.css` | Every colour, size, radius, space and duration. Nothing else may define one. |
| `frontend/src/styles/reset.css` | Document base, scrollbars, the one focus ring, `.skip-link`, `.sr-only`. |
| `frontend/src/styles/base.css` | `.page`, the three heading roles, `.muted` / `.small` / `.controls`. |
| `frontend/src/ui/` | Shared React primitives and their `ui.css`, which is also the app's shared component CSS. |
| `frontend/src/components/ui/` | shadcn components. Owned by `shadcn add`; edit deliberately, because the CLI rewrites them. |
| route-local `.css` | One sheet per route, beside its component, imported from `index.css`. |

`frontend/src/styles.css` is **gone**. It was 4578 lines; its routes took their
own sheets and its shared remainder went into `ui.css`.

## Cascade layers

Load order is expressed as **layers**, not import order:

```
@layer theme, base, foundation, app, utilities;
```

| Layer | Contents |
| --- | --- |
| `theme` | Tailwind's design tokens |
| `base` | Tailwind preflight |
| `foundation` | `tokens.css`, `reset.css`, `base.css` — outranks preflight |
| `app` | `ui/ui.css` **first**, then every route sheet |
| `utilities` | Tailwind utilities — win over everything above |

Two rules, both enforced by `tests/cssCascade.test.ts`, both learned the hard
way during the migration:

1. **Nothing may be unlayered.** Unlayered CSS outranks *every* layer
   regardless of specificity. Three route sheets were once imported straight
   from their components, which is how Vite injects them unlayered — every
   Tailwind utility on those routes silently lost.
2. **All app CSS shares one layer, `ui.css` first.** A layer beats specificity
   outright, so splitting `ui.css` and the route sheets across two layers
   inverts the cascade between them: every route rule defeats every primitive
   rule however specific. Measured when this was briefly wrong — it dropped the
   danger border off an invalid input, the grey fill off a disabled one, and
   collapsed a textarea from 120px to 66px.

## Tailwind and the token bridge

Tailwind v4 on Base UI. Utilities carry layout, spacing and colour; CSS carries
selector work that utilities express badly — sticky table columns, `color-mix()`
hovers, `:not(:last-child)::after` connectors.

`index.css` exposes `tokens.css` to Tailwind through `@theme inline`, so product
code writes `bg-app-accent` and `rounded-control` rather than
`bg-[var(--accent)]`. Every bridged entry **references** its token:
`.bg-app-accent{background-color:var(--accent)}`. Values are never copied, so
`tokens.css` stays the only definition site.

The `app-` prefix is deliberate. shadcn's components reference `bg-accent` and
`text-muted-foreground`, and those names are mapped to *its* palette — which is
in turn repointed at our tokens, so anything `shadcn add` writes inherits the
app's colours with no restyling. Where the two systems disagree on meaning, ours
keeps the plain name and shadcn's takes `sh-`: its `--accent` is a subtle hover
surface, ours is the brand blue; its `--muted` is a surface, ours is muted
*text*.

Preflight is kept rather than split out: the shadcn CLI detects Tailwind by the
literal `@import "tailwindcss"`, and the split form breaks `init` and every
`add`.

## Tokens

| Role | Value |
| --- | --- |
| Page background | `#F7F8FA`, uniform |
| Surface | `#FFFFFF`, opaque |
| Subtle surface | `#F2F4F7` — grouping, disabled, selected |
| Text: primary / secondary / muted | `#182230` / `#475467` / `#596579` |
| Accent / hover | `#2563EB` / `#1D4ED8`, white text on the filled variant |
| Separator / meaningful control border | `#D0D5DD` / `#7A8699` — the difference is deliberate |
| Success / warning / danger | `#067647` / `#92400E` / `#B42318` |
| Body and controls | 16/24, weight 400; labels and actions 500–600 |
| Table content / metadata | 14/20 / 13/18. **13px is a floor.** |
| Page title / section / subsection | 28/36 · 20/28 · 16/24, weight 600 |
| KPI | 32/40, weight 600, tabular numerals |
| Space scale | 4, 8, 12, 16, 24, 32, 48, 64 (1–2px only for borders and icon alignment) |
| Control height | 44px; icon button 44×44 around a 20px glyph |
| Table rows | 52px single line, 68px identity + secondary line |
| Radius | 8 controls · 12 cards · 16 dialogs; pill for badges and chips only |
| Elevation | Cards have **no** shadow. One soft shadow, and only on popup / dialog / drawer. |
| Focus | 2px solid accent outline, 2px offset. Never a translucent halo. |

Contrast is checked on the surfaces the colours are actually used on; the
computed ratios are in the header comment of `tokens.css`.

### What is not allowed

No decorative gradient, backdrop blur, glow, rim highlight, multi-layer shadow
or lift-on-hover on any app surface. Exceptions are functional and there are
exactly four:

1. charts and heatmaps — the colour is the data;
2. avatars and logos — they contain an image;
3. skeleton shimmer — it signals loading;
4. the LinkedIn message preview — it imitates an external surface, and the
   exception stops at its frame.

Surfaces nest **two levels deep at most**: page → section. A row or a KPI inside
a section does not also get its own border and shadow.

## Primitives

Import from `src/ui`. A primitive never knows about Neon, LH2 or a reply enum —
a domain adapter maps values to labels and variants.

| Primitive | Contract |
| --- | --- |
| `Button` / `LinkButton` / `IconButton` | `primary` · `secondary` · `ghost` · `danger`. An action is a `<button>`, a navigation is an `<a>`. `loading` disables and keeps the width. `IconButton` requires a `label`. |
| `PageHeader` | One `<h1>` per route, optional breadcrumb / description / context, one primary action. |
| `Panel` / `SectionHeader` | `surface` or `plain`; two heading levels, `section` and `subsection`. |
| `Field` and friends | Visible label, wired help and error ids, `aria-invalid`. An error is text with an icon, never colour alone. |
| `Tabs` / `SegmentedControl` | Tabs switch a section; segmented switches a mode or a period. One tab stop, arrow-key movement. |
| `Badge` / `StatusText` | Colour always travels with a word. |
| `AccountIdentity` + `disambiguate` | Name alone when unique, `name · account` when not. An unknown contact is `LinkedIn contact` plus an identifier — never a name invented from a slug. |
| `TableFrame` / `TableToolbar` / `Table` | Frame, toolbar, local scroll, sticky head. Sorting, paging and filtering stay with the screen. |
| `Toolbar` / `ActiveFilters` | Search plus one or two primary selectors on the page; everything else in a sheet. |
| `Dialog` | Role and name, initial focus, focus trap, background hidden from assistive technology, Escape, scroll lock, returned focus. A persistent pane is not a modal and must not use it. |
| `useDirtyGuard` | A clean form closes at once; a dirty one asks `Keep editing` / `Discard changes` — for Escape, Close, the backdrop and navigation alike. |
| `UpdatingNote` / `InlineError` | Initial load, refresh, empty, and failure are four different things. |

`Button`, `IconButton` and `Dialog` are Base UI underneath. `LinkButton` and
`ExternalLinkButton` deliberately are **not**: Base UI's `useButton` applies
`role="button"` to any non-native element, which would relabel every in-app
navigation as a button for assistive technology.

`Drawer` and `RefreshingRegion` are still implemented and exported, but the
current route tree has zero consumers for either one. They remain pending
Phase 1 contract cleanup; this document must not describe them as removed until
that phase deletes the exports and the scan proves the same zero-consumer state.
The product `ConversationDrawer` is a separate, currently used modal surface
and is not evidence that the unused `Drawer` primitive has a consumer.

Base UI queues a dialog's initial focus through `requestAnimationFrame`, so one
opened while the tab is hidden receives focus late; it still lands when the tab
is shown, and a hidden tab cannot be typed into meanwhile.

## The widget tier

`src/components/ui/`, written by `shadcn add` and themed through the token
bridge — nothing here is restyled by hand. Demonstrated on `#/ui-gallery` →
**Widgets**.

| Component | Use |
| --- | --- |
| `Popover` / `Tooltip` / `DropdownMenu` | Anchored, collision-aware, dismissed on Escape and outside press. Never hand-roll an outside-click listener again. |
| `Command` | Type-ahead over a list. Backs Quick Navigation. |
| `Combobox` | A select with search. |
| `Calendar` | `react-day-picker`. Backs `DateRangePicker`. |
| `Sonner` | Toasts, behind `useToast`. An error stays until dismissed; everything else fades after 5s. |

Adding one: `npx shadcn@latest add <name>`. It will re-add a `.dark` block and
`next-themes`; the guards fail the build on the first and the second is not
wanted. One light theme, still.

## Layout

- Sidebar 232px, nav rows 44px.
- Page gutters are 24px below 1440px and 32px at 1440px and wider; analytics
  max-width is 1600px.
- List routes read title → context → toolbar → results. **The first result
  starts no lower than y=340 at 1280×720** with default filters. This is measured
  on the real routed list surface; the Gallery's "List chrome" composition is a
  reference for the anatomy and cannot prove the route-level position.
- Filters open **over** the page. They never take height from the results.
- A wide table or board scrolls inside its own region, with a written hint. It
  is never shrunk until its text is unreadable.

## Dates

`en-GB`, explicitly. Operational business times render in Europe/Madrid and
carry a visible `Madrid` marker (`14 Sep, 13:20 · Madrid`). Analytical interval
slices render in UTC and say `UTC`, because that is what the views slice on. A
relative time always has its absolute value within reach. The UTC data contract
itself is unchanged. See `src/ui/datetime.ts`.

## The gallery

`vite dev` → `#/ui-gallery`. Four tabs: **Primitives** (every primitive in
every state), **Compositions** (four stand-ins for the hardest real screens),
**List chrome**, and **Widgets** (the shadcn tier, which is how its theming is
verified). It reads no API and writes nothing.

`import.meta.env.DEV` gates the route, so it never renders in production —
though it is still built as a lazy chunk, which is why bundle measurements
must exclude it. Counting it overstates the app's JavaScript by ~80 KB
gzipped that no user downloads.

Geometry and contrast are measured here, in a browser. Two things the migration
proved jsdom cannot see: a cascade-layer defect, and anything Base UI schedules
through `requestAnimationFrame` — which includes dialog focus and the scroll
lock.

## Checks

```bash
npm run build        # tsc -b && vite build — the only typecheck for src/
npm run test         # includes the two guards below
npm run typecheck:api
```

`tests/uiPrimitives.test.tsx` pins behaviour, not appearance — jsdom applies no
stylesheet, so a CSS assertion there would pass while the page looked wrong.
Geometry and contrast are measured in a browser against the gallery.

Two guards exist because `tsc -b` is the only automated check over `src/` and
there is no linter:

- **`tests/cssCascade.test.ts`** — layer order, no unlayered sheet anywhere in
  `src/`, no component-level `import './x.css'`, no token capture by shadcn, no
  dark block, no translucent focus halo, and `styles.css` still gone. Every
  assertion is mutation-tested: each defect is re-introduced and caught by its
  own assertion.
- **`tests/unknownClasses.test.ts`** — walks the TypeScript AST for literal
  `className` tokens and diffs them against the built CSS, so a mistyped
  utility fails the build. A regex version was 80% false positives. Its
  allowlist of pre-existing dead class names is a **ratchet**: it may only
  shrink.

Two habits the migration earned:

- A grep that comes back empty against generated CSS is more often the pattern
  than the output. The minifier reorders `animation` shorthand, rewrites
  `flex: 2 1 420px` to `flex: 2 420px`, and escapes bracket selectors. Parse
  rule blocks instead.
- Tests here have twice used a styling class as a selector handle
  (`.avatar.fallback`, `.deployed-step-label`), so deleting the rule broke the
  test rather than the app. Prefer a `data-*` handle over restoring the class.
