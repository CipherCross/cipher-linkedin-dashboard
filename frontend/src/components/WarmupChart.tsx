import {
  Bar, BarChart, CartesianGrid, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Lead } from '../lib/types'
import { lastWeeks, weekStart } from '../lib/leads'
import { Panel, SectionHeader } from '../ui'
import { AXIS, BAR_CURSOR, CHART_TEXT_SIZE, ChartEmpty, GRID, SERIES, TOOLTIP, dateTick } from './chartTheme'

/** Invites per calendar week vs LinkedIn's ~100–200/week safe zone.
 *  The main view for ramping a warming-up account safely. */
export function WarmupChart({ leads }: { leads: Lead[] }) {
  const weeks = lastWeeks(12)
  const counts = new Map(weeks.map((w) => [w, 0]))
  for (const l of leads) {
    if (!l.invited_at) continue
    const w = weekStart(l.invited_at)
    if (counts.has(w)) counts.set(w, counts.get(w)! + 1)
  }
  const data = weeks.map((week) => ({ week, invites: counts.get(week) ?? 0 }))
  const peak = Math.max(...data.map((d) => d.invites), 0)

  if (peak === 0) {
    return (
      <Panel>
        <SectionHeader title="Invite volume per week (warm-up / limit tracker)" />
        <ChartEmpty height={240} label="No invites in the last 12 weeks" />
      </Panel>
    )
  }

  return (
    <Panel>
      <SectionHeader title="Invite volume per week (warm-up / limit tracker)" />
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="week" {...AXIS} tickFormatter={dateTick} minTickGap={24} />
          <YAxis {...AXIS} allowDecimals={false}
            domain={[0, Math.max(220, Math.ceil(peak * 1.15))]} />
          <Tooltip {...TOOLTIP} cursor={BAR_CURSOR} labelFormatter={dateTick} />
          <ReferenceArea y1={100} y2={200} fill={SERIES.safeBand} fillOpacity={0.07} />
          <ReferenceLine y={200} stroke={SERIES.limit} strokeDasharray="4 4"
            label={{ value: '~200/wk cap', fill: SERIES.limit, fontSize: CHART_TEXT_SIZE, position: 'insideTopRight' }} />
          <Bar dataKey="invites" name="Invites" fill={SERIES.invite} radius={[3, 3, 0, 0]}
            maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <div className="text-app-text-muted text-app-meta">
        Green band ≈ LinkedIn&apos;s typical safe range (100–200 invites/week) for a
        warmed-up account. Ramp gradually toward it for new accounts.
      </div>
    </Panel>
  )
}
