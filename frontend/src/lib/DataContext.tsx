import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { supabase } from './supabase'
import type {
  DashboardData, Hypothesis, HypothesisCampaign, Icp, IcpIndustry, IcpPersona, Lead, Message,
  SavedSearch,
} from './types'

const EMPTY: DashboardData = {
  instances: [],
  campaigns: [],
  activity: [],
  leads: [],
  syncRuns: [],
  messages: [],
  annotations: [],
  steps: [],
  briefing: null,
  prevBriefing: null,
  teamMembers: [],
  pipelineEvents: [],
  savedSearches: [],
  icps: [],
  icpPersonas: [],
  icpIndustries: [],
  hypotheses: [],
  hypothesisCampaigns: [],
}

const LEAD_COLUMNS_BASE =
  'id,instance_id,campaign_id,profile_url,full_name,headline,company,' +
  'added_at,invited_at,connected_at,first_message_at,replied_at,last_action_at'
// The manual-pipeline columns (migration pending on some DBs).
const LEAD_COLUMNS_PIPELINE =
  `${LEAD_COLUMNS_BASE},pipeline_stage,pipeline_substatus,lost_reason,` +
  'pipeline_stage_changed_at,assigned_to'
// Demographics (migration 041) + photo (migration 042). These ship in adjacent
// migrations, so they share ONE rung: a DB is expected to have both or neither.
const LEAD_COLUMNS_FULL =
  `${LEAD_COLUMNS_PIPELINE},education_start_year,first_job_start_year,` +
  'birth_year_min,birth_year_max,gender,gender_confidence,demo_inferred_at,' +
  'demo_model,photo_path,photo_synced_at'
// The widest set we ask for first.
const LEAD_COLUMNS = LEAD_COLUMNS_FULL
// Retry ladder, widest → narrowest. Requesting a missing column makes PostgREST
// 400 the whole query (SQLSTATE 42703); on that error fetchAllLeads drops to the
// NEXT rung rather than falling straight to base — so a DB that has the pipeline
// migration but not the demographics/photo ones keeps its pipeline columns
// instead of silently losing them. Each narrower rung's fields come back
// undefined/null in the UI.
const LEAD_COLUMN_LADDER = [LEAD_COLUMNS_FULL, LEAD_COLUMNS_PIPELINE, LEAD_COLUMNS_BASE]

// True for PostgREST's "undefined column" error (Postgres SQLSTATE 42703),
// regardless of which column is missing. supabase-js error shapes vary, so also
// accept a message that names a missing column as a fallback.
function isMissingColumn(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null
  if (err?.code === '42703') return true
  return !!err?.message && /column\s+.*\s+does not exist/i.test(err.message)
}

// PostgREST caps responses at 1000 rows; page until a short page comes back.
// Walks the LEAD_COLUMN_LADDER down on a missing-column error so a DB that has
// only some of the lead migrations still renders (narrower rungs' fields come
// back undefined/null).
// `updatedSince` (delta refresh, migration 031) restricts to rows whose
// updated_at moved since the cursor; a DB without that column 42703s, which the
// caller catches to disable delta and fall back to a full fetch permanently.
async function fetchAllLeads(
  columns: string = LEAD_COLUMNS,
  updatedSince?: string,
): Promise<Lead[]> {
  const page = 1000
  const all: Lead[] = []
  try {
    for (let from = 0; ; from += page) {
      let q = supabase!.from('leads').select(columns).order('id')
      if (updatedSince) q = q.gte('updated_at', updatedSince)
      const { data, error } = await q.range(from, from + page - 1)
      if (error) throw error
      all.push(...((data ?? []) as unknown as Lead[]))
      if (!data || data.length < page) break
    }
  } catch (e) {
    // Missing-column error (SQLSTATE 42703): drop to the next narrower rung of
    // the ladder (full → pipeline → base). Only that error class triggers a
    // step-down; any OTHER error (network, RLS, missing updated_at, …) must
    // propagate. A custom column list not on the ladder also propagates.
    const rung = LEAD_COLUMN_LADDER.indexOf(columns)
    const next = rung >= 0 ? LEAD_COLUMN_LADDER[rung + 1] : undefined
    if (next && isMissingColumn(e)) return fetchAllLeads(next, updatedSince)
    throw e
  }
  return all
}

