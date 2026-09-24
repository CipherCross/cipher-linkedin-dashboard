import {
  Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Lead } from '../lib/types'
import { weekRange, weekStart } from '../lib/leads'
import { Panel, SectionHeader } from '../ui'
import { AXIS, ChartEmpty, GRID, SERIES, TOOLTIP, dateTick, legendText } from './chartTheme'

interface Cohort {
  week: string
  invites: number
  accepted: number
  rate: number | null
}

/** Acceptance rate grouped by the week the invite went out. Recent cohorts
 *  are still maturing — invites can be accepted weeks later. */
export function CohortChart({ leads, weeks = 16 }: { leads: Lead[]; weeks?: number }) {
  const byWeek = new Map<string, Cohort>()
  for (const l of leads) {
    if (!l.invited_at) continue
    const week = weekStart(l.invited_at)
    const row = byWeek.get(week) ?? { week, invites: 0, accepted: 0, rate: null }
    row.invites += 1
    if (l.connected_at) row.accepted += 1
    byWeek.set(week, row)
  }
  const firstWeek = [...byWeek.keys()].sort()[0]
  const data = (firstWeek ? weekRange(firstWeek) : [])
    .slice(-weeks)
    .map((week) => {
      const r = byWeek.get(week) ?? { week, invites: 0, accepted: 0, rate: null }
      return {
        ...r,
        rate: r.invites > 0 ? Math.round((1000 * r.accepted) / r.invites) / 10 : null,
      }
    })

  return (
    <Panel>
      <SectionHeader title="Weekly invite cohorts" />
      {data.length === 0 ? (
        <ChartEmpty label="No invites sent yet" />
      ) : (
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: 0, left: -16, bottom: 0 }}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="week" {...AXIS} tickFormatter={dateTick} minTickGap={24} />
          <YAxis yAxisId="n" {...AXIS} allowDecimals={false} />
          <YAxis yAxisId="pct" orientation="right" {...AXIS} unit="%" width={44} />
          <Tooltip {...TOOLTIP} labelFormatter={dateTick} />
          <Legend formatter={legendText} />
          <Bar yAxisId="n" dataKey="invites" name="Invites sent" fill={SERIES.invite}
            fillOpacity={0.5} maxBarSize={28} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Line yAxisId="pct" dataKey="rate" name="Acceptance %" stroke={SERIES.accepted}
            strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      )}
      <div className="text-app-text-muted text-app-meta">
        Cohort = week the invite was sent. Recent weeks are still maturing.
      </div>
    </Panel>
  )
}
