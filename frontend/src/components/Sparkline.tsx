import type { DailyActivity } from '../lib/types'

/** Tiny inline activity sparkline: one bar per day of `event_type` counts,
 *  no axes. Days with no activity render as gaps; the range is padded so two
 *  cards over the same period stay visually comparable. */
export function Sparkline({
  activity,
  eventType = 'invite_sent',
  from,
  to,
  width = 220,
  height = 36,
}: {
  activity: DailyActivity[]
  eventType?: string
  from: string | null
  to: string | null
  width?: number
  height?: number
}) {
  const byDay = new Map<string, number>()
  for (const a of activity) {
    if (a.event_type !== eventType) continue
    byDay.set(a.day, (byDay.get(a.day) ?? 0) + a.cnt)
  }
  if (byDay.size === 0) {
    return <div className="sparkline-empty muted small">no activity in range</div>
  }

  const days = [...byDay.keys()].sort()
  const start = from ?? days[0]
  const end = to ?? days[days.length - 1]
  const dayMs = 86_400_000
  const n = Math.max(
    1,
    Math.round((new Date(end).getTime() - new Date(start).getTime()) / dayMs) + 1,
  )
  const counts = new Array<number>(n).fill(0)
  for (const [day, cnt] of byDay) {
    const i = Math.round((new Date(day).getTime() - new Date(start).getTime()) / dayMs)
    if (i >= 0 && i < n) counts[i] = cnt
  }
  const max = Math.max(...counts, 1)
  const barW = width / n

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
    >
      {counts.map((c, i) =>
        c > 0 ? (
          <rect
            key={i}
            x={i * barW}
            y={height - (height * c) / max}
            width={Math.max(barW - 0.5, 0.75)}
            height={(height * c) / max}
            fill="var(--accent)"
            opacity={0.85}
          />
        ) : null,
      )}
    </svg>
  )
}
