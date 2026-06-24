import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useData } from '../lib/DataContext'
import {
  SENTIMENT_META, SENTIMENT_ORDER, instanceName, latestRepliesByLead, leadKey,
} from '../lib/leads'
import { ago } from '../components/CampaignTable'
import { useConversation } from '../lib/ConversationContext'
import type { CoachingDigest, Sentiment } from '../lib/types'

const RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 },
]

/** Operational view: everyone who replied recently, newest first — the
 *  follow-up worklist for the team, now sorted by the reply's decision. */
export function Replies() {
  const { data, refetch } = useData()
  const { openConversation } = useConversation()
  const [rangeDays, setRangeDays] = useState(30)
  const [filter, setFilter] = useState<Sentiment | 'unclassified' | null>(null)
  const [classifying, setClassifying] = useState(false)
  const [classifyMsg, setClassifyMsg] = useState<string | null>(null)
  const [digests, setDigests] = useState<Record<string, CoachingDigest>>({})
  const [digestOpen, setDigestOpen] = useState(false)
  const [digestBusy, setDigestBusy] = useState<string | null>(null)
  const [digestErr, setDigestErr] = useState<string | null>(null)

  // The per-account self-correction digests (coaching_digest), read anon like the
  // rest of the dashboard; (re)computed on demand via the Refresh button below.
  // Reloads whenever the dashboard data reloads (mount, interval, post-classify
  // refetch) so the digests stay in sync rather than only fetching once on mount.
  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    ;(async () => {
      const { data: rows } = await supabase!.from('coaching_digest').select('*')
      if (cancelled || !rows) return
      const map: Record<string, CoachingDigest> = {}
      for (const r of rows as CoachingDigest[]) map[r.instance_id] = r
      setDigests(map)
    })()
    return () => {
      cancelled = true
    }
  }, [data])

  async function refreshDigest(instance_id: string) {
    setDigestBusy(instance_id)
    setDigestErr(null)
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instance_id, mode: 'digest' }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      setDigests((prev) => ({
        ...prev,
        [instance_id]: {
          instance_id,
          summary: j.summary ?? null,
          patterns: j.patterns ?? [],
          computed_at: j.computed_at ?? null,
          model: j.model ?? null,
        },
      }))
    } catch (e) {
      setDigestErr(e instanceof Error ? e.message : String(e))
    } finally {
      setDigestBusy(null)
    }
  }

  // Latest inbound message (body + its classification) per lead.
  const snippets = useMemo(() => latestRepliesByLead(data?.messages ?? []), [data])

  const repliesAll = useMemo(() => {
    if (!data) return []
    const since = rangeDays > 0 ? Date.now() - rangeDays * 86_400_000 : 0
    return data.leads
      .filter((l) => l.replied_at && new Date(l.replied_at).getTime() >= since)
      .sort((a, b) => b.replied_at!.localeCompare(a.replied_at!))
  }, [data, rangeDays])

  // Bucket counts over the date range (one bucket per sentiment + unclassified).
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const l of repliesAll) {
      const s = snippets.get(leadKey(l.instance_id, l.profile_url))?.sentiment ?? 'unclassified'
      c[s] = (c[s] ?? 0) + 1
    }
    return c
  }, [repliesAll, snippets])

  const replies = useMemo(() => {
    if (!filter) return repliesAll
    return repliesAll.filter(
      (l) =>
        (snippets.get(leadKey(l.instance_id, l.profile_url))?.sentiment ?? 'unclassified') ===
        filter
    )
  }, [repliesAll, filter, snippets])

  if (!data) return null

  const campaignName = (id: string) =>
    data.campaigns.find((c) => c.campaign_id === id)?.campaign_name ?? id
  const instanceLabel = (id: string) =>
    instanceName(data.instances.find((i) => i.id === id), id)

  async function classify() {
    setClassifying(true)
    setClassifyMsg(null)
    try {
      const res = await fetch('/api/classify', { method: 'POST' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      setClassifyMsg(
        `Classified ${j.classified} repl${j.classified === 1 ? 'y' : 'ies'}` +
          (j.remaining ? `, ${j.remaining} still queued` : ' — all caught up')
      )
      refetch()
    } catch (e) {
      setClassifyMsg(`Couldn't classify: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setClassifying(false)
    }
  }

  return (
    <>
      <header>
        <div>
          <h1>Replies</h1>
          <div className="muted small">
            {replies.length.toLocaleString('en-US')} replies
            {rangeDays > 0 ? ` in the last ${rangeDays} days` : ' total'} — newest
            first. Open the profile to continue the conversation.
          </div>
        </div>
        <div className="controls">
          <button className="btn-accent" onClick={classify} disabled={classifying}>
            {classifying ? 'Classifying…' : 'Classify new replies'}
          </button>
          <div className="range-group">
            {RANGES.map((r) => (
              <button
                key={r.label}
                className={r.days === rangeDays ? 'active' : ''}
                onClick={() => setRangeDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {classifyMsg && (
        <div className="muted small classify-status">{classifyMsg}</div>
      )}

      <div className="card coach-digest-card">
        <button
          className="coach-digest-toggle"
          onClick={() => setDigestOpen((o) => !o)}
        >
          <span className="coach-digest-caret">{digestOpen ? '▾' : '▸'}</span>
          Your coaching digest
          <span className="muted small">— recurring habits to fix for more replies</span>
        </button>
        {digestOpen && (
          <div className="coach-digest-body">
            {digestErr && <div className="banner">{digestErr}</div>}
            {data.instances.map((inst) => {
              const d = digests[inst.id]
              return (
                <div className="coach-digest-inst" key={inst.id}>
                  <div className="coach-digest-inst-head">
                    <span className="coach-digest-name">{instanceName(inst, inst.id)}</span>
                    <button
                      className="link-btn"
                      disabled={digestBusy === inst.id}
                      onClick={() => refreshDigest(inst.id)}
                    >
                      {digestBusy === inst.id ? 'Analyzing…' : d ? 'Refresh' : 'Generate'}
                    </button>
                    {d?.computed_at && (
                      <span className="muted small">· {d.computed_at.slice(0, 10)}</span>
                    )}
                  </div>
                  {d?.summary && <div className="coach-digest-summary small">{d.summary}</div>}
                  {d?.patterns?.length ? (
                    <ul className="coach-digest-patterns small">
                      {d.patterns.map((p, i) => (
                        <li key={i}>
                          <span className="badge senti obj">{p.count}×</span> {p.issue} — {p.advice}
                        </li>
                      ))}
                    </ul>
                  ) : d ? (
                    <div className="muted small">No recurring patterns yet.</div>
                  ) : (
                    <div className="muted small">
                      Not generated yet — Generate to analyze this account's open threads.
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="range-group sentiment-filter">
        <button className={!filter ? 'active' : ''} onClick={() => setFilter(null)}>
          All {repliesAll.length}
        </button>
        {SENTIMENT_ORDER.filter((s) => counts[s]).map((s) => (
          <button
            key={s}
            className={`senti ${SENTIMENT_META[s].cls} ${filter === s ? 'active' : ''}`}
            onClick={() => setFilter(filter === s ? null : s)}
          >
            {SENTIMENT_META[s].label} {counts[s]}
          </button>
        ))}
        {counts['unclassified'] ? (
          <button
            className={filter === 'unclassified' ? 'active' : ''}
            onClick={() => setFilter(filter === 'unclassified' ? null : 'unclassified')}
          >
            Unclassified {counts['unclassified']}
          </button>
        ) : null}
      </div>

      <div className="card">
        <div className="reply-list">
          {replies.map((l) => {
            const snip = snippets.get(leadKey(l.instance_id, l.profile_url))
            const meta = snip?.sentiment ? SENTIMENT_META[snip.sentiment] : null
            return (
              <div
                className="reply-row row-clickable"
                key={l.id}
                onClick={() => openConversation(l)}
              >
                <div className="reply-who">
                  <a
                    className="row-link"
                    href={l.profile_url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {l.full_name || l.profile_url.replace('https://www.linkedin.com/in/', '')}
                  </a>
                  <div className="muted small ellipsis" title={l.headline ?? ''}>
                    {[l.headline, l.company].filter(Boolean).join(' · ') || '—'}
                  </div>
                  {snip && (
                    <div className="reply-body">
                      {meta && (
                        <span
                          className={`badge senti ${meta.cls}`}
                          title={snip.reason ?? ''}
                        >
                          {meta.label}
                        </span>
                      )}
                      “{snip.body}”
                    </div>
                  )}
                </div>
                <div className="reply-meta">
                  <Link
                    className="row-link muted small"
                    to={`/campaign/${encodeURIComponent(l.campaign_id)}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {campaignName(l.campaign_id)}
                  </Link>
                  <div className="muted small">{instanceLabel(l.instance_id)}</div>
                </div>
                <div className="reply-when muted small">
                  {ago(l.replied_at)}
                  <div>{l.replied_at!.slice(0, 10)}</div>
                </div>
              </div>
            )
          })}
          {replies.length === 0 && (
            <div className="muted">No replies in this period.</div>
          )}
        </div>
      </div>
    </>
  )
}