// The manual-pipeline audit log is append-only and unbounded, so it will exceed
// PostgREST's 1000-row cap; page through it (like fetchAllLeads / inbound
// messages) or the funnel's "ever reached" math silently truncates. A missing
// table (migration pending) resolves to an empty list, never a failed load.
// `occurredSince` (delta refresh) restricts to events appended since the cursor;
// the log is append-only so occurred_at is a safe delta key (no updated_at).
async function fetchAllPipelineEvents(occurredSince?: string): Promise<Record<string, unknown>[]> {
  const page = 1000
  const all: Record<string, unknown>[] = []
  for (let from = 0; ; from += page) {
    let q = supabase!
      .from('pipeline_events')
      .select('*')
      .order('occurred_at')
      .order('id') // tiebreaker: bulk auto-advance inserts share one occurred_at
    if (occurredSince) q = q.gte('occurred_at', occurredSince)
    const { data, error } = await q.range(from, from + page - 1)
    if (error) return all // missing table / query error → whatever we have (usually none)
    all.push(...((data ?? []) as Record<string, unknown>[]))
    if (!data || data.length < page) break
  }
  return all
}

const MESSAGE_COLUMNS_BASE =
  'id,instance_id,campaign_id,profile_url,direction,body,sent_at,sentiment,reason,classified_at'
// `source` (migration 026: 'sync' | 'manual') may not exist on the live DB yet.
// Requesting a missing column makes PostgREST 400 the whole query, so fetchMessages
// retries once without it (see below) — pre-migration DBs keep loading, and the
// import callout simply renders nothing.
const MESSAGE_COLUMNS = `${MESSAGE_COLUMNS_BASE},source`

// True only for PostgREST's "undefined column" error (Postgres SQLSTATE 42703),
// i.e. the `source` column doesn't exist yet. supabase-js error shapes vary, so
// also accept a message that names the missing column as a fallback.
function isMissingSourceColumn(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null
  if (err?.code === '42703') return true
  return !!err?.message && /column\s+.*source.*\s+does not exist/i.test(err.message)
}

// Inbound replies drive sentiment / positive-reply counts shown beside ALL-TIME
// lead totals, so they must not be windowed — a 90-day / 2000-row cap silently
// undercounts them on busy accounts. Fetch every inbound row (paginated past the
// 1000-row cap); keep outbound to the 90-day window since it's only recent display.
// `updatedSince` (delta refresh, migration 031) restricts to rows whose
// updated_at moved since the cursor; the direction filters and the outbound
// 90-day window are preserved so a delta merges like-for-like. A DB without the
// updated_at column 42703s — the caller catches it, disables delta, and falls
// back to a full fetch permanently.
async function fetchMessages(
  since: string,
  columns: string = MESSAGE_COLUMNS,
  updatedSince?: string,
): Promise<Message[]> {
  const page = 1000
  const all: Message[] = []
  const withUpdated = <T,>(q: T): T =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updatedSince ? ((q as any).gte('updated_at', updatedSince) as T) : q
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pageThrough = async (build: () => any) => {
    for (let from = 0; ; from += page) {
      const { data, error } = await build()
        // sent_at isn't unique (bulk syncs stamp identical times), so add id as a
        // stable tiebreaker or page boundaries can drop/duplicate rows.
        .order('sent_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + page - 1)
      if (error) throw error
      all.push(...((data ?? []) as unknown as Message[]))
      if (!data || data.length < page) break
    }
  }
  try {
    await pageThrough(() =>
      withUpdated(supabase!.from('messages').select(columns).eq('direction', 'in')))
    await pageThrough(() =>
      withUpdated(supabase!.from('messages').select(columns).eq('direction', 'out').gte('sent_at', since)))
  } catch (e) {
    // Pre-migration DB has no `source` column → PostgREST 400 with code 42703
    // ("undefined column"). Retry once with the base columns so the dashboard
    // still loads (partial `all` is discarded by the retry). Any OTHER error
    // (network, timeout, RLS, missing updated_at, …) must propagate — falling
    // back on those would silently hide the callout and mask a real failure.
    if (columns !== MESSAGE_COLUMNS_BASE && isMissingSourceColumn(e))
      return fetchMessages(since, MESSAGE_COLUMNS_BASE, updatedSince)
    throw e
  }
  all.sort((a, b) => (a.sent_at < b.sent_at ? 1 : a.sent_at > b.sent_at ? -1 : 0))
  return all
}

// Delta refresh returns only the rows that changed; fold them onto the array we
// already hold, replacing matched ids and appending new ones. Order is not
// preserved (callers that need a sort re-sort after merging).
function mergeById<T extends { id: string | number }>(existing: T[], updates: T[]): T[] {
  if (updates.length === 0) return existing
  const map = new Map<string | number, T>()
  for (const r of existing) map.set(r.id, r)
  for (const r of updates) map.set(r.id, r)
  return [...map.values()]
}

// A 2-minute overlap on the delta cursor absorbs clock skew and commits that
// landed mid-fetch; overlapping rows just re-merge idempotently (never missed).
const REFRESH_OVERLAP_MS = 2 * 60_000

// The always-full-refetched small tables get a fresh array every cycle even when
// their data is unchanged. Keep the previous reference when the payload is
// deep-equal so consumers memoized on a data slice don't recompute on a no-op
// refresh. These tables are small, so a JSON compare is cheap.
function stableSlice<T>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
}

