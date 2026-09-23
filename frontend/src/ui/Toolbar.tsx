import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button, IconButton } from './Button'
import { COPY } from './labels'

/**
 * Search plus one or two primary selectors stay on the page; everything else
 * moves into a `FilterDialog` (Overlay.tsx) that opens *over* the page.
 *
 * That is the whole point: on Replies, opening the filters pushed the workspace
 * from y≈145 to y≈362, and on Leads twelve inline filters plus a digest plus
 * tabs put the first table row at y≈480 on a 1280×660 window. An overlay costs
 * the results no height at all.
 */

export function Toolbar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`ui-toolbar ${className}`.trim()}>{children}</div>
}

export function FilterCount({ count }: { count: number }) {
  if (count <= 0) return null
  return <span className="ui-filter-count">{count}</span>
}

export interface ActiveFilter {
  id: string
  label: string
  value: string
  onRemove: () => void
}

export function ActiveFilters({
  filters, onClearAll,
}: {
  filters: ActiveFilter[]
  onClearAll: () => void
}) {
  if (filters.length === 0) return null
  return (
    <div className="ui-active-filters">
      {filters.map((filter) => (
        <span className="ui-active-filter" key={filter.id}>
          <span>
            <span className="muted">{filter.label}:</span> {filter.value}
          </span>
          <IconButton
            className="ui-active-filter__remove"
            onClick={filter.onRemove}
            label={`Remove filter ${filter.label}: ${filter.value}`}
            icon={<X size={14} aria-hidden="true" />}
          />
        </span>
      ))}
      <Button variant="ghost" size="sm" onClick={onClearAll}>{COPY.clearAll}</Button>
    </div>
  )
}
