# UI/UX Redesign Plan

Goal: make the dashboard feel like a designed product rather than a bootstrapped
internal tool — without touching data semantics, metric logic (`src/lib/leads.ts`),
or the API layer. Everything below is frontend-only (`frontend/src` + `index.html`).

This plan is based on a code audit of all pages/components plus a visual
walkthrough of the running app (Overview, Leads, Replies, Playbook, Health, Chat,
Campaign detail, Account detail, Conversation drawer) with live data.

---

## 1. Current-state assessment

### What already works (keep)
- **Information density and IA are good.** Six clear sections; drill-down paths
  (account → campaign → lead → conversation) make sense. The redesign is about
  *finish*, not restructuring navigation.
- Dark analytics aesthetic fits the ops-dashboard use case.
- The funnel/cohort mental model is communicated well (footnotes like
  "Recent weeks are still maturing" are genuinely good UX writing).
- Fast: one data fetch, client-side filtering; no perceived slowness to fix.

### What makes it feel bootstrapped (observed)

**Identity & chrome**
- No favicon, no `public/` dir at all; tab shows the default Vite globe. Title is
  generic "LinkedIn Campaign Dashboard". Brand is plain bold text "LinkedIn Campaigns".
- System font stack, one weight ramp; `h1` 22px / `h2` 15px is the entire type scale.
- Icons are ad-hoc emoji/unicode: 📣 briefing, ★ hot leads, 🗓/▾ in the date picker,
  `←`/`→` arrows in pager and links. Reads as prototype.

**Visual system**
- Only 6 design tokens (`--bg/--panel/--border/--text/--muted/--accent`); every
  other color is hard-coded inline (`#1a2236`, `#1d2538`, `#234072`, `#34c98e`,
  `#f7b94f`, `#f76a5c`, `#b98cf0`…) — ~15 unnamed colors scattered through
  `styles.css`. No spacing/radius/shadow scale; values drift (radius 4/5/6/7/8/9/10/12px).
- Panels (`--panel #141a2b`) barely separate from background (`#0c1220`); no
  elevation system, so everything sits on one flat plane.
- Charts are Recharts defaults: harsh grid lines, unstyled tooltips (white box on
  the campaign activity chart), axis labels like `04-27`, duplicated legend styles
  per chart. The "Leads added per day" card renders a fully empty axes grid when
  the range has no data.

**States & feedback**
- App-level loading is a single centered "Loading…" string (`Layout.tsx:36`).
- Empty states are bare one-liners: "No messages in this thread.",
  "No instances registered yet.", "no activity in range".
- Write actions (save playbook, save config, import conversation, refresh
  briefing) report status via inline text swaps; no toasts, no optimistic
  feedback, no confirmation affordances.
- No error boundary: a render error white-screens the app.

**Tables & data display**
- Leads table: ISO dates wrap into two lines (`2026-` / `06-25`) in narrow
  columns; 5 date columns of mostly `—`; no sticky header on a 50-row page;
  rows are clickable but only via mouse (no keyboard/focus affordance).
- Health table: raw seconds/row counts fine, but errors truncate with no way to
  expand other than a `title` tooltip.
- Number columns are right-aligned (good) but date/label formatting is
  inconsistent across pages (`ago()` here, ISO there, `toLocaleDateString` elsewhere).

**Page-specific rough edges**
- **Overview** is a very long single column: briefing (large, Ukrainian) → KPI
  row → hot leads (10 full-width quote rows) → collapsed replies panel → account
  cards. First screen is entirely briefing; the KPIs the page exists for are
  below the fold.
- **Campaign detail**: the per-step funnel renders all ~18 LH2 steps (waiters,
  webhooks, endorse-skills) as identical full-width bars — a wall of blue. The
  interesting steps (invite/messages) drown in plumbing.
- **Replies**: sentiment filter chips are plain badges with no count-per-class;
  the digest card and classify button sit above with unclear hierarchy.
- **Chat**: empty state is four grey suggestion pills floating in a huge empty
  card; input is a bare text field; no context about what the copilot can do.
