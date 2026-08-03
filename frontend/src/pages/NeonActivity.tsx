/**
 * The S12 slice, rendered.
 *
 * One read-only view whose data comes from Neon through `/api/activity-daily`,
 * beside the untouched Supabase path that feeds every other page. It reuses the
 * existing `ActivityChart` on purpose: the point of the slice is to prove the
 * new data path, not to build new UI.
 *
 * This page is temporary scaffolding for the G2 decision. S13 migrates
 * `DataContext` and the real pages; at that point this route can go.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityChart } from '../components/ActivityChart'
import { useAuth } from '../lib/AuthContext'
import { presetRanges, rangeToParam, type DateRange } from '../lib/leads'
import { fetchAllNeonActivity } from '../lib/neonActivity'
import type { DailyActivity } from '../lib/types'

export function NeonActivity() {
  const { user } = useAuth()
  const presets = useMemo(() => presetRanges(), [])
  // Defaults to the open range so the slice walks every page on first load —
  // the point of this page is to exercise the cursor, not to pick a pretty window.
  const [range, setRange] = useState<DateRange>(
    () => presets.find((r) => r.id === 'all') ?? presets[0],
  )
  const [instanceId, setInstanceId] = useState('s12-activity')
  const [activity, setActivity] = useState<DailyActivity[]>([])
  const [pages, setPages] = useState(0)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const started = performance.now()
    try {
      const result = await fetchAllNeonActivity(instanceId, range)
      setActivity(result.activity)
      setPages(result.pages)
      setElapsedMs(Math.round(performance.now() - started))
    } catch (err) {
      setActivity([])
      setPages(0)
      setElapsedMs(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [instanceId, range])

  useEffect(() => {
    void load()
  }, [load])

  const totalEvents = activity.reduce((sum, row) => sum + row.cnt, 0)

  return (
    <div className="page">
      <header className="page-header">
        <h1>Daily activity — served from Neon</h1>
        <p className="muted">
          Read-only slice: browser → <code>/api/activity-daily</code> → Neon,
          under row-level security. Every other page still reads Supabase.
        </p>
      </header>

      <div className="card">
        <div className="filters">
          <label>
            Instance{' '}
            <input
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
              placeholder="instance_id"
            />
          </label>
          <label>
            Range{' '}
            <select
              value={rangeToParam(range)}
              onChange={(e) => {
                const next = presets.find(
                  (r) => rangeToParam(r) === e.target.value,
                )
                if (next) setRange(next)
              }}
            >
              {presets.map((r) => (
                <option key={r.id} value={rangeToParam(r)}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Reload'}
          </button>
        </div>

        {error ? (
          <>
            <p className="error" role="alert">
              {error}
            </p>
            {/* The temporary actor bridge maps an identity-provider subject to a
                canonical Neon user id. When it has no entry, showing the
                signed-in subject is what lets an operator configure it — it is
                the viewer's own id, not anyone else's. Goes away with the
                bridge itself in S17. */}
            <p className="muted">
              Signed-in identity subject: <code>{user?.id ?? 'unknown'}</code>
            </p>
          </>
        ) : (
          <p className="muted" data-testid="neon-activity-summary">
            {activity.length.toLocaleString()} rows over {pages} page
            {pages === 1 ? '' : 's'} · {totalEvents.toLocaleString()} events
            {elapsedMs === null ? '' : ` · ${elapsedMs} ms`}
          </p>
        )}
      </div>

      <ActivityChart
        activity={activity}
        title="Daily activity (Neon)"
        from={range.from}
        to={range.to}
      />
    </div>
  )
}
