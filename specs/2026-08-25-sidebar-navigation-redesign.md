# Sidebar navigation redesign

## Goal

Replace the overloaded left panel with a small, stable navigation surface that is easy to scan and predictable at every viewport size. The sidebar should expose the product's most-used workflows, move lower-frequency destinations into clearly named secondary groups, and provide fast search for everything else without permanently rendering accounts or campaigns.

## Non-goals

- Removing account or campaign detail routes, data, or deep-link support.
- Redesigning the content or workflows inside individual pages.
- Adding favorites, pinned shortcuts, user-defined ordering, or navigation analytics in this iteration.
- Changing role permissions or treating hidden navigation as authorization.
- Redesigning the wider application shell beyond the navigation, mobile header, and controls needed to open or close it.

## Research findings

- The current sidebar combines 13 page destinations, a nested account/campaign browser, data freshness, theme controls, member identity, and sign-out in one 264px column. This creates competing hierarchies and multiple vertical scrolling regions.
- Overview is the landing page and brand destination but is currently buried inside a collapsible secondary section.
- The icon-only desktop rail exposes many equally weighted icons, depends on tooltips for recognition, and removes account/campaign access, so it is not functionally equivalent to the expanded state.
- The account tree has already needed special short-window safeguards. Removing it eliminates the main source of vertical pressure instead of continuing to compress the remaining navigation.
- Mobile currently reuses the desktop drawer but hides the footer, including identity and sign-out, and lacks complete drawer focus management.
- The code already provides useful primitives to preserve: labelled navigation regions, active states, disclosure buttons, Lucide icons, theme tokens, a skip link, reduced-motion behavior, role-aware CSV Import visibility, and route-aware page naming.
- Fluent navigation guidance favors brief, plain, goal-oriented labels and no more than two hierarchy levels. WAI guidance supports disclosure buttons with `aria-expanded` and requires clear current-page, focus-order, and non-color-only status cues.
- Navigation is configured separately from route registration today. The redesign should move toward one canonical metadata registry so labels, grouping, permissions, titles, quick search, and route matching cannot drift apart.

## Decisions

- **Accounts and campaigns:** Remove the entire “Accounts & campaigns” tree, its count, search field, freshness dots, nested campaign rows, and reserved scrolling workspace from the left menu. Account and campaign routes remain available through deep links and quick search.
- **Primary destinations:** Keep five always-visible destinations in this order: Overview, Follow-ups, Pipeline, Leads, and Chat.
- **Secondary destinations:** Group Review, Playbook, Searches, ICPs, and Hypotheses under a compact collapsible “Strategy” section.
- **System destinations:** Keep Team, CSV Import, and Health in a lower-frequency “Administration” section near the bottom. CSV Import remains admin-only in navigation and route authorization.
- **Collapsed behavior:** Remove the persisted 68px icon-only mode. Replace it with a simple show/hide control on desktop; reopening always restores the fully labelled sidebar.
- **Fast access:** Add a single keyboard- and button-accessible quick navigation dialog that searches pages, accounts, and campaigns. Do not add pinned or customizable shortcuts in the first iteration.
- **Mobile:** Use the same hierarchy in an off-canvas drawer, with an explicit close control, Escape handling, focus moved into the drawer on open, background interaction disabled, and focus returned to the trigger on close.

## Approach

Create one navigation registry containing route, label, icon, group, ordering, route-match behavior, and permission metadata for every navigable page. Use it to render the sidebar, resolve document titles, populate quick navigation, and retain the existing route-specific loading behavior without duplicating labels or access rules.

The desktop sidebar becomes a stable three-part layout:

1. Brand and hide control.
2. Five primary workflows followed by the compact Strategy disclosure.
3. Administration, member identity, theme, freshness, and sign-out anchored at the bottom.

The removed account/campaign area is replaced by a single “Go to…” action near the top of the sidebar. It opens a dialog with type-ahead search, keyboard traversal, grouped results, clear result types, and recent-query-free behavior. Selecting an account or campaign navigates to the existing detail route; the dialog does not become another persistent entity browser.

