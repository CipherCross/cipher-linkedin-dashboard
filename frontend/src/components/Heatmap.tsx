import { Fragment, useState } from 'react'
import type { Lead } from '../lib/types'
import { num } from '../lib/format'
import { ChartEmpty } from './chartTheme'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
// `token` is the theme colour the cell intensity is mixed from, so the heatmap
// tracks the palette instead of carrying its own rgb triplets.
const METRICS = [
  { id: 'accepted', label: 'Accepts', field: 'connected_at' as const, token: 'var(--success)' },
  { id: 'replied', label: 'Replies', field: 'replied_at' as const, token: 'var(--warning)' },
]

/** Day-of-week × hour distribution of accepts/replies, in the viewer's
 *  timezone — shows when the audience actually responds. */
export function Heatmap({ leads }: { leads: Lead[] }) {
  const [metricId, setMetricId] = useState('accepted')
  const metric = METRICS.find((m) => m.id === metricId)!

  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0))
  let total = 0
  for (const l of leads) {
    const ts = l[metric.field]
    if (!ts) continue
    const d = new Date(ts)
    grid[(d.getDay() + 6) % 7][d.getHours()] += 1
    total += 1
  }
  const max = Math.max(...grid.flat(), 1)

  return (
    <div className="card">
      <div className="card-head">
        <h2>Response times — {metric.label.toLowerCase()} by day &amp; hour</h2>
        <div className="range-group">
          {METRICS.map((m) => (
            <button key={m.id} className={m.id === metricId ? 'active' : ''}
              onClick={() => setMetricId(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {total === 0 ? (
        <ChartEmpty height={200} label="No response data yet" />
      ) : (
        <>
          <div className="heatmap">
            <div className="heatmap-corner" />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="heatmap-hour muted">{h % 3 === 0 ? h : ''}</div>
            ))}
            {grid.map((row, d) => (
              <Fragment key={d}>
                <div className="heatmap-day muted">{DAYS[d]}</div>
                {row.map((count, h) => (
                  <div
                    key={h}
                    className="heatmap-cell"
                    title={`${DAYS[d]} ${h}:00 — ${count}`}
                    style={{
                      background: count > 0
                        ? `color-mix(in srgb, ${metric.token} ${(15 + 85 * (count / max)).toFixed(1)}%, transparent)`
                        : 'var(--surface-2)',
                    }}
                  />
                ))}
              </Fragment>
            ))}
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            {num(total)} events · times shown in your local timezone
          </div>
        </>
      )}
    </div>
  )
}
