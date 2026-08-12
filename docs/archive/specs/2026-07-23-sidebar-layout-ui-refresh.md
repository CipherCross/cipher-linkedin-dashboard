# Sidebar layout and UI refresh

## Goal
Refine the desktop sidebar into a clearer, calmer navigation surface that makes daily SDR work easier to find while preserving every existing route and the account-to-campaign drill-down. Improve hierarchy, spacing, active states, collapsed-mode clarity, and account scanning without changing the dashboard's restrained operations-console character.

## Non-goals
- Reworking the mobile drawer or other mobile navigation behavior.
- Adding, removing, or renaming application routes.
- Replacing the account/campaign tree with a new switcher or search experience.
- Changing campaign, lead, funnel, or sync data behavior.
- Performing a broader redesign of page content outside the application shell.

## Research findings
- `frontend/src/components/Layout.tsx` owns the full application shell, including 12 fixed links, the account/campaign tree, desktop collapse state, theme control, and sync-health status.
- The desktop sidebar is currently 264px wide and collapses to a persisted 68px icon rail. `--sidebar-w` is also used by the Pipeline page's full-bleed layout, so the width contract must remain stable or be updated consistently.
- Fixed links are rendered from a shared `LINKS` collection and use React Router `NavLink`, which already provides `aria-current="page"` for the active route.
- Styling is centralized in plain CSS and uses established color, type, spacing, focus, reduced-motion, light-theme, and dark-theme conventions.
- The current information architecture and account-to-campaign drill-down are useful; the main opportunity is visual hierarchy and interaction finish rather than route restructuring.
- The account/campaign region scrolls independently, active accounts auto-expand, campaigns sort by name, and account filtering appears only when there are more than three accounts.
- Current desktop accessibility weaknesses include small account disclosure targets, disclosure labels that omit account names, active styling that relies heavily on color, collapsed links that depend on native `title` tooltips, and unguarded `localStorage` access.
- Repository verification for TypeScript UI work is `npm run build`, followed by manual desktop visual and keyboard checks; there are no sidebar-specific automated tests.
- Established navigation guidance favors short stable labels, a visibly distinct current page, native links and buttons, visible focus, sufficiently large targets, and hierarchy communicated by more than color alone.

## Decisions
- Scope: visual polish is the primary goal, with hierarchy changes allowed when they improve scanning and prioritization.
- Priority: daily SDR tools—Follow-ups, Pipeline, and Leads—should be more prominent than manager and strategy views.
- Accounts and campaigns: retain and improve the existing tree directly in the sidebar.
- Interaction: retain the collapsible desktop sidebar; mobile work is explicitly out of scope.
- Visual direction: keep the quiet dark/light operations-console aesthetic, refined with stronger hierarchy and finish.

## Approach
Organize the fixed routes into a small number of visually labeled desktop sections while keeping route names, URLs, and underlying navigation behavior unchanged. Place daily execution destinations first, followed by insight/strategy and system/administration destinations, using restrained section labels and spacing rather than large decorative treatments.

Refine the expanded sidebar as a coherent vertical layout: a more deliberate brand/header area, consistently sized navigation rows, a stronger non-color-only active marker, and a clearer transition into the account/campaign workspace. Give the account tree more legible indentation, disclosure targets, selection states, and freshness cues while preserving its current data, sorting, filtering, and expansion rules.

Treat collapsed mode as a first-class icon rail. Preserve recognizable icons, clear active/focus indicators, and accessible labels while removing dependence on browser-native `title` behavior. Keep controls aligned to a consistent rail grid and ensure the transition between expanded and collapsed states does not shift page content unexpectedly.

Keep the existing sidebar width contract unless visual testing shows a small width adjustment is necessary; if it changes, update every `--sidebar-w` consumer together. Harden desktop collapse persistence so unavailable browser storage cannot break the shell. Do not alter mobile markup or behavior except where shared desktop changes must be safely neutralized by existing responsive styles.

