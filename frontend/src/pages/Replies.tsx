import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import { instanceName } from '../lib/leads'
import { ago } from '../components/CampaignTable'
import type { Sentiment } from '../lib/types'

const RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 },
]

// Display order is by follow-up priority, not alphabetical.
const SENTIMENT_ORDER: Sentiment[] = [
  'positive',
  'objection',
  'neutral',
  'referral',
  'negative',
  'auto',
]
const SENTIMENT_META: Record<Sentiment, { label: string; cls: string }> = {
  positive: { label: 'Positive', cls: 'pos' },
  objection: { label: 'Objection', cls: 'obj' },
  neutral: { label: 'Neutral', cls: 'neu' },
  referral: { label: 'Referral', cls: 'ref' },
  negative: { label: 'Negative', cls: 'neg' },
  auto: { label: 'Auto', cls: 'auto' },
}

interface Snippet {
  body: string
  sentiment: Sentiment | null
  reason: string | null
}

/** Operational view: everyone who replied recently, newest first — the
 *  follow-up worklist for the team, now sorted by the reply's decision. */
export function Replies() {
  const { data, refetch } = useData()
  const [rangeDays, setRangeDays] = useState(30)
  const [filter, setFilter] = useState<Sentiment | 'unclassified' | null>(null)
  const [classifying, setClassifying] = useState(false)
  const [classifyMsg, setClassifyMsg] = useState<string | null>(null)

  // Latest inbound message (body + its classification) per lead. Messages
  // arrive sorted desc, so the first one seen per key is the most recent.
  const snippets = useMemo(() => {
    const map = new Map<string, Snippet>()
    for (const m of data?.messages ?? []) {
      if (m.direction !== 'in' || !m.body) continue
      const key = `${m.instance_id}|${m.profile_url}`
      if (!map.has(key))
        map.set(key, { body: m.body, sentiment: m.sentiment, reason: m.reason })
    }
    return map
  }, [data])

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
      const s = snippets.get(`${l.instance_id}|${l.profile_url}`)?.sentiment ?? 'unclassified'
      c[s] = (c[s] ?? 0) + 1
    }
    return c
  }, [repliesAll, snippets])

  const replies = useMemo(() => {
    if (!filter) return repliesAll
    return repliesAll.filter(
      (l) =>
        (snippets.get(`${l.instance_id}|${l.profile_url}`)?.sentiment ?? 'unclassified') ===
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
            const snip = snippets.get(`${l.instance_id}|${l.profile_url}`)
            const meta = snip?.sentiment ? SENTIMENT_META[snip.sentiment] : null
            return (
              <div className="reply-row" key={l.id}>
                <div className="reply-who">
                  <a className="row-link" href={l.profile_url} target="_blank" rel="noreferrer">
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
                  <Link className="row-link muted small" to={`/campaign/${encodeURIComponent(l.campaign_id)}`}>
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
