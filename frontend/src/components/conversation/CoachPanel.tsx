import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Sparkles, X } from 'lucide-react'
import { authFetch } from '../../lib/api'
import { ago } from '../../lib/format'
import { ISSUE_KIND_LABEL, NEXT_ACTION_META, SEVERITY_TONE, leadKey } from '../../lib/leads'
import type { Coaching, Lead } from '../../lib/types'
import { Badge, Button, IconButton, InlineError, SegmentedControl } from '../../ui'
import { CopyButton } from '../CopyButton'
import { Skeleton } from '../Skeleton'

/**
 * The conversation's AI coach: generated on demand only (auto-loading on every
 * open burned model credits for conversations nobody wanted coached), keyed to
 * the open lead so a slow answer cannot land on another conversation.
 */
export function useCoaching(lead: Lead | null) {
  const [coaching, setCoaching] = useState<Coaching | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestKey = useRef('')

  useEffect(() => {
    requestKey.current = ''
    setCoaching(null)
    setError(null)
    setLoading(false)
  }, [lead?.instance_id, lead?.profile_url])

  /** `force` bypasses the server cache (Regenerate). */
  const load = useCallback(async (force: boolean) => {
    if (!lead) return
    const key = leadKey(lead.instance_id, lead.profile_url)
    requestKey.current = key
    setLoading(true)
    setError(null)
    try {
      const res = await authFetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instance_id: lead.instance_id,
          profile_url: lead.profile_url,
          campaign_id: lead.campaign_id,
          force,
        }),
      })
      const body = await res.json()
      if (requestKey.current !== key) return
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setCoaching(body as Coaching)
    } catch (e) {
      if (requestKey.current === key) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (requestKey.current === key) setLoading(false)
    }
  }, [lead])

  return { coaching, loading, error, load }
}

type CoachView = 'ideas' | 'feedback'

/**
 * The coach's side panel inside the conversation workspace. Ideas first —
 * they are what the SDR came for — and feedback on the SDR's hand-written
 * messages one tab away. Sequence messages are reviewed on the Sequences side,
 * so the coach never critiques them, and says so.
 */