## Implementation phases
1. **Navigation hierarchy and structure — S**
   - Group existing links into execution, insights/strategy, and system sections.
   - Preserve all routes, labels, icons, active matching, and document-title behavior.
   - Add semantic labels/list structure where useful without introducing ARIA menu behavior.

2. **Expanded desktop visual polish — M**
   - Refine brand/header geometry, section spacing, row density, typography, hover/focus states, and the active-page treatment.
   - Create a clearer visual boundary and heading for the account/campaign workspace.
   - Keep dark and light themes visually equivalent and consistent with existing tokens.

3. **Account and campaign tree refinement — M**
   - Enlarge disclosure targets and include account names in accessible labels.
   - Improve indentation, active states, truncated-name handling, freshness/status communication, and filtering presentation.
   - Preserve account ordering, campaign sorting, auto-expansion, and route behavior.

4. **Collapsed rail and resilience — M**
   - Align icons and utility controls to a consistent compact grid.
   - Provide accessible, keyboard-visible labels or tooltips that do not rely solely on `title`.
   - Strengthen collapsed active/focus states and guard collapse-state storage access.

5. **Desktop verification and finish — S**
   - Build the frontend and resolve TypeScript or production-build regressions.
   - Visually inspect expanded and collapsed states at representative desktop widths in both themes.
   - Keyboard-check every navigation, disclosure, filter, collapse, theme, and status control.
   - Confirm Pipeline full-bleed positioning and page-content alignment remain correct.

## Affected files/modules
- `frontend/src/components/Layout.tsx` — navigation grouping, sidebar semantics, account tree controls, collapsed-mode labeling, and collapse persistence.
- `frontend/src/styles.css` — sidebar layout, visual hierarchy, expanded/collapsed states, account tree, theme variants, focus/hover/active states, and responsive safeguards.
- `frontend/src/App.tsx` — expected to remain unchanged; inspect only to verify route coverage against the regrouped navigation.
- `frontend/src/pages/Pipeline.tsx` and its related styles — expected to remain behaviorally unchanged; verify the shared sidebar-width layout contract.

## Risks & how to verify
- **Regrouping could hide or reorder a frequently used destination.** Verify every current route appears exactly once, labels remain unchanged, and daily SDR routes are visibly first.
- **Sidebar geometry could break full-bleed pages or introduce horizontal overflow.** Check Overview, Pipeline, Leads, and an account/campaign route at several desktop widths in expanded and collapsed states.
- **Collapsed mode could become icon-only without reliable names.** Navigate by keyboard and confirm every control exposes a stable accessible name and a visible label/tooltip treatment.
- **Account tree styling could regress expansion or active-route logic.** Test multiple accounts, expanded/collapsed accounts, campaign navigation, filtering, long names, and the active account/campaign state.
- **Theme-specific contrast could weaken active, hover, or status states.** Inspect both themes and confirm current-page and status meaning do not rely on color alone.
- **Shared CSS might accidentally affect mobile despite mobile being out of scope.** Perform a narrow-width smoke check to confirm the existing drawer remains usable and no desktop-only labels or geometry leak into it.
- **Storage restrictions could break shell initialization.** Verify collapse state gracefully falls back when local storage reads or writes are unavailable.

## Definition of done
- All existing routes remain present and functional, with daily SDR destinations given the strongest placement.
- The expanded desktop sidebar has clear sections, consistent spacing, a distinct current-page indicator, and a polished brand-to-navigation-to-account hierarchy.
- The account/campaign tree is easier to scan and operate without changing its data or navigation semantics.
- The collapsed desktop rail remains fully operable and understandable with mouse and keyboard, without depending solely on native `title` tooltips.
- Dark and light themes both have clear hover, focus, active, disclosure, and status states.
- Existing Pipeline and page-shell alignment remain correct in expanded and collapsed modes.
- `npm run build` passes.
- A narrow-width smoke check confirms that shared changes did not regress the existing mobile drawer, while no dedicated mobile redesign work is included.
