import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ChevronDown, ChevronRight, Download, GraduationCap, Loader2, SearchX, Sparkles, X,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useData } from '../lib/DataContext'
import { useConversation } from '../lib/ConversationContext'
import { useToast } from '../lib/ToastContext'
import { usePipelineActions } from '../lib/usePipelineActions'
import { EmptyState } from '../components/EmptyState'
import { LeadAvatar } from '../components/Avatar'
import { LostReasonModal } from '../components/LostReasonModal'
import type { CoachingDigest, Gender, Lead, Sentiment } from '../lib/types'
import {
  AGE_BUCKETS, GENDER_SHORT, RISK_LABEL, SENTIMENT_META, SENTIMENT_ORDER, STAGES, ageBucketOf,
  ageRange, downloadCsv, instanceName, latestRepliesByLead, leadKey, riskOf, stageMeta,
  stageOf, toCsv,
} from '../lib/leads'
import type { AgeBucket, RiskFlag, Stage } from '../lib/leads'
import { PIPELINE_STAGES, stageLabel } from '../lib/pipeline'
import { num, shortDate } from '../lib/format'

const PAGE_SIZE = 50

type SortKey = 'full_name' | 'added_at' | 'invited_at' | 'connected_at' | 'replied_at' | 'last_action_at'

const SORT_KEYS: SortKey[] = [
  'full_name', 'added_at', 'invited_at', 'connected_at', 'replied_at', 'last_action_at',
]

// The date/milestone columns. `added_at` is opt-in (deploy-pending on most
// notebooks, so it's mostly em-dashes today) — toggled on from the table toolbar.
const DATE_COLUMNS: Array<{ key: SortKey; label: string; optional?: boolean }> = [
  { key: 'added_at', label: 'Added', optional: true },
  { key: 'invited_at', label: 'Invited' },
  { key: 'connected_at', label: 'Accepted' },
  { key: 'replied_at', label: 'Replied' },
  { key: 'last_action_at', label: 'Last action' },
]

// Short chip labels for the active at-risk filter (the <select> text is verbose).
const RISK_CHIP: Record<RiskFlag, string> = {
  pending_2w: 'Pending 14d+',
  no_reply_2w: 'No reply 14d+',
}

// The sentiment filter buckets: every classified sentiment, plus `unclassified`
// (replied but not yet labelled) and `any` (has any reply, the /replies default).
type SentFilter = Sentiment | 'unclassified' | 'any'
const isSentFilter = (v: string | null): v is SentFilter =>
  v === 'any' || v === 'unclassified' || SENTIMENT_ORDER.includes(v as Sentiment)

// The "replied within" window options (days). '' / absent = any time.
const REPLIED_DAYS = new Set(['7', '30', '90'])

