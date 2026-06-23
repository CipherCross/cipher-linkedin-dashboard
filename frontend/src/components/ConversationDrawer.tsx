import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useData } from '../lib/DataContext'
import { SENTIMENT_META, SENTIMENT_ORDER, instanceName } from '../lib/leads'
import type { Lead, Message, Sentiment } from '../lib/types'

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

  // Esc closes the drawer.
  useEffect(() => {
    if (!lead) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lead, onClose])

  // Fetch the full thread whenever the active lead changes.
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
      </aside>
    </div>
  )
}
