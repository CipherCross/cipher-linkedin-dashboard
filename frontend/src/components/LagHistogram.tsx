import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { AXIS, BAR_CURSOR, ChartEmpty, GRID, TOOLTIP } from './chartTheme'

const BUCKETS: Array<{ label: string; max: number }> = [
  { label: '≤1d', max: 1 },
  { label: '2–3d', max: 3 },
  { label: '4–7d', max: 7 },
  { label: '8–14d', max: 14 },
  { label: '15–30d', max: 30 },
  { label: '30d+', max: Infinity },
]

export function LagHistogram({
  title, lags, color,
}: { title: string; lags: number[]; color: string }) {
  const counts = BUCKETS.map((b) => ({ label: b.label, count: 0 }))
  for (const lag of lags) {
    // Bucket by whole elapsed days so a 1.4-day lag counts as "≤1d", not "2–3d".
    const days = Math.floor(lag)
    const i = BUCKETS.findIndex((b) => days <= b.max)
    counts[i === -1 ? BUCKETS.length - 1 : i].count += 1
  }
  const median = medianOf(lags)

  if (lags.length === 0) {
    return (
      <div className="card chart-card">
        <h2>{title}</h2>
        <ChartEmpty height={240} label="No timing data yet" />
      </div>
    )
  }

  return (
    <div className="card chart-card">
      <h2>{title}</h2>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={counts} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" {...AXIS} />
          <YAxis {...AXIS} allowDecimals={false} />
          <Tooltip {...TOOLTIP} cursor={BAR_CURSOR} />
          <Bar dataKey="count" name="Leads" fill={color} radius={[3, 3, 0, 0]} maxBarSize={40} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <div className="muted small">
        Median {median!.toFixed(1)} days · {lags.length} leads
      </div>
    </div>
  )
}

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
