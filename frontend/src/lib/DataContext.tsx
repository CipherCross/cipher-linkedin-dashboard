import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { supabase } from './supabase'
import { fetchConversationReplyIntents, isMissingRelation } from './conversationPaging'
import { fetchNeonBootstrap, fetchNeonDashboard, resolveReadPath } from './dashboardReads'
import type { RosterPath } from './rosterWrites'
import type {
  Annotation, CampaignMetrics, CampaignStep, ConversationLatestMessage,
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
  // The safe default while nothing has been read: the ids of an empty roster
  // belong to no space, and `supabase` is the value every write surface treats
  // as permissive — but the list is empty, so nothing is offered either way.
  rosterPath: 'supabase',
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
}

const LEAD_COLUMNS_BASE =
  'id,instance_id,campaign_id,profile_url,full_name,headline,company,' +
  'added_at,invited_at,connected_at,first_message_at,replied_at,last_action_at'
// The manual-pipeline columns (migration pending on some DBs).
const LEAD_COLUMNS_PIPELINE =
  `${LEAD_COLUMNS_BASE},pipeline_stage,pipeline_substatus,lost_reason,` +
  'pipeline_stage_changed_at,assigned_to'
// Demographics lifecycle v2 (migration 048). Keep the old 041/042 rung beneath it
// so frontend/API rollout can safely precede the new migration.
const LEAD_COLUMNS_DEMO_V2 =
  `${LEAD_COLUMNS_PIPELINE},education_start_year,first_job_start_year,` +
  'birth_year_min,birth_year_max,age_inferred_at,age_method_version,age_source,' +
  'gender,gender_confidence,gender_inferred_at,gender_model_version,demo_inferred_at,' +
  'demo_model,photo_path,photo_synced_at'
// Demographics (migration 041) + photo (migration 042).
const LEAD_COLUMNS_FULL =
  `${LEAD_COLUMNS_PIPELINE},education_start_year,first_job_start_year,` +
  'birth_year_min,birth_year_max,gender,gender_confidence,demo_inferred_at,' +
  'demo_model,photo_path,photo_synced_at'
// The widest set we ask for first.
const LEAD_COLUMNS = LEAD_COLUMNS_DEMO_V2
// Retry ladder, widest → narrowest. Requesting a missing column makes PostgREST
// 400 the whole query (SQLSTATE 42703); on that error fetchAllLeads drops to the
// NEXT rung rather than falling straight to base — so a DB that has the pipeline
// migration but not the demographics/photo ones keeps its pipeline columns
// instead of silently losing them. Each narrower rung's fields come back
// undefined/null in the UI.
const LEAD_COLUMN_LADDER = [
  LEAD_COLUMNS_DEMO_V2,
  LEAD_COLUMNS_FULL,
  LEAD_COLUMNS_PIPELINE,
  LEAD_COLUMNS_BASE,
]

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

/** Follow-up state and its authoritative latest-message projection are both
 *  conversation-scoped and can exceed PostgREST's 1,000-row cap. A pre-046
 *  database is an explicit unavailable state, not an empty queue. */
async function fetchFollowUpData(): Promise<{
  states: FollowUpState[]
  latest: ConversationLatestMessage[]
  available: boolean
}> {
  const page = 1000
  const states: FollowUpState[] = []
  const latest: ConversationLatestMessage[] = []
  try {
    for (let from = 0; ; from += page) {
      const { data, error } = await supabase!
        .from('conversation_follow_up_state')
        .select('*')
        .order('instance_id')
        .order('profile_url')
        .range(from, from + page - 1)
      if (error) throw error
      states.push(...((data ?? []) as unknown as FollowUpState[]))
      if (!data || data.length < page) break
    }
    for (let from = 0; ; from += page) {
      const { data, error } = await supabase!
        .from('conversation_latest_message')
        .select('*')
        .order('instance_id')
        .order('profile_url')
        .range(from, from + page - 1)
      if (error) throw error
      latest.push(...((data ?? []) as unknown as ConversationLatestMessage[]))
      if (!data || data.length < page) break
    }
    return { states, latest, available: true }
  } catch (e) {
    if (isMissingRelation(e)) return { states: [], latest: [], available: false }
    throw e
  }
}

