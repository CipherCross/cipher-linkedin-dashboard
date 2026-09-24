import {
  Area, AreaChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Annotation, DailyActivity } from '../lib/types'
import { Panel, SectionHeader } from '../ui'
import { AXIS, ChartEmpty, GRID, SERIES as HUE, TOOLTIP, dateTick, legendText } from './chartTheme'

const SERIES = [
  { key: 'invite_sent', label: 'Invites', color: HUE.invite },
  { key: 'invite_accepted', label: 'Accepted', color: HUE.accepted },
  { key: 'reply_received', label: 'Replies', color: HUE.reply },
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
  // `daily_activity` buckets EVERY event type, including non-funnel ones the
  // agent writes for its own bookkeeping (`conversation_refresh`). Only the
  // three series above are charted, so only they are folded in — an allowlist,
  // so a new bookkeeping event type is invisible here the day it is written.
  const charted = new Set(SERIES.map((s) => s.key))
  const byDay = new Map<string, Record<string, number | string>>()
  for (const row of activity) {
    if (!charted.has(row.event_type)) continue
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
    <Panel>
      <SectionHeader title={title} />
      {data.length === 0 ? (
        <ChartEmpty height={240} label="No activity in this range" />
      ) : (
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={data} margin={{ top: 8, right: 16, left: -16, bottom: 0 }}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="day" {...AXIS} tickFormatter={dateTick} minTickGap={24} />
          <YAxis {...AXIS} allowDecimals={false} />
          <Tooltip {...TOOLTIP} labelFormatter={dateTick} />
          <Legend formatter={legendText} />
          {annotations
            .filter((a) => data.some((d) => d.day === a.noted_at))
            .map((a) => (
              <ReferenceLine
                key={a.id}
                x={a.noted_at}
                stroke={HUE.annotation}
                strokeDasharray="4 4"
                label={{
                  value: a.note.length > 24 ? a.note.slice(0, 23) + '…' : a.note,
                  fill: HUE.annotation, fontSize: 10, position: 'insideTopLeft', angle: -90,
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
              fillOpacity={0.12}
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      )}
    </Panel>
  )
}