export function LeadsExplorer() {
  const { data, refetch } = useData()
  const { openConversation } = useConversation()
  const { setStage, members, memberName } = usePipelineActions()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pendingLost, setPendingLost] = useState<Lead | null>(null)

  const inst = params.get('inst') ?? 'all'
  const camp = params.get('camp') ?? 'all'
  const stage = params.get('stage') ?? 'all'
  const risk = params.get('risk') ?? 'all'
  const pipe = params.get('pipe') ?? 'all'
  const who = params.get('who') ?? 'all'
  const genderF = params.get('gender') ?? 'all'
  const ageF = params.get('agebucket') ?? 'all'
  const q = params.get('q') ?? ''

  // Reply filters (folded in from the old Replies page): a sentiment bucket and
  // a "replied within N days" window, both URL-persisted like the rest.
  const sentRaw = params.get('sentiment')
  const sent: SentFilter | null = isSentFilter(sentRaw) ? sentRaw : null
  const repliedRaw = params.get('replied')
  const repliedDays = REPLIED_DAYS.has(repliedRaw ?? '') ? Number(repliedRaw) : 0
  // Reply-mode = either reply filter is engaged; it flips on the snippet/badge in
  // rows and defaults the sort to newest reply first (the old Replies ordering).
  const replyActive = sent != null || repliedDays > 0

  // Sort / page / column toggle all live in the URL so the page is fully
  // shareable (as its subtitle advertises).
  const rawSort = params.get('sort')
  const sortKey: SortKey = (SORT_KEYS as string[]).includes(rawSort ?? '')
    ? (rawSort as SortKey)
    : replyActive
      ? 'replied_at'
      : 'last_action_at'
  const sortAsc = params.get('dir') === 'asc'
  const page = Math.max(0, (Number(params.get('page')) || 1) - 1)
  const showAdded = params.get('added') === '1'

  // Search is debounced: it types into local state and only commits to the URL
  // param (which re-filters every lead) ~200ms after the last keystroke.
  const [qInput, setQInput] = useState(q)
  useEffect(() => {
    const id = setTimeout(() => {
      const t = qInput.trim()
      if (t === q) return
      // Functional form so a filter change during the debounce window isn't
      // clobbered by a stale params snapshot.
      setParams((prev) => {
        const next = new URLSearchParams(prev)
        if (t) next.set('q', t)
        else next.delete('q')
        next.delete('page')
        return next
      }, { replace: true })
    }, 200)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput])
  // Re-sync the input when q changes from outside (chip clear / clear all).
  useEffect(() => {
    setQInput(q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  // A `camp` from the URL can name a campaign in a different account than the
  // selected `inst` (e.g. a shared link). Ignore it then instead of rendering an
  // empty list with a stale campaign still selected in the dropdown.
  const campInstance = data?.campaigns.find((c) => c.campaign_id === camp)?.instance_id
  const effCamp =
    camp !== 'all' && inst !== 'all' && campInstance && campInstance !== inst ? 'all' : camp

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value === 'all' || value === '') next.delete(key)
    else next.set(key, value)
    if (key === 'inst') next.delete('camp')
    next.delete('page') // back to the first page on any filter change
    setParams(next, { replace: true })
  }

  const clearAll = () => {
    setParams(new URLSearchParams(), { replace: true })
  }

  const setSentiment = (f: SentFilter | null) => {
    const next = new URLSearchParams(params)
    if (f) next.set('sentiment', f)
    else next.delete('sentiment')
    next.delete('page')
    setParams(next, { replace: true })
  }

  // Latest inbound reply (body + classification) per lead — powers the sentiment
  // buckets/counts and the per-row snippet shown in reply mode.
  const snippets = useMemo(() => latestRepliesByLead(data?.messages ?? []), [data])

  // «Classify new replies» — moved here from the Replies page; same endpoint and
  // refetch behaviour so freshly-labelled replies flow into the buckets.
  const [classifying, setClassifying] = useState(false)
  async function classify() {
    setClassifying(true)
    try {
      const res = await fetch('/api/classify', { method: 'POST' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      toast.success(
        `Classified ${j.classified} repl${j.classified === 1 ? 'y' : 'ies'}` +
          (j.remaining ? `, ${j.remaining} still queued` : ' — all caught up'),
      )
      refetch()
    } catch (e) {
      toast.error(`Couldn't classify: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setClassifying(false)
    }
  }

  // Per-account coaching digest — collapsible, collapsed by default. Read anon
  // like the rest of the dashboard; (re)computed on demand via POST /api/coach.
  const [digests, setDigests] = useState<Record<string, CoachingDigest>>({})
  const [digestOpen, setDigestOpen] = useState(false)
  const [digestBusy, setDigestBusy] = useState<string | null>(null)
  const [digestErr, setDigestErr] = useState<string | null>(null)
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

  const goPage = (n: number) => {
    const next = new URLSearchParams(params)
    if (n <= 0) next.delete('page')
    else next.set('page', String(n + 1))
    setParams(next, { replace: true })
    scrollRef.current?.scrollTo({ top: 0 })
  }

  // Everything except the two reply filters — the shared base that both the
  // sentiment bucket counts and the final row list derive from, so bucket counts
  // stay truthful against the other active filters (account/campaign/stage/…).
  const baseFiltered = useMemo(() => {
    if (!data) return []
    const needle = q.trim().toLowerCase()
    return data.leads.filter((l) => {
      if (inst !== 'all' && l.instance_id !== inst) return false
      if (effCamp !== 'all' && l.campaign_id !== effCamp) return false
      if (stage !== 'all' && stageOf(l) !== (stage as Stage)) return false
      if (risk !== 'all' && riskOf(l) !== (risk as RiskFlag)) return false
      if (pipe === 'untriaged') {
        if (!l.replied_at || l.pipeline_stage) return false
      } else if (pipe !== 'all' && l.pipeline_stage !== pipe) return false
      if (who === 'unassigned') {
        if (l.assigned_to != null) return false
      } else if (who !== 'all' && String(l.assigned_to) !== who) return false
      // Demographic filters match only explicit values, so a pre-migration DB
      // (gender/age undefined) matches nothing rather than everything.
      if (genderF !== 'all' && l.gender !== genderF) return false
      if (ageF !== 'all' && ageBucketOf(l) !== (ageF as AgeBucket)) return false
      if (needle) {
        const hay = `${l.full_name ?? ''} ${l.headline ?? ''} ${l.company ?? ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [data, inst, effCamp, stage, risk, pipe, who, genderF, ageF, q])

  const bucketOf = (l: Lead): Sentiment | 'unclassified' =>
    snippets.get(leadKey(l.instance_id, l.profile_url))?.sentiment ?? 'unclassified'

  // Sentiment bucket counts over the base set, restricted to replied leads inside
  // the reply-date window but NOT by the sentiment filter itself (so the numbers
  // don't collapse to the selected bucket) — matches the old Replies page.
  const replyCounts = useMemo(() => {
    const c: Record<string, number> = {}
    let total = 0
    const since = repliedDays > 0 ? Date.now() - repliedDays * 86_400_000 : 0
    for (const l of baseFiltered) {
      if (!l.replied_at) continue
      if (repliedDays > 0 && new Date(l.replied_at).getTime() < since) continue
      c[bucketOf(l)] = (c[bucketOf(l)] ?? 0) + 1
      total++
    }
    return { c, total }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseFiltered, repliedDays, snippets])

  const filtered = useMemo(() => {
    const since = repliedDays > 0 ? Date.now() - repliedDays * 86_400_000 : 0
    const rows = baseFiltered.filter((l) => {
      if (repliedDays > 0) {
        if (!l.replied_at || new Date(l.replied_at).getTime() < since) return false
      }
      if (sent) {
        if (!l.replied_at) return false
        if (sent !== 'any' && bucketOf(l) !== sent) return false
      }
      return true
    })
    rows.sort((a, b) => {
      const av = a[sortKey] ?? ''
      const bv = b[sortKey] ?? ''
      if (av === bv) return 0
      if (av === '') return 1 // nulls last regardless of direction
      if (bv === '') return -1
      return sortAsc ? (av < bv ? -1 : 1) : av < bv ? 1 : -1
    })
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseFiltered, repliedDays, sent, snippets, sortKey, sortAsc])

  if (!data) return null

  const campaignName = (id: string) =>
    data.campaigns.find((c) => c.campaign_id === id)?.campaign_name ?? id
  const instanceLabel = (id: string) =>
    instanceName(data.instances.find((i) => i.id === id), id)

  const campaignOptions = data.campaigns.filter(
    (c) => inst === 'all' || c.instance_id === inst,
  )
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const dateColumns = DATE_COLUMNS.filter((c) => !c.optional || showAdded)
  // Lead, Headline, Campaign, Stage, Pipeline, Age, Gender + the date columns.
  const colSpan = 7 + dateColumns.length

  // One removable chip per active filter, so the current view is legible at a glance.
  const activeFilters: Array<{ id: string; label: string; onClear: () => void }> = []
  if (q.trim()) activeFilters.push({ id: 'q', label: `“${q.trim()}”`, onClear: () => setFilter('q', '') })
  if (inst !== 'all')
    activeFilters.push({ id: 'inst', label: `Account: ${instanceLabel(inst)}`, onClear: () => setFilter('inst', 'all') })
  if (effCamp !== 'all')
    activeFilters.push({ id: 'camp', label: `Campaign: ${campaignName(effCamp)}`, onClear: () => setFilter('camp', 'all') })
  if (stage !== 'all')
    activeFilters.push({
      id: 'stage',
      label: `Stage: ${STAGES.find((s) => s.id === stage)?.label ?? stage}`,
      onClear: () => setFilter('stage', 'all'),
    })
  if (risk !== 'all')
    activeFilters.push({
      id: 'risk',
      label: RISK_CHIP[risk as RiskFlag] ?? risk,
      onClear: () => setFilter('risk', 'all'),
    })
  if (pipe !== 'all')
    activeFilters.push({
      id: 'pipe',
      label: `Pipeline: ${pipe === 'untriaged' ? 'Untriaged' : stageLabel(pipe)}`,
      onClear: () => setFilter('pipe', 'all'),
    })
  if (who !== 'all')
    activeFilters.push({
      id: 'who',
      label: `Owner: ${who === 'unassigned' ? 'Unassigned' : memberName(Number(who)) || who}`,
      onClear: () => setFilter('who', 'all'),
    })
  if (genderF !== 'all')
    activeFilters.push({
      id: 'gender',
      label: `Gender: ${genderF === 'male' ? 'Male' : genderF === 'female' ? 'Female' : 'Unknown'}`,
      onClear: () => setFilter('gender', 'all'),
    })
  if (ageF !== 'all')
    activeFilters.push({
      id: 'agebucket',
      label: `Age: ${AGE_BUCKETS.find((b) => b.id === ageF)?.label ?? ageF}`,
      onClear: () => setFilter('agebucket', 'all'),
    })
  if (repliedDays > 0)
    activeFilters.push({
      id: 'replied',
      label: `Replied: last ${repliedDays} days`,
      onClear: () => setFilter('replied', 'all'),
    })
  if (sent)
    activeFilters.push({
      id: 'sentiment',
      label: `Reply: ${
        sent === 'any' ? 'any' : sent === 'unclassified' ? 'unclassified' : SENTIMENT_META[sent].label
      }`,
      onClear: () => setSentiment(null),
    })

  const onSort = (key: SortKey) => {
    const nextAsc = key === sortKey ? !sortAsc : key === 'full_name'
    const next = new URLSearchParams(params)
    next.set('sort', key)
    next.set('dir', nextAsc ? 'asc' : 'desc')
    next.delete('page')
    setParams(next, { replace: true })
  }
  const sortInd = (key: SortKey) => (
    <span className="sort-ind">{key === sortKey ? (sortAsc ? '↑' : '↓') : ''}</span>
  )

  const exportCsv = () =>
    downloadCsv(
      `leads-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        filtered.map((l) => ({
          name: l.full_name,
          profile_url: l.profile_url,
          headline: l.headline,
          company: l.company,
          campaign: campaignName(l.campaign_id),
          instance: instanceLabel(l.instance_id),
          stage: stageOf(l),
          risk: riskLabel(l),
          age: ageRange(l),
          gender: l.gender ?? null,
          gender_confidence: l.gender_confidence ?? null,
          demo_source: l.demo_model ?? null,
          pipeline_stage: l.pipeline_stage,
          pipeline_substatus: l.pipeline_substatus,
          assigned_to: memberName(l.assigned_to) || null,
          lost_reason: l.lost_reason,
          added_at: l.added_at,
          invited_at: l.invited_at,
          connected_at: l.connected_at,
          replied_at: l.replied_at,
          last_action_at: l.last_action_at,
        })),
      ),
    )

  return (
    <>
      <header>
        <div>
          <h1>Leads</h1>
          <div className="muted small">
            Filters are kept in the URL, so any view here is shareable.
          </div>
        </div>
      </header>

      <div className="card coach-digest-card">
        <button className="coach-digest-toggle" onClick={() => setDigestOpen((o) => !o)}>
          {digestOpen ? (
            <ChevronDown size={15} className="coach-digest-caret" />
          ) : (
            <ChevronRight size={15} className="coach-digest-caret" />
          )}
          <GraduationCap size={16} className="coach-digest-icon" />
          Your coaching digest
          <span className="muted small">— recurring habits to fix for more replies</span>
        </button>
        {digestOpen && (
          <div className="coach-digest-body">
            {digestErr && <div className="banner">{digestErr}</div>}
            {data.instances.map((instance) => {
              const d = digests[instance.id]
              return (
                <div className="coach-digest-inst" key={instance.id}>
                  <div className="coach-digest-inst-head">
                    <span className="coach-digest-name">{instanceName(instance, instance.id)}</span>
                    <button
                      className="link-btn"
                      disabled={digestBusy === instance.id}
                      onClick={() => refreshDigest(instance.id)}
                    >
                      {digestBusy === instance.id ? 'Analyzing…' : d ? 'Refresh' : 'Generate'}
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

      <div className="filter-bar card">
        <label className="filter-field filter-field-grow">
          <span className="filter-label">Search</span>
          <input
            type="search"
            placeholder="Name, headline, company…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
          />
        </label>
        <label className="filter-field">
          <span className="filter-label">Account</span>
          <select value={inst} onChange={(e) => setFilter('inst', e.target.value)}>
            <option value="all">All accounts</option>
            {data.instances.map((i) => (
              <option key={i.id} value={i.id}>{instanceName(i)}</option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span className="filter-label">Campaign</span>
          <select value={effCamp} onChange={(e) => setFilter('camp', e.target.value)}>
            <option value="all">All campaigns</option>
            {campaignOptions.map((c) => (
              <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span className="filter-label">Stage</span>
          <select value={stage} onChange={(e) => setFilter('stage', e.target.value)}>
            <option value="all">All stages</option>
            {STAGES.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span className="filter-label">Status</span>
          <select value={risk} onChange={(e) => setFilter('risk', e.target.value)}>
            <option value="all">Any status</option>
            <option value="pending_2w">At risk: pending 14d+ (withdraw?)</option>
            <option value="no_reply_2w">At risk: no reply 14d+ (follow up)</option>
          </select>
        </label>
        <label className="filter-field">
          <span className="filter-label">Pipeline</span>
          <select value={pipe} onChange={(e) => setFilter('pipe', e.target.value)}>
            <option value="all">All pipeline</option>
            <option value="untriaged">Untriaged replies</option>
            {PIPELINE_STAGES.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span className="filter-label">Owner</span>
          <select value={who} onChange={(e) => setFilter('who', e.target.value)}>
            <option value="all">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={String(m.id)}>{m.name}</option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span className="filter-label">Replied</span>
          <select
            value={repliedDays ? String(repliedDays) : 'all'}
            onChange={(e) => setFilter('replied', e.target.value)}
          >
            <option value="all">Any time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>
        <label className="filter-field">
          <span className="filter-label">Gender</span>
          <select value={genderF} onChange={(e) => setFilter('gender', e.target.value)}>
            <option value="all">Any gender</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label className="filter-field">
          <span className="filter-label">Age</span>
          <select value={ageF} onChange={(e) => setFilter('agebucket', e.target.value)}>
            <option value="all">Any age</option>
            {AGE_BUCKETS.map((b) => (
              <option key={b.id} value={b.id}>{b.label}</option>
            ))}
          </select>
        </label>
      </div>

      {activeFilters.length > 0 && (
        <div className="active-filters">
          {activeFilters.map((f) => (
            <button key={f.id} className="filter-chip" onClick={f.onClear}>
              {f.label}
              <X size={13} />
            </button>
          ))}
          <button className="filter-chip-clear" onClick={clearAll}>
            Clear all
          </button>
        </div>
      )}

      <div
        className="segmented sentiment-filter"
        role="tablist"
        aria-label="Filter leads by reply sentiment"
      >
        <button
          className={`segmented-item ${!sent ? 'active' : ''}`}
          role="tab"
          aria-selected={!sent}
          onClick={() => setSentiment(null)}
        >
          All leads
        </button>
        <button
          className={`segmented-item ${sent === 'any' ? 'active' : ''}`}
          role="tab"
          aria-selected={sent === 'any'}
          onClick={() => setSentiment(sent === 'any' ? null : 'any')}
        >
          Any reply <span className="segmented-count">{replyCounts.total}</span>
        </button>
        {SENTIMENT_ORDER.filter((s) => replyCounts.c[s] || sent === s).map((s) => (
          <button
            key={s}
            className={`segmented-item ${sent === s ? 'active' : ''}`}
            role="tab"
            aria-selected={sent === s}
            onClick={() => setSentiment(sent === s ? null : s)}
          >
            <span className={`seg-dot ${SENTIMENT_META[s].cls}`} />
            {SENTIMENT_META[s].label} <span className="segmented-count">{replyCounts.c[s] ?? 0}</span>
          </button>
        ))}
        {replyCounts.c['unclassified'] || sent === 'unclassified' ? (
          <button
            className={`segmented-item ${sent === 'unclassified' ? 'active' : ''}`}
            role="tab"
            aria-selected={sent === 'unclassified'}
            onClick={() => setSentiment(sent === 'unclassified' ? null : 'unclassified')}
          >
            Unclassified <span className="segmented-count">{replyCounts.c['unclassified'] ?? 0}</span>
          </button>
        ) : null}
      </div>

      <div className="card">
        <div className="table-toolbar">
          <span className="muted small">
            {num(filtered.length)} of {num(data.leads.length)} leads
          </span>
          <div className="table-toolbar-actions">
            <label className="col-toggle">
              <input
                type="checkbox"
                checked={showAdded}
                onChange={(e) => setFilter('added', e.target.checked ? '1' : '')}
              />
              Added date
            </label>
            <button className="btn sm" onClick={classify} disabled={classifying}>
              {classifying ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              {classifying ? 'Classifying…' : 'Classify new replies'}
            </button>
            <button className="btn sm" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download size={14} /> Export CSV
            </button>
          </div>
        </div>
        <div className="table-scroll tall" ref={scrollRef}>
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => onSort('full_name')}>
                Lead{sortInd('full_name')}
              </th>
              <th>Headline</th>
              <th>Campaign</th>
              <th>Stage</th>
              <th>Pipeline</th>
              <th>Age</th>
              <th>Gender</th>
              {dateColumns.map((c) => (
                <th key={c.key} className="sortable" onClick={() => onSort(c.key)}>
                  {c.label}{sortInd(c.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((l) => {
              // In reply mode surface the latest inbound snippet + sentiment badge
              // (the old ReplyRow presentation, inlined into the table cell).
              const reply = replyActive
                ? snippets.get(leadKey(l.instance_id, l.profile_url))
                : undefined
              const senti = reply?.sentiment ? SENTIMENT_META[reply.sentiment] : null
              return (
              <tr
                key={l.id}
                className="row-clickable"
                tabIndex={0}
                role="button"
                aria-label={`Open conversation with ${l.full_name || 'lead'}`}
                onClick={() => openConversation(l)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openConversation(l)
                  }
                }}
              >
                <td>
                  <div className="lead-cell">
                    <LeadAvatar lead={l} size={30} />
                    <div className="lead-cell-main">
                      <a
                        className="row-link"
                        href={l.profile_url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {l.full_name || l.profile_url.replace('https://www.linkedin.com/in/', '')}
                      </a>
                      {senti && (
                        <span className={`badge senti ${senti.cls}`} title={reply?.reason ?? ''}>
                          {senti.label}
                        </span>
                      )}
                      {l.company && <div className="muted small">{l.company}</div>}
                      {reply && <div className="reply-body">“{reply.body}”</div>}
                    </div>
                  </div>
                </td>
                <td className="muted ellipsis" title={l.headline ?? ''}>{l.headline ?? '—'}</td>
                <td className="muted small">{campaignName(l.campaign_id)}</td>
                <td><StageBadge lead={l} /></td>
                <td onClick={(e) => e.stopPropagation()}>
                  <select
                    className={`pipe-stage-select${l.pipeline_stage ? '' : ' quiet'}`}
                    value={l.pipeline_stage ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === 'lost') setPendingLost(l)
                      else void setStage(l, v || null)
                    }}
                  >
                    <option value="">—</option>
                    {PIPELINE_STAGES.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                </td>
                <td className="muted col-age">{ageRange(l) ?? '—'}</td>
                <td className="col-gender"><GenderCell lead={l} /></td>
                {dateColumns.map((c) => (
                  <td key={c.key} className="muted col-date">
                    {shortDate(l[c.key] as string | null)}
                  </td>
                ))}
              </tr>
              )
            })}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={colSpan}>
                  <EmptyState
                    icon={SearchX}
                    title="No leads match these filters"
                    hint={
                      activeFilters.length > 0
                        ? 'Adjust or clear the filters to see more leads.'
                        : 'Leads appear here once your accounts sync.'
                    }
                    action={
                      activeFilters.length > 0 ? (
                        <button className="link-btn" onClick={clearAll}>Clear filters</button>
                      ) : undefined
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
        {pages > 1 && (
          <div className="pager">
            <button className="btn" disabled={page === 0} onClick={() => goPage(page - 1)}>
              ← Prev
            </button>
            <span className="muted small">page {page + 1} / {pages}</span>
            <button className="btn" disabled={page >= pages - 1} onClick={() => goPage(page + 1)}>
              Next →
            </button>
          </div>
        )}
      </div>

      {pendingLost && (
        <LostReasonModal
          leadName={pendingLost.full_name}
          onCancel={() => setPendingLost(null)}
          onConfirm={(reason) => {
            const lead = pendingLost
            setPendingLost(null)
            void setStage(lead, 'lost', { lostReason: reason })
          }}
        />
      )}
    </>
  )
}

/** Gender chip: inferred rows show "F ·72%" (muted, click the ROW to confirm in
 *  the drawer); SDR-confirmed rows show "F ✓". `unknown` is a real value ("?"),
 *  not blank — a lead with no inference yet shows an em-dash. */
function GenderCell({ lead }: { lead: Lead }) {
  const g = lead.gender
  if (!g) return <span className="muted">—</span>
  const short = GENDER_SHORT[g as Gender]
  if (lead.demo_model === 'manual')
    return (
      <span className="gender-cell manual" title="Confirmed by an SDR">
        {short} ✓
      </span>
    )
  const conf = lead.gender_confidence != null ? Math.round(lead.gender_confidence * 100) : null
  return (
    <span className="gender-cell muted" title="inferred by AI — click to confirm">
      {short}
      {conf != null ? ` ·${conf}%` : ''}
    </span>
  )
}

function StageBadge({ lead }: { lead: Lead }) {
  const stage = stageMeta(stageOf(lead))
  const risk = riskOf(lead)
  return (
    <>
      <span className={`badge stage-${stage.id}`}>{stage.label}</span>
      {risk && <span className="badge risk">{RISK_LABEL[risk]}</span>}
    </>
  )
}

const riskLabel = (l: Lead) => {
  const r = riskOf(l)
  return r ? RISK_LABEL[r] : null
}
