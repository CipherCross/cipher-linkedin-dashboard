import type { ReactNode, RefObject } from 'react'

/**
 * The shared table shell: frame, toolbar, local scroll, sticky head.
 *
 * It deliberately owns none of the business logic — sorting, paging, filtering
 * and the data hooks stay on the screen that knows the domain. This is a frame,
 * not a mega-table.
 */

export function TableFrame({
  toolbar, hint, maxHeight, children, className = '', scrollLabel, scrollRef, busy,
}: {
  toolbar?: ReactNode
  /** Rendered under the table: "12 of 340 · scroll for more columns", etc. */
  hint?: ReactNode
  maxHeight?: number | string
  children: ReactNode
  className?: string
  /** Names the scroll region so keyboard users can reach and pan it. */
  scrollLabel?: string
  /** The scroll region itself, e.g. to return to the top on a page change. */
  scrollRef?: RefObject<HTMLDivElement>
  /** Marks the region busy while its rows are being replaced. */
  busy?: boolean
}) {
  return (
    <div className={`ui-table-frame ${className}`.trim()}>
      {toolbar}
      <div
        ref={scrollRef}
        className="ui-table-scroll"
        aria-busy={busy || undefined}
        style={maxHeight ? { maxHeight } : undefined}
        // A scrollable region needs to be reachable and named for the keyboard.
        tabIndex={0}
        role="region"
        aria-label={scrollLabel}
      >
        {children}
      </div>
      {hint && <div className="ui-table-hint">{hint}</div>}
    </div>
  )
}

export function TableToolbar({
  count, actions, children,
}: {
  count?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="ui-table-toolbar">
      {count != null && <span className="ui-table-toolbar__count">{count}</span>}
      {children}
      {actions && <div className="ui-table-toolbar__actions">{actions}</div>}
    </div>
  )
}

/**
 * A sortable column header. The header cell carries `aria-sort`; the label is a
 * real button so the sort is reachable and announced from the keyboard. The
 * route still owns the sort key, the direction and what a click does.
 */
export function SortHeader({
  label, active, direction, onSort, className = '',
}: {
  label: ReactNode
  active: boolean
  direction: 'asc' | 'desc'
  onSort: () => void
  className?: string
}) {
  return (
    <th
      scope="col"
      className={`ui-table__sort ${className}`.trim()}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button type="button" className="ui-table__sort-button" onClick={onSort}>
        {label}
        <span className="ui-table__sort-mark" aria-hidden="true">
          {active ? (direction === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  )
}

export function Table({
  children, className = '', caption,
}: {
  children: ReactNode
  className?: string
  caption?: string
}) {
  return (
    <table className={`ui-table ${className}`.trim()}>
      {caption && <caption className="sr-only">{caption}</caption>}
      {children}
    </table>
  )
}
