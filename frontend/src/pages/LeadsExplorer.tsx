import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ChevronDown, ChevronRight, Columns3, Download, Filter, GraduationCap, Loader2, SearchX, Sparkles,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import {
  fetchNeonCoachingDigests, fetchNeonLeadsSearchPage, resolveReadPath,
} from '../lib/dashboardReads'
import type { LeadsSearchQuery } from '../lib/dashboardReads'
import { useData } from '../lib/DataContext'
import { useConversation } from '../lib/ConversationContext'
import { useToast } from '../lib/ToastContext'
import { usePipelineActions } from '../lib/usePipelineActions'
import { authFetch } from '../lib/api'
import { useAuth } from '../lib/AuthContext'
import { EmptyState } from '../components/EmptyState'
import {
  AccountIdentity, ActiveFilters, Button, Dialog, FilterCount, InlineError, LinkButton,
  PageHeader, Panel, SelectField, TableFrame, TableToolbar, Tabs, TextField, Toolbar,
} from '../ui'
import { COPY } from '../ui/labels'
import { LeadMilestoneBadge, LeadReplyIdentity } from '../components/leads-and-replies/LeadReplyIdentity'
import { LostReasonModal } from '../components/LostReasonModal'
import type {
  CoachingDigest, Gender, Lead, LeadsSearchItem, LeadsSearchPage, ReplyIntent, Sentiment,
} from '../lib/types'
import {
  AGE_BUCKETS, GENDER_SHORT, INTENT_META, INTENT_ORDER, RISK_LABEL, SENTIMENT_META,
  SENTIMENT_ORDER, STAGES, ageBucketOf, ageRange, downloadCsv, highestIntentByLead,
  accountLabeller, latestRepliesByLead, leadKey, riskOf, stageOf, toCsv,
} from '../lib/leads'
import type { AgeBucket, RiskFlag, Stage } from '../lib/leads'
import { PIPELINE_STAGES, stageLabel } from '../lib/pipeline'
import { num, shortDate } from '../lib/format'
import {
  activeFollowUp,
  businessDateKey,
  followUpBucket,
  followUpDueLabel,
  followUpKey,
  followUpStateMap,
} from '../lib/followUps'

const PAGE_SIZE = 50

type SortKey =
  | 'full_name'
  | 'added_at'
  | 'invited_at'
  | 'connected_at'
  | 'replied_at'
  | 'last_action_at'
  | 'next_follow_up_date'
type LeadDateSortKey = Exclude<SortKey, 'next_follow_up_date' | 'full_name'>

const SORT_KEYS: SortKey[] = [
  'full_name', 'added_at', 'invited_at', 'connected_at', 'replied_at', 'last_action_at',
  'next_follow_up_date',
]

