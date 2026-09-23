import { useEffect, useState } from 'react'
import { Activity, AlertCircle, CheckCircle2, FlaskConical, Megaphone } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useAuth } from '../lib/AuthContext'
import { authPost } from '../lib/api'
import { instanceName } from '../lib/leads'
import { InstancePanel } from '../components/InstancePanel'
import { ago } from '../lib/format'
import { listSequencePublishTargets, type SequencePublishTarget } from '../lib/sequenceBuilderApi'
import {
  Badge, Button, Dialog, EmptyState, InlineError, PageHeader, Panel, SectionHeader,
  Table, TableFrame, type Tone,
} from '../ui'

export function Health() {
  const { data } = useData()
  const { isAdmin } = useAuth()
  const [briefingOpen, setBriefingOpen] = useState(false)
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
      {/* Diagnosis first. Regenerating the Monday briefing is a rare action, so
          it opens a dialog from the header rather than sitting as the page's
          loudest button. */}
      <PageHeader
        title="Sync health"
        description="Per-instance freshness and the recent sync-run history. Agents run every 30 minutes."
        actions={isAdmin && (
          <Button
            variant="secondary"
            icon={<Megaphone size={18} aria-hidden="true" />}
            onClick={() => setBriefingOpen(true)}
          >
            Monday briefing
          </Button>
        )}
      />

      {briefingOpen && isAdmin && (
        <Dialog
          title="Monday briefing"
          description="Regenerate the completed-week review from current data and post it once to Slack."
          onRequestClose={() => setBriefingOpen(false)}
          busy={briefingStatus === 'running'}
          busyMessage="Wait for the briefing to finish before closing."
          footer={<>
            <Button variant="secondary" disabled={briefingStatus === 'running'} onClick={() => setBriefingOpen(false)}>
              Done
            </Button>
            <Button
              variant="primary"
              loading={briefingStatus === 'running'}
              loadingLabel="Generating the briefing"
              onClick={() => void rerunWeeklyBriefing()}
            >
              Regenerate and post
            </Button>
          </>}
        >
          {briefingMessage && (
            <p
              className={briefingStatus === 'error' ? 'text-app-meta text-app-danger' : 'text-app-meta text-app-text-muted'}
              role={briefingStatus === 'error' ? 'alert' : 'status'}
            >
              {briefingMessage}
            </p>
          )}
        </Dialog>
      )}

      {isAdmin && (
        <Panel className="mb-app-xl" aria-labelledby="publish-compatibility-title">
          <SectionHeader
            id="publish-compatibility-title"
            title={
              <span className="inline-flex items-center gap-app-sm">
                <FlaskConical size={20} aria-hidden="true" className="text-app-accent" />
                Publishing compatibility
              </span>
            }
            description="Measured Linked Helper state. This is separate from sync freshness and campaign runtime."
          />
          {publishTargetsError && (
            <InlineError title="Compatibility could not be loaded" message={publishTargetsError} />
          )}
          {!publishTargetsError && publishTargets.length === 0 && (
            <EmptyState
              icon={FlaskConical}
              title="No publishing probes yet"
              hint="Probes are reported once a notebook attempts a publish."
            />
          )}
          {publishTargets.length > 0 && (
            <TableFrame scrollLabel="Publishing compatibility">
              <Table caption="Publishing compatibility" className="min-w-[720px]">
                <thead>
                  <tr>
                    <th scope="col">Notebook</th>
                    <th scope="col">Measured LH2</th>
                    <th scope="col">Observed contract</th>
                    <th scope="col">Approved contract</th>
                    <th scope="col">Canary</th>
                    <th scope="col">Publishing</th>
                  </tr>
                </thead>
                <tbody>
                  {publishTargets.map((target) => {
                    const approved = target.compatibility_state === 'approved' && target.compatible
                    const short = (value?: string | null) => value ? `${value.slice(0, 12)}…` : '—'
                    return (
                      <tr key={target.instance_id}>
                        <td>
                          <div className="font-semibold">{label(target.instance_id)}</div>
                          <div className="text-app-meta text-app-text-muted">{target.machine_key}</div>
                        </td>
                        <td>{target.measured_lh_version ?? 'Unknown'}</td>
                        <td>
                          <code className="font-mono text-app-meta" title={target.contract_fingerprint ?? undefined}>
                            {short(target.contract_fingerprint)}
                          </code>
                        </td>
                        <td>
                          <code
                            className="font-mono text-app-meta"
                            title={(target.approved_contract_fingerprint
                              ?? (target.compatibility_state === 'approved' ? target.contract_fingerprint : null)) ?? undefined}
                          >
                            {short(target.approved_contract_fingerprint
                              ?? (target.compatibility_state === 'approved' ? target.contract_fingerprint : null))}
                          </code>
                        </td>
                        <td>
                          <Badge tone={canaryTone(target)}>{canaryLabel(target)}</Badge>
                          {target.canary_error_code && (
                            <div className="text-app-meta text-app-danger mt-1">{target.canary_error_code}</div>
                          )}
                        </td>
                        <td>
                          <Badge
                            tone={approved ? 'success' : 'danger'}
                            icon={approved
                              ? <CheckCircle2 size={14} aria-hidden="true" />
                              : <AlertCircle size={14} aria-hidden="true" />}
                          >
                            {approved ? 'Ready' : 'Blocked'}
                          </Badge>
                          {!approved && (
                            <div className="text-app-meta text-app-text-muted mt-1">
                              {target.compatibility_state?.replace(/_/g, ' ') || target.compatibility_error_code || 'unknown'}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </Table>
            </TableFrame>
          )}
        </Panel>
      )}

      <div className="grid grid-cols-[1fr_300px] gap-app-lg mb-app-xl max-[860px]:grid-cols-1 max-[860px]:[&>:last-child]:order-[-1]">
        <Panel>
          <SectionHeader title="Recent sync runs" />
          <TableFrame scrollLabel="Recent sync runs" maxHeight="calc(100vh - 300px)">
            <Table caption="Recent sync runs" className="min-w-[520px]">
              <thead>
                <tr>
                  <th scope="col">Instance</th>
                  <th scope="col">Started</th>
                  <th scope="col" className="text-right">Duration</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="text-right">Rows</th>
                  <th scope="col">Error</th>
                </tr>
              </thead>
              <tbody>
                {data.syncRuns.slice(0, 50).map((r) => (
                  <tr key={r.id}>
                    <td className="text-app-text-muted">{label(r.instance_id)}</td>
                    <td className="text-app-text-muted" title={r.started_at}>{ago(r.started_at)}</td>
                    <td className="text-right tabular-nums text-app-text-muted">{duration(r.started_at, r.finished_at)}</td>
                    <td>
                      <Badge tone={runStatusTone(r.status)}>{r.status}</Badge>
                    </td>
                    <td className="text-right tabular-nums">{r.rows_upserted ?? '—'}</td>
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
            </Table>
          </TableFrame>
        </Panel>
        <InstancePanel instances={data.instances} runs={data.syncRuns} />
      </div>
    </>
  )
}

/** Sync-run status → tone. Mirrors the previous `.uptime-tick`/`.badge.status-*`
 *  colours: ok = success, error = danger, running = warning. */
function runStatusTone(status: string): Tone {
  return status === 'ok' ? 'success' : status === 'error' ? 'danger' : status === 'running' ? 'warning' : 'neutral'
}

function canaryTone(target: SequencePublishTarget): Tone {
  const state = target.canary_state
    ?? (target.compatibility_state === 'canary_pending' ? 'pending' : null)
  switch (state) {
    case 'succeeded': return 'success'
    case 'failed':
    case 'rejected': return 'danger'
    case 'pending':
    case 'claimed': return 'warning'
    default: return 'neutral'
  }
}

function canaryLabel(target: SequencePublishTarget): string {
  return target.canary_state
    ? target.canary_state.replace(/_/g, ' ')
    : target.compatibility_state === 'canary_pending' ? 'pending' : 'not required'
}

/** The error column — one truncated line by default, expands to the full text on
 *  click (previously only reachable via the browser title tooltip). */
function ErrorCell({ error }: { error: string | null }) {
  const [open, setOpen] = useState(false)
  if (!error) return <td className="text-app-text-muted">—</td>
  return (
    <td className="max-w-[280px]">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start px-0 text-app-danger hover:text-app-text"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        title={open ? 'Collapse' : 'Show full error'}
      >
        <span className={open ? 'block w-full whitespace-pre-wrap break-words text-left' : 'block w-full truncate text-left'}>
          {error}
        </span>
      </Button>
    </td>
  )
}

function duration(start: string, end: string | null): string {
  if (!end) return '—'
  const s = (new Date(end).getTime() - new Date(start).getTime()) / 1000
  if (s < 0) return '<1s' // notebook/server clock skew can produce negatives
  return s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`
}
