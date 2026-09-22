# UI redesign manual checklist

This is the Phase 0 evidence template. A row is evidence only after the
operator fills it from a real browser run; an empty cell means **NOT RUN**, not
pass. Do not infer a route result from the Gallery. The Gallery is valid for
primitive and composition smoke checks only. The first-result `y ≤ 340` check
must be measured on the real list route with its default filters.

## Run record

| Field | Value |
| --- | --- |
| Commit |  |
| Environment | `vite dev` (Gallery only), `vercel dev` with safe fixtures, or authenticated read-only preview |
| Evidence level | Unit / build / local browser / authenticated preview / production rendering |
| Date and operator |  |
| Data policy | Fixture or read-only data only; no production writes |

## Evidence rows

Use one row for each route/state/viewport combination that is exercised. The
keyboard cell records focus order, visible focus, Enter/Space activation,
Escape, and the relevant arrow-key behavior where the route has it. The visual
cell records hierarchy, clipping, local scroll, text floor, and overflow; it
does not claim computed geometry unless the browser measurement was made.

| Commit | Environment | Role | Route/state | Viewport | Keyboard result | Visual result | Issue link |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  | 1280×720 |  |  |  |
|  |  |  |  | 1440×900 |  |  |  |
|  |  |  |  | 1920×1080 |  |  |  |

Required viewport matrix: **1280×720, 1440×900, and 1920×1080**. At 1280,
record the real route's first result position for list routes and confirm
`y ≤ 340`; also record whether wide content scrolls inside its named
region and whether the primary action and Replies inspector remain reachable.
At 1440 and 1920, record the 32px page gutter. At 1280, record the 24px page
gutter. Do not accept a screenshot of an arbitrary viewport as evidence for
these exact sizes.

## Required state and permission matrix

Fill only states the route supports. Mark unsupported states `N/A` with the
reason in the issue column. `PASS` means the current route behavior was
observed; it does not mean a future redesign has been accepted.

| Route family / surface | Ordinary member | Admin | Initial load | Populated default | Long labels/messages | Empty | No match | Read failure | Background refresh | Mutation states (clean / dirty / pending / success / failure / conflict / refused) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shell, sign-in, reset, non-admin gate |  |  |  |  |  |  |  |  |  |  |
| Overview and account/campaign detail |  |  |  |  |  |  |  |  |  |  |
| Leads, Follow-ups, Review |  |  |  |  |  |  |  |  |  |  |
| Replies and ConversationDrawer |  |  |  |  |  |  |  |  |  |  |
| Pipeline and campaign-leads workspace |  |  |  |  |  |  |  |  |  |  |
| Sentiment Analysis |  |  |  |  |  |  |  |  |  |  |
| Team, Health, Neon Activity |  |  |  |  |  |  |  |  |  |  |
| Searches, ICPs, Hypotheses |  |  |  |  |  |  |  |  |  |  |
| Playbook |  |  |  |  |  |  |  |  |  |  |
| CSV Import |  |  |  |  |  |  |  |  |  |  |
| Chat |  |  |  |  |  |  |  |  |  |  |
| Sequence Hub / editor |  |  |  |  |  |  |  |  |  |  |
| Gallery (dev only) | N/A | N/A |  |  |  |  |  | N/A | N/A | N/A |

Permission checks must preserve the live contract: CSV Import, Team member
management, Health briefing rerun, Playbook save, sequence publish,
and other existing admin-only actions remain absent or disabled for an ordinary
member with the current reason text. Library and sequence create/edit/archive controls have no client admin gate today; verify their current availability and server-refusal presentation without introducing a new gate. A disabled-looking control is not proof of
server enforcement; this checklist records the UI state only.

## Required interaction checks

- Filter overlay: opening creates a draft; changing fields does not change URL,
  data, selection, or scroll; Apply commits all keys and resets paging; Cancel,
  Escape, and backdrop leave the applied state unchanged.
- Dirty form/dialog: clean close is immediate. Dirty Close, Escape, backdrop,
  and navigation offer `Keep editing` and `Discard changes`; Keep editing
  restores focus; pending submission cannot double-submit; failure retains the
  draft.
- Background refresh: old results remain visible with an explicit updating
  status and the old scope; completion replaces only the relevant region.
- Dialog: initial focus, Tab/Shift+Tab trap, Escape/outside close, background
  inaccessibility, scroll lock, and exact trigger focus restoration.
- Lists/tables/workspaces: row or link activation works from the keyboard;
  row actions do not trigger row selection; local horizontal scroll has a
  visible hint; no page-level horizontal overflow is introduced.
- Reduced motion: loading and transition affordances remain understandable
  when reduced motion is enabled.

## Issue recording

Use an issue link for every `FAIL`, `N/A`, or observed discrepancy. Include the
route, state, viewport, role, expected behavior, observed behavior, and
evidence level. Do not record a visual issue as fixed from a unit test alone.
