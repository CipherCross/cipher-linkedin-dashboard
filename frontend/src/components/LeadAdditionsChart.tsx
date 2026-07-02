import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Lead } from '../lib/types'
import { addedByDay, dayRange, weekRange, weekStart } from '../lib/leads'

/** When and how many leads were queued into the campaign(s): counts of
 *  added_at per week (default) or per day. Leads synced before added_at
 *  existed carry their earliest milestone (migration 025 backfill); untouched
 *  legacy rows may be undated and are called out below the chart instead of
 *  silently dropped. */
export function LeadAdditionsChart({
  leads, weeks = 16, days = 90, granularity = 'week',
}: {
  leads: Lead[]
  weeks?: number
  days?: number
  granularity?: 'day' | 'week'
}) {
  const daily = granularity === 'day'
  const { byDay, undated } = addedByDay(leads)
  const buckets = new Map<string, number>()
  for (const [day, n] of byDay) {
    const key = daily ? day : weekStart(day)
    buckets.set(key, (buckets.get(key) ?? 0) + n)
  }
  const first = [...buckets.keys()].sort()[0]
  const axis = first
    ? daily ? dayRange(first).slice(-days) : weekRange(first).slice(-weeks)
    : []
  const data = axis.map((date) => ({ date, added: buckets.get(date) ?? 0 }))

  return (
    <div className="card chart-card">
      <h2>{daily ? 'Leads added per day' : 'Leads added per week'}</h2>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 0, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="#26304a" strokeDasharray="3 3" />
          <XAxis dataKey="date" stroke="#7c89a8" fontSize={11}
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
        {daily ? 'Day' : 'Week'} the lead was queued into the campaign.
        {undated > 0 &&
          ` ${undated.toLocaleString('en-US')} lead${undated === 1 ? '' : 's'} with no known add date not shown.`}
      </div>
    </div>
  )
}