- **Playbook**: raw monospace `<textarea>` as the primary surface; Preview is a
  toggle instead of side-by-side.
- **Conversation drawer**: header cramps three rows of metadata; "no classified
  reply" status text reads like debug output; AI coach panel is a flat grey block.

**Interaction & a11y**
- Focus styles: only `.chat-input` defines one; everything else relies on
  (mostly removed) browser defaults. Keyboard users can't operate row-click
  tables or the drawer.
- Only two animations exist (drawer fade/slide); buttons/cards have no hover
  transitions, active-nav has no affordance beyond a subtle bg change.
- `--muted #7c89a8` on `--panel` passes AA for large text only; 11–12px muted
  text is used heavily (KPI labels, table headers, timestamps).
- Mobile: grids collapse at 860/700/480px but tables overflow with no
  horizontal-scroll wrapper; topnav wraps into two ragged lines.

---

## 2. Design direction

Keep the **dark-first, data-dense ops console** character — don't chase a
marketing-site look. The reference feel is Linear/Vercel dashboard: quiet
surfaces, one accent, crisp tabular numerals, purposeful color reserved for
status and data.

**Stack decision: stay on plain CSS.** 796 lines of CSS is small enough that a
token refactor is cheaper and safer than a Tailwind/CSS-modules migration (no
build changes, no class-name churn in 25 components). Two small additions:

| Add | Why |
|---|---|
| `lucide-react` | Replaces emoji/unicode glyphs; tree-shakable, ~1KB per icon |
| `@fontsource-variable/inter` | Product-grade UI font, self-hosted (no external request); enables real weight ramp + `font-feature-settings: 'tnum'` |

No other dependencies. Recharts stays (restyled through shared defaults).
Dark-only remains for now; the token layer below makes a future light theme a
one-block addition, not a rewrite.

---

## 3. Phases

Ordered so each phase ships independently and `npm run build` (the only gate —
no tests/linter in this repo) passes after each.

### Phase 1 — Design tokens & primitives (foundation, do first)
`src/styles.css` (rewrite top section), `src/main.tsx` (font import).

1. **Token layer** replacing all hard-coded colors:
   - Neutrals: `--bg`, `--surface-1` (cards), `--surface-2` (nested: inputs,
     tracks, code), `--surface-3` (hover), `--border`, `--border-strong`.
     Slightly increase card/bg separation and add a subtle card shadow token.
   - Text: `--text`, `--text-secondary`, `--text-muted` (bump muted contrast to
     AA for the 12px uses).
   - Accent ramp: `--accent`, `--accent-hover`, `--accent-subtle` (10–15% bg for
     active nav/chips), `--on-accent`.
   - Status (used by badges, dots, funnel, sentiment): `--success`, `--warning`,
     `--danger`, `--info`, `--purple`, each with a `-subtle` bg variant. Map the
     existing sentiment classes (pos/obj/neu/ref/neg/auto) onto these.
   - Scales: `--radius-sm/md/lg` (6/10/14), `--space-1..8` (4px base),
     `--shadow-sm/md/lg`, `--font-sans`, `--font-mono`.
2. **Typography**: Inter variable; type scale (12/13/14/16/20/28); `h1` 20px
   semibold with tighter letter-spacing; `tnum` on all numeric cells/KPIs
   (replaces scattered `font-variant-numeric`).
3. **Primitives pass** (still in CSS, same class names so no component churn):
   unified `.btn` (default/accent/ghost + sizes), inputs/selects with shared
   focus ring (`:focus-visible` outline token), `.badge` unified with subtle-bg
   style instead of border-only, `.card` with consistent padding/radius/shadow.
4. **Global focus-visible style** and `prefers-reduced-motion` guard for the
   transitions added later.

Acceptance: zero raw hex values outside the `:root` block; every page visually
intact but tighter.

### Phase 2 — App shell & identity
`Layout.tsx`, `index.html`, new `public/`.

