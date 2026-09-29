import { useVisibleInterval } from './useVisibleInterval'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import {
  fetchNeonBootstrap,
  fetchNeonFollowUpState,
  fetchNeonRouteSnapshot,
  routeSnapshotRequest,
  type NeonRouteSnapshot,
} from './dashboardReads'
import type { LeadEdit } from './leadEdits'
import type {
  Annotation, CampaignMetrics, CampaignSequenceContext, CampaignStep, ConversationLatestMessage,
  ConversationReplyIntent, DailyActivity, DashboardData, FollowUpState,
  Hypothesis, HypothesisCampaign, Icp, IcpIndustry, IcpPersona, Instance, Lead,
  Message, PipelineEvent, SavedSearch, SyncRun, TeamMember,
} from './types'

const EMPTY: DashboardData = {
  instances: [],
  campaigns: [],
  activity: [],
  leads: [],
  syncRuns: [],
  messages: [],
  conversationReplyIntents: [],
  annotations: [],
  steps: [],
  teamMembers: [],
  pipelineEvents: [],
  followUpStates: [],
  latestConversationMessages: [],
  followUpsAvailable: false,
  savedSearches: [],
  icps: [],
  icpPersonas: [],
  icpIndustries: [],
  hypotheses: [],
  hypothesisCampaigns: [],
  campaignSequenceContext: null,
}

// Every refresh returns fresh arrays even when the data is unchanged. Keep the previous reference when the payload is
// deep-equal so consumers memoized on a data slice don't recompute on a no-op
// refresh. These tables are small, so a JSON compare is cheap.
function stableSlice<T>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
}

/** One load's worth of rows, in the browser's own types. */
interface Fetched {
  instances: Instance[]
  campaigns: CampaignMetrics[]
  activity: DailyActivity[]
  syncRuns: SyncRun[]
  annotations: Annotation[]
  steps: CampaignStep[]
  teamMembers: TeamMember[]
  savedSearches: SavedSearch[]
  icps: Icp[]
  icpPersonas: IcpPersona[]
  icpIndustries: IcpIndustry[]
  hypotheses: Hypothesis[]
  hypothesisCampaigns: HypothesisCampaign[]
  leads: Lead[]
  messages: Message[]
  pipelineEvents: PipelineEvent[]
  followUpStates: FollowUpState[]
  latestConversationMessages: ConversationLatestMessage[]
  followUpsAvailable: boolean
  conversationReplyIntents: ConversationReplyIntent[]
  campaignSequenceContext: CampaignSequenceContext | null
}

type NeonBootstrap = Awaited<ReturnType<typeof fetchNeonBootstrap>>

/** Adapt one route-owned payload, over the shell bootstrap, to the commit shape. */
function routeSnapshotFetched(
  bootstrap: NeonBootstrap,
  snapshot: NeonRouteSnapshot,
): Fetched {
  const campaignById = new Map(
    bootstrap.campaigns.map((campaign) => [campaign.campaign_id, campaign]),
  )
  for (const campaign of snapshot.campaigns ?? []) {
    campaignById.set(campaign.campaign_id, campaign)
  }
  return {
    // Health owns the live account heartbeat. The shell bootstrap is loaded
    // once per tab, while route snapshots refresh every five minutes; keeping
    // the bootstrap rows here made `last_sync_at` age indefinitely in an open
    // tab even as newer sync runs appeared directly beside it.
    instances: snapshot.instances ?? bootstrap.instances,
    campaigns: [...campaignById.values()],
    activity: [],
    syncRuns: snapshot.syncRuns ?? [],
    annotations: snapshot.annotations ?? [],
    steps: snapshot.steps ?? [],
    teamMembers: bootstrap.teamMembers,
    savedSearches: snapshot.savedSearches ?? [],
    icps: snapshot.icps ?? [],
    icpPersonas: snapshot.icpPersonas ?? [],
    icpIndustries: snapshot.icpIndustries ?? [],
    hypotheses: snapshot.hypotheses ?? [],
    hypothesisCampaigns: snapshot.hypothesisCampaigns ?? [],
    leads: snapshot.leads ?? [],
    messages: snapshot.messages ?? [],
    pipelineEvents: snapshot.pipelineEvents ?? [],
    followUpStates: snapshot.followUpStates ?? [],
    latestConversationMessages: snapshot.latestConversationMessages ?? [],
    followUpsAvailable: snapshot.followUpsAvailable ?? false,
    conversationReplyIntents: snapshot.conversationReplyIntents ?? [],
    campaignSequenceContext: snapshot.campaignSequenceContext ?? null,
  }
}

