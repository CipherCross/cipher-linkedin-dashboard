// Shared visual language for every Recharts chart, driven by the design tokens
// so a chart never carries its own hard-coded palette. Follows the dataviz
// guidance: solid hairline gridlines (never dashed), muted axis text that never
// wears a data colour, one dark tooltip surface, and series colours drawn from
// the status ramp. Import these instead of re-typing hexes per chart.
import { shortDate } from '../lib/format'

/** Series colours, mapped to the status/accent ramp used across the funnel,
 *  sparklines and KPIs so a metric is the same hue everywhere. */
export const SERIES = {
  invite: 'var(--accent)',
  accepted: 'var(--success)',
  reply: 'var(--warning)',
  lead: 'var(--text-muted)',
  added: 'var(--purple)',
} as const

/** Categorical hues for per-item charts (one bubble/slice per campaign). */
export const CATEGORICAL = [
  'var(--accent)', 'var(--success)', 'var(--warning)', 'var(--danger)', 'var(--purple)',
  '#3fc9d6', '#e87fb0', '#9ccc65', '#ffa94d', 'var(--text-muted)',
]

/** <CartesianGrid {...GRID} /> — recessive, solid, one step off the surface. */
export const GRID = { stroke: 'var(--chart-grid)', strokeDasharray: '0' as const }

/** <XAxis {...AXIS} /> / <YAxis {...AXIS} /> — muted 11px text, hairline line. */
export const AXIS = {
  stroke: 'var(--border-strong)',
  tickLine: false,
  axisLine: { stroke: 'var(--border)' },
  tick: { fill: 'var(--text-muted)', fontSize: 11 },
} as const

/** <Tooltip {...TOOLTIP} /> — dark card, value-forward. */
export const TOOLTIP = {
  contentStyle: {
    background: 'var(--surface-1)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    boxShadow: 'var(--shadow-md)',
    fontSize: 12,
    padding: '8px 10px',
  },
  labelStyle: { color: 'var(--text)', fontWeight: 600, marginBottom: 4 },
  itemStyle: { color: 'var(--text-secondary)', padding: 0 },
} as const

/** Hover backdrop for bar/scatter charts (the mark is the hit target). */
export const BAR_CURSOR = { fill: 'rgba(255, 255, 255, 0.04)' }

/** X-axis tick formatter for YYYY-MM-DD day/week keys → "Jun 25". */
export const dateTick = (d: string) => shortDate(d)

/** <Legend formatter={legendText} /> — identity stays in the coloured swatch;
 *  the label itself is neutral text (a light hue is illegible as text). */
export const legendText = (value: string) => (
  <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{value}</span>
)

/** Placeholder shown in a chart card when the range has no data, instead of a
 *  bare grid of empty axes. */
export function ChartEmpty({ height = 240, label }: { height?: number; label: string }) {
  return (
    <div className="chart-empty" style={{ height }}>
      <span>{label}</span>
    </div>
  )
}
