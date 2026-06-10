import {
  Bar, BarChart, CartesianGrid, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Lead } from '../lib/types'
import { lastWeeks, weekStart } from '../lib/leads'

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

  return (
    <div className="card chart-card">
      <h2>Invite volume per week (warm-up / limit tracker)</h2>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="#26304a" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="week" stroke="#7c89a8" fontSize={11}
            tickFormatter={(d: string) => d.slice(5)} />
          <YAxis stroke="#7c89a8" fontSize={11} allowDecimals={false}
            domain={[0, Math.max(220, Math.ceil(peak * 1.15))]} />
          <Tooltip
            cursor={{ fill: '#26304a55' }}
            contentStyle={{ background: '#141a2b', border: '1px solid #26304a', borderRadius: 8 }}
            labelStyle={{ color: '#e7ecf5' }}
          />
          <ReferenceArea y1={100} y2={200} fill="#34c98e" fillOpacity={0.07} />
          <ReferenceLine y={200} stroke="#f76a5c" strokeDasharray="4 4"
            label={{ value: '~200/wk cap', fill: '#f76a5c', fontSize: 11, position: 'insideTopRight' }} />
          <Bar dataKey="invites" name="Invites" fill="#4f8ef7" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <div className="muted small">
        Green band ≈ LinkedIn&apos;s typical safe range (100–200 invites/week) for a
        warmed-up account. Ramp gradually toward it for new accounts.
      </div>
    </div>
  )
}
