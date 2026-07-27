import { useState } from 'react'
import { Activity, Megaphone } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { authPost } from '../lib/api'
import { instanceName } from '../lib/leads'
import { InstancePanel } from '../components/InstancePanel'
import { EmptyState } from '../components/EmptyState'
import { ago } from '../lib/format'

export function Health() {
  const { data } = useData()
  const { isAdmin } = useAuth()
  const [briefingStatus, setBriefingStatus] = useState<
    'idle' | 'running' | 'done' | 'error'
  >('idle')
  const [briefingMessage, setBriefingMessage] = useState('')
  if (!data) return null

  const label = (id: string) =>
    instanceName(data.instances.find((i) => i.id === id), id)

  const rerunWeeklyBriefing = async () => {
    setBriefingStatus('running')
    setBriefingMessage('Generating the briefing from current data…')
    try {
      const response = await authPost('/api/briefing?kind=weekly', {
        full: true,
        send_slack: true,
      })
      const result = await response.json() as {
        status?: string
        error?: string
      }
      if (!response.ok || result.status !== 'done') {
        throw new Error(result.error || 'The briefing did not finish.')
      }
      setBriefingStatus('done')
      setBriefingMessage('Posted to Slack.')
    } catch (error) {
      setBriefingStatus('error')
      setBriefingMessage(
        error instanceof Error ? error.message : 'Could not generate the briefing.',
      )
    }
  }

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

      {isAdmin && (
        <div className="card briefing-rerun">
          <div className="briefing-rerun-copy">
            <Megaphone size={20} aria-hidden="true" />
            <div>
              <h2>Monday briefing</h2>
              <div className="muted small">
                Regenerate the completed-week review from current data and post it once to Slack.
              </div>
            </div>
          </div>
          <div className="briefing-rerun-action">
            {briefingMessage && (
              <span
                className={`small ${
                  briefingStatus === 'error' ? 'text-danger' : 'muted'
                }`}
                role={briefingStatus === 'error' ? 'alert' : 'status'}
              >
                {briefingMessage}
              </span>
            )}
            <button
              className="btn accent"
              type="button"
              disabled={briefingStatus === 'running'}
              onClick={() => void rerunWeeklyBriefing()}
            >
              {briefingStatus === 'running' ? 'Generating…' : 'Regenerate and post'}
            </button>
          </div>
        </div>
      )}

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
        aria-expanded={open}
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
