import type { ReactNode } from 'react'

// Kept apart from KpiCards so a route that only needs a plain tile (Review,
// the Gallery) does not import the sparkline and velocity charts with it.

/** One KPI tile's shell: white surface, hairline border, 16px padding. */
export const KPI_TILE = 'flex flex-col gap-app-xs min-w-0 bg-app-surface border border-app-border rounded-card p-card'

/** The row the tiles wrap in; each tile grows from 220px. */
export function KpiGrid({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-group mb-section">{children}</div>
}

/** A plain tile — label, value and one explanatory line — on the same shell
 *  as `KpiCards`' own, which add an icon, a delta and a sparkline. */
export function KpiTile({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className={`${KPI_TILE} flex-1 basis-[220px]`}>
      <span className="text-app-text-muted text-app-meta">{label}</span>
      <div className="text-app-kpi font-semibold tabular-nums tracking-[-0.02em]">{value}</div>
      {sub && <div className="text-app-text-secondary text-app-meta">{sub}</div>}
    </div>
  )
}
