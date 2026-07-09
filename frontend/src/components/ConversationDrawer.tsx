import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, Loader2, MessagesSquare, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import { usePipelineActions } from '../lib/usePipelineActions'
import { ImportHistoryPanel } from './ImportHistoryPanel'
import { LeadNotesPanel } from './LeadNotesPanel'
import { LostReasonModal } from './LostReasonModal'
import { InitialsAvatar } from './Avatar'
import { EmptyState } from './EmptyState'
import { Skeleton } from './Skeleton'
import {
  ISSUE_KIND_LABEL, NEXT_ACTION_META, SENTIMENT_META, SENTIMENT_ORDER, SEVERITY_CLS,
  instanceName, leadKey,
} from '../lib/leads'
import { PIPELINE_STAGES, stageById, substatusLabel } from '../lib/pipeline'
import { clockTime, dayHeading } from '../lib/format'
import type { Coaching, Lead, Message, Sentiment } from '../lib/types'

// Only the thread fields the drawer renders — fetched on demand (the global
// DataContext caps messages at 90 days / 2000 rows, too narrow for "whole chain").
type ThreadMsg = Pick<
  Message,
  'id' | 'direction' | 'body' | 'sent_at' | 'sentiment' | 'reason' | 'classified_model' | 'source'
>

/** Slide-in panel showing one lead's full conversation, both directions, oldest
 *  first. Inbound replies can be reclassified in place. */
