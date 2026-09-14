import type { ReactNode } from 'react'

/**
 * The shared table shell: frame, toolbar, local scroll, sticky head.
 *
 * It deliberately owns none of the business logic — sorting, paging, filtering
 * and the data hooks stay on the screen that knows the domain. This is a frame,
 * not a mega-table.
 */

export function TableFrame({
  toolbar, hint, maxHeight, children, className = '', scrollLabel,
}: {
  toolbar?: ReactNode
  /** Rendered under the table: "12 of 340 · scroll for more columns", etc. */
  hint?: ReactNode
  maxHeight?: number | string
  children: ReactNode
  className?: string
  /** Names the scroll region so keyboard users can reach and pan it. */
  scrollLabel?: string
}) {
  return (
    <div className={`ui-table-frame ${className}`.trim()}>
      {toolbar}
      <div
        className="ui-table-scroll"
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
