import { useState } from 'react'
import { Activity } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { instanceName } from '../lib/leads'
import { InstancePanel } from '../components/InstancePanel'
import { EmptyState } from '../components/EmptyState'
import { ago } from '../lib/format'

export function Health() {
  const { data } = useData()
  if (!data) return null

  const label = (id: string) =>
    instanceName(data.instances.find((i) => i.id === id), id)

  return (
    <>
      <header>
        <div>
          <h1>Sync health</h1>
          <div className="muted small">
            Per-instance freshness and the recent sync-run history (agents run
            every 30 minutes).
          </div>
        </div>
      </header>

      <div className="main-grid health-grid">
        <div className="card health-runs">
          <h2>Recent sync runs</h2>
          <div className="table-scroll tall">
          <table>
            <thead>
              <tr>
                <th>Instance</th>
                <th>Started</th>
                <th className="num">Duration</th>
                <th>Status</th>
                <th className="num">Rows</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {data.syncRuns.slice(0, 50).map((r) => (
                <tr key={r.id}>
                  <td className="muted">{label(r.instance_id)}</td>
                  <td className="muted" title={r.started_at}>{ago(r.started_at)}</td>
                  <td className="num muted">{duration(r.started_at, r.finished_at)}</td>
                  <td>
                    <span className={`badge status-${r.status}`}>{r.status}</span>
                  </td>
                  <td className="num">{r.rows_upserted ?? '—'}</td>
                  <ErrorCell error={r.error} />
                </tr>
              ))}
              {data.syncRuns.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      icon={Activity}
                      title="No sync runs yet"
                      hint="Runs appear here once an agent syncs a notebook (agents run every ~30 min)."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
        <InstancePanel instances={data.instances} runs={data.syncRuns} />
      </div>
    </>
  )
}

/** The error column — one truncated line by default, expands to the full text on
 *  click (previously only reachable via the browser title tooltip). */
function ErrorCell({ error }: { error: string | null }) {
  const [open, setOpen] = useState(false)
  if (!error) return <td className="muted">—</td>
  return (
    <td className="error-cell">
      <button
        className={`error-cell-btn ${open ? 'open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Collapse' : 'Show full error'}
      >
        {error}
      </button>
    </td>
  )
}

function duration(start: string, end: string | null): string {
  if (!end) return '—'
  const s = (new Date(end).getTime() - new Date(start).getTime()) / 1000
  if (s < 0) return '<1s' // notebook/server clock skew can produce negatives
  return s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`
}