1. Sticky translucent header (backdrop-blur) with: logo mark + product name,
   nav links with icons (lucide: `LayoutDashboard`, `Users`, `MessageSquare`,
   `BookOpen`, `Activity`, `Sparkles`), active state = accent-subtle pill.
   Collapse to icon-only on <700px instead of wrapping.
2. Global sync-status chip in the header (worst-case instance freshness — data
   already in `DataContext`); links to Health. This surfaces the #1 operational
   question (is data fresh?) everywhere.
3. Identity: pick a product name (working suggestion: **Outreach Deck** — decide
   with the team), favicon + touch icon in `public/`, `<title>`, meta
   `theme-color`, proper `lang`.
4. Replace "Loading…" with a branded splash (logo + skeleton shell) and add a
   top-level React error boundary with a retry screen.

### Phase 3 — Data-display components (shared, high leverage)
`KpiCards.tsx`, `CampaignTable.tsx`, `Funnel.tsx`, chart components, new `src/lib/format.ts`.

1. **`format.ts`**: single source for dates (`Jun 25`, `Jun 25 '26` cross-year),
   relative times (existing `ago()` moves here), numbers, percents. Sweep all
   pages to use it — kills the ISO-wrap problem in tables.
2. **KPI cards**: label + icon row, larger value with `tnum`, sub-metric as a
   quiet second line; add per-KPI sparkline (component exists) and a
   range-over-range delta chip (`↑ 12%` vs previous equal-length period —
   computable from `rangeTotals` with a shifted range; **cohort caveat**: label
   deltas for replies as "maturing" per `CLAUDE.md` funnel guidance).
3. **Tables**: shared styles — sticky `thead` inside `.table-scroll`, row
   hover, focusable rows (`tabIndex=0`, Enter opens drawer), consistent
   alignment, `—` dimmed. Column tuning per page in Phase 4.
4. **Charts** (follow the dataviz skill when implementing): shared Recharts
   theme module — grid at 6% white, axis text `--text-muted` 11px, styled dark
   tooltip (currently white-on-white on campaign activity), consistent series
   colors from the status/accent ramp, formatted date ticks from `format.ts`.
   Empty-range guard: render a proper empty state instead of blank axes
   ("No leads added in this range").
5. **Funnel**: color stages by status ramp end-to-end (lead→invite→accept→reply),
   show conversion % between bars as connecting labels rather than a right-hand
   column of small grey text.

### Phase 4 — Page-level UX
One PR per page; order by usage.

- **Overview** (`pages/Overview.tsx`, `BriefingCard.tsx`, `HotLeads.tsx`):
  - KPI row first, briefing second as a **collapsed-by-default digest**: headline +
    top action visible, expand for the rest. (Briefing content stays Ukrainian —
    by design.)
  - Hot leads: cap at 5 with avatar, name/title on one line, quote clamped to 2
    lines, sentiment chip aligned; "View all" → Replies with the positive filter
    pre-applied (it already supports URL state).
  - Account cards: turn the whole card header into the link to the account page
    (today only campaign names link); align the 5-stat row on a baseline grid.