export function CoachPanel({
  id,
  state,
  threadSize,
  threadLastSentAt,
  threadCapped,
  onClose,
}: {
  id: string
  state: ReturnType<typeof useCoaching>
  /** The thread on screen, to tell when the take predates new messages. */
  threadSize: number
  threadLastSentAt: string | null
  /** The on-screen thread is a capped window, so its size proves nothing. */
  threadCapped: boolean
  onClose: () => void
}) {
  const { coaching, loading, error, load } = state
  const [view, setView] = useState<CoachView>('ideas')
  useEffect(() => { setView('ideas') }, [coaching?.coached_at])

  const stale = !!coaching && threadSize > 0 && (
    (!threadCapped && coaching.scope.message_count !== threadSize)
    || (threadLastSentAt !== null && coaching.scope.last_sent_at !== null
      && new Date(threadLastSentAt).getTime() !== new Date(coaching.scope.last_sent_at).getTime())
  )
  const action = coaching ? NEXT_ACTION_META[coaching.next_action] : null

  return (
    <aside id={id} aria-label="AI coach" className="conversation-coach">
      <div className="conversation-pane-head">
        <span className="inline-flex items-center gap-app-sm min-w-0">
          <Sparkles size={16} className="text-app-accent shrink-0" aria-hidden="true" />
          <h3 className="conversation-pane-title">AI coach</h3>
          {coaching?.coached_at && (
            <span className="text-app-meta text-app-text-muted truncate" title={new Date(coaching.coached_at).toLocaleString('en-GB')}>
              {coaching.cached ? 'Saved' : 'Generated'} {ago(coaching.coached_at)}
            </span>
          )}
        </span>
        <span className="ml-auto inline-flex items-center gap-app-xs">
          {coaching && (
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw aria-hidden="true" />}
              loading={loading}
              loadingLabel="Regenerating…"
              onClick={() => void load(true)}
            >
              Regenerate
            </Button>
          )}
          <IconButton label="Close AI coach" icon={<X aria-hidden="true" />} onClick={onClose} />
        </span>
      </div>

      <div className="conversation-pane-body flex flex-col gap-group">
        {error && <InlineError title="Coaching failed." message={error} onRetry={() => void load(!!coaching)} />}

        {!coaching && !loading && (
          <div className="flex flex-col items-start gap-group p-card rounded-card bg-app-surface-2">
            <div className="flex flex-col gap-app-xs">
              <strong className="text-app-table">Ideas for your next message</strong>
              <p className="m-0 text-app-table text-app-text-secondary">
                Reads this conversation and drafts 10–15 different next messages to choose from,
                plus feedback on the messages you wrote by hand.
              </p>
              <p className="m-0 text-app-meta text-app-text-muted">
                Sequence messages are skipped — they are reviewed on the Sequences side.
              </p>
            </div>
            <Button variant="primary" icon={<Sparkles aria-hidden="true" />} onClick={() => void load(false)}>
              Generate ideas
            </Button>
          </div>
        )}

        {loading && !coaching && (
          <div className="flex flex-col gap-group" aria-hidden="true">
            <p className="m-0 text-app-meta text-app-text-muted">Reading the conversation…</p>
            <Skeleton height={64} radius="var(--radius-card)" />
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={96} radius="var(--radius-card)" />)}
          </div>
        )}

        {coaching && (
          <>
            <section className="flex flex-col gap-stack p-card rounded-card bg-app-surface-2" aria-label="Summary">
              {action && (
                <span className="inline-flex items-center gap-app-sm">
                  <span className="text-app-meta text-app-text-muted">Next move</span>
                  <Badge tone={action.tone}>{action.label}</Badge>
                </span>
              )}
              {coaching.summary && <p className="m-0 text-app-table">{coaching.summary}</p>}
              <p className="m-0 text-app-meta text-app-text-muted">
                {scopeLine(coaching.scope)}
              </p>
            </section>

            {stale && (
              <p className="m-0 text-app-meta text-app-warning" role="status">
                New messages since this was generated — Regenerate for an updated take.
              </p>
            )}

            <SegmentedControl
              label="Coach view"
              value={view}
              onChange={setView}
              items={[
                { id: 'ideas', label: 'Ideas', count: coaching.ideas.length },
                { id: 'feedback', label: 'Feedback', count: coaching.issues.length },
              ]}
            />

            {view === 'ideas' && (
              coaching.ideas.length === 0
                ? <p className="m-0 text-app-meta text-app-text-muted">No ideas this time — Regenerate to try again.</p>
                : (
                  <ol className="list-none m-0 p-0 flex flex-col gap-stack" aria-label="Message ideas">
                    {coaching.ideas.map((idea, index) => (
                      <li key={index} className="conversation-idea">
                        <div className="flex items-center gap-app-sm">
                          <span className="conversation-idea__index" aria-hidden="true">{index + 1}</span>
                          <span className="text-app-meta font-semibold text-app-text-secondary truncate">{idea.angle || 'Option'}</span>
                          <CopyButton className="ml-auto" text={idea.message} title={`Copy idea ${index + 1}`} />
                        </div>
                        <p className="m-0 text-app-table whitespace-pre-wrap [overflow-wrap:anywhere]">{idea.message}</p>
                        {idea.why && <p className="m-0 text-app-meta text-app-text-muted">{idea.why}</p>}
                      </li>
                    ))}
                  </ol>
                )
            )}

            {view === 'feedback' && (
              coaching.issues.length === 0
                ? (
                  <p className="m-0 text-app-meta text-app-text-muted">
                    {coaching.scope.hand_written === 0
                      ? 'Nothing to review yet — every message you sent here came from the sequence.'
                      : 'Nothing to fix in your hand-written messages.'}
                  </p>
                )
                : (
                  <ul className="list-none m-0 p-0 flex flex-col gap-group" aria-label="Feedback on your messages">
                    {coaching.issues.map((issue, index) => (
                      <li key={index} className="flex flex-col items-start gap-app-xs pl-app-sm border-l-2 border-app-border">
                        <Badge tone={SEVERITY_TONE[issue.severity]}>{ISSUE_KIND_LABEL[issue.kind]}</Badge>
                        {issue.quote && <q className="text-app-table italic text-app-text-muted [overflow-wrap:anywhere]">{issue.quote}</q>}
                        <p className="m-0 text-app-table">{issue.fix}</p>
                      </li>
                    ))}
                  </ul>
                )
            )}
          </>
        )}
      </div>
    </aside>
  )
}

function scopeLine(scope: Coaching['scope']): string {
  const own = `${scope.hand_written} hand-written ${scope.hand_written === 1 ? 'message' : 'messages'} reviewed`
  if (!scope.sequence) return own
  return `${own} · ${scope.sequence} sequence ${scope.sequence === 1 ? 'message' : 'messages'} skipped`
}
