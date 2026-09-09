import { useEffect, useState } from 'react'
import { Activity, AlertCircle, CheckCircle2, FlaskConical, Megaphone } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { authPost } from '../lib/api'
import { instanceName } from '../lib/leads'
import { InstancePanel } from '../components/InstancePanel'
import { EmptyState } from '../components/EmptyState'
import { ago } from '../lib/format'
import { listSequencePublishTargets, type SequencePublishTarget } from '../lib/sequenceBuilderApi'

export function Health() {
  const { data } = useData()
  const { isAdmin } = useAuth()
  const [briefingStatus, setBriefingStatus] = useState<
    'idle' | 'running' | 'done' | 'error'
  >('idle')
  const [briefingMessage, setBriefingMessage] = useState('')
  const [publishTargets, setPublishTargets] = useState<SequencePublishTarget[]>([])
  const [publishTargetsError, setPublishTargetsError] = useState('')

  useEffect(() => {
    if (!isAdmin) return
    void listSequencePublishTargets()
      .then(setPublishTargets)
      .catch((error) => setPublishTargetsError(error instanceof Error ? error.message : 'Could not load publishing compatibility.'))
  }, [isAdmin])
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

      {isAdmin && (
        <section className="card publish-compatibility-card" aria-labelledby="publish-compatibility-title">
          <div className="publish-compatibility-heading">
            <div><FlaskConical size={20} aria-hidden="true" /><div><h2 id="publish-compatibility-title">Publishing compatibility</h2><p className="muted small">Measured Linked Helper state. This is separate from sync freshness and campaign runtime.</p></div></div>
          </div>
          {publishTargetsError && <div className="sequence-publish-state error"><AlertCircle size={18} /><div><strong>Compatibility could not be loaded</strong><p>{publishTargetsError}</p></div></div>}
          {!publishTargetsError && publishTargets.length === 0 && <p className="muted small">No publishing probes have been reported yet.</p>}
          {publishTargets.length > 0 && <div className="table-scroll"><table><thead><tr><th>Notebook</th><th>Measured LH2</th><th>Observed contract</th><th>Approved contract</th><th>Canary</th><th>Publishing</th></tr></thead><tbody>{publishTargets.map((target) => {
            const approved = target.compatibility_state === 'approved' && target.compatible
            const short = (value?: string | null) => value ? `${value.slice(0, 12)}…` : '—'
            return <tr key={target.instance_id}>
              <td><strong>{label(target.instance_id)}</strong><div className="muted small">{target.machine_key}</div></td>
              <td>{target.measured_lh_version ?? 'Unknown'}</td>
              <td><code title={target.contract_fingerprint ?? undefined}>{short(target.contract_fingerprint)}</code></td>
              <td><code title={(target.approved_contract_fingerprint ?? (target.compatibility_state === 'approved' ? target.contract_fingerprint : null)) ?? undefined}>{short(target.approved_contract_fingerprint ?? (target.compatibility_state === 'approved' ? target.contract_fingerprint : null))}</code></td>
              <td><span className={`badge compatibility-${target.canary_state ?? target.compatibility_state ?? 'unknown'}`}>{target.canary_state ? target.canary_state.replace(/_/g, ' ') : target.compatibility_state === 'canary_pending' ? 'pending' : 'not required'}</span>{target.canary_error_code && <div className="text-danger small">{target.canary_error_code}</div>}</td>
              <td><span className={`badge ${approved ? 'status-success' : 'status-failed'}`}>{approved ? <><CheckCircle2 size={12} /> Ready</> : <><AlertCircle size={12} /> Blocked</>}</span>{!approved && <div className="muted small">{target.compatibility_state?.replace(/_/g, ' ') || target.compatibility_error_code || 'unknown'}</div>}</td>
            </tr>
          })}</tbody></table></div>}
        </section>
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
