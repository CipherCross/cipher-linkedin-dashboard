import {
  Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Lead } from '../lib/types'
import { weekRange, weekStart } from '../lib/leads'

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
    <div className="card chart-card">
      <h2>Weekly invite cohorts</h2>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: 0, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="#26304a" strokeDasharray="3 3" />
          <XAxis dataKey="week" stroke="#7c89a8" fontSize={11}
            tickFormatter={(d: string) => d.slice(5)} />
          <YAxis yAxisId="n" stroke="#7c89a8" fontSize={11} allowDecimals={false} />
          <YAxis yAxisId="pct" orientation="right" stroke="#34c98e" fontSize={11}
            unit="%" width={44} />
          <Tooltip
            contentStyle={{ background: '#141a2b', border: '1px solid #26304a', borderRadius: 8 }}
            labelStyle={{ color: '#e7ecf5' }}
          />
          <Legend />
          <Bar yAxisId="n" dataKey="invites" name="Invites sent" fill="#4f8ef7" fillOpacity={0.5} />
          <Line yAxisId="pct" dataKey="rate" name="Acceptance %" stroke="#34c98e"
            strokeWidth={2} dot={{ r: 2 }} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="muted small">
        Cohort = week the invite was sent. Recent weeks are still maturing.
      </div>
    </div>
  )
}