export function ConversationDrawer({
  lead,
  closing,
  onClose,
}: {
  lead: Lead | null
  closing?: boolean
  onClose: () => void
}) {
  const { data, refetch } = useData()
  const toast = useToast()
  const { setStage, assign, members } = usePipelineActions()
  const [pendingLost, setPendingLost] = useState(false)
  const [rows, setRows] = useState<ThreadMsg[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The message + target sentiment currently being saved (for the inline spinner).
  const [saving, setSaving] = useState<{ id: number; to: Sentiment } | null>(null)
  // Which inbound bubble has its sentiment button row revealed (badge clicked).
  const [openSentiId, setOpenSentiId] = useState<number | null>(null)
  const [coaching, setCoaching] = useState<Coaching | null>(null)
  const [coachLoading, setCoachLoading] = useState(false)
  const [coachError, setCoachError] = useState<string | null>(null)
  const [coachOpen, setCoachOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  // Bumped after a manual import so the thread effect refetches the new rows.
  const [reloadKey, setReloadKey] = useState(0)
  // Identifies the conversation a coach request was issued for, so a slow
  // response can't land on a drawer the user has since switched away from.
  const coachReqKey = useRef('')

  // Esc closes; Tab is trapped inside the drawer while it's open (modal dialog).
  useEffect(() => {
    if (!lead) return
    const el = drawerRef.current
    // Move focus into the dialog so keyboard users start inside it.
    el?.focus()
    const focusables = () =>
      Array.from(
        el?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((n) => n.offsetParent !== null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !el) return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && (active === first || active === el)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lead, onClose])

  // Switching leads always starts on the thread view, not a stale import panel.
  useEffect(() => setImportOpen(false), [lead])

  // Lock the background from scrolling while the drawer is open (restore on close).
  useEffect(() => {
    if (!lead) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [lead])

  // The thread renders oldest-first; triage users click a recent reply, so open
  // at the newest message. Re-runs after an import bumps reloadKey.
  useEffect(() => {
    if (!rows || importOpen) return
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows, reloadKey, importOpen])

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
        .select('id,direction,body,sent_at,sentiment,reason,classified_model,source')
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
    setCoachOpen(false)
  }, [lead])

  if (!lead) return null

  // The `lead` prop is a snapshot captured when the drawer opened; pipeline
  // fields (stage/substatus/assignee) mutate in place via patchLead, so read
  // the live row from context for those controls.
  const live = data?.leads.find((x) => x.id === lead.id) ?? lead
  const liveStage = stageById(live.pipeline_stage)

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
    setSaving({ id: msg.id, to: sentiment })
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
      setOpenSentiId(null)
      refetch()
    } catch (e) {
      // A banner at the top of a long thread scrolls off-screen — toast instead.
      toast.error(`Couldn't reclassify: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(null)
    }
  }

  const name = lead.full_name || lead.profile_url.replace('https://www.linkedin.com/in/', '')

  return (
    <div className={`conv-overlay ${closing ? 'closing' : ''}`} onClick={onClose}>
      <aside
        className="conv-drawer"
        onClick={(e) => e.stopPropagation()}
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Conversation with ${name}`}
        tabIndex={-1}
      >
        <header className="conv-head">
          <div className="conv-head-top">
            <InitialsAvatar name={name} size={40} />
            <div className="conv-head-id">
              <div className="conv-head-name-row">
                <a
                  className="row-link conv-name"
                  href={lead.profile_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {name}
                </a>
                <a
                  className="li-link"
                  href={lead.profile_url}
                  target="_blank"
                  rel="noreferrer"
                  title="Open LinkedIn profile"
                >
                  in
                </a>
              </div>
              <div className="muted small ellipsis" title={[lead.headline, lead.company].filter(Boolean).join(' · ')}>
                {[lead.headline, lead.company].filter(Boolean).join(' · ') || '—'}
              </div>
            </div>
            <button className="conv-close" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="conv-status">
            <Link
              className="row-link muted small"
              to={`/campaign/${encodeURIComponent(lead.campaign_id)}`}
              onClick={onClose}
            >
              {campaignName}
            </Link>
            <span className="muted small">· {accountLabel}</span>
            {statusMeta ? (
              <span
                className={`badge senti ${statusMeta.cls}`}
                title={latestInbound?.reason ?? 'Follows the most recent reply'}
              >
                {statusMeta.label}
              </span>
            ) : (
              <span className="badge">No reply yet</span>
            )}
            {/* Hidden while the empty state shows — that state carries its own
                Import-history CTA, and two identical links one viewport apart
                read as clutter. */}
            {!importOpen && !(rows && rows.length === 0) && (
              <button
                className="link-btn conv-import-btn"
                onClick={() => setImportOpen(true)}
                disabled={!rows}
                title="Paste a conversation copied from LinkedIn"
              >
                Import history
              </button>
            )}
          </div>

          <div className="conv-pipeline-controls">
            <label className="filter-field">
              <span className="filter-label">Stage</span>
              <select
                value={live.pipeline_stage ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'lost') setPendingLost(true)
                  else void setStage(live, v || null)
                }}
              >
                <option value="">Not in pipeline</option>
                {PIPELINE_STAGES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </label>
            {liveStage && liveStage.substatuses.length > 0 && (
              <label className="filter-field">
                <span className="filter-label">Substatus</span>
                <select
                  value={live.pipeline_substatus ?? ''}
                  onChange={(e) =>
                    void setStage(live, live.pipeline_stage, { substatus: e.target.value || null })
                  }
                >
                  <option value="">—</option>
                  {liveStage.substatuses.map((s) => (
                    <option key={s} value={s}>{substatusLabel(s)}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="filter-field">
              <span className="filter-label">Owner</span>
              <select
                value={String(live.assigned_to ?? '')}
                onChange={(e) => void assign(live, e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={String(m.id)}>{m.name}</option>
                ))}
              </select>
            </label>
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
        <div className="conv-thread" ref={threadRef}>
          {loading && (
            <div className="conv-thread-skeleton" aria-hidden="true">
              <Skeleton className="sk-bubble in" width="68%" height={44} radius="10px 10px 10px 2px" />
              <Skeleton className="sk-bubble out" width="54%" height={32} radius="10px 10px 2px 10px" />
              <Skeleton className="sk-bubble in" width="60%" height={38} radius="10px 10px 10px 2px" />
            </div>
          )}
          {rows && rows.length === 0 && !loading && (
            <EmptyState
              icon={MessagesSquare}
              title="No messages yet"
              hint="LH2 stops capturing a thread once you take it over by hand. Paste the LinkedIn conversation to import its history."
              action={
                <button className="link-btn" onClick={() => setImportOpen(true)}>
                  Import history
                </button>
              }
            />
          )}
          {rows?.map((m, idx) => {
            const inbound = m.direction === 'in'
            const meta = inbound && m.sentiment ? SENTIMENT_META[m.sentiment] : null
            const prev = idx > 0 ? rows[idx - 1] : null
            const newDay =
              !prev || new Date(prev.sent_at).toDateString() !== new Date(m.sent_at).toDateString()
            return (
              <Fragment key={m.id}>
              {newDay && (
                <div className="msg-day-sep"><span>{dayHeading(m.sent_at)}</span></div>
              )}
              <div className={`msg ${inbound ? 'in' : 'out'}`}>
                <div className="msg-bubble">
                  {m.body || <span className="muted">(empty)</span>}
                </div>
                <div className="msg-meta">
                  <span className="msg-time muted small">{clockTime(m.sent_at)}</span>
                  {m.source === 'manual' && (
                    <span
                      className="msg-imported"
                      title="Imported from a pasted LinkedIn thread — this time is the real message time, not an LH2 action-run time"
                    >
                      imported
                    </span>
                  )}
                </div>
                {inbound && (
                  <div className={`msg-reclassify ${openSentiId === m.id ? 'open' : ''}`}>
                    <button
                      type="button"
                      className={`msg-senti-badge badge senti ${meta ? meta.cls : ''}`}
                      title={meta ? (m.reason ?? 'Click to reclassify') : 'Set sentiment'}
                      onClick={() => setOpenSentiId(openSentiId === m.id ? null : m.id)}
                    >
                      {meta ? (
                        <>
                          {meta.label}
                          {m.classified_model === 'manual' ? ' ✓' : ''}
                        </>
                      ) : (
                        'Set sentiment'
                      )}
                    </button>
                    <div className="msg-senti-btns">
                      {SENTIMENT_ORDER.map((s) => {
                        const savingThis = saving?.id === m.id && saving.to === s
                        return (
                          <button
                            key={s}
                            className={`senti ${SENTIMENT_META[s].cls} ${
                              m.sentiment === s ? 'active' : ''
                            }`}
                            disabled={saving?.id === m.id}
                            onClick={() => reclassify(m, s)}
                          >
                            {savingThis && <Loader2 size={11} className="spin" />}
                            {SENTIMENT_META[s].label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
              </Fragment>
            )
          })}
        </div>

        <div className={`conv-coaching ${coachOpen ? 'open' : ''}`}>
          <div className="conv-coaching-head">
            <button
              className="conv-coaching-toggle"
              onClick={() => setCoachOpen((o) => !o)}
              aria-expanded={coachOpen}
            >
              {coachOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              <span className="conv-coaching-title">AI coach</span>
            </button>
            {actionMeta && (
              <span className={`badge senti ${actionMeta.cls}`} title="Suggested next action">
                {actionMeta.label}
              </span>
            )}
            <span className="grow" />
            <button
              className="link-btn"
              onClick={() => {
                setCoachOpen(true)
                loadCoaching(!!coaching)
              }}
              disabled={coachLoading}
            >
              {coachLoading ? 'Coaching…' : coaching ? 'Regenerate' : 'Get coaching'}
            </button>
          </div>

          {coachOpen && (
          <div className="conv-coaching-body">
          {coachError && <div className="banner conv-error">{coachError}</div>}
          {coachLoading && !coaching && (
            <div className="muted small">Reading the conversation…</div>
          )}
          {!coaching && !coachLoading && !coachError && (
            <div className="muted small">Get an AI read on what to say next to earn a reply.</div>
          )}

          {coaching && (
            <>
              {coaching.cached && <div className="muted small coach-cached">Cached take</div>}

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
          )}
        </div>

        <LeadNotesPanel lead={lead} />
        </>
        )}
      </aside>

      {pendingLost && (
        <LostReasonModal
          leadName={live.full_name}
          onCancel={() => setPendingLost(false)}
          onConfirm={(reason) => {
            setPendingLost(false)
            void setStage(live, 'lost', { lostReason: reason })
          }}
        />
      )}
    </div>
  )
}
