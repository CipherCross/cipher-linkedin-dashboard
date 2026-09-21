// Shared visual language for every Recharts chart, driven by the design tokens
// so a chart never carries its own hard-coded palette. Follows the dataviz
// guidance: solid hairline gridlines (never dashed), muted axis text that never
// wears a data colour, one opaque tooltip surface, and series colours drawn from
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

/** Categorical hues for per-item charts (one bubble/slice per campaign).
 *  Drawn from the theme's --chart-cat-* tokens so they match the palette's
 *  saturation (the old Material lime/orange were off-ramp). */
export const CATEGORICAL = [
  'var(--accent)', 'var(--success)', 'var(--warning)', 'var(--danger)', 'var(--purple)',
  'var(--chart-cat-teal)', 'var(--chart-cat-pink)', 'var(--chart-cat-lime)',
  'var(--chart-cat-amber)', 'var(--text-muted)',
]

/** Kill Recharts' grow-from-zero mount animation. Data refreshes every 5 min and
 *  the replay reads as a glitch — spread onto every series, or set the prop
 *  directly (`isAnimationActive={false}`). */
export const NO_ANIM = { isAnimationActive: false } as const

/** <CartesianGrid {...GRID} /> — recessive, solid, one step off the surface. */
export const GRID = { stroke: 'var(--chart-grid)', strokeDasharray: '0' as const }

/** <XAxis {...AXIS} /> / <YAxis {...AXIS} /> — 13px muted text (the metadata
 *  floor; it used to be 11), hairline line. */
export const AXIS = {
  stroke: 'var(--border-strong)',
  tickLine: false,
  axisLine: { stroke: 'var(--border)' },
  tick: { fill: 'var(--text-muted)', fontSize: 13 },
} as const

/** <Tooltip {...TOOLTIP} /> — one opaque popover surface, matching `.chart-tip`
 *  in styles.css (used by custom-content tooltips) and the shared overlay
 *  shadow. There is no longer a translucent branch to keep in sync, and so no
 *  reduced-transparency fallback to get wrong. */
export const TOOLTIP = {
  contentStyle: {
    background: 'var(--surface-1)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-control)',
    boxShadow: 'var(--shadow-overlay)',
    fontSize: 13,
    padding: '8px 12px',
  },
  labelStyle: { color: 'var(--text)', fontWeight: 600, marginBottom: 4 },
  itemStyle: { color: 'var(--text-secondary)', padding: 0 },
} as const

/** Hover backdrop for bar/scatter charts (the mark is the hit target).
 *  Tokenised so it inverts (dark-on-light) with the theme. */
export const BAR_CURSOR = { fill: 'var(--chart-bar-cursor)' }

/** X-axis tick formatter for YYYY-MM-DD day/week keys → "Jun 25". */
export const dateTick = (d: string) => shortDate(d)

/** <Legend formatter={legendText} /> — identity stays in the coloured swatch;
 *  the label itself is neutral text (a light hue is illegible as text). */
export const legendText = (value: string) => (
  <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{value}</span>
)

/** Placeholder shown in a chart card when the range has no data, instead of a
 *  bare grid of empty axes. */
export function ChartEmpty({ height = 240, label }: { height?: number; label: string }) {
  return (
    <div className="flex items-center justify-center mt-1 text-app-text-muted text-[length:var(--text-sm)] bg-app-surface-2 border border-dashed border-app-border rounded-md" style={{ height }}>
      <span>{label}</span>
    </div>
  )
}