- **Campaign detail** (`pages/CampaignDetail.tsx`, `MessageSequence.tsx`):
  - Sequence: visually de-emphasize plumbing steps (waiters/webhooks/visits) —
    render them as thin connector rows between full **message/invite step cards**;
    or group consecutive non-message steps into a single "+3 automation steps"
    collapsible. Keeps the reply-rate story readable.
  - Keep KPI row/funnel/cohorts layout (it's good); apply Phase 3 chart theme.
- **Leads** (`pages/LeadsExplorer.tsx`): filter bar → labeled controls with an
  active-filter chip row + "Clear all"; drop `Added` (deploy-pending per memory
  notes, mostly `—` today) into an optional column toggle; stage badges get the
  status ramp; date columns via `format.ts`; result count + Export CSV move into
  the table header row.
- **Replies** (`pages/Replies.tsx`): sentiment filter → segmented control with
  counts ("Positive 37 · Objection 4 …"); reply rows get avatars; classify
  button becomes icon-button with spinner state; digest card gets the Phase 3
  card treatment.
- **Health** (`pages/Health.tsx`): instance panel first on mobile; error cell
  expands on click; add per-instance uptime strip (last N runs as colored
  ticks — data already in `syncRuns`).
- **Chat** (`pages/Chat.tsx`): centered empty state with icon + one-line
  capability blurb + suggestion cards (2×2 grid); auto-growing textarea, send on
  Enter (Shift+Enter newline), stop button while streaming; tool-call blocks get
  icon + tinted left border instead of full grey boxes.
- **Playbook** (`pages/Playbook.tsx`): two-pane edit/preview on wide screens
  (toggle stays on mobile); unsaved-changes indicator on the Save button.
- **Conversation drawer** (`ConversationDrawer.tsx`, `ImportHistoryPanel.tsx`):
  header → avatar + name + LinkedIn link on one row, campaign/account + status
  chips on a second; Esc-to-close + focus trap + `role="dialog"`; message
  timestamps grouped by day separators; AI coach panel collapsed to a single
  action row until expanded; import flow gets numbered step header
  (Paste → Review → Import) and a success toast.

### Phase 5 — States, feedback, motion
Cross-cutting, after 3–4.

1. **Skeletons** for cards/tables/charts during initial load (shell renders
   immediately after Phase 2 splash).
2. **Empty states**: small icon + one sentence + next action (e.g. Leads
   no-match → "Clear filters" button; no instances → link to sync-agent README).
3. **Toast system** (single tiny context, no dependency) for: playbook saved,
   config saved, import success/failure, briefing refresh, classify done.
4. **Motion**: 120–160ms ease-out on hover/active for buttons, cards, rows,
   nav; number tween on KPI values is optional polish; everything behind
   `prefers-reduced-motion`.

### Phase 6 — Responsive & accessibility sweep
1. Breakpoint audit at 1280/1024/768/390: tables get `overflow-x` wrappers with
   edge fade; Leads table drops to essential columns on mobile; drawer already
   goes full-width (keep).
2. A11y: aria-labels on icon buttons, `aria-current` on nav, contrast re-check
   of every `-subtle` pairing, keyboard path through: nav → filters → table row →
   drawer → close.
3. Final `npm run build` + visual pass across all 8 routes at 3 widths.

---

## 4. Explicit non-goals / guardrails

- **No auth work** — known deferred item, tracked separately (do not flag).
- **No metric/funnel logic changes** — `leads.ts`, SQL views, and agent
  `derive_events` stay untouched; this plan only consumes them.
- **No router change** — HashRouter URLs (`/#/leads`) are ugly but switching to
  BrowserRouter needs a `vercel.json` rewrite + re-testing shared links; not
  worth bundling into a visual redesign. Optional follow-up.
- **No fetch-layer changes** — the inbound-full/outbound-90d asymmetry in
  `DataContext` is deliberate.
- Briefing/coach content language (Ukrainian) is by design.

## 5. Sequencing & effort (rough)

| Phase | Scope | Est. |
|---|---|---|
| 1 | Tokens, type, primitives | 1 day |
| 2 | Shell, identity, error boundary | 0.5–1 day |
| 3 | Format lib, KPI, tables, chart theme, funnel | 1–1.5 days |
| 4 | Eight page passes | 2–3 days |
| 5 | Skeletons, empty states, toasts, motion | 1 day |
| 6 | Responsive + a11y sweep | 0.5–1 day |

Phases 1–2 alone remove most of the "bootstrapped" impression; 3–4 are where it
starts feeling like a product; 5–6 make it feel finished.

## 6. Verification

After each phase: `cd frontend && npm run build` (tsc is the only type gate —
note it does not cover `frontend/api`, which this plan doesn't touch), then a
visual pass with `npm run dev` across Overview, Leads (+drawer), Replies,
Playbook, Health, Chat, one campaign page, one account page at desktop and
~390px width.
