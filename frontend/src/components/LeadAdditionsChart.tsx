import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Lead } from '../lib/types'
import { weekRange, weekStart } from '../lib/leads'

/** When and how many leads were queued into the campaign(s): weekly counts of
 *  added_at. Leads synced before added_at existed carry their earliest
 *  milestone (migration 025 backfill); untouched legacy rows may be undated
 *  and are called out below the chart instead of silently dropped. */
export function LeadAdditionsChart({ leads, weeks = 16 }: { leads: Lead[]; weeks?: number }) {
  const byWeek = new Map<string, number>()
  let undated = 0
  for (const l of leads) {
    if (!l.added_at) {
      undated++
      continue
    }
    const week = weekStart(l.added_at)
    byWeek.set(week, (byWeek.get(week) ?? 0) + 1)
  }
  const firstWeek = [...byWeek.keys()].sort()[0]
  const data = (firstWeek ? weekRange(firstWeek) : [])
    .slice(-weeks)
    .map((week) => ({ week, added: byWeek.get(week) ?? 0 }))

  return (
    <div className="card chart-card">
      <h2>Leads added per week</h2>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 0, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="#26304a" strokeDasharray="3 3" />
          <XAxis dataKey="week" stroke="#7c89a8" fontSize={11}
            tickFormatter={(d: string) => d.slice(5)} />
          <YAxis stroke="#7c89a8" fontSize={11} allowDecimals={false} />
          <Tooltip
            contentStyle={{ background: '#141a2b', border: '1px solid #26304a', borderRadius: 8 }}
            labelStyle={{ color: '#e7ecf5' }}
            cursor={{ fill: '#26304a', fillOpacity: 0.35 }}
          />
          <Bar dataKey="added" name="Leads added" fill="#a578ec" fillOpacity={0.85}
            radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <div className="muted small">
        Week the lead was queued into the campaign.
        {undated > 0 &&
          ` ${undated.toLocaleString('en-US')} lead${undated === 1 ? '' : 's'} with no known add date not shown.`}
      </div>
    </div>
  )
}