When the sidebar is hidden on desktop, content uses the full width and a small persistent header control restores navigation. Mobile keeps its current drawer model but receives complete focus and dismissal behavior. Active destinations remain visible when their section is closed by marking the section trigger and automatically opening it on route navigation.

## Implementation phases

1. **Canonical navigation model — M.** Extract page metadata into a shared registry and use it for sidebar groups, page titles, route matching, permissions, and loading variants. Preserve all existing routes and direct-route authorization.
2. **Desktop information architecture — M.** Remove the account/campaign tree and collapsed icon rail, reorder primary destinations, rename and reposition secondary groups, add desktop hide/restore behavior, and simplify the footer.
3. **Quick navigation — M.** Add the “Go to…” trigger and accessible search dialog for pages, accounts, and campaigns, including keyboard traversal, empty states, result-type labels, and existing encoded detail routes.
4. **Mobile and accessibility completion — M.** Apply the same hierarchy to mobile; add an in-drawer close control, Escape dismissal, focus transfer/return, inert background behavior, semantic main content, and current-page signaling.
5. **Regression and visual verification — M.** Add focused navigation tests and verify expanded, hidden, short-height, mobile, keyboard-only, reduced-motion, long-label, admin, non-admin, active-detail, and empty-data states in an authenticated production-shaped preview.

## Affected files/modules

- `frontend/src/components/Layout.tsx` — sidebar shell, desktop/mobile controls, footer, and removal of the account tree.
- `frontend/src/styles.css` — simplified sidebar layout, hidden state, quick-navigation styles, mobile drawer behavior, focus states, and responsive checks.
- `frontend/src/App.tsx` — consume shared navigation metadata while preserving route registration and direct-route guards.
- `frontend/src/lib/navigation.ts` — new canonical navigation registry, matching helpers, permission metadata, and searchable destination types.
- `frontend/src/components/QuickNavigation.tsx` — new searchable navigation dialog.
- `frontend/tests/` — new navigation registry, permissions, matching, quick-search, and keyboard behavior coverage.

## Risks & how to verify

- **Users lose a route they still need:** retain every existing account/campaign route and verify direct links plus quick-search navigation for encoded IDs.
- **Navigation visibility is mistaken for authorization:** keep `AdminOnly` and server-side checks intact; test CSV Import as both admin and non-admin through menu and direct URL.
- **Registry extraction changes titles or skeletons:** add table-driven tests mapping every registered route to its label, group, match behavior, and loading variant.
- **Hidden sidebar becomes undiscoverable:** keep a persistent, clearly labelled restore control and verify it by mouse and keyboard at desktop breakpoints.
- **Quick search performs poorly with many campaigns:** normalize a lightweight in-memory index from already-loaded bootstrap account/campaign metadata and measure interaction with production-shaped counts.
- **Mobile drawer traps or loses focus:** test open, Tab/Shift+Tab, Escape, backdrop dismissal, route selection, and focus return; confirm closed content is not keyboard-reachable.
- **The visual redesign is only source-verified:** run an authenticated visual pass at wide desktop, short desktop, tablet, and phone sizes before deployment.

## Definition of done

- The left sidebar contains no account or campaign tree, filter, count, freshness dot, or nested entity row.
- Overview, Follow-ups, Pipeline, Leads, and Chat are always visible and appear in the agreed order.
- Strategy and Administration are visually secondary, correctly grouped, and reveal the active destination.
- The icon-only rail and its persisted state are removed; desktop navigation can be hidden and reliably restored.
- “Go to…” finds and opens every permitted page plus existing accounts and campaigns using keyboard or pointer input.
- Admin-only visibility and direct-route authorization remain correct.
- Mobile navigation has explicit close, Escape, focus containment, background inertness, and focus return behavior.
- Route labels, titles, matching, quick-search entries, and loading variants derive from one tested metadata source.
- Relevant frontend tests and `npm run build` pass.
- Authenticated visual verification passes across the agreed desktop and mobile states without horizontal clipping, hidden active destinations, or competing sidebar scroll regions.
