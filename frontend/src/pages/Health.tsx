import { useData } from '../lib/DataContext'
import { instanceName } from '../lib/leads'
import { InstancePanel } from '../components/InstancePanel'
import { ago } from '../components/CampaignTable'

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

      <div className="main-grid">
        <div className="card">
          <h2>Recent sync runs</h2>
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
                  <td className="muted small ellipsis" title={r.error ?? ''}>
                    {r.error ?? ''}
                  </td>
                </tr>
              ))}
              {data.syncRuns.length === 0 && (
                <tr><td colSpan={6} className="muted">No sync runs recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <InstancePanel instances={data.instances} />
      </div>
    </>
  )
}

function duration(start: string, end: string | null): string {
  if (!end) return '—'
  const s = (new Date(end).getTime() - new Date(start).getTime()) / 1000
  if (s < 0) return '<1s' // notebook/server clock skew can produce negatives
  return s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`
}