const Ctx = createContext<{
  data: DashboardData | null
  loading: boolean
  refetch: () => void
  /** Merge a partial update into one lead in place (no refetch). Used by the
   *  manual-pipeline optimistic writes so a stage/assignee change reflects
   *  everywhere the lead is rendered. */
  patchLead: (leadId: string, patch: Partial<Lead>) => void
  /** Insert-or-replace a saved search in place after a /api/playbook save, so
   *  the Search Library reflects the change without a full refetch. */
  upsertSavedSearch: (search: SavedSearch) => void
  /** Drop a saved search from local state after a hard delete. */
  removeSavedSearch: (id: number) => void
  /** Insert-or-replace an ICP in place after save_icp. */
  upsertIcp: (icp: Icp) => void
  /** Drop an ICP (and its personas/industries — DB cascades) after delete_icp. */
  removeIcp: (id: number) => void
  /** Insert-or-replace a buyer persona in place after save_icp_persona. */
  upsertIcpPersona: (persona: IcpPersona) => void
  /** Drop a buyer persona after delete_icp_persona. */
  removeIcpPersona: (id: number) => void
  /** Insert-or-replace a per-industry keyword refinement after save_icp_industry. */
  upsertIcpIndustry: (industry: IcpIndustry) => void
  /** Drop a per-industry keyword refinement after delete_icp_industry. */
  removeIcpIndustry: (id: number) => void
  /** Insert-or-replace a hypothesis in place after save_hypothesis. */
  upsertHypothesis: (hyp: Hypothesis) => void
  /** Drop a hypothesis (and its campaign assignments — DB cascades) after
   *  delete_hypothesis. */
  removeHypothesis: (id: number) => void
  /** Replace a hypothesis's campaign set in local state after a successful
   *  set_hypothesis_campaigns call (server enforces at-most-one-hypothesis;
   *  this mirrors that by also dropping these campaign_ids from any OTHER
   *  hypothesis's rows). */
  assignCampaigns: (hypothesisId: number, campaignIds: string[]) => void
}>({
  data: null,
  loading: true,
  refetch: () => {},
  patchLead: () => {},
  upsertSavedSearch: () => {},
  removeSavedSearch: () => {},
  upsertIcp: () => {},
  removeIcp: () => {},
  upsertIcpPersona: () => {},
  removeIcpPersona: () => {},
  upsertIcpIndustry: () => {},
  removeIcpIndustry: () => {},
  upsertHypothesis: () => {},
  removeHypothesis: () => {},
  assignCampaigns: () => {},
})

