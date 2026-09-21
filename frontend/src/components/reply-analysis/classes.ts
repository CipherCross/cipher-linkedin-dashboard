/**
 * Shared class strings for the sentiment-analysis page.
 *
 * These were grouped selectors in `sentiment-analysis.css`
 * (`.sa-bar-row, .sa-reason-row, .sa-trend-row { … }`). A grouped selector has
 * no utility equivalent — the whole point of it is that one declaration block
 * serves several elements — so the sharing moves here instead of being
 * copy-pasted across three call sites in three files.
 *
 * Only strings that genuinely had more than one consumer live here. A class
 * used once is written inline at its element.
 */

/** Every drill-down row: bars, reasons, weekly trend. Each adds its own grid. */
export const SA_ROW =
  'grid items-center gap-app-md min-h-control p-app-sm border border-transparent ' +
  'rounded-control text-app-text no-underline ' +
  '[a&:hover]:border-app-accent [a&:hover]:bg-app-surface-2'

/** The three bar tracks and their fills. */
export const SA_TRACK = 'block h-2 rounded-pill bg-app-surface-2 overflow-hidden'
export const SA_FILL = 'block h-full rounded-[inherit]'

/** A metric the inbox cannot filter exactly is honestly not a link. */
export const SA_DISABLED = 'text-app-text-muted cursor-not-allowed'

/** Right-aligned tabular figure at the end of a row. */
export const SA_FIGURE = 'text-app-table tabular-nums text-right'

/** Both the multi-label note and the formula note. */
export const SA_NOTE = 'mt-app-lg mx-0 mb-0 pl-app-md border-l-2 border-app-accent'

/** Auto-fitting card grids, at their two different minimums. */
export const SA_GRID_220 = 'grid gap-app-lg grid-cols-[repeat(auto-fit,minmax(220px,1fr))]'
export const SA_GRID_260 = 'grid gap-app-md grid-cols-[repeat(auto-fit,minmax(260px,1fr))]'
