import { useEffect, useState } from 'react'
import { Activity, AlertCircle, CheckCircle2, FlaskConical, Megaphone, MoreHorizontal } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { authPost } from '../lib/api'
import { instanceName } from '../lib/leads'
import { InstancePanel } from '../components/InstancePanel'
import { ago } from '../lib/format'
import { listSequencePublishTargets, type SequencePublishTarget } from '../lib/sequenceBuilderApi'
import { Button, PageHeader, EmptyState } from '../ui'

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
      {/* Diagnosis first. Regenerating the Monday briefing is a rare action,
          so it lives in a menu rather than as the page's loudest button. */}
      <PageHeader
        title="Sync health"
        description="Per-instance freshness and the recent sync-run history. Agents run every 30 minutes."
        actions={isAdmin && (
          <details className="relative [&>summary]:inline-flex [&>summary]:items-center [&>summary]:gap-app-sm [&>summary]:min-h-control [&>summary]:px-app-lg [&>summary]:border [&>summary]:border-app-border-strong [&>summary]:rounded-control [&>summary]:bg-app-surface [&>summary]:text-app-text [&>summary]:text-app-body [&>summary]:font-semibold [&>summary]:cursor-pointer [&>summary]:list-none [&>summary::-webkit-details-marker]:hidden">
            <summary>
              <MoreHorizontal size={18} aria-hidden="true" />
              Actions
            </summary>
            <div className="absolute right-0 z-30 w-[min(360px,calc(100vw-48px))] mt-app-sm p-app-lg flex flex-col gap-app-md items-start border border-app-border rounded-card bg-app-surface shadow-[var(--shadow-overlay)] [&_h3]:flex [&_h3]:items-center [&_h3]:gap-app-sm [&_h3]:m-0">
              <h3>
                <Megaphone size={18} aria-hidden="true" />
                Monday briefing
              </h3>
              <p className="muted small">
                Regenerate the completed-week review from current data and post it once to Slack.
              </p>
              <Button
                variant="secondary"
                onClick={() => void rerunWeeklyBriefing()}
                loading={briefingStatus === 'running'}
                loadingLabel="Generating the briefing"
              >
                Regenerate and post
              </Button>
              {briefingMessage && (
                <span
                  className={`small ${briefingStatus === 'error' ? 'text-danger' : 'muted'}`}
                  role={briefingStatus === 'error' ? 'alert' : 'status'}
                >
                  {briefingMessage}
                </span>
              )}
            </div>
          </details>
        )}
      />

      {isAdmin && (
        <section className="card mb-[18px] [&_code]:text-app-meta" aria-labelledby="publish-compatibility-title">
          <div className="flex justify-between gap-app-lg mb-[14px] [&>div]:flex [&>div]:items-start [&>div]:gap-2.5 [&_svg]:flex-[0_0_auto] [&_svg]:mt-0.5 [&_svg]:text-app-accent [&_h2]:m-0 [&_p]:mt-[3px] [&_p]:mx-0 [&_p]:mb-0">
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

      <div className="grid grid-cols-[1fr_300px] gap-app-lg mb-app-xl max-[860px]:grid-cols-1 max-[860px]:[&>:last-child]:order-[-1]">
        <div className="card [&_table]:min-w-[520px]">
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
    <td className="max-w-[280px]">
      <button
        className={`block w-full text-left bg-none border-none cursor-pointer p-0 text-app-danger font-[inherit] text-[length:var(--text-xs)] leading-[1.4] whitespace-nowrap overflow-hidden text-ellipsis hover:text-app-text ${open ? 'open' : ''}`}
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
