import { useMemo, useState } from 'react'
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { TrendingUp } from 'lucide-react'
import type { Lead } from '../lib/types'
import { weekStart } from '../lib/leads'
import { num } from '../lib/format'
import { SERIES, TOOLTIP, dateTick } from './chartTheme'

const WINDOWS = [4, 8, 12] as const
type WindowWeeks = (typeof WINDOWS)[number]

/** Last `weeks` complete Mon–Sun (UTC) weeks, plus the current week-to-date.
 *  The partial current week is drawn on the trend line but excluded from the
 *  average, so the headline number doesn't crater every Monday morning. */
function velocityByWeek(leads: Lead[], weeks: WindowWeeks) {
  const thisMonday = weekStart(new Date().toISOString())
  const start = new Date(`${thisMonday}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - weeks * 7)
  const firstMonday = start.toISOString().slice(0, 10)
  const buckets = new Map<string, number>()
  let undated = 0
  for (const l of leads) {
    if (!l.added_at) {
      undated++
      continue
    }
    const week = weekStart(l.added_at)
    if (week < firstMonday || week > thisMonday) continue
    buckets.set(week, (buckets.get(week) ?? 0) + 1)
  }
  const data: { week: string; added: number }[] = []
  for (const d = new Date(`${firstMonday}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 7)) {
    const week = d.toISOString().slice(0, 10)
    data.push({ week, added: buckets.get(week) ?? 0 })
    if (week >= thisMonday) break
  }
  const avg = Math.round(data.slice(0, -1).reduce((a, d) => a + d.added, 0) / weeks)
  return { data, avg, undated }
}

/** Compact KPI-tile version of lead-intake velocity: avg leads added per week
 *  over a fixed rolling window (4/8/12 complete weeks, toggleable), independent
 *  of the page's date-range picker. Sits inline in KpiCards' grid. */
export function LeadsVelocityChart({ leads }: { leads: Lead[] }) {
  const [weeks, setWeeks] = useState<WindowWeeks>(4)
  const { data, avg, undated } = useMemo(() => velocityByWeek(leads, weeks), [leads, weeks])
  const title = undated > 0
    ? `${num(undated)} lead${undated === 1 ? '' : 's'} with no known add date not shown`
    : undefined

  return (
    <div className="card kpi" title={title}>
      <div className="kpi-top">
        <span className="kpi-label"><TrendingUp size={14} strokeWidth={2} /> Leads velocity</span>
        <span className="kpi-toggle" title="Rolling window (complete Mon–Sun weeks; the current week shows on the trend line but isn't averaged)">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={w === weeks ? 'active' : undefined}
              onClick={() => setWeeks(w)}
            >
              {w}w
            </button>
          ))}
        </span>
      </div>
      <div className="kpi-value">{num(avg)}</div>
      <div className="kpi-sub">per week · last {weeks} full weeks</div>
      <div className="kpi-spark">
        <ResponsiveContainer width="100%" height={28}>
          <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 0 }}>
            {/* Hidden but still gives Tooltip a "week" dataKey to look the label up
                by — without an XAxis, Recharts falls back to the numeric data index
                as the tooltip label, which dateTick (expects a date string) then
                chokes on. */}
            <XAxis dataKey="week" hide />
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
      </div>
    </div>
  )
}
