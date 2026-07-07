import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Lead } from '../lib/types'
import type { DateRange } from '../lib/leads'
import { tsInRange, weekStart } from '../lib/leads'
import { num } from '../lib/format'
import { AXIS, ChartEmpty, GRID, NO_ANIM, SERIES, TOOLTIP, dateTick } from './chartTheme'

function velocityByWeek(leads: Lead[], range: DateRange) {
  const buckets = new Map<string, number>()
  let undated = 0
  for (const l of leads) {
    if (!l.added_at) {
      undated++
      continue
    }
    if (!tsInRange(l.added_at, range)) continue
    const week = weekStart(l.added_at)
    buckets.set(week, (buckets.get(week) ?? 0) + 1)
  }
  const weeks = [...buckets.keys()].sort()
  if (weeks.length === 0) return { data: [], undated }
  const last = weeks[weeks.length - 1]
  const data: { week: string; added: number }[] = []
  for (const d = new Date(`${weeks[0]}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 7)) {
    const week = d.toISOString().slice(0, 10)
    data.push({ week, added: buckets.get(week) ?? 0 })
    if (week >= last) break
  }
  return { data, undated }
}

/** Lead-intake velocity: new leads added per week, zero-filled across gap
 *  weeks so a quiet sourcing week reads as a dip instead of vanishing. */
export function LeadsVelocityChart({ leads, range }: { leads: Lead[]; range: DateRange }) {
  const { data, undated } = velocityByWeek(leads, range)

  return (
    <div className="card chart-card">
      <h2>Leads velocity</h2>
      {data.length < 2 ? (
        <ChartEmpty label="Not enough weeks of data yet to chart velocity" />
      ) : (
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 0, left: -16, bottom: 0 }}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="week" {...AXIS} tickFormatter={dateTick} minTickGap={24} />
          <YAxis {...AXIS} allowDecimals={false} />
          <Tooltip {...TOOLTIP} cursor={false} labelFormatter={dateTick} />
          <Line
            {...NO_ANIM}
            type="monotone"
            dataKey="added"
            name="Leads added"
            stroke={SERIES.added}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
      )}
      <div className="muted small">
        Added per week, by the week the lead was queued in.
        {undated > 0 &&
          ` ${num(undated)} lead${undated === 1 ? '' : 's'} with no known add date not shown.`}
      </div>
    </div>
  )
}
