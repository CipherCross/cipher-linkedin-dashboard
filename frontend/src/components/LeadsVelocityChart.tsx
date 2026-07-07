import { Line, LineChart, ResponsiveContainer, Tooltip } from 'recharts'
import { TrendingUp } from 'lucide-react'
import type { Lead } from '../lib/types'
import type { DateRange } from '../lib/leads'
import { tsInRange, weekStart } from '../lib/leads'
import { num } from '../lib/format'
import { SERIES, TOOLTIP, dateTick } from './chartTheme'

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

/** Compact KPI-tile version of lead-intake velocity: avg leads added per week
 *  over the range, with a tiny zero-filled trend line in place of the usual
 *  activity sparkline. Sits inline in KpiCards' grid, not a full chart card. */
export function LeadsVelocityChart({ leads, range }: { leads: Lead[]; range: DateRange }) {
  const { data, undated } = velocityByWeek(leads, range)
  const hasTrend = data.length >= 2
  const avg = data.length > 0
    ? Math.round(data.reduce((a, d) => a + d.added, 0) / data.length)
    : 0
  const title = undated > 0
    ? `${num(undated)} lead${undated === 1 ? '' : 's'} with no known add date not shown`
    : undefined

  return (
    <div className="card kpi" title={title}>
      <div className="kpi-top">
        <span className="kpi-label"><TrendingUp size={14} strokeWidth={2} /> Leads velocity</span>
      </div>
      <div className="kpi-value">{hasTrend ? num(avg) : '—'}</div>
      <div className="kpi-sub">{hasTrend ? 'per week' : 'not enough weeks yet'}</div>
      <div className="kpi-spark">
        {hasTrend ? (
          <ResponsiveContainer width="100%" height={28}>
            <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 0 }}>
              <Tooltip {...TOOLTIP} cursor={false} labelFormatter={dateTick} />
              <Line
                type="monotone"
                dataKey="added"
                name="Leads added"
                stroke={SERIES.added}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="sparkline-empty muted small">no weekly trend yet</div>
        )}
      </div>
    </div>
  )
}
