import {
  Area, AreaChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Annotation, DailyActivity } from '../lib/types'

const SERIES = [
  { key: 'invite_sent', label: 'Invites', color: '#4f8ef7' },
  { key: 'invite_accepted', label: 'Accepted', color: '#34c98e' },
  { key: 'reply_received', label: 'Replies', color: '#f7b94f' },
]

export function ActivityChart({
  activity, title = 'Daily activity', annotations = [], from, to,
}: {
  activity: DailyActivity[]
  title?: string
  annotations?: Annotation[]
  from?: string | null
  to?: string | null
}) {
  const byDay = new Map<string, Record<string, number | string>>()
  for (const row of activity) {
    const entry = byDay.get(row.day) ?? { day: row.day }
    entry[row.event_type] = ((entry[row.event_type] as number) ?? 0) + row.cnt
    byDay.set(row.day, entry)
  }
  // The daily_activity view has no rows for quiet days; fill every day from
  // the first datapoint to today with zeros so the lines stay continuous.
  const data: Array<Record<string, number | string>> = []
  const days = [...byDay.keys()].sort()
  const today = new Date().toISOString().slice(0, 10)
  // Span the explicit range when given, else first datapoint → today.
  const start = from ?? days[0]
  const end = to ?? today
  if (start) {
    for (
      let d = new Date(`${start}T00:00:00Z`);
      d.toISOString().slice(0, 10) <= end;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      const day = d.toISOString().slice(0, 10)
      const entry = byDay.get(day) ?? { day }
      for (const s of SERIES) entry[s.key] = (entry[s.key] as number) ?? 0
      data.push(entry)
    }
  }

  return (
    <div className="card chart-card">
      <h2>{title}</h2>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data} margin={{ top: 8, right: 16, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="#26304a" strokeDasharray="3 3" />
          <XAxis
            dataKey="day"
            stroke="#7c89a8"
            fontSize={11}
            tickFormatter={(d: string) => d.slice(5)}
          />
          <YAxis stroke="#7c89a8" fontSize={11} allowDecimals={false} />
          <Tooltip
            contentStyle={{ background: '#141a2b', border: '1px solid #26304a', borderRadius: 8 }}
            labelStyle={{ color: '#e7ecf5' }}
          />
          <Legend />
          {annotations
            .filter((a) => data.some((d) => d.day === a.noted_at))
            .map((a) => (
              <ReferenceLine
                key={a.id}
                x={a.noted_at}
                stroke="#b48cf2"
                strokeDasharray="4 4"
                label={{
                  value: a.note.length > 24 ? a.note.slice(0, 23) + '…' : a.note,
                  fill: '#b48cf2', fontSize: 10, position: 'insideTopLeft', angle: -90,
                  dx: -4, dy: 8,
                }}
              />
            ))}
          {SERIES.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              fill={s.color}
              fillOpacity={0.15}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