const Ctx = createContext<{
  data: DashboardData | null
  loading: boolean
  phase: 'empty' | 'bootstrap' | 'full'
  refetch: () => void
  /** Merge a partial update into one lead in place (no refetch). Used by the
   *  manual-pipeline optimistic writes so a stage/assignee change reflects
   *  everywhere the lead is rendered. */
  patchLead: (leadId: string, patch: Partial<Lead>) => void
  /** Every patchLead edit this session, merged per lead, with when it was made.
   *  `data.leads` already carries them; this is for the leads it does not hold —
   *  Leads reads its rows page by page — so the drawer and that table still show
   *  a saved stage, owner or gender. Apply with `withLeadEdits`. */
  leadEdits: ReadonlyMap<string, LeadEdit>
  /** Fold a completed campaign-context save into the campaign_metrics slice. */
  patchCampaign: (campaignId: string, patch: Partial<CampaignMetrics>) => void
  /** Optimistically replace/remove one conversation-scoped follow-up state.
   *  Pending values survive an in-flight five-minute refresh. */
  patchFollowUpState: (key: string, state: FollowUpState | null) => void
  /** Load one conversation's follow-up state when the route's own data carries
   *  none (Leads is page-local), so the conversation drawer can still schedule
   *  against the real revision. A no-op where the route already has them. */
  loadFollowUpState: (instanceId: string, profileUrl: string) => Promise<void>
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
  phase: 'empty',
  refetch: () => {},
  patchLead: () => {},
  leadEdits: new Map(),
  patchCampaign: () => {},
  patchFollowUpState: () => {},
  loadFollowUpState: async () => {},
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
  const location = useLocation()
  // Replies and its report own their query-string reads. Their selections and
  // filters must not restart the shared dashboard snapshot.
  const activeRouteHash = `#${location.pathname}${location.pathname === '/replies' || location.pathname === '/sentiment-analysis' ? '' : location.search}`
  // The snapshot restarts only when what it reads changes, and its key says
  // exactly that: the route, a detail id, and Campaign's `cmp` list. Every
  // other query parameter — a Hypotheses selection (`?h=`), Pipeline or
  // Follow-ups filters, a tab or range — never reaches the request, so
  // restarting on it re-read an identical snapshot, dropped the page to its
  // skeleton and remounted it. `load` reads the current hash through a ref.
  const routeLoadKey = routeSnapshotRequest(activeRouteHash)?.key ?? `local:${location.pathname || '/'}`
  const activeRouteHashRef = useRef(activeRouteHash)
  activeRouteHashRef.current = activeRouteHash
  const [data, setData] = useState<DashboardData | null>(null)
  const [leadEdits, setLeadEdits] = useState<ReadonlyMap<string, LeadEdit>>(() => new Map())
  const [loading, setLoading] = useState(true)
  const [phase, setPhase] = useState<'empty' | 'bootstrap' | 'full'>('empty')
  const bootstrapReady = useRef(false)
  const bootstrapData = useRef<NeonBootstrap | null>(null)
  const inFlightRouteKey = useRef<string | null>(null)
  // The route whose snapshot last committed, i.e. the one on screen now.
  const shownRouteKey = useRef<string | null>(null)
  // Only the most recent load() wins, so a manual refetch can't be clobbered by
  // an in-flight interval load (or vice versa).
  const reqId = useRef(0)
  // Optimistic pipeline patches still awaiting server confirmation, kept so a
  // load() already in flight can't revert them (re-applied after every commit).
  const pendingPatches = useRef<Map<string, { patch: Partial<Lead>; at: number }>>(new Map())
  const pendingFollowUps = useRef<
    Map<string, { state: FollowUpState | null; at: number }>
  >(new Map())
  // Follow-up states loaded one conversation at a time (loadFollowUpState) on a
  // route whose data carries none. Folded into every commit that also carries
  // none, so the five-minute refresh cannot take an open drawer's follow-up
  // away. `routeHasFollowUps` is what the last commit's own data said.
  const threadFollowUps = useRef<Map<string, FollowUpState | null>>(new Map())
  const routeHasFollowUps = useRef(false)

  // Surface an error without wiping on-screen data: keep the last successful
  // load and only stamp the error field. First-load failures (prev === null)
  // still fall back to the empty-with-error state.
  const showError = useCallback((message: string) => {
    setData((prev) => (prev ? { ...prev, error: message } : { ...EMPTY, error: message }))
  }, [])

  // Re-apply still-pending optimistic patches on top of freshly-fetched leads so
  // an in-flight load() can't revert them. A patch is confirmed/dropped only when
  // a row that was GENUINELY fetched this cycle reflects it, or after a 30s TTL.
  // Every load is a complete replacement, so every returned id counts.
  const applyPending = useCallback((leads: Lead[]): Lead[] => {
    const pend = pendingPatches.current
    if (pend.size === 0) return leads
    const now = Date.now()
    for (const [lid, p] of pend) if (now - p.at > 30_000) pend.delete(lid)
    if (pend.size === 0) return leads
    const byId = new Map(leads.map((l) => [l.id, l]))
    for (const [lid, p] of pend) {
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
    setLeadEdits((edits) => {
      const next = new Map(edits)
      next.set(leadId, { patch: { ...edits.get(leadId)?.patch, ...patch }, at: Date.now() })
      return next
    })
    setData((prevData) =>
      prevData
        ? { ...prevData, leads: prevData.leads.map((l) => (l.id === leadId ? { ...l, ...patch } : l)) }
        : prevData,
    )
  }, [])

  const patchCampaign = useCallback((campaignId: string, patch: Partial<CampaignMetrics>) => {
    setData((prevData) =>
      prevData
        ? {
            ...prevData,
            campaigns: prevData.campaigns.map((campaign) =>
              campaign.campaign_id === campaignId ? { ...campaign, ...patch } : campaign,
            ),
          }
        : prevData,
    )
  }, [])

  const followUpKey = (instanceId: string, profileUrl: string) =>
    `${instanceId}|${profileUrl}`

  // A route with its own follow-up data wins outright; one without it gets the
  // states its drawers loaded one conversation at a time.
  const withThreadFollowUps = useCallback(
    (fetched: { followUpStates: FollowUpState[]; followUpsAvailable: boolean }): FollowUpState[] => {
      if (fetched.followUpsAvailable || threadFollowUps.current.size === 0) return fetched.followUpStates
      const byKey = new Map(fetched.followUpStates.map((r) => [followUpKey(r.instance_id, r.profile_url), r]))
      for (const [key, state] of threadFollowUps.current) {
        if (state) byKey.set(key, state)
        else byKey.delete(key)
      }
      return [...byKey.values()]
    },
    [],
  )

  const applyPendingFollowUps = useCallback((rows: FollowUpState[]): FollowUpState[] => {
    const pending = pendingFollowUps.current
    if (pending.size === 0) return rows
    const now = Date.now()
    for (const [key, p] of pending) if (now - p.at > 30_000) pending.delete(key)
    if (pending.size === 0) return rows

    const byKey = new Map(rows.map((r) => [followUpKey(r.instance_id, r.profile_url), r]))
    for (const [key, p] of pending) {
      const fetched = byKey.get(key)
      if (p.state === null) {
        if (!fetched) pending.delete(key)
        else byKey.delete(key)
        continue
      }
      if (fetched && fetched.revision >= p.state.revision) {
        pending.delete(key)
        continue
      }
      byKey.set(key, p.state)
    }
    return [...byKey.values()]
  }, [])

  const patchFollowUpState = useCallback((key: string, state: FollowUpState | null) => {
    pendingFollowUps.current.set(key, { state, at: Date.now() })
    if (threadFollowUps.current.has(key)) threadFollowUps.current.set(key, state)
    setData((prevData) => {
      if (!prevData) return prevData
      const rest = prevData.followUpStates.filter(
        (row) => followUpKey(row.instance_id, row.profile_url) !== key,
      )
      return {
        ...prevData,
        followUpStates: state ? [...rest, state] : rest,
      }
    })
  }, [])

  const loadFollowUpState = useCallback(async (instanceId: string, profileUrl: string) => {
    if (routeHasFollowUps.current) return
    const { state, available } = await fetchNeonFollowUpState(instanceId, profileUrl)
    if (!available || routeHasFollowUps.current) return
    const key = followUpKey(instanceId, profileUrl)
    threadFollowUps.current.set(key, state)
    setData((prevData) => {
      if (!prevData) return prevData
      const rest = prevData.followUpStates.filter(
        (row) => followUpKey(row.instance_id, row.profile_url) !== key,
      )
      return {
        ...prevData,
        followUpsAvailable: true,
        followUpStates: state ? [...rest, state] : rest,
      }
    })
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

  // Every load is a complete replacement: the shell bootstrap once per tab,
  // then the active route's snapshot. Initial load, manual refetch after a
  // write, and the five-minute refresh all take this one path.
  const load = useCallback(async () => {
    const routeRequest = routeSnapshotRequest(activeRouteHashRef.current)
    const routeKey = routeRequest?.key ?? routeLoadKey
    // Manual refresh and the timer may meet the route's first load. A route
    // payload is complete, so a second request for the same key only adds load
    // and makes the first result stale; coalesce it here.
    if (inFlightRouteKey.current === routeKey) return
    const id = ++reqId.current
    inFlightRouteKey.current = routeKey
    // Only a route whose snapshot is not on screen yet drops to the skeleton.
    // A refresh of the same route (timer, tab refocus, refetch after a write)
    // swaps the data in quietly: flipping `loading` here makes Layout unmount
    // the page, and with it any open conversation drawer and its unsaved text.
    if (shownRouteKey.current !== routeKey) {
      setLoading(true)
      if (bootstrapReady.current) setPhase('bootstrap')
    }
    try {
      if (!bootstrapReady.current) {
        const bootstrap = await fetchNeonBootstrap()
        if (id !== reqId.current) return
        bootstrapReady.current = true
        bootstrapData.current = bootstrap
        setData({
          ...EMPTY,
          instances: bootstrap.instances,
          campaigns: bootstrap.campaigns,
          teamMembers: bootstrap.teamMembers,
        })
        setPhase('bootstrap')
        setLoading(false)
        if (typeof performance !== 'undefined') {
          performance.mark('dashboard_bootstrap_ready')
        }
      }
      const fetched = routeSnapshotFetched(
        bootstrapData.current!,
        routeRequest ? await fetchNeonRouteSnapshot(routeRequest) : {},
      )
      const {
        instances, campaigns, activity, syncRuns, annotations, steps, teamMembers,
        savedSearches, icps, icpPersonas, icpIndustries, hypotheses, hypothesisCampaigns,
        leads, messages, pipelineEvents, conversationReplyIntents,
      } = fetched
      if (id !== reqId.current) return
      // Success replaces every slice (clearing any prior error), with
      // still-pending optimistic patches re-applied on top.
      setData((prev) => {
        const base = prev ?? EMPTY
        // Small tables reuse the prior reference when deep-equal, so a no-op
        // refresh keeps every data slice reference-stable for downstream memos.
        return {
          instances: stableSlice(base.instances, instances),
          campaigns: stableSlice(base.campaigns, campaigns),
          activity: stableSlice(base.activity, activity),
          syncRuns: stableSlice(base.syncRuns, syncRuns),
          messages,
          conversationReplyIntents: stableSlice(
            base.conversationReplyIntents,
            conversationReplyIntents,
          ),
          annotations: stableSlice(base.annotations, annotations),
          steps: stableSlice(base.steps, steps),
          teamMembers: stableSlice(base.teamMembers, teamMembers),
          savedSearches: stableSlice(base.savedSearches, savedSearches),
          icps: stableSlice(base.icps, icps),
          icpPersonas: stableSlice(base.icpPersonas, icpPersonas),
          icpIndustries: stableSlice(base.icpIndustries, icpIndustries),
          hypotheses: stableSlice(base.hypotheses, hypotheses),
          hypothesisCampaigns: stableSlice(
            base.hypothesisCampaigns,
            hypothesisCampaigns,
          ),
          pipelineEvents,
          followUpStates: applyPendingFollowUps(withThreadFollowUps(fetched)),
          latestConversationMessages: stableSlice(
            base.latestConversationMessages,
            fetched.latestConversationMessages,
          ),
          followUpsAvailable: fetched.followUpsAvailable || threadFollowUps.current.size > 0,
          campaignSequenceContext: fetched.campaignSequenceContext,
          leads: applyPending(leads),
        }
      })
      shownRouteKey.current = routeKey
      routeHasFollowUps.current = fetched.followUpsAvailable
      // Those states were a stand-in for route data this route now has.
      if (fetched.followUpsAvailable) threadFollowUps.current.clear()
      setPhase('full')
      if (typeof performance !== 'undefined') {
        performance.mark('dashboard_full_ready')
      }
    } catch (e) {
      if (id === reqId.current)
        showError(e instanceof Error ? e.message : String(e))
    } finally {
      if (inFlightRouteKey.current === routeKey) inFlightRouteKey.current = null
    }
    if (id === reqId.current) setLoading(false)
  }, [routeLoadKey, showError, applyPending, applyPendingFollowUps, withThreadFollowUps])

  const refetch = useCallback(() => {
    void load()
  }, [load])

  useEffect(() => {
    void load()
  }, [load])

  useVisibleInterval(refetch, 5 * 60_000)

  return (
    <Ctx.Provider
      value={{
        data, loading, phase, refetch, patchLead, leadEdits, patchCampaign, patchFollowUpState, loadFollowUpState,
        upsertSavedSearch, removeSavedSearch,
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

