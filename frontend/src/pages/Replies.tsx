import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, GraduationCap, Inbox, Loader2, Sparkles } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import {
  SENTIMENT_META, SENTIMENT_ORDER, instanceName, latestRepliesByLead, leadKey,
} from '../lib/leads'
import { ReplyRow } from '../components/ReplyRow'
import { EmptyState } from '../components/EmptyState'
import { num, shortDate } from '../lib/format'
import type { CoachingDigest, Sentiment } from '../lib/types'

type Filter = Sentiment | 'unclassified'
const isFilter = (v: string | null): v is Filter =>
  v === 'unclassified' || SENTIMENT_ORDER.includes(v as Sentiment)

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
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  // Both the sentiment filter and the date range live in the URL so deep links
  // (e.g. the Overview "Hot leads → View all" → /replies?sentiment=positive) land
  // pre-filtered and views are shareable.
  const filterParam = params.get('sentiment')
  const filter: Filter | null = isFilter(filterParam) ? filterParam : null
  const setFilter = (f: Filter | null) => {
    const next = new URLSearchParams(params)
    if (f) next.set('sentiment', f)
    else next.delete('sentiment')
    setParams(next, { replace: true })
  }
  const rangeParam = params.get('range')
  const rangeDays = RANGES.some((r) => String(r.days) === rangeParam) ? Number(rangeParam) : 30
  const setRangeDays = (days: number) => {
    const next = new URLSearchParams(params)
    next.set('range', String(days))
    setParams(next, { replace: true })
  }
  // "New since last visit": snapshot the previous visit time on mount (before
  // overwriting it), so rows with a newer reply can show the accent dot.
  const lastSeenRef = useRef(0)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('replies:lastSeen')
      lastSeenRef.current = raw ? Number(raw) || 0 : 0
      localStorage.setItem('replies:lastSeen', String(Date.now()))
    } catch {
      /* storage full / disabled — just skip the "new" markers */
    }
  }, [])
  const [classifying, setClassifying] = useState(false)
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

  async function classify() {
    setClassifying(true)
    try {
      const res = await fetch('/api/classify', { method: 'POST' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      toast.success(
        `Classified ${j.classified} repl${j.classified === 1 ? 'y' : 'ies'}` +
          (j.remaining ? `, ${j.remaining} still queued` : ' — all caught up')
      )
      refetch()
    } catch (e) {
      toast.error(`Couldn't classify: ${e instanceof Error ? e.message : String(e)}`)
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
            {num(replies.length)} replies
            {rangeDays > 0 ? ` in the last ${rangeDays} days` : ' total'} — newest
            first. Open the profile to continue the conversation.
          </div>
        </div>
        <div className="controls">
          <button className="btn-accent icon-btn" onClick={classify} disabled={classifying}>
            {classifying ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Sparkles size={15} />
            )}
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

      <div className="card coach-digest-card">
        <button
          className="coach-digest-toggle"
          onClick={() => setDigestOpen((o) => !o)}
        >
          {digestOpen ? <ChevronDown size={15} className="coach-digest-caret" /> : <ChevronRight size={15} className="coach-digest-caret" />}
          <GraduationCap size={16} className="coach-digest-icon" />
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
                      <span className="muted small">· {shortDate(d.computed_at)}</span>
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

      <div className="segmented sentiment-filter" role="tablist" aria-label="Filter replies by sentiment">
        <button
          className={`segmented-item ${!filter ? 'active' : ''}`}
          role="tab"
          aria-selected={!filter}
          onClick={() => setFilter(null)}
        >
          All <span className="segmented-count">{repliesAll.length}</span>
        </button>
        {SENTIMENT_ORDER.filter((s) => counts[s] || filter === s).map((s) => (
          <button
            key={s}
            className={`segmented-item ${filter === s ? 'active' : ''}`}
            role="tab"
            aria-selected={filter === s}
            onClick={() => setFilter(filter === s ? null : s)}
          >
            <span className={`seg-dot ${SENTIMENT_META[s].cls}`} />
            {SENTIMENT_META[s].label} <span className="segmented-count">{counts[s]}</span>
          </button>
        ))}
        {counts['unclassified'] || filter === 'unclassified' ? (
          <button
            className={`segmented-item ${filter === 'unclassified' ? 'active' : ''}`}
            role="tab"
            aria-selected={filter === 'unclassified'}
            onClick={() => setFilter(filter === 'unclassified' ? null : 'unclassified')}
          >
            Unclassified <span className="segmented-count">{counts['unclassified'] ?? 0}</span>
          </button>
        ) : null}
      </div>

      <div className="card">
        <div className="reply-list">
          {replies.map((l) => {
            const reply = snippets.get(leadKey(l.instance_id, l.profile_url))
            const repliedTs = reply?.sent_at ?? l.replied_at
            const isNew =
              lastSeenRef.current > 0 && !!repliedTs &&
              new Date(repliedTs).getTime() > lastSeenRef.current
            return (
              <ReplyRow
                key={l.id}
                lead={l}
                reply={reply}
                campaigns={data.campaigns}
                instances={data.instances}
                isNew={isNew}
              />
            )
          })}
          {replies.length === 0 && (
            <EmptyState
              icon={Inbox}
              title={filter ? 'No replies match this filter' : 'No replies in this period'}
              hint={
                filter
                  ? 'Try a different sentiment or a wider date range.'
                  : 'Replies from your prospects show up here, newest first.'
              }
              action={
                filter ? (
                  <button className="link-btn" onClick={() => setFilter(null)}>Show all replies</button>
                ) : undefined
              }
            />
          )}
        </div>
      </div>
    </>
  )
}