export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  // Only the most recent load() wins, so a manual refetch can't be clobbered by
  // an in-flight interval load (or vice versa).
  const reqId = useRef(0)
  // Delta-refresh state. cursor = "changed since" watermark for the next interval
  // fetch (max updated_at proxy: load start minus an overlap buffer). deltaSupported
  // flips to false permanently if the DB lacks the updated_at column (migration 031
  // pending), pinning the session to full refetches.
  const cursorRef = useRef<string | null>(null)
  const deltaSupported = useRef(true)
  // Optimistic pipeline patches still awaiting server confirmation, kept so a
  // load() already in flight can't revert them (re-applied after every commit).
  const pendingPatches = useRef<Map<string, { patch: Partial<Lead>; at: number }>>(new Map())

  // Surface an error without wiping on-screen data: keep the last successful
  // load and only stamp the error field. First-load failures (prev === null)
  // still fall back to the empty-with-error state.
  const showError = useCallback((message: string) => {
    setData((prev) => (prev ? { ...prev, error: message } : { ...EMPTY, error: message }))
  }, [])

  // Re-apply still-pending optimistic patches on top of freshly-fetched leads so
  // an in-flight load() can't revert them. A patch is confirmed/dropped only when
  // a row that was GENUINELY fetched this cycle reflects it, or after a 30s TTL.
  // `fetchedIds` = the lead ids this fetch actually returned (null = a full fetch,
  // so every id counts). In a delta merge a pending-patched lead that's absent
  // from the batch is carried over from state still holding the optimistic value;
  // comparing that to itself would clear the patch with no server confirmation, so
  // carried-over rows keep their pending entry (TTL still applies).
  const applyPending = useCallback((leads: Lead[], fetchedIds: Set<string> | null): Lead[] => {
    const pend = pendingPatches.current
    if (pend.size === 0) return leads
    const now = Date.now()
    for (const [lid, p] of pend) if (now - p.at > 30_000) pend.delete(lid)
    if (pend.size === 0) return leads
    const byId = new Map(leads.map((l) => [l.id, l]))
    for (const [lid, p] of pend) {
      if (fetchedIds && !fetchedIds.has(lid)) continue // not fetched this cycle → keep
      const row = byId.get(lid)
      if (row && Object.entries(p.patch).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v))
        pend.delete(lid)
    }
    if (pend.size === 0) return leads
    return leads.map((l) => {
      const p = pend.get(l.id)
      return p ? { ...l, ...p.patch } : l
    })
  }, [])

  // Merge a partial update into one lead in place (optimistic pipeline writes),
  // AND record it as pending so a concurrent load()'s commit re-applies it.
  const patchLead = useCallback((leadId: string, patch: Partial<Lead>) => {
    const prev = pendingPatches.current.get(leadId)?.patch
    pendingPatches.current.set(leadId, { patch: { ...prev, ...patch }, at: Date.now() })
    setData((prevData) =>
      prevData
        ? { ...prevData, leads: prevData.leads.map((l) => (l.id === leadId ? { ...l, ...patch } : l)) }
        : prevData,
    )
  }, [])

  // Insert-or-replace a saved search after a server write returns the full row.
  // No pending-patch machinery: the write has already landed server-side, and
  // the small tables full-refetch every cycle would re-fetch the same row.
  const upsertSavedSearch = useCallback((search: SavedSearch) => {
    setData((prevData) => {
      if (!prevData) return prevData
      const rest = prevData.savedSearches.filter((s) => s.id !== search.id)
      return { ...prevData, savedSearches: [...rest, search] }
    })
  }, [])

  const removeSavedSearch = useCallback((id: number) => {
    setData((prevData) =>
      prevData
        ? { ...prevData, savedSearches: prevData.savedSearches.filter((s) => s.id !== id) }
        : prevData,
    )
  }, [])

  // --- ICP + Hypothesis mutators (migration 043) — same shape as
  // upsertSavedSearch/removeSavedSearch above: the write has already landed
  // server-side, so these just fold the returned row into local state.
  const upsertIcp = useCallback((icp: Icp) => {
    setData((prevData) => {
      if (!prevData) return prevData
      const rest = prevData.icps.filter((i) => i.id !== icp.id)
      return { ...prevData, icps: [...rest, icp] }
    })
  }, [])

  const removeIcp = useCallback((id: number) => {
    setData((prevData) =>
      prevData
        ? {
            ...prevData,
            icps: prevData.icps.filter((i) => i.id !== id),
            // DB cascades on delete; mirror that locally so stale children don't
            // linger until the next refetch.
            icpPersonas: prevData.icpPersonas.filter((p) => p.icp_id !== id),
            icpIndustries: prevData.icpIndustries.filter((x) => x.icp_id !== id),
          }
        : prevData,
    )
  }, [])

  const upsertIcpPersona = useCallback((persona: IcpPersona) => {
    setData((prevData) => {
      if (!prevData) return prevData
      const rest = prevData.icpPersonas.filter((p) => p.id !== persona.id)
      return { ...prevData, icpPersonas: [...rest, persona] }
    })
  }, [])

  const removeIcpPersona = useCallback((id: number) => {
    setData((prevData) =>
      prevData
        ? { ...prevData, icpPersonas: prevData.icpPersonas.filter((p) => p.id !== id) }
        : prevData,
    )
  }, [])

  const upsertIcpIndustry = useCallback((industry: IcpIndustry) => {
    setData((prevData) => {
      if (!prevData) return prevData
      const rest = prevData.icpIndustries.filter((x) => x.id !== industry.id)
      return { ...prevData, icpIndustries: [...rest, industry] }
    })
  }, [])

  const removeIcpIndustry = useCallback((id: number) => {
    setData((prevData) =>
      prevData
        ? { ...prevData, icpIndustries: prevData.icpIndustries.filter((x) => x.id !== id) }
        : prevData,
    )
  }, [])

  const upsertHypothesis = useCallback((hyp: Hypothesis) => {
    setData((prevData) => {
      if (!prevData) return prevData
      const rest = prevData.hypotheses.filter((h) => h.id !== hyp.id)
      return { ...prevData, hypotheses: [...rest, hyp] }
    })
  }, [])

  const removeHypothesis = useCallback((id: number) => {
    setData((prevData) =>
      prevData
        ? {
            ...prevData,
            hypotheses: prevData.hypotheses.filter((h) => h.id !== id),
            hypothesisCampaigns: prevData.hypothesisCampaigns.filter((hc) => hc.hypothesis_id !== id),
          }
        : prevData,
    )
  }, [])

  const assignCampaigns = useCallback((hypothesisId: number, campaignIds: string[]) => {
    setData((prevData) => {
      if (!prevData) return prevData
      const idSet = new Set(campaignIds)
      // Drop this hypothesis's old assignments not in the new set, AND release
      // these campaign_ids from whichever hypothesis currently holds them
      // (mirrors the server's set_hypothesis_campaigns RPC).
      const kept = prevData.hypothesisCampaigns.filter((hc) => {
        if (hc.hypothesis_id === hypothesisId) return idSet.has(hc.campaign_id)
        return !idSet.has(hc.campaign_id)
      })
      const now = new Date().toISOString()
      const existing = new Set(
        kept.filter((hc) => hc.hypothesis_id === hypothesisId).map((hc) => hc.campaign_id),
      )
      const added = campaignIds
        .filter((cid) => !existing.has(cid))
        .map((cid) => ({ hypothesis_id: hypothesisId, campaign_id: cid, created_at: now }))
      return { ...prevData, hypothesisCampaigns: [...kept, ...added] }
    })
  }, [])

  // `mode` = 'full' re-downloads everything (initial load + manual refetch after a
  // write); 'delta' (the 5-min interval) fetches only rows changed since the
  // cursor and merges them, falling back to a full refetch if the DB has no
  // updated_at column yet (migration 031 pending).
  const load = useCallback(async (mode: 'full' | 'delta' = 'full') => {
    const id = ++reqId.current
    if (!supabase) {
      showError(
        'Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.',
      )
      setLoading(false)
      return
    }
    const cursor = cursorRef.current
    const delta = mode === 'delta' && deltaSupported.current && cursor != null
    const startedAt = Date.now()
    try {
        const since = new Date(startedAt - 90 * 86_400_000)
          .toISOString()
          .slice(0, 10)
        // Small / view-backed tables can't delta (views) and are cheap — always
        // full, even on an interval refresh.
        const smallP = Promise.all([
          supabase
            .from('instances')
            .select('id,label,last_sync_at,agent_version,account_name,account_url,account_avatar,config,config_updated_at')
            .order('id'),
          supabase.from('campaign_metrics').select('*').order('campaign_name'),
          supabase.from('daily_activity').select('*').gte('day', since),
          supabase
            .from('sync_runs')
            .select('id,instance_id,started_at,finished_at,status,rows_upserted,error')
            .order('started_at', { ascending: false })
            .limit(200),
          supabase.from('annotations').select('*').order('noted_at'),
          supabase
            .from('campaign_steps')
            .select('*')
            .order('campaign_id')
            .order('step_index'),
          supabase
            .from('briefings')
            .select('*')
            .order('briefing_date', { ascending: false })
            .limit(2),
          // Manual-pipeline tables may not exist yet (migration pending). Their
          // errors are intentionally NOT folded into the aggregate `error`
          // below — a missing table just yields an empty list, never a failed
          // load. team_members' .select() resolves with {data,error} (never
          // throws); fetchAllPipelineEvents swallows its own errors to [].
          supabase.from('team_members').select('id,name,active,created_at').order('id'),
          // Search Library (migration 040) — same tolerated-error pattern: a
          // missing table (pre-migration DB) yields [] and its error is excluded
          // from the aggregate `error` below, so it never fails the load.
          supabase.from('saved_searches').select('*').order('platform').order('name'),
          // ICP + Hypothesis layer (migration 043) — same tolerated-error pattern.
          supabase.from('icps').select('*').order('name'),
          supabase.from('icp_personas').select('*').order('icp_id').order('sort'),
          supabase.from('icp_industries').select('*').order('icp_id').order('name'),
          supabase.from('hypotheses').select('*').order('name'),
          supabase.from('hypothesis_campaigns').select('*'),
        ])
        // Big append-heavy tables delta on an interval refresh, full otherwise.
        const leadsP = delta ? fetchAllLeads(LEAD_COLUMNS, cursor!) : fetchAllLeads()
        const messagesP = delta ? fetchMessages(since, MESSAGE_COLUMNS, cursor!) : fetchMessages(since)
        const eventsP = delta ? fetchAllPipelineEvents(cursor!) : fetchAllPipelineEvents()
        const [small, leads, messages, pipelineEvents] = await Promise.all([
          smallP, leadsP, messagesP, eventsP,
        ])
        const [
          instances, campaigns, activity, syncRuns, annotations, steps, briefing, teamMembers,
          savedSearches, icps, icpPersonas, icpIndustries, hypotheses, hypothesisCampaigns,
        ] = small
        if (id !== reqId.current) return
        const error =
          instances.error ?? campaigns.error ?? activity.error ??
          syncRuns.error ?? annotations.error ?? steps.error ??
          briefing.error
        if (error) {
          // Query-level failure: keep prior data, just flag the error.
          showError(error.message)
        } else {
          // Success replaces the small tables wholesale (clearing any prior
          // error); the big tables replace on a full load and merge-by-id on a
          // delta, with still-pending optimistic patches re-applied on top.
          setData((prev) => {
            const base = prev ?? EMPTY
            // Only rows genuinely returned this cycle can confirm a pending patch
            // (a delta merge carries absent leads over from state unchanged).
            const fetchedLeadIds = delta ? new Set(leads.map((l) => l.id)) : null
            const nextLeads = applyPending(delta ? mergeById(base.leads, leads) : leads, fetchedLeadIds)
            let nextMessages: Message[]
            if (delta) {
              const merged = mergeById(base.messages, messages) // === base.messages when batch empty
              // Delta merges are additive: prune outbound rows that have aged past
              // the 90-day window (same cutoff as the fetch filter; inbound
              // untouched) so they don't linger until a full fetch. filter() always
              // allocates, so only adopt the result when it actually removed a row —
              // otherwise keep `merged`'s reference for a no-op tick.
              const pruned = merged.filter((m) => m.direction !== 'out' || m.sent_at.slice(0, 10) >= since)
              const trimmed = pruned.length === merged.length ? merged : pruned
              nextMessages =
                trimmed === base.messages
                  ? base.messages // nothing merged or pruned → stable reference
                  : [...trimmed].sort((a, b) =>
                      a.sent_at < b.sent_at ? 1 : a.sent_at > b.sent_at ? -1 : 0)
            } else {
              nextMessages = messages
            }
            const events = delta
              ? mergeById(
                  base.pipelineEvents as unknown as { id: number }[],
                  pipelineEvents as unknown as { id: number }[],
                )
              : pipelineEvents
            // Small tables reuse the prior reference when deep-equal, so a no-op
            // refresh keeps every data slice reference-stable for downstream memos.
            return {
              instances: stableSlice(base.instances, instances.data ?? []),
              campaigns: stableSlice(base.campaigns, campaigns.data ?? []),
              activity: stableSlice(base.activity, activity.data ?? []),
              syncRuns: stableSlice(base.syncRuns, syncRuns.data ?? []),
              messages: nextMessages,
              annotations: stableSlice(base.annotations, annotations.data ?? []),
              steps: stableSlice(base.steps, steps.data ?? []),
              briefing: stableSlice(base.briefing, briefing.data?.[0] ?? null),
              prevBriefing: stableSlice(base.prevBriefing, briefing.data?.[1] ?? null),
              teamMembers: stableSlice(base.teamMembers, teamMembers.data ?? []),
              savedSearches: stableSlice(
                base.savedSearches,
                (savedSearches.data ?? []) as SavedSearch[],
              ),
              icps: stableSlice(base.icps, (icps.data ?? []) as Icp[]),
              icpPersonas: stableSlice(base.icpPersonas, (icpPersonas.data ?? []) as IcpPersona[]),
              icpIndustries: stableSlice(base.icpIndustries, (icpIndustries.data ?? []) as IcpIndustry[]),
              hypotheses: stableSlice(base.hypotheses, (hypotheses.data ?? []) as Hypothesis[]),
              hypothesisCampaigns: stableSlice(
                base.hypothesisCampaigns,
                (hypothesisCampaigns.data ?? []) as HypothesisCampaign[],
              ),
              // Already reference-stable on a no-op delta (mergeById returns the
              // prior array when the batch is empty); full fetch gets a fresh one.
              pipelineEvents: events as unknown as DashboardData['pipelineEvents'],
              leads: nextLeads,
            }
          })
          // Advance the cursor for the next delta (start-time minus overlap).
          cursorRef.current = new Date(startedAt - REFRESH_OVERLAP_MS).toISOString()
        }
      } catch (e) {
        // A delta query hit a missing updated_at column (migration 031 pending):
        // disable delta for the session and immediately retry as a full load so
        // the dashboard keeps working pre-migration.
        if (delta && isMissingColumn(e)) {
          deltaSupported.current = false
          return load('full')
        }
        if (id === reqId.current)
          showError(e instanceof Error ? e.message : String(e))
      }
      if (id === reqId.current) setLoading(false)
  }, [showError, applyPending])

  // Manual refetch (post-write) always forces a full fetch — a delta could miss
  // a row the caller just changed if updated_at ordering/skew raced the commit.
  const refetch = useCallback(() => {
    void load('full')
  }, [load])

  useEffect(() => {
    void load('full')
    const timer = setInterval(() => void load('delta'), 5 * 60_000)
    return () => clearInterval(timer)
  }, [load])

  return (
    <Ctx.Provider
      value={{
        data, loading, refetch, patchLead, upsertSavedSearch, removeSavedSearch,
        upsertIcp, removeIcp, upsertIcpPersona, removeIcpPersona,
        upsertIcpIndustry, removeIcpIndustry, upsertHypothesis, removeHypothesis,
        assignCampaigns,
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export const useData = () => useContext(Ctx)