const MESSAGE_COLUMNS_BASE =
  'id,instance_id,campaign_id,profile_url,direction,body,sent_at,sentiment,reason,classified_at,classified_model'
// `source` (migration 026: 'sync' | 'manual') may not exist on the live DB yet.
const MESSAGE_COLUMNS_SOURCE = `${MESSAGE_COLUMNS_BASE},source`
// Intent columns arrive in migration 047. Keep a retry ladder so the frontend
// can be deployed before the additive migration without taking the dashboard
// down; intent metrics simply remain empty until the schema lands.
const MESSAGE_COLUMNS =
  `${MESSAGE_COLUMNS_SOURCE},intent_level,intent_reason,intent_classified_at,` +
  'intent_classified_model,intent_taxonomy_version'
const MESSAGE_COLUMN_LADDER = [MESSAGE_COLUMNS, MESSAGE_COLUMNS_SOURCE, MESSAGE_COLUMNS_BASE]

// True only for PostgREST's "undefined column" error (Postgres SQLSTATE 42703),
// i.e. the `source` column doesn't exist yet. supabase-js error shapes vary, so
// also accept a message that names the missing column as a fallback.
function isMissingMessageColumn(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null
  if (err?.code === '42703') return true
  return !!err?.message && /column\s+.*\s+does not exist/i.test(err.message)
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
    // Step down only for a genuinely missing column. A partial page is discarded
    // by the retry; network/RLS errors still propagate.
    const rung = MESSAGE_COLUMN_LADDER.indexOf(columns)
    const next = rung >= 0 ? MESSAGE_COLUMN_LADDER[rung + 1] : undefined
    if (next && isMissingMessageColumn(e))
      return fetchMessages(since, next, updatedSince)
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

function isProgressiveLocation(): boolean {
  if (typeof window === 'undefined') return false
  const route = window.location.hash.replace(/^#/, '').split('?')[0] || '/'
  return route === '/' || route === '/leads'
}

// The always-full-refetched small tables get a fresh array every cycle even when
// their data is unchanged. Keep the previous reference when the payload is
// deep-equal so consumers memoized on a data slice don't recompute on a no-op
// refresh. These tables are small, so a JSON compare is cheap.
function stableSlice<T>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
}

/**
 * One load's worth of rows, in the browser's own types and with no trace of
 * which provider answered.
 *
 * Both fetchers below produce exactly this, so the commit block in `load()` —
 * the delta merge, the pending-patch replay, the reference-stability pass — is
 * written once and is provider-independent. That is the whole point of the
 * shape: the switch must not fork the part of `DataContext` that decides what
 * the dashboard shows, only the part that decides where the rows come from.
 */
interface Fetched {
  /**
   * Which provider's id space `teamMembers` — and therefore every
   * `leads.assigned_to` and `owner_id` beside it — belongs to.
   *
   * On the shape rather than inferred by a consumer, because the two fetchers
   * are the only code that knows, and because the answer decides more than a
   * label: `rosterWrites.ts` reads it to refuse sending a member id to a writer
   * that would resolve it against the other database.
   */
  rosterPath: RosterPath
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
  /**
   * A query-level failure that must be *reported* without throwing — the
   * Supabase path's aggregate of the six reads whose errors are not tolerated.
   * `null` on the Neon path, where every failure throws and the outer `catch`
   * reports it; the field stays on the shape rather than becoming a union so
   * the commit block does not have to know which fetcher ran.
   */
  error: string | null
}

/**
 * The Supabase read path, unchanged in substance and moved out of `load()`
 * verbatim.
 *
 * Everything about it is deliberately as it was: the seven reads whose errors
 * are excluded from the aggregate (a missing manual-pipeline or Search Library
 * table yields `[]` and never fails the load), the two column ladders, the
 * inbound/outbound asymmetry, the delta watermark. The switch adds a sibling; it
 * does not renegotiate this path, which is the one every deployment is running.
 */
async function fetchSupabaseDashboard(
  since: string,
  delta: boolean,
  cursor: string | null,
): Promise<Fetched> {
  // Small / view-backed tables can't delta (views) and are cheap — always
  // full, even on an interval refresh.
  const smallP = Promise.all([
    supabase!
      .from('instances')
      .select('id,label,last_sync_at,agent_version,account_name,account_url,account_avatar,config,config_updated_at')
      .order('id'),
    supabase!.from('campaign_metrics').select('*').order('campaign_name'),
    supabase!.from('daily_activity').select('*').gte('day', since),
    supabase!
      .from('sync_runs')
      .select('id,instance_id,started_at,finished_at,status,rows_upserted,error')
      .order('started_at', { ascending: false })
      .limit(200),
    supabase!.from('annotations').select('*').order('noted_at'),
    supabase!
      .from('campaign_steps')
      .select('*')
      .order('campaign_id')
      .order('step_index'),
    // Manual-pipeline tables may not exist yet (migration pending). Their
    // errors are intentionally NOT folded into the aggregate `error`
    // below — a missing table just yields an empty list, never a failed
    // load. team_members' .select() resolves with {data,error} (never
    // throws); fetchAllPipelineEvents swallows its own errors to [].
    supabase!
      .from('team_members')
      .select('id,name,active,created_at,auth_user_id,email,role')
      .order('id'),
    // Search Library (migration 040) — same tolerated-error pattern: a
    // missing table (pre-migration DB) yields [] and its error is excluded
    // from the aggregate `error` below, so it never fails the load.
    supabase!.from('saved_searches').select('*').order('platform').order('name'),
    // ICP + Hypothesis layer (migration 043) — same tolerated-error pattern.
    supabase!.from('icps').select('*').order('name'),
    supabase!.from('icp_personas').select('*').order('icp_id').order('sort'),
    supabase!.from('icp_industries').select('*').order('icp_id').order('name'),
    supabase!.from('hypotheses').select('*').order('name'),
    supabase!.from('hypothesis_campaigns').select('*'),
  ])
  // Big append-heavy tables delta on an interval refresh, full otherwise.
  const leadsP = delta ? fetchAllLeads(LEAD_COLUMNS, cursor!) : fetchAllLeads()
  const messagesP = delta ? fetchMessages(since, MESSAGE_COLUMNS, cursor!) : fetchMessages(since)
  const eventsP = delta ? fetchAllPipelineEvents(cursor!) : fetchAllPipelineEvents()
  const followUpsP = fetchFollowUpData()
  // Full-thread projection needed for exact P3 ghosting even though the
  // global message cache intentionally windows outbound rows to 90 days.
  // Conversation-scoped and therefore unbounded, so it pages like the two
  // sibling views in fetchFollowUpData rather than sitting in smallP with
  // no .range() loop — which silently capped it at PostgREST's 1,000 rows.
  // It resolves to rows or throws; a missing relation is the one tolerated
  // failure, and it yields [] rather than a prefix.
  const replyIntentsP = fetchConversationReplyIntents(supabase!)
  const [small, leads, messages, pipelineEvents, followUps, conversationReplyIntents] =
    await Promise.all([
      smallP, leadsP, messagesP, eventsP, followUpsP, replyIntentsP,
    ])
  const [
    instances, campaigns, activity, syncRuns, annotations, steps, teamMembers,
    savedSearches, icps, icpPersonas, icpIndustries, hypotheses, hypothesisCampaigns,
  ] = small
  const error =
    instances.error ?? campaigns.error ?? activity.error ??
    syncRuns.error ?? annotations.error ?? steps.error
  return {
    rosterPath: 'supabase',
    instances: (instances.data ?? []) as Instance[],
    campaigns: (campaigns.data ?? []) as CampaignMetrics[],
    activity: (activity.data ?? []) as DailyActivity[],
    syncRuns: (syncRuns.data ?? []) as SyncRun[],
    annotations: (annotations.data ?? []) as Annotation[],
    steps: (steps.data ?? []) as CampaignStep[],
    teamMembers: (teamMembers.data ?? []) as TeamMember[],
    savedSearches: (savedSearches.data ?? []) as SavedSearch[],
    icps: (icps.data ?? []) as Icp[],
    icpPersonas: (icpPersonas.data ?? []) as IcpPersona[],
    icpIndustries: (icpIndustries.data ?? []) as IcpIndustry[],
    hypotheses: (hypotheses.data ?? []) as Hypothesis[],
    hypothesisCampaigns: (hypothesisCampaigns.data ?? []) as HypothesisCampaign[],
    leads,
    messages,
    pipelineEvents: pipelineEvents as unknown as PipelineEvent[],
    followUpStates: followUps.states,
    latestConversationMessages: followUps.latest,
    followUpsAvailable: followUps.available,
    conversationReplyIntents,
    error: error ? error.message : null,
  }
}

/**
 * The application API's read path, behind the deployment's `NEON_READS_DEFAULT`
 * flag. Everything it decides lives in `dashboardReads.ts`; this is the adapter
 * from that module's result to `Fetched`, and it is two facts long.
 *
 * **The roster arrives with the leads, and `rosterPath` says whose ids these
 * are.** S13's switch left `teamMembers` empty here, on the argument that a
 * Supabase roster beside Neon leads would put a confidently wrong name on every
 * owner chip. That argument was right and it expired with its premise: both ends
 * of the join now come from the same database. What it left behind was a worse
 * artefact — a Team page stating "0 Active teammates" — so the roster moves on
 * the same flag rather than a second one.
 *
 * The marker is not decoration. The ids in these rows are this provider's, and
 * `/api/pipeline`'s member-keyed actions resolve ids against the *other* one; it
 * is what `rosterWrites.ts` reads to refuse the round trip.
 */
async function fetchNeonDashboardData(
  since: string,
  delta: boolean,
  cursor: string | null,
): Promise<Fetched> {
  const fetched = await fetchNeonDashboard({
    since,
    updatedSince: delta ? cursor : null,
  })
  // `rosterPath` arrives inside `fetched` rather than being written here, and
  // that is a correction the mutation pass forced: a literal in this file is a
  // literal no test can reach, and this one decides whether a member id may be
  // written back to the other provider.
  return {
    ...fetched,
    // Never set: on this path a read either answers or throws, and the throw is
    // reported by `load()`'s outer catch.
    error: null,
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
  /** Fold a completed campaign-context save into the campaign_metrics slice. */
  patchCampaign: (campaignId: string, patch: Partial<CampaignMetrics>) => void
  /** Optimistically replace/remove one conversation-scoped follow-up state.
   *  Pending values survive an in-flight five-minute refresh. */
  patchFollowUpState: (key: string, state: FollowUpState | null) => void
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
  patchCampaign: () => {},
  patchFollowUpState: () => {},
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
  const [phase, setPhase] = useState<'empty' | 'bootstrap' | 'full'>('empty')
  const bootstrapReady = useRef(false)
  const fullSnapshotReady = useRef(false)
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
  const pendingFollowUps = useRef<
    Map<string, { state: FollowUpState | null; at: number }>
  >(new Map())

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
    // Which provider answers this load. Memoized for the page's lifetime, so
    // this costs one unauthenticated round trip per session and every later
    // load — and every component read — sees the same answer. Any failure
    // resolves to `supabase`, so a flag lookup can never take the working
    // dashboard down.
    const readPath = await resolveReadPath()
    if (readPath === 'supabase' && !supabase) {
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
        if (readPath === 'neon' && mode === 'full' && !bootstrapReady.current) {
          const bootstrap = await fetchNeonBootstrap()
          if (id !== reqId.current) return
          bootstrapReady.current = true
          setData({
            ...EMPTY,
            instances: bootstrap.instances,
            campaigns: bootstrap.campaigns,
            teamMembers: bootstrap.teamMembers,
            rosterPath: bootstrap.rosterPath,
          })
          setPhase('bootstrap')
          setLoading(false)
          if (typeof performance !== 'undefined') {
            performance.mark('dashboard_bootstrap_ready')
          }
          // Overview and Leads both have compact route-owned reads, so neither
          // starts the historical tenant-wide snapshot on its critical path.
          // Other deep links still continue into the full route dataset below.
          if (isProgressiveLocation()) return
        }
        const since = new Date(startedAt - 90 * 86_400_000)
          .toISOString()
          .slice(0, 10)
        // The one line the switch adds. Both fetchers answer with `Fetched`, so
        // everything below this point is provider-independent and did not change.
        const fetched =
          readPath === 'neon'
            ? await fetchNeonDashboardData(since, delta, cursor)
            : await fetchSupabaseDashboard(since, delta, cursor)
        const {
          instances, campaigns, activity, syncRuns, annotations, steps, teamMembers,
          savedSearches, icps, icpPersonas, icpIndustries, hypotheses, hypothesisCampaigns,
          leads, messages, pipelineEvents, conversationReplyIntents,
        } = fetched
        if (id !== reqId.current) return
        if (fetched.error) {
          // Query-level failure: keep prior data, just flag the error.
          showError(fetched.error)
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
              instances: stableSlice(base.instances, instances),
              campaigns: stableSlice(base.campaigns, campaigns),
              activity: stableSlice(base.activity, activity),
              syncRuns: stableSlice(base.syncRuns, syncRuns),
              messages: nextMessages,
              conversationReplyIntents: stableSlice(
                base.conversationReplyIntents,
                conversationReplyIntents,
              ),
              annotations: stableSlice(base.annotations, annotations),
              steps: stableSlice(base.steps, steps),
              teamMembers: stableSlice(base.teamMembers, teamMembers),
              // Committed beside the roster it describes, never carried over
              // from `base`: the two must move together or a refresh could leave
              // one provider's ids labelled as the other's.
              rosterPath: fetched.rosterPath,
              savedSearches: stableSlice(base.savedSearches, savedSearches),
              icps: stableSlice(base.icps, icps),
              icpPersonas: stableSlice(base.icpPersonas, icpPersonas),
              icpIndustries: stableSlice(base.icpIndustries, icpIndustries),
              hypotheses: stableSlice(base.hypotheses, hypotheses),
              hypothesisCampaigns: stableSlice(
                base.hypothesisCampaigns,
                hypothesisCampaigns,
              ),
              // Already reference-stable on a no-op delta (mergeById returns the
              // prior array when the batch is empty); full fetch gets a fresh one.
              pipelineEvents: events as unknown as DashboardData['pipelineEvents'],
              followUpStates: applyPendingFollowUps(fetched.followUpStates),
              latestConversationMessages: stableSlice(
                base.latestConversationMessages,
                fetched.latestConversationMessages,
              ),
              followUpsAvailable: fetched.followUpsAvailable,
              leads: nextLeads,
            }
          })
          // Advance the cursor for the next delta (start-time minus overlap).
          cursorRef.current = new Date(startedAt - REFRESH_OVERLAP_MS).toISOString()
          setPhase('full')
          fullSnapshotReady.current = true
          if (typeof performance !== 'undefined') {
            performance.mark('dashboard_full_ready')
          }
        }
      } catch (e) {
        // A delta query hit a missing updated_at column (migration 031 pending):
        // disable delta for the session and immediately retry as a full load so
        // the dashboard keeps working pre-migration.
        //
        // Supabase-path only in practice, and by construction rather than by a
        // guard: the API never returns driver text (`safeErrorLabel` logs a name
        // and a code, never a message), so nothing reaching here from the Neon
        // path can look like a missing column. There is nothing to step down to
        // on that path either — the ledger-applied baseline carries every column
        // the operations select, so a missing one is a broken deployment.
        if (delta && isMissingColumn(e)) {
          deltaSupported.current = false
          return load('full')
        }
        if (id === reqId.current)
          showError(e instanceof Error ? e.message : String(e))
      }
      if (id === reqId.current) setLoading(false)
  }, [showError, applyPending, applyPendingFollowUps])

  // Manual refetch (post-write) always forces a full fetch — a delta could miss
  // a row the caller just changed if updated_at ordering/skew raced the commit.
  const refetch = useCallback(() => {
    void load('full')
  }, [load])

  useEffect(() => {
    void load('full')
    const ensureFull = () => {
      if (!isProgressiveLocation()) void load('full')
    }
    const afterOverview = () => {
      // Yield one task so React can paint the useful metrics before background
      // relation walks compete for network, JSON parsing and the database pool.
      setTimeout(() => void load('full'), 0)
    }
    window.addEventListener('hashchange', ensureFull)
    window.addEventListener('dashboard:overview-ready', afterOverview)
    const timer = setInterval(() => {
      if (fullSnapshotReady.current || !isProgressiveLocation()) void load('delta')
    }, 5 * 60_000)
    return () => {
      clearInterval(timer)
      window.removeEventListener('hashchange', ensureFull)
      window.removeEventListener('dashboard:overview-ready', afterOverview)
    }
  }, [load])

  return (
    <Ctx.Provider
      value={{
        data, loading, phase, refetch, patchLead, patchCampaign, patchFollowUpState,
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
