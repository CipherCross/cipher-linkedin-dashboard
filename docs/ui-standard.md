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
| `frontend/src/styles/tokens.css` | Every colour, size, radius, space and duration. Nothing else may define one. |
| `frontend/src/styles/reset.css` | Document base, scrollbars, the one focus ring, `.skip-link`, `.sr-only`. |
| `frontend/src/styles/base.css` | `.page`, the three heading roles, `.muted` / `.small` / `.controls`. |
| `frontend/src/ui/` | Shared React primitives and their `ui.css`. |
| `frontend/src/styles.css` | **Legacy.** Route and component rules not yet migrated. It only shrinks. |
| route-local `.css` | Layout for one route. Colours, type and geometry come from tokens. |

Load order is fixed in `main.tsx`: tokens → reset → base → `ui.css` → legacy.

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
| `Dialog` / `Drawer` | Role and name, synchronous initial focus, focus trap, inert background, Escape, scroll lock, returned focus. A persistent pane is not a modal and must not use these. |
| `useDirtyGuard` | A clean form closes at once; a dirty one asks `Keep editing` / `Discard changes` — for Escape, Close, the backdrop and navigation alike. |
| `UpdatingNote` / `RefreshingRegion` / `InlineError` | Initial load, refresh, empty, and failure are four different things. |

## Layout

- Sidebar 232px, nav rows 44px.
- Page gutters 32px (24px below 1440), analytics max-width 1600px.
- List routes read title → context → toolbar → results. **The first result
  starts no lower than y=340 at 1280×720** with default filters; the gallery's
  "List chrome" composition is what that is measured on.
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

`vite dev` → `#/ui-gallery`. Every primitive in every state, plus four
compositions. It reads no API and writes nothing, and `import.meta.env.DEV`
drops it from production builds, so no production route exists.

## Checks

```bash
npm run build        # tsc -b && vite build — the only typecheck for src/
npm run test         # includes tests/uiPrimitives.test.tsx
npm run typecheck:api
```

`tests/uiPrimitives.test.tsx` pins behaviour, not appearance — jsdom applies no
stylesheet, so a CSS assertion there would pass while the page looked wrong.
Geometry and contrast are measured in a browser against the gallery.