// The date/milestone columns. `added_at` is opt-in (deploy-pending on most
// notebooks, so it's mostly em-dashes today) — toggled on from the table toolbar.
const DATE_COLUMNS: Array<{
  key: LeadDateSortKey; label: string; optional?: boolean; detail?: boolean
}> = [
  { key: 'added_at', label: 'Added', optional: true, detail: true },
  { key: 'invited_at', label: 'Invited', detail: true },
  { key: 'connected_at', label: 'Accepted', detail: true },
  { key: 'replied_at', label: 'Replied', detail: true },
  { key: 'last_action_at', label: 'Latest activity' },
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

/* The filters that live inside the sheet and are committed together. The
 * search box and the account selector sit on the page itself and stay
 * immediate — they are visibly set and have their own controls. */
const SHEET_FILTER_KEYS = [
  'camp', 'stage', 'risk', 'pipe', 'who', 'follow', 'replied', 'intent',
  'gender', 'agebucket',
] as const

// The "replied within" window options (days). '' / absent = any time.
const REPLIED_DAYS = new Set(['7', '30', '90'])

export function LeadsExplorer() {
  const { isAdmin } = useAuth()
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
  const followF = params.get('follow') ?? 'all'
  const q = params.get('q') ?? ''

  // Reply filters (folded in from the old Replies page): a sentiment bucket and
  // a "replied within N days" window, both URL-persisted like the rest.
  const sentRaw = params.get('sentiment')
  const sent: SentFilter | null = isSentFilter(sentRaw) ? sentRaw : null
  const intentRaw = params.get('intent')
  const intent: ReplyIntent | 'none' | null =
    intentRaw === 'none' || INTENT_ORDER.includes(intentRaw as ReplyIntent)
      ? (intentRaw as ReplyIntent | 'none')
      : null
  const repliedRaw = params.get('replied')
  const repliedDays = REPLIED_DAYS.has(repliedRaw ?? '') ? Number(repliedRaw) : 0
  // Reply-mode = either reply filter is engaged; it flips on the snippet/badge in
  // rows and defaults the sort to newest reply first (the old Replies ordering).
  const replyActive = sent != null || intent != null || repliedDays > 0

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
  /* Default columns are the standard's six: Lead, Account / campaign, Milestone,
   * Pipeline, Next follow-up, Latest activity. Headline, age and gender are real
   * data but not what the page is scanned for, so they move behind Columns
   * rather than being dropped. The filters and the export are unchanged. */
  const showDetailColumns = params.get('cols') === 'all'

  const [serverMode, setServerMode] = useState(false)
  const [serverPage, setServerPage] = useState<LeadsSearchPage | null>(null)
  const [serverLoading, setServerLoading] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverRefresh, setServerRefresh] = useState(0)
  const [exporting, setExporting] = useState(false)

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

  const repliedSince = useMemo(
    () => repliedDays > 0
      ? new Date(Date.now() - repliedDays * 86_400_000).toISOString()
      : null,
    [repliedDays],
  )
  const serverQuery = useMemo<LeadsSearchQuery>(() => ({
    inst,
    camp: effCamp,
    stage,
    risk,
    pipe,
    who,
    gender: genderF,
    agebucket: ageF,
    follow: followF,
    repliedSince,
    sentiment: sent,
    intent,
    q: q.trim(),
    sort: sortKey,
    dir: sortAsc ? 'asc' : 'desc',
    today: businessDateKey(),
    page,
    pageSize: PAGE_SIZE,
  }), [
    inst, effCamp, stage, risk, pipe, who, genderF, ageF, followF, repliedSince,
    sent, intent, q, sortKey, sortAsc, page,
  ])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const path = await resolveReadPath()
      if (cancelled) return
      if (path !== 'neon') {
        setServerMode(false)
        setServerPage(null)
        return
      }
      setServerMode(true)
      setServerLoading(true)
      setServerError(null)
      setServerPage(null)
      try {
        const next = await fetchNeonLeadsSearchPage(serverQuery)
        if (cancelled) return
        setServerPage(next)
        performance.mark('dashboard_leads_page_ready')
      } catch (error) {
        if (cancelled) return
        setServerError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setServerLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [serverQuery, serverRefresh])

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

  const openFilters = () => {
    setFilterDraft(Object.fromEntries(
      SHEET_FILTER_KEYS.map((key) => [key, params.get(key) ?? 'all']),
    ))
  }
  const setDraftFilter = (key: string, value: string) => {
    setFilterDraft((current) => ({ ...(current ?? {}), [key]: value }))
  }
  const clearDraftFilters = () => {
    setFilterDraft(Object.fromEntries(SHEET_FILTER_KEYS.map((key) => [key, 'all'])))
  }
  const applyFilters = () => {
    const draft = filterDraft
    setFilterDraft(null)
    if (!draft) return
    const next = new URLSearchParams(params)
    for (const key of SHEET_FILTER_KEYS) {
      const value = draft[key] ?? 'all'
      if (value === 'all' || value === '') next.delete(key)
      else next.set(key, value)
    }
    next.delete('page') // one scope change, one reset to the first page
    setParams(next, { replace: true })
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
  const snippets = useMemo(() => {
    if (!serverMode) return latestRepliesByLead(data?.messages ?? [])
    return new Map(
      (serverPage?.items ?? [])
        .filter((item) => item.reply !== null)
        .map((item) => [leadKey(item.lead.instance_id, item.lead.profile_url), item.reply!]),
    )
  }, [data?.messages, serverMode, serverPage])
  const conversationIntents = useMemo(() => {
    if (!serverMode) return highestIntentByLead(data?.messages ?? [])
    return new Map(
      (serverPage?.items ?? [])
        .filter((item) => item.highestIntent !== null)
        .map((item) => [
          leadKey(item.lead.instance_id, item.lead.profile_url),
          { highest: item.highestIntent!, first_at: item.reply?.sent_at ?? '' },
        ]),
    )
  }, [data?.messages, serverMode, serverPage])
  const followUps = useMemo(() => {
    if (!serverMode) return followUpStateMap(data?.followUpStates ?? [])
    return followUpStateMap(
      (serverPage?.items ?? []).flatMap((item) => item.followUp ? [item.followUp] : []),
    )
  }, [data?.followUpStates, serverMode, serverPage])

  const [updatingDemographics, setUpdatingDemographics] = useState(false)

  const demographicsSummary = (value: unknown): string => {
    if (!value || typeof value !== 'object') return ''
    const d = value as { processed?: number; failed?: number; remaining?: number | null }
    const bits = [`${d.processed ?? 0} demographics processed`]
    if (d.failed) bits.push(`${d.failed} failed`)
    if (d.remaining != null) bits.push(`${d.remaining} remaining`)
    return bits.join(', ')
  }

  async function updateDemographics() {
    setUpdatingDemographics(true)
    try {
      const res = await authFetch('/api/classify?mode=demographics', { method: 'POST' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      toast.success(demographicsSummary(j.demographics) || 'Demographics are up to date')
      if (serverMode) setServerRefresh((value) => value + 1)
      else refetch()
    } catch (e) {
      toast.error(`Couldn't update demographics: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setUpdatingDemographics(false)
    }
  }

  // Per-account coaching digest — collapsible, collapsed by default. Read on
  // whichever path the deployment serves, like the rest of the dashboard;
  // (re)computed on demand via POST /api/coach.
  const [digests, setDigests] = useState<Record<string, CoachingDigest>>({})
  const [digestOpen, setDigestOpen] = useState(false)
  /* The filter sheet edits a draft and commits it on Apply. Writing each
   * `onChange` straight to the URL meant Escape "closed" a dialog that had
   * already changed the result behind it, and there was nothing to cancel back
   * to. `null` means the sheet is closed. */
  const [filterDraft, setFilterDraft] = useState<Record<string, string> | null>(null)
  const filtersOpen = filterDraft !== null
  const [digestBusy, setDigestBusy] = useState<string | null>(null)
  const [digestErr, setDigestErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const index = (rows: readonly CoachingDigest[]) => {
        const map: Record<string, CoachingDigest> = {}
        for (const r of rows) map[r.instance_id] = r
        setDigests(map)
      }
      if ((await resolveReadPath()) === 'neon') {
        try {
          const rows = await fetchNeonCoachingDigests()
          if (cancelled) return
          index(rows)
        } catch (e) {
          if (cancelled) return
          // The Supabase branch below swallows its error — it destructures only
          // `data`, so a failure has always rendered as "no digests computed
          // yet". The panel owns an error slot, so this path fills it instead.
          setDigestErr(
            `Couldn't load the coaching digest: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
        return
      }
      if (!supabase) return
      const { data: rows } = await supabase.from('coaching_digest').select('*')
      if (cancelled || !rows) return
      index(rows as CoachingDigest[])
    })()
    return () => {
      cancelled = true
    }
  }, [data])

  async function refreshDigest(instance_id: string) {
    setDigestBusy(instance_id)
    setDigestErr(null)
    try {
      const res = await authFetch('/api/coach', {
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
      if (genderF === 'pending') {
        if (l.gender != null) return false
      } else if (genderF !== 'all' && l.gender !== genderF) return false
      if (ageF !== 'all' && ageBucketOf(l) !== (ageF as AgeBucket)) return false
      if (followF !== 'all') {
        const followState = followUps.get(followUpKey(l.instance_id, l.profile_url))
        if (followUpBucket(followState) !== followF) return false
      }
      if (needle) {
        const hay = `${l.full_name ?? ''} ${l.headline ?? ''} ${l.company ?? ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [data, inst, effCamp, stage, risk, pipe, who, genderF, ageF, followF, followUps, q])

  const bucketOf = (l: Lead): Sentiment | 'unclassified' =>
    snippets.get(leadKey(l.instance_id, l.profile_url))?.sentiment ?? 'unclassified'

  // Sentiment bucket counts over the base set, restricted to replied leads inside
  // the reply-date window but NOT by the sentiment filter itself (so the numbers
  // don't collapse to the selected bucket) — matches the old Replies page.
  const legacyReplyCounts = useMemo(() => {
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

  const replyCounts = serverMode
    ? serverPage?.replyCounts ?? { total: 0, c: {} }
    : legacyReplyCounts

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
      if (intent) {
        const level = conversationIntents.get(leadKey(l.instance_id, l.profile_url))?.highest
        if (intent === 'none' ? !!level : level !== intent) return false
      }
      return true
    })
    rows.sort((a, b) => {
      const av = sortKey === 'next_follow_up_date'
        ? followUps.get(followUpKey(a.instance_id, a.profile_url))?.next_follow_up_date ?? ''
        : a[sortKey] ?? ''
      const bv = sortKey === 'next_follow_up_date'
        ? followUps.get(followUpKey(b.instance_id, b.profile_url))?.next_follow_up_date ?? ''
        : b[sortKey] ?? ''
      if (av === bv) return 0
      if (av === '') return 1 // nulls last regardless of direction
      if (bv === '') return -1
      return sortAsc ? (av < bv ? -1 : 1) : av < bv ? 1 : -1
    })
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseFiltered, repliedDays, sent, intent, snippets, conversationIntents, sortKey, sortAsc, followUps])

  if (!data) return null

  const campaignName = (id: string) =>
    data.campaigns.find((c) => c.campaign_id === id)?.campaign_name ?? id
  const instanceLabel = accountLabeller(data.instances)

  const campaignOptions = data.campaigns.filter(
    (c) => inst === 'all' || c.instance_id === inst,
  )
  const resultCount = serverMode ? serverPage?.total ?? 0 : filtered.length
  const allLeadCount = serverMode ? serverPage?.allTotal ?? 0 : data.leads.length
  const pages = Math.max(1, Math.ceil(resultCount / PAGE_SIZE))
  const pageRows = serverMode
    ? (serverPage?.items ?? []).map((item) => item.lead)
    : filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const dateColumns = DATE_COLUMNS.filter(
    (c) => (!c.optional || showAdded) && (showDetailColumns || !c.detail),
  )
  // Lead, Account / campaign, Milestone, Pipeline, Next follow-up + the date
  // columns, plus Headline / Age / Gender when the detail columns are shown.
  const colSpan = 5 + (showDetailColumns ? 3 : 0) + dateColumns.length

  /* How many of the sheet's filters are engaged. The search box and the account
   * selector are on the page and visibly set, so they are not counted here. */
  const sheetFilterCount = [
    effCamp !== 'all', stage !== 'all', risk !== 'all', pipe !== 'all', who !== 'all',
    followF !== 'all', repliedDays > 0, intent != null, genderF !== 'all', ageF !== 'all',
  ].filter(Boolean).length
  /* What the sheet's footer counts while it is open: the draft, not the URL. */
  const draftFilterCount = filterDraft
    ? SHEET_FILTER_KEYS.filter((key) => (filterDraft[key] ?? 'all') !== 'all').length
    : 0

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
      label:
        `Gender: ${
          genderF === 'male'
            ? 'Male'
            : genderF === 'female'
              ? 'Female'
              : genderF === 'pending'
                ? 'Pending'
                : 'Unknown'
        }`,
      onClear: () => setFilter('gender', 'all'),
    })
  if (ageF !== 'all')
    activeFilters.push({
      id: 'agebucket',
      label: `Age: ${AGE_BUCKETS.find((b) => b.id === ageF)?.label ?? ageF}`,
      onClear: () => setFilter('agebucket', 'all'),
    })
  if (followF !== 'all')
    activeFilters.push({
      id: 'follow',
      label: `Follow-up: ${followF}`,
      onClear: () => setFilter('follow', 'all'),
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
  if (intent)
    activeFilters.push({
      id: 'intent',
      label: `Intent: ${intent === 'none' ? 'none' : `${INTENT_META[intent].short} · ${INTENT_META[intent].label}`}`,
      onClear: () => setFilter('intent', 'all'),
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

  const exportCsv = async () => {
    setExporting(true)
    try {
      let items: LeadsSearchItem[]
      if (serverMode) {
        items = []
        const exportPageSize = 1_000
        const pageCount = Math.ceil(resultCount / exportPageSize)
        for (let exportPage = 0; exportPage < pageCount; exportPage++) {
          const result = await fetchNeonLeadsSearchPage({
            ...serverQuery,
            page: exportPage,
            pageSize: exportPageSize,
          })
          items.push(...result.items)
        }
      } else {
        items = filtered.map((lead) => ({
          lead,
          reply: snippets.get(leadKey(lead.instance_id, lead.profile_url)) ?? null,
          highestIntent:
            conversationIntents.get(leadKey(lead.instance_id, lead.profile_url))?.highest ?? null,
          followUp: followUps.get(followUpKey(lead.instance_id, lead.profile_url)) ?? null,
        }))
      }

      downloadCsv(
        `leads-${new Date().toISOString().slice(0, 10)}.csv`,
        toCsv(items.map(({ lead: l, highestIntent, followUp }) => ({
          name: l.full_name,
          profile_url: l.profile_url,
          headline: l.headline,
          company: l.company,
          campaign: campaignName(l.campaign_id),
          instance: instanceLabel(l.instance_id),
          stage: stageOf(l),
          risk: riskLabel(l),
          age: ageRange(l),
          age_source: l.age_source ?? null,
          age_method: l.age_method_version ?? null,
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
          next_follow_up_date: followUp?.next_follow_up_date ?? null,
          reply_intent: highestIntent,
        }))),
      )
    } catch (error) {
      toast.error(`Couldn't export leads: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Leads"
        description="Filters are kept in the URL, so any view here is shareable."
        actions={<LinkButton variant="secondary" to="/replies?view=all&scope=all">Open Replies</LinkButton>}
      />

      {/* Search and the account scope stay on the page; the other ten filters
          live in a sheet that opens over it. Twelve inline filters plus the
          digest and the tabs used to put the first table row at y≈480. */}
      <Toolbar>
        <TextField
          className="ui-toolbar__search"
          label="Search leads"
          labelHidden
          type="search"
          placeholder="Name, headline, company…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
        />
        <SelectField label="Account" labelHidden value={inst} onChange={(e) => setFilter('inst', e.target.value)}>
          <option value="all">All accounts</option>
          {data.instances.map((i) => (
            <option key={i.id} value={i.id}>{instanceLabel(i.id)}</option>
          ))}
        </SelectField>
        <Button
          variant="secondary"
          icon={<Filter size={18} aria-hidden="true" />}
          aria-expanded={filtersOpen}
          onClick={openFilters}
        >{COPY.filters}<FilterCount count={sheetFilterCount} /></Button>
      </Toolbar>

      {filterDraft && (
        <Dialog
          title={COPY.filters}
          description="These apply on top of the search and the account selected on the page. Nothing changes until you apply."
          onRequestClose={() => setFilterDraft(null)}
          footerNote={draftFilterCount ? `${draftFilterCount} filter${draftFilterCount === 1 ? '' : 's'} selected` : 'No filters selected'}
          footer={<>
            <Button variant="ghost" onClick={clearDraftFilters}>{COPY.clearAll}</Button>
            <Button variant="secondary" onClick={() => setFilterDraft(null)}>{COPY.cancel}</Button>
            <Button variant="primary" onClick={applyFilters}>{COPY.apply}</Button>
          </>}
        >
          <div className="grid gap-app-lg grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
            <SelectField label="Campaign" value={filterDraft.camp} onChange={(e) => setDraftFilter('camp', e.target.value)}>
              <option value="all">All campaigns</option>
              {campaignOptions.map((c) => (
                <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>
              ))}
            </SelectField>
            <SelectField label="Milestone" value={filterDraft.stage} onChange={(e) => setDraftFilter('stage', e.target.value)}>
              <option value="all">All milestones</option>
              {STAGES.map((sOption) => (
                <option key={sOption.id} value={sOption.id}>{sOption.label}</option>
              ))}
            </SelectField>
            <SelectField label="Status" value={filterDraft.risk} onChange={(e) => setDraftFilter('risk', e.target.value)}>
              <option value="all">Any status</option>
              <option value="pending_2w">At risk: pending 14d+ (withdraw?)</option>
              <option value="no_reply_2w">At risk: no reply 14d+ (follow up)</option>
            </SelectField>
            <SelectField label="Pipeline" value={filterDraft.pipe} onChange={(e) => setDraftFilter('pipe', e.target.value)}>
              <option value="all">All pipeline</option>
              <option value="untriaged">Untriaged replies</option>
              {PIPELINE_STAGES.map((sOption) => (
                <option key={sOption.id} value={sOption.id}>{sOption.label}</option>
              ))}
            </SelectField>
            <SelectField label="Owner" value={filterDraft.who} onChange={(e) => setDraftFilter('who', e.target.value)}>
              <option value="all">Anyone</option>
              <option value="unassigned">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={String(m.id)}>{m.name}</option>
              ))}
            </SelectField>
            <SelectField label="Follow-up" value={filterDraft.follow} onChange={(e) => setDraftFilter('follow', e.target.value)}>
              <option value="all">Any follow-up</option>
              <option value="overdue">Overdue</option>
              <option value="today">Today</option>
              <option value="upcoming">Upcoming</option>
              <option value="unscheduled">Unscheduled</option>
            </SelectField>
            <SelectField
              label="Replied"
              value={filterDraft.replied}
              onChange={(e) => setDraftFilter('replied', e.target.value)}
            >
              <option value="all">Any time</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </SelectField>
            <SelectField label="Buying interest reached" value={filterDraft.intent} onChange={(e) => setDraftFilter('intent', e.target.value)}>
              <option value="all">Any level</option>
              {INTENT_ORDER.map((level) => (
                <option key={level} value={level}>
                  {INTENT_META[level].short} · {INTENT_META[level].label}
                </option>
              ))}
              <option value="none">No P1–P3 interest</option>
            </SelectField>
            <SelectField label="Gender" value={filterDraft.gender} onChange={(e) => setDraftFilter('gender', e.target.value)}>
              <option value="all">Any gender</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="unknown">Unknown</option>
              <option value="pending">Pending evaluation</option>
            </SelectField>
            <SelectField label="Age" value={filterDraft.agebucket} onChange={(e) => setDraftFilter('agebucket', e.target.value)}>
              <option value="all">Any age</option>
              {AGE_BUCKETS.map((b) => (
                <option key={b.id} value={b.id}>{b.label}</option>
              ))}
            </SelectField>
          </div>
        </Dialog>
      )}

      <ActiveFilters
        onClearAll={clearAll}
        filters={activeFilters.map((f) => {
          // The existing chip strings are already "Field: value"; split them so
          // the shared chip can style the two halves differently.
          const split = f.label.indexOf(': ')
          return {
            id: f.id,
            label: split > 0 ? f.label.slice(0, split) : 'Filter',
            value: split > 0 ? f.label.slice(split + 2) : f.label,
            onRemove: f.onClear,
          }
        })}
      />

      {/* Which replies the result set is scoped to — a section of the same
          list, so tabs rather than a segmented mode switch. */}
      <Tabs
        label="Filter leads by reply sentiment"
        value={sent ?? 'all'}
        onChange={(value) => setSentiment(value === 'all' ? null : (value as Sentiment | 'any' | 'unclassified'))}
        items={[
          { id: 'all', label: 'All leads' },
          { id: 'any', label: 'Any reply', count: replyCounts.total },
          ...SENTIMENT_ORDER.filter((sOption) => replyCounts.c[sOption] || sent === sOption).map((sOption) => ({
            id: sOption as string,
            label: SENTIMENT_META[sOption].label,
            count: replyCounts.c[sOption] ?? 0,
          })),
          ...(replyCounts.c['unclassified'] || sent === 'unclassified'
            ? [{ id: 'unclassified', label: 'Unclassified', count: replyCounts.c['unclassified'] ?? 0 }]
            : []),
        ]}
      />

      {serverError && (
        <InlineError
          title="Leads could not load."
          message="The list below may be incomplete or out of date."
          detail={serverError}
          onRetry={() => setServerRefresh((value) => value + 1)}
        />
      )}

      <TableFrame
        scrollLabel="Leads"
        className="leads-table-frame"
        toolbar={
          <TableToolbar
            count={<>
              {serverLoading && <Loader2 size={14} className="spin" aria-hidden="true" />}
              {num(resultCount)} of {num(allLeadCount)} leads
            </>}
            actions={<>
              <Button
                variant="ghost"
                size="sm"
                icon={<Columns3 size={16} aria-hidden="true" />}
                aria-pressed={showDetailColumns}
                onClick={() => setFilter('cols', showDetailColumns ? '' : 'all')}
              >{showDetailColumns ? 'Fewer columns' : 'More columns'}</Button>
              {isAdmin && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Sparkles size={16} aria-hidden="true" />}
                  onClick={updateDemographics}
                  loading={updatingDemographics}
                  title="Process the next fair batch of name-based gender evaluations"
                >Update demographics</Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                icon={<Download size={16} aria-hidden="true" />}
                onClick={() => void exportCsv()}
                disabled={resultCount === 0}
                loading={exporting}
              >Export CSV</Button>
            </>}
          />
        }
        hint={pages > 1 ? (
          <div className="flex justify-center items-center gap-app-lg pt-app-md">
            <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => goPage(page - 1)}>← Previous</Button>
            <span className="muted">Page {page + 1} of {pages}</span>
            <Button variant="secondary" size="sm" disabled={page >= pages - 1} onClick={() => goPage(page + 1)}>Next →</Button>
          </div>
        ) : undefined}
      >
        <div ref={scrollRef}>
        <table className="ui-table">
          <thead>
            <tr>
              <th scope="col" className="sortable" onClick={() => onSort('full_name')}>
                Lead{sortInd('full_name')}
              </th>
              {showDetailColumns && <th scope="col">Headline</th>}
              <th scope="col">Account / campaign</th>
              <th scope="col">Milestone</th>
              <th scope="col">Pipeline</th>
              {showDetailColumns && <th scope="col">Age</th>}
              {showDetailColumns && <th scope="col">Gender</th>}
              <th scope="col" className="sortable" onClick={() => onSort('next_follow_up_date')}>
                Next follow-up{sortInd('next_follow_up_date')}
              </th>
              {dateColumns.map((c) => (
                <th scope="col" key={c.key} className="sortable" onClick={() => onSort(c.key)}>
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
              const reachedIntent = conversationIntents.get(
                leadKey(l.instance_id, l.profile_url),
              )?.highest
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
                <td onClick={(e) => e.stopPropagation()}>
                  <LeadReplyIdentity
                    lead={l}
                    reply={reply}
                    highestIntent={reachedIntent}
                    showSnippet={replyActive}
                  />
                  {l.replied_at && <Link
                    className="row-link small"
                    to={`/replies?view=all&scope=all&thread=${encodeURIComponent(`${l.instance_id}|${l.profile_url}`)}`}
                    onClick={(e) => e.stopPropagation()}
                  >Open in Replies</Link>}
                </td>
                {showDetailColumns && (
                  <td className="muted ellipsis" title={l.headline ?? ''}>{l.headline ?? '—'}</td>
                )}
                <td>
                  <AccountIdentity
                    name={instanceLabel(l.instance_id)}
                    secondary={campaignName(l.campaign_id)}
                    title={campaignName(l.campaign_id)}
                  />
                </td>
                <td><LeadMilestoneBadge lead={l} /></td>
                <td onClick={(e) => e.stopPropagation()}>
                  <select
                    className={`pipe-stage-select${l.pipeline_stage ? '' : ' quiet'}`}
                    value={l.pipeline_stage ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === 'lost') setPendingLost(l)
                      else void setStage(l, v || null).then(() => {
                        if (serverMode) setServerRefresh((value) => value + 1)
                      })
                    }}
                  >
                    <option value="">—</option>
                    {PIPELINE_STAGES.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                </td>
                {showDetailColumns && <td className="muted col-age">{ageRange(l) ?? '—'}</td>}
                {showDetailColumns && <td className="col-gender"><GenderCell lead={l} /></td>}
                <td className="col-follow-up">
                  {(() => {
                    const followState = followUps.get(followUpKey(l.instance_id, l.profile_url))
                    return activeFollowUp(followState) ? (
                      <span className={`follow-due ${followUpBucket(followState)}`}>
                        {followUpDueLabel(followState)}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )
                  })()}
                </td>
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
                        <Button variant="secondary" size="sm" onClick={clearAll}>{COPY.clearFilters}</Button>
                      ) : undefined
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </TableFrame>

      {/* Coaching is an aid, not the work. It used to sit between the page
          title and the filters; collapsed and below the results, it costs the
          first row no vertical space. */}
      <Panel className="mb-app-xl">
        <button data-digest="toggle" className="flex items-center gap-app-sm w-full bg-none border-none text-app-text text-[length:var(--text-base)] font-semibold cursor-pointer p-0 text-left" onClick={() => setDigestOpen((o) => !o)}>
          {digestOpen
            ? <ChevronDown size={18} className="coach-digest-caret" aria-hidden="true" />
            : <ChevronRight size={18} className="coach-digest-caret" aria-hidden="true" />}
          <GraduationCap size={18} className="text-app-accent shrink-0" aria-hidden="true" />
          Your coaching digest
          <span className="muted small">— recurring habits to fix for more replies</span>
        </button>
        {digestOpen && (
          <div data-digest="body" className="mt-app-md flex flex-col gap-app-lg">
            {digestErr && <div className="banner">{digestErr}</div>}
            {data.instances.map((instance) => {
              const d = digests[instance.id]
              return (
                <div data-digest="instance" className="border-t border-app-border pt-app-md first:border-t-0 first:pt-0" key={instance.id}>
                  <div className="flex items-center gap-app-sm">
                    <span className="font-semibold">{instanceLabel(instance.id)}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={digestBusy === instance.id}
                      onClick={() => refreshDigest(instance.id)}
                    >
                      {d ? 'Refresh' : 'Generate'}
                    </Button>
                    {d?.computed_at && (
                      <span className="muted small">· {shortDate(d.computed_at)}</span>
                    )}
                  </div>
                  {d?.summary && <div className="mt-1.5 leading-[1.5] small">{d.summary}</div>}
                  {d?.patterns?.length ? (
                    <ul data-digest="patterns" className="mt-app-sm mx-0 mb-0 pl-0 list-none flex flex-col gap-1.5 leading-[1.45] small">
                      {d.patterns.map((pattern, i) => (
                        <li key={i}>
                          <span className="badge senti obj">{pattern.count}×</span> {pattern.issue} — {pattern.advice}
                        </li>
                      ))}
                    </ul>
                  ) : d ? (
                    <div className="muted small">No recurring patterns yet.</div>
                  ) : (
                    <div className="muted small">
                      Not generated yet — Generate to analyse this account's open threads.
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Panel>

      {pendingLost && (
        <LostReasonModal
          leadName={pendingLost.full_name}
          onCancel={() => setPendingLost(null)}
          onConfirm={(reason) => {
            const lead = pendingLost
            setPendingLost(null)
            void setStage(lead, 'lost', { lostReason: reason }).then(() => {
              if (serverMode) setServerRefresh((value) => value + 1)
            })
          }}
        />
      )}
    </>
  )
}

/** Gender chip: inferred rows show "F ·72%" (muted, click the ROW to review in
 *  the drawer); SDR-reviewed rows show "F ✓". `unknown` is a real value ("?"),
 *  not blank — a lead with no inference yet shows an em-dash. */
function GenderCell({ lead }: { lead: Lead }) {
  const g = lead.gender
  if (!g) return <span className="muted">—</span>
  const short = GENDER_SHORT[g as Gender]
  if (lead.demo_model === 'manual')
    return (
      <span className="gender-cell manual" title="Reviewed by an SDR">
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

const riskLabel = (l: Lead) => {
  const r = riskOf(l)
  return r ? RISK_LABEL[r] : null
}
