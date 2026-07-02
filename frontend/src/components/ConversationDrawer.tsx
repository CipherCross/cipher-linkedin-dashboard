import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useData } from '../lib/DataContext'
import { ImportHistoryPanel } from './ImportHistoryPanel'
import {
  ISSUE_KIND_LABEL, NEXT_ACTION_META, SENTIMENT_META, SENTIMENT_ORDER, SEVERITY_CLS,
  instanceName, leadKey,
} from '../lib/leads'
import type { Coaching, Lead, Message, Sentiment } from '../lib/types'

// Only the thread fields the drawer renders — fetched on demand (the global
// DataContext caps messages at 90 days / 2000 rows, too narrow for "whole chain").
type ThreadMsg = Pick<
  Message,
  'id' | 'direction' | 'body' | 'sent_at' | 'sentiment' | 'reason' | 'classified_model'
>

const fmtTime = (ts: string) =>
  new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

/** Slide-in panel showing one lead's full conversation, both directions, oldest
 *  first. Inbound replies can be reclassified in place. */
export function ConversationDrawer({
  lead,
  onClose,
}: {
  lead: Lead | null
  onClose: () => void
}) {
  const { data, refetch } = useData()
  const [rows, setRows] = useState<ThreadMsg[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [coaching, setCoaching] = useState<Coaching | null>(null)
  const [coachLoading, setCoachLoading] = useState(false)
  const [coachError, setCoachError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  // Bumped after a manual import so the thread effect refetches the new rows.
  const [reloadKey, setReloadKey] = useState(0)
  // Identifies the conversation a coach request was issued for, so a slow
  // response can't land on a drawer the user has since switched away from.
  const coachReqKey = useRef('')

  // Esc closes the drawer.
  useEffect(() => {
    if (!lead) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lead, onClose])

  // Switching leads always starts on the thread view, not a stale import panel.
  useEffect(() => setImportOpen(false), [lead])

  // Fetch the full thread whenever the active lead changes (or an import lands).
  useEffect(() => {
    if (!lead) {
      setRows(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setRows(null)
    ;(async () => {
      if (!supabase) {
        setError('Supabase is not configured.')
        setLoading(false)
        return
      }
      const { data: msgs, error: err } = await supabase
        .from('messages')
        .select('id,direction,body,sent_at,sentiment,reason,classified_model')
        .eq('instance_id', lead.instance_id)
        .eq('profile_url', lead.profile_url)
        .order('sent_at', { ascending: true })
      if (cancelled) return
      if (err) setError(err.message)
      else setRows((msgs ?? []) as ThreadMsg[])
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [lead, reloadKey])

  // On-demand coaching: ask /api/coach for this conversation. The endpoint serves
  // a cached take instantly when the thread is unchanged, else generates a fresh
  // one (a few seconds). `force` bypasses the cache for the Regenerate button.
  const loadCoaching = useCallback(
    async (force: boolean) => {
      if (!lead) return
      const k = leadKey(lead.instance_id, lead.profile_url)
      coachReqKey.current = k
      setCoachLoading(true)
      setCoachError(null)
      if (force) setCoaching(null)
      try {
        const res = await fetch('/api/coach', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            instance_id: lead.instance_id,
            profile_url: lead.profile_url,
            force,
          }),
        })
        const j = await res.json()
        if (coachReqKey.current !== k) return // user switched conversations
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
        setCoaching(j as Coaching)
      } catch (e) {
        if (coachReqKey.current === k)
          setCoachError(e instanceof Error ? e.message : String(e))
      } finally {
        if (coachReqKey.current === k) setCoachLoading(false)
      }
    },
    [lead],
  )

  // Coaching is generated on demand via the button only — auto-loading on every
  // drawer open burned model credits for conversations nobody wanted coached.
  useEffect(() => {
    coachReqKey.current = ''
    setCoaching(null)
    setCoachError(null)
    setCoachLoading(false)
  }, [lead])

  if (!lead) return null

  const campaignName =
    data?.campaigns.find((c) => c.campaign_id === lead.campaign_id)?.campaign_name ??
    lead.campaign_id
  const accountLabel = instanceName(
    data?.instances.find((i) => i.id === lead.instance_id),
    lead.instance_id,
  )

  // The lead's effective status = its most recent classified inbound reply.
  const latestInbound = rows
    ? [...rows].reverse().find((m) => m.direction === 'in' && m.body)
    : undefined
  const statusMeta = latestInbound?.sentiment
    ? SENTIMENT_META[latestInbound.sentiment]
    : null

  // Compare the live thread to what the coaching was generated against, so we can
  // nudge for a Regenerate when new messages have arrived since.
  const liveMarker =
    rows && rows.length ? `${rows[rows.length - 1].sent_at}|${rows.length}` : null
  const coachStale =
    !!coaching?.last_msg_marker && !!liveMarker && coaching.last_msg_marker !== liveMarker
  const actionMeta = coaching ? NEXT_ACTION_META[coaching.next_action] : null

  async function reclassify(msg: ThreadMsg, sentiment: Sentiment) {
    if (msg.sentiment === sentiment) return
    setSavingId(msg.id)
    setError(null)
    try {
      const res = await fetch('/api/reclassify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: msg.id, sentiment }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      setRows(
        (prev) =>
          prev?.map((m) =>
            m.id === msg.id ? { ...m, sentiment, classified_model: 'manual' } : m,
          ) ?? prev,
      )
      refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingId(null)
    }
  }

  const name = lead.full_name || lead.profile_url.replace('https://www.linkedin.com/in/', '')

  return (
    <div className="conv-overlay" onClick={onClose}>
      <aside className="conv-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="conv-head">
          <div className="conv-head-top">
            <a
              className="row-link conv-name"
              href={lead.profile_url}
              target="_blank"
              rel="noreferrer"
            >
              {name}
            </a>
            <button className="conv-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
          <div className="muted small ellipsis">
            {[lead.headline, lead.company].filter(Boolean).join(' · ') || '—'}
          </div>
          <div className="muted small">
            <Link
              className="row-link"
              to={`/campaign/${encodeURIComponent(lead.campaign_id)}`}
              onClick={onClose}
            >
              {campaignName}
            </Link>
            {' · '}
            {accountLabel}
            {!importOpen && (
              <>
                {' · '}
                <button
                  className="link-btn"
                  onClick={() => setImportOpen(true)}
                  disabled={!rows}
                  title="Paste a conversation copied from LinkedIn"
                >
                  Import history
                </button>
              </>
            )}
          </div>
          <div className="conv-status">
            <span className="muted small">Lead status</span>
            {statusMeta ? (
              <span
                className={`badge senti ${statusMeta.cls}`}
                title={latestInbound?.reason ?? ''}
              >
                {statusMeta.label}
              </span>
            ) : (
              <span className="muted small">— no classified reply</span>
            )}
            <span className="muted small">· follows the most recent reply</span>
          </div>
        </header>

        {error && <div className="banner conv-error">{error}</div>}

        {importOpen && (
          <ImportHistoryPanel
            lead={lead}
            accountName={
              data?.instances.find((i) => i.id === lead.instance_id)?.account_name ?? null
            }
            existing={rows}
            onImported={() => {
              setReloadKey((k) => k + 1)
              refetch()
            }}
            onClose={() => setImportOpen(false)}
          />
        )}

        {!importOpen && (
        <>
        <div className="conv-thread">
          {loading && <div className="muted center">Loading conversation…</div>}
          {rows && rows.length === 0 && !loading && (
            <div className="muted center">No messages in this thread.</div>
          )}
          {rows?.map((m) => {
            const inbound = m.direction === 'in'
            const meta = inbound && m.sentiment ? SENTIMENT_META[m.sentiment] : null
            return (
              <div className={`msg ${inbound ? 'in' : 'out'}`} key={m.id}>
                <div className="msg-bubble">
                  {m.body || <span className="muted">(empty)</span>}
                </div>
                <div className="msg-time muted small">{fmtTime(m.sent_at)}</div>
                {inbound && (
                  <div className="msg-reclassify">
                    {meta && (
                      <span className={`badge senti ${meta.cls}`} title={m.reason ?? ''}>
                        {meta.label}
                        {m.classified_model === 'manual' ? ' ✓' : ''}
                      </span>
                    )}
                    <div className="msg-senti-btns">
                      {SENTIMENT_ORDER.map((s) => (
                        <button
                          key={s}
                          className={`senti ${SENTIMENT_META[s].cls} ${
                            m.sentiment === s ? 'active' : ''
                          }`}
                          disabled={savingId === m.id}
                          onClick={() => reclassify(m, s)}
                        >
                          {SENTIMENT_META[s].label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="conv-coaching">
          <div className="conv-coaching-head">
            <span className="conv-coaching-title">AI coach</span>
            <span className="muted small grow">— how to earn the next reply</span>
            <button
              className="link-btn"
              onClick={() => loadCoaching(!!coaching)}
              disabled={coachLoading}
            >
              {coachLoading ? 'Coaching…' : coaching ? 'Regenerate' : 'Get coaching'}
            </button>
          </div>

          {coachError && <div className="banner conv-error">{coachError}</div>}
          {coachLoading && !coaching && (
            <div className="muted small">Reading the conversation…</div>
          )}

          {coaching && (
            <>
              {actionMeta && (
                <div className="coach-action">
                  <span className="muted small">Next</span>
                  <span className={`badge senti ${actionMeta.cls}`}>{actionMeta.label}</span>
                  {coaching.cached && <span className="muted small">· cached</span>}
                </div>
              )}

              {coaching.summary && <div className="coach-summary small">{coaching.summary}</div>}

              {coaching.issues.length > 0 && (
                <div className="coach-section">
                  <div className="coach-label muted small">What hurt your reply odds</div>
                  <div className="coach-issues">
                    {coaching.issues.map((iss, i) => (
                      <div className="coach-issue" key={i}>
                        <span className={`badge senti ${SEVERITY_CLS[iss.severity]}`}>
                          {ISSUE_KIND_LABEL[iss.kind]}
                        </span>
                        <div className="coach-issue-body small">
                          {iss.quote && <div className="coach-quote muted">“{iss.quote}”</div>}
                          <div>{iss.fix}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {coaching.tips.length > 0 && (
                <div className="coach-section">
                  <div className="coach-label muted small">How to respond now</div>
                  <ul className="coach-tips small">
                    {coaching.tips.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}

              {coachStale && (
                <div className="muted small coach-stale">
                  New messages since this was generated — Regenerate for an updated take.
                </div>
              )}
            </>
          )}
        </div>
        </>
        )}
      </aside>
    </div>
  )
}
