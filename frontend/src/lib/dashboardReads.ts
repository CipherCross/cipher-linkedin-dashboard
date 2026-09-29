/**
 * The browser's client for the application API's read vocabulary
 * (`GET /api/activity-daily?op=…`) — the switch half of S13.
 *
 * ## Why this module exists, and why it is a `.ts` file
 *
 * S13 parts 1–3 built twenty-two read operations behind one `?op=`-dispatched
 * endpoint and stopped there; `N-S13-consolidation.md:495` records the gap in
 * one line — "`DataContext` was not rewired to the Neon read path" — and eleven
 * of the twenty-two had no caller at all. This module is every one of those
 * callers.
 *
 * It is a plain module rather than logic inside `DataContext.tsx` because
 * everything this path *decides* — which operation, which parameters, when a walk
 * stops, what an `unavailable` marker means — is provable here without mounting
 * anything, and is covered by `tests/dashboardReads.test.ts`.
 *
 * The call sites in `DataContext.tsx` and the five components are no longer
 * uncovered: `tests/dataContext.test.tsx`, `tests/playbookPage.test.tsx` and
 * `tests/leadsExplorerDigest.test.tsx` render them against a mocked transport.
 * Which branch a component takes is a different question from what the branch
 * asks for, and the two halves are tested in the two places accordingly.
 *
 * ## The rules this client keeps, and where each comes from
 *
 * 1. **A partial result is never returned as if it were complete.** Applied to
 *    cursor walks: a failed page throws and
 *    discards the accumulator, and a walk that will not terminate throws rather
 *    than answering with the pages it managed to collect.
 * 2. **The server's tolerance policy is the client's tolerance policy.** Ten
 *    reads answer an absent relation with `unavailable: true` and HTTP 200; the
 *    other twelve fail. This client adds no tolerance of its own — a non-200 is
 *    an error on every operation.
 * 3. **The fetch asymmetry is preserved by construction.** Inbound messages are
 *    read all-time with no `from`/`to`; outbound carries the 90-day floor. The
 *    endpoint refuses `from`/`to` on `messages.inboundHistory` by not declaring
 *    it `ranged`, so the asymmetry is enforced on both sides rather than
 *    remembered on one.
 * 4. **The roster comes from the same database as the leads.**
 *    `leads.assigned_to` and `conversation_follow_up_state.owner_id` are member
 *    ids, so `identity.teamRoster` is one of the reads below and both ends of
 *    every member-id join arrive from one database.
 */

import { authFetch } from './api'
import { toTeamMember, type RosterMember } from './identityAuth'
import type {
  Annotation, CampaignMetrics, CampaignStep, CoachingDigest,
  ConversationLatestMessage, ConversationReplyIntent, DailyActivity,
  DashboardData, FollowUpEvent, FollowUpState, Hypothesis, HypothesisCampaign, Icp,
  IcpIndustry, IcpPersona, Instance, Lead, LeadNote, Message, PipelineEvent,
  OverviewSummary, SavedSearch, SyncRun, TeamMember,
  OverviewAccountCampaigns, OverviewPerformance, OverviewSystemTotals,
  LeadsSearchPage, SequenceHubSnapshot, CampaignPreview,
} from './types'

/**
 * The one function every read is dispatched through. The path still says
 * `activity-daily` because S12 named it and renaming it would have needed a
 * `vercel.json` rewrite that cannot be verified without a deploy; the
 * *operation names* below are the vocabulary that matters.
 */
export const READ_ENDPOINT = '/api/activity-daily'

/**
 * Every operation this client calls, spelled literally.
 *
 * The names are the server's, and `tests/dashboardReads.test.ts` asserts this
 * set equals `READ_OPERATION_NAMES` exported by `frontend/api/activity-daily.ts`
 * — so an operation added to the endpoint with no caller, or a caller naming an
 * operation the endpoint does not allowlist, fails a test rather than a request.
 * That assertion is what closes "eleven of twenty-two reads have no caller".
 */
export const READ_OPS = {
  bootstrap: 'dashboard.bootstrap',
  overviewSystemTotals: 'overview.systemTotals',
  overviewPerformance: 'overview.performance',
  overviewAccountCampaigns: 'overview.accountCampaigns',
  overviewSummary: 'overview.summary',
  campaignPreview: 'campaign.preview',
  sequenceHub: 'sequences.hub',
  routeSnapshot: 'dashboard.routeSnapshot',
  dailySeries: 'activity.dailySeries',
  instances: 'instances.overview',
  campaigns: 'campaigns.performance',
  campaignSteps: 'campaigns.sequenceSteps',
  syncRuns: 'sync.recentRuns',
  annotations: 'annotations.timeline',
  leads: 'leads.directory',
  leadsSearchPage: 'leads.searchPage',
  inboundMessages: 'messages.inboundHistory',
  outboundMessages: 'messages.outboundRecent',
  pipelineEvents: 'pipeline.eventLog',
  followUpState: 'conversations.followUpState',
  latestMessage: 'conversations.latestMessage',
  replyIntent: 'conversations.replyIntent',
  followUpHistory: 'conversations.followUpHistory',
  thread: 'messages.thread',
  leadNotes: 'leads.notes',
  savedSearches: 'searches.saved',
  icps: 'icp.profiles',
  icpPersonas: 'icp.personas',
  icpIndustries: 'icp.industries',
  hypotheses: 'hypotheses.list',
  hypothesisCampaigns: 'hypotheses.campaigns',
  /**
   * The roster. Named `identity.teamRoster` because it is the identity
   * surface's operation, served here as well rather than duplicated: the
   * dashboard needs the same seven columns `/api/identity?op=team.roster`
   * already returns, and a second spelling of one read is a second thing to
   * keep correct.
   */
  teamRoster: 'identity.teamRoster',
  /**
   * The playbook, named `coach.playbook` for the same reason the roster is
   * named `identity.teamRoster`: `/api/coach` already reads this singleton and
   * the Playbook page wants the same row. Borrowed, not duplicated.
   */
  playbook: 'coach.playbook',
  /** Every account's coaching digest, for the Leads Explorer's panel. */
  coachingDigests: 'coaching.digests',
} as const

/** Dedicated manual-reply reads stay outside DataContext's bootstrap dataset. */
export const REPLY_READ_OPS = {
  capabilities: 'replies.capabilities',
  inbox: 'replies.inbox',
  facets: 'replies.facets',
  thread: 'replies.thread',
  analytics: 'replies.analytics',
  reviewHistory: 'replies.reviewHistory',
} as const

export type RouteSnapshotRoute =
  | 'account'
  | 'campaign'
  | 'pipeline'
  | 'follow-ups'
  | 'review'
  | 'health'
  | 'searches'
  | 'icp'
  | 'hypotheses'

export interface RouteSnapshotRequest {
  readonly route: RouteSnapshotRoute
  readonly routeId?: string
  readonly compareIds?: string
  readonly key: string
}

export type NeonRouteSnapshot = Partial<Pick<
  DashboardData,
  | 'instances'
  | 'campaigns'
  | 'leads'
  | 'messages'
  | 'pipelineEvents'
  | 'conversationReplyIntents'
  | 'annotations'
  | 'steps'
  | 'syncRuns'
  | 'followUpStates'
  | 'latestConversationMessages'
  | 'followUpsAvailable'
  | 'savedSearches'
  | 'icps'
  | 'icpPersonas'
  | 'icpIndustries'
  | 'hypotheses'
  | 'hypothesisCampaigns'
  | 'campaignSequenceContext'
>>

/**
 * Canonical route key for the datasets that are not already page-local.
 * Query parameters intentionally do not participate: these snapshots contain
 * the page's complete workflow dataset and the page filters it without another
 * network read. Detail ids do participate because they change database scope.
 */
export function routeSnapshotRequest(hash: string): RouteSnapshotRequest | null {
  const [path = '/', query = ''] = hash.replace(/^#/, '').split('?', 2)
  const account = path.match(/^\/account\/(.+)$/)
  if (account) {
    const routeId = decodeURIComponent(account[1])
    return { route: 'account', routeId, key: `account:${routeId}` }
  }
  const campaign = path.match(/^\/campaign\/(.+)$/)
  if (campaign) {
    const routeId = decodeURIComponent(campaign[1])
    const compareIds = [...new Set(
      (new URLSearchParams(query).get('cmp') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id && id !== routeId),
    )].slice(0, 8).join(',')
    return {
      route: 'campaign',
      routeId,
      ...(compareIds ? { compareIds } : {}),
      key: `campaign:${routeId}:compare:${compareIds}`,
    }
  }
  const route = path.slice(1) as RouteSnapshotRoute
  if ([
    'pipeline', 'follow-ups', 'review', 'health', 'searches', 'icp', 'hypotheses',
  ].includes(route)) {
    return { route, key: route }
  }
  // Replies and Sentiment are deliberately absent, and this is the whole of the
  // change: they are page-local, like Leads and Team. Their snapshot was
  // `SELECT jsonb_build_object('repliesAvailable', true)` — an authenticated
  // read, a pooled connection and a round trip for a constant that nothing ever
  // read back. Returning `null` here leaves `DataContext` committing the
  // bootstrap exactly as it does for every other local route, so the state and
  // the page-availability contract are unchanged; what is gone is the request.
  return null
}

/**
 * The deployment lookup. Dispatched before authentication and reads no
 * database. The server still answers `readPath` (constant `neon`) beside
 * `photoPath`; this client reads only the photo half.
 */
export const READ_PATH_OPERATION = 'config.readPath'

/**
 * Which lead-photo posture the deployment serves. `disabled` means initials
 * only: it is a deliberate no-photo policy and never falls through to storage.
 */
export type PhotoPath = 'disabled' | 'neon'

/**
 * The injectable transport. Defaults to `authFetch`, which sends the signed-in
 * browser's identity cookie. Injectable so every rule below is testable without
 * a network or a session.
 */
export type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>

/** The endpoint's own cap. Asking for more is a 400. */
export const MAX_LIMIT = 1000

/**
 * A walk's page ceiling. At the maximum page size that is a million rows, well
 * past anything this dashboard holds — it is a guard against a server bug
 * turning into an unbounded client loop, not a data-volume assumption.
 *
 * Exceeding it **throws**. Returning the pages collected so far would be the
 * exact defect this module is written against: a confidently short answer that
 * no caller can distinguish from a complete one.
 */
export const MAX_PAGES = 1000

// ---------------------------------------------------------------------------
// The photo posture
// ---------------------------------------------------------------------------

let photoPathPromise: Promise<PhotoPath> | null = null

/**
 * Ask the deployment which photo posture it serves, or `null` when the lookup
 * gives no usable answer — a network failure, a non-200, or a body carrying
 * neither exact string.
 *
 * Plain `fetch`, not `authFetch`: this operation is unauthenticated by design
 * (see `readPathResponse` in `api/activity-daily.ts`), so an avatar rendering
 * before sign-in has settled does not depend on a session.
 */
async function lookupPhotoPath(
  fetchImpl: ApiFetch = globalThis.fetch.bind(globalThis),
): Promise<PhotoPath | null> {
  try {
    const res = await fetchImpl(
      `${READ_ENDPOINT}?op=${encodeURIComponent(READ_PATH_OPERATION)}`,
    )
    if (!res.ok) return null
    const body = (await res.json()) as { photoPath?: unknown } | null
    return body?.photoPath === 'neon' || body?.photoPath === 'disabled'
      ? body.photoPath
      : null
  } catch {
    return null
  }
}

/**
 * The lookup's answer alone, unmemoized. A failed lookup answers `disabled`:
 * initials are the honest outcome for "we do not know", where `neon` would fire
 * one request per avatar at a deployment that may not serve them.
 */
export async function fetchPhotoPath(fetchImpl?: ApiFetch): Promise<PhotoPath> {
  return (await lookupPhotoPath(fetchImpl)) ?? 'disabled'
}

/**
 * The photo posture, resolved once per page load and shared by every avatar.
 *
 * An **answer** is memoized — a deployment's posture does not change under a
 * running tab. A **failure is not**: it answers `disabled` for that caller and
 * the next one asks again, so a transient blip costs a retry rather than the
 * session's photos.
 */
export function resolvePhotoPath(fetchImpl?: ApiFetch): Promise<PhotoPath> {
  photoPathPromise ??= lookupPhotoPath(fetchImpl).then((path) => {
    // Concurrent callers still share this one in-flight request; what is
    // dropped is the *settled* failure, so only the next caller retries.
    if (path === null) {
      photoPathPromise = null
      return 'disabled'
    }
    return path
  })
  return photoPathPromise
}

/** Drop the memoized posture. For tests; nothing in the app calls it. */
export function resetPhotoPath(): void {
  photoPathPromise = null
}

// ---------------------------------------------------------------------------
// One page, and the walk over pages
// ---------------------------------------------------------------------------

/** The dispatching endpoint's response body, for every operation. */
export interface ReadPage<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
  readonly hasMore: boolean
  /** Present and `true` only when the relation itself is absent. */
  readonly unavailable?: boolean
}

/** What a walk returns: the whole relation, or the fact that it is not there. */
export interface ReadResult<T> {
  readonly items: T[]
  /** `true` when the server answered `unavailable` — an absent relation, not an
   *  empty one. Only the ten tolerated reads can ever produce it. */
  readonly unavailable: boolean
}

export type ReadQuery = Readonly<Record<string, string | number | null | undefined>>

function buildUrl(operation: string, query: ReadQuery = {}): string {
  const params = new URLSearchParams({ op: operation })
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue
    params.set(key, String(value))
  }
  return `${READ_ENDPOINT}?${params.toString()}`
}

/**
 * One page. A non-200 throws, on every operation without exception — the
 * endpoint has already applied its own per-operation tolerance and expressed the
 * tolerated case as a 200 carrying `unavailable: true`, so a non-200 here is a
 * genuine failure and layering a second, blanket tolerance over it would undo
 * the narrowing S13 chose.
 */
export async function readPage<T>(
  operation: string,
  query: ReadQuery = {},
  fetchImpl: ApiFetch = authFetch,
  signal?: AbortSignal,
): Promise<ReadPage<T>> {
  const res = await fetchImpl(buildUrl(operation, query), signal ? { signal } : undefined)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(
      `${operation}: ${body?.error ?? `request failed (${res.status})`}`,
    )
  }
  return (await res.json()) as ReadPage<T>
}

/**
 * Walk every page of one operation.
 *
 * The walk follows the server's cursor rather than counting, so it is correct
 * for the keyset reads and the offset reads alike — which of the two an
 * operation uses is the server's decision and the client never needs to know.
 *
 * Three properties, each of which is a test:
 *
 * - a failed page **throws**, discarding what had arrived;
 * - `unavailable` short-circuits with `[]`, never with a prefix;
 * - exceeding `MAX_PAGES` throws rather than returning the prefix collected.
 */
export async function readAll<T>(
  operation: string,
  query: ReadQuery = {},
  fetchImpl: ApiFetch = authFetch,
): Promise<ReadResult<T>> {
  const items: T[] = []
  let cursor: string | null = null
  for (let pages = 0; ; pages++) {
    if (pages >= MAX_PAGES) {
      throw new Error(
        `${operation}: exceeded ${MAX_PAGES} pages — refusing to answer with a partial relation`,
      )
    }
    const page: ReadPage<T> = await readPage<T>(
      operation,
      cursor === null ? query : { ...query, cursor },
      fetchImpl,
    )
    if (page.unavailable === true) return { items: [], unavailable: true }
    items.push(...page.items)
    if (!page.hasMore || page.nextCursor === null) break
    cursor = page.nextCursor
  }
  return { items, unavailable: false }
}

// ---------------------------------------------------------------------------
// The dashboard load
// ---------------------------------------------------------------------------

/**
 * Everything `DataContext` commits, in the browser's own types.
 *
 * `teamMembers` is here as of the roster slice — see `fetchNeonDashboard` for
 * what its rows carry.
 */
export interface NeonDashboardFetch {
  readonly teamMembers: TeamMember[]
  readonly instances: Instance[]
  readonly campaigns: CampaignMetrics[]
  readonly activity: DailyActivity[]
  readonly syncRuns: SyncRun[]
  readonly annotations: Annotation[]
  readonly steps: CampaignStep[]
  readonly savedSearches: SavedSearch[]
  readonly icps: Icp[]
  readonly icpPersonas: IcpPersona[]
  readonly icpIndustries: IcpIndustry[]
  readonly hypotheses: Hypothesis[]
  readonly hypothesisCampaigns: HypothesisCampaign[]
  readonly leads: Lead[]
  readonly messages: Message[]
  readonly pipelineEvents: PipelineEvent[]
  readonly followUpStates: FollowUpState[]
  readonly latestConversationMessages: ConversationLatestMessage[]
  readonly followUpsAvailable: boolean
  readonly conversationReplyIntents: ConversationReplyIntent[]
}

export interface NeonDashboardOptions {
  /**
   * The 90-day floor, as an inclusive UTC calendar day (`YYYY-MM-DD`). It bounds
   * the daily-activity series and the outbound message window, and nothing else.
   */
  readonly since: string
  /**
   * The delta-refresh watermark, or `null` for a full load. Only the four reads
   * that can express a watermark receive it; everything else is re-read whole.
   */
  readonly updatedSince: string | null
  readonly fetchImpl?: ApiFetch
}

/**
 * The Health page's cap. It is a page size and the first page is the answer — asking for one page of 200 and
 * not walking is the same "newest 200 runs" the page has always rendered.
 */
export const SYNC_RUN_LIMIT = 200

export interface NeonDashboardBootstrap {
  readonly instances: Instance[]
  readonly campaigns: CampaignMetrics[]
  readonly teamMembers: TeamMember[]
}

interface BootstrapWireRow {
  readonly instances: Instance[]
  readonly campaigns: CampaignMetrics[]
  readonly teamMembers: TeamMember[]
}

/**
 * One-row shell payload. Unlike the historical initial load this does not walk
 * a relation and does not touch leads/messages, so the app shell has one actor
 * resolution and one database query on its critical path.
 */
export async function fetchNeonBootstrap(
  fetchImpl: ApiFetch = authFetch,
): Promise<NeonDashboardBootstrap> {
  const page = await readPage<BootstrapWireRow>(
    READ_OPS.bootstrap,
    { limit: 1 },
    fetchImpl,
  )
  const row = page.items[0]
  if (!row) throw new Error(`${READ_OPS.bootstrap}: response contained no bootstrap row`)
  return {
    instances: row.instances,
    campaigns: row.campaigns,
    teamMembers: row.teamMembers,
  }
}

/** Exact, compact Overview aggregates for an inclusive UTC calendar range. */
export async function fetchNeonOverviewSummary(
  range: { readonly from: string | null; readonly to: string | null },
  fetchImpl: ApiFetch = authFetch,
): Promise<OverviewSummary> {
  const page = await readPage<OverviewSummary>(
    READ_OPS.overviewSummary,
    { from: range.from, to: range.to, limit: 1 },
    fetchImpl,
  )
  const row = page.items[0]
  if (!row) throw new Error(`${READ_OPS.overviewSummary}: response contained no summary row`)
  return row
}

/**
 * Account Analytics uses its own date range, independent from the Performance
 * chart. It intentionally reuses the same compact server operation because the
 * response already contains the per-account totals and range-scoped campaign
 * rows that section needs.
 */
export async function fetchNeonOverviewAccountAnalytics(
  range: { readonly from: string | null; readonly to: string | null },
  fetchImpl: ApiFetch = authFetch,
): Promise<OverviewSummary> {
  return fetchNeonOverviewSummary(range, fetchImpl)
}

/** Exact system-wide funnel totals without the wider Overview analytics payload. */
export async function fetchNeonOverviewSystemTotals(
  range: { readonly from: string | null; readonly to: string | null },
  fetchImpl: ApiFetch = authFetch,
  signal?: AbortSignal,
): Promise<OverviewSystemTotals> {
  return overviewRead(READ_OPS.overviewSystemTotals, range, fetchImpl, signal, async () => {
    const page = await readPage<{ totals: OverviewSystemTotals }>(
      READ_OPS.overviewSystemTotals,
      { from: range.from, to: range.to, limit: 1 },
      fetchImpl,
      signal,
    )
    const row = page.items[0]
    if (!row) throw new Error(`${READ_OPS.overviewSystemTotals}: response contained no totals row`)
    return row.totals
  })
}

type OverviewRange = { readonly from: string | null; readonly to: string | null }
const overviewRequests = new Map<string, Promise<unknown>>()

function overviewRangeKey(range: OverviewRange): string {
  const toExclusive = range.to
    ? new Date(`${range.to}T00:00:00Z`).getTime() + 86_400_000
    : null
  return `${range.from ? `${range.from}T00:00:00.000Z` : null}|${toExclusive == null ? null : new Date(toExclusive).toISOString()}`
}

function overviewRead<T>(
  operation: string,
  range: OverviewRange,
  fetchImpl: ApiFetch,
  signal: AbortSignal | undefined,
  read: () => Promise<T>,
): Promise<T> {
  const key = `${operation}|${overviewRangeKey(range)}`
  const current = overviewRequests.get(key)
  if (current) return current as Promise<T>
  if (signal?.aborted) return Promise.reject(new DOMException('The request was aborted.', 'AbortError'))
  const request = read()
  overviewRequests.set(key, request)
  void request.then(
    () => { if (overviewRequests.get(key) === request) overviewRequests.delete(key) },
    () => { if (overviewRequests.get(key) === request) overviewRequests.delete(key) },
  )
  // Keep the parameter in the helper's contract: operation + range is the
  // dedupe key; fetchImpl is intentionally not part of it.
  void fetchImpl
  return request
}

export async function fetchNeonOverviewPerformance(
  range: OverviewRange,
  fetchImpl: ApiFetch = authFetch,
  signal?: AbortSignal,
): Promise<OverviewPerformance> {
  return overviewRead(READ_OPS.overviewPerformance, range, fetchImpl, signal, async () => {
    const page = await readPage<OverviewPerformance>(
      READ_OPS.overviewPerformance,
      { from: range.from, to: range.to, limit: 1 },
      fetchImpl,
      signal,
    )
    const row = page.items[0]
    if (!row) throw new Error(`${READ_OPS.overviewPerformance}: response contained no performance row`)
    return row
  })
}

export async function fetchNeonOverviewAccountCampaigns(
  range: OverviewRange,
  fetchImpl: ApiFetch = authFetch,
  signal?: AbortSignal,
): Promise<OverviewAccountCampaigns> {
  return overviewRead(READ_OPS.overviewAccountCampaigns, range, fetchImpl, signal, async () => {
    const page = await readPage<OverviewAccountCampaigns>(
      READ_OPS.overviewAccountCampaigns,
      { from: range.from, to: range.to, limit: 1 },
      fetchImpl,
      signal,
    )
    const row = page.items[0]
    if (!row) throw new Error(`${READ_OPS.overviewAccountCampaigns}: response contained no campaigns row`)
    return row
  })
}

/** One campaign's preview, read only after the operator opens it — never part
 *  of the Overview bootstrap. A missing campaign is an error, not an empty
 *  preview, so the dialog offers Retry instead of claiming there is nothing. */
export async function fetchNeonCampaignPreview(
  campaignId: string,
  fetchImpl: ApiFetch = authFetch,
  signal?: AbortSignal,
): Promise<CampaignPreview> {
  const page = await readPage<Omit<CampaignPreview, 'campaign'> & { campaign: CampaignPreview['campaign'] | null }>(
    READ_OPS.campaignPreview,
    { campaign_id: campaignId, limit: 1 },
    fetchImpl,
    signal,
  )
  const row = page.items[0]
  if (!row?.campaign) throw new Error(`${READ_OPS.campaignPreview}: campaign not found`)
  return { ...row, campaign: row.campaign }
}

/** Bounded union of managed sequences, direct campaigns, deployments and reply previews. */
export async function fetchNeonSequenceHub(
  fetchImpl: ApiFetch = authFetch,
): Promise<SequenceHubSnapshot> {
  const page = await readPage<SequenceHubSnapshot>(
    READ_OPS.sequenceHub,
    { limit: 1 },
    fetchImpl,
  )
  const row = page.items[0]
  if (!row) throw new Error(`${READ_OPS.sequenceHub}: response contained no snapshot`)
  return row
}

export interface LeadsSearchQuery {
  readonly inst: string
  readonly camp: string
  readonly stage: string
  readonly risk: string
  readonly pipe: string
  readonly who: string
  readonly gender: string
  readonly agebucket: string
  readonly follow: string
  readonly repliedSince: string | null
  readonly sentiment: string | null
  readonly intent: string | null
  readonly q: string
  readonly sort: string
  readonly dir: 'asc' | 'desc'
  readonly today: string
  readonly page: number
  readonly pageSize?: number
}

/** One exact Leads/Replies explorer page; no tenant-wide relation walks. */
export async function fetchNeonLeadsSearchPage(
  query: LeadsSearchQuery,
  fetchImpl: ApiFetch = authFetch,
): Promise<LeadsSearchPage> {
  const page = await readPage<LeadsSearchPage>(
    READ_OPS.leadsSearchPage,
    {
      instance_id: query.inst === 'all' ? null : query.inst,
      camp: query.camp === 'all' ? null : query.camp,
      stage: query.stage === 'all' ? null : query.stage,
      risk: query.risk === 'all' ? null : query.risk,
      pipe: query.pipe === 'all' ? null : query.pipe,
      who: query.who === 'all' ? null : query.who,
      gender: query.gender === 'all' ? null : query.gender,
      agebucket: query.agebucket === 'all' ? null : query.agebucket,
      follow: query.follow === 'all' ? null : query.follow,
      replied_since: query.repliedSince,
      sentiment: query.sentiment,
      intent: query.intent,
      q: query.q,
      sort: query.sort,
      dir: query.dir,
      today: query.today,
      page: query.page,
      page_size: query.pageSize ?? 50,
      limit: 1,
    },
    fetchImpl,
  )
  const row = page.items[0]
  if (!row) throw new Error(`${READ_OPS.leadsSearchPage}: response contained no page`)
  return row
}

/**
 * Load the whole dashboard from the application API.
 *
 * **The roster comes from here too**, so both ends of every member-id join
 * arrive from one database. `team_members.user_id` is `NOT NULL` in the
 * portable baseline, so every member *is* a login.
 *
 * **No column ladders.** The ledger-applied baseline carries every column the
 * operations select, so a missing column is a broken deployment rather than a
 * migration in flight, and it fails loudly (`api/_lib/data/operations/leads.ts`).
 *
 * **No blanket error tolerance.** Only an absent relation is tolerated, by the
 * server, per operation. A timeout or a denial on `searches.saved` fails the
 * load — which the outer `catch` in `DataContext` degrades to "prior data plus
 * a visible banner", not a blank dashboard.
 */
export async function fetchNeonDashboard(
  options: NeonDashboardOptions,
): Promise<NeonDashboardFetch> {
  const { since, updatedSince, fetchImpl } = options
  const delta = { updated_since: updatedSince }

  const all = <T>(operation: string, query: ReadQuery = {}) =>
    readAll<T>(operation, query, fetchImpl)

  const [
    teamMembers,
    instances, campaigns, activity, syncRuns, annotations, steps,
    savedSearches, icps, icpPersonas, icpIndustries, hypotheses, hypothesisCampaigns,
    leads, inbound, outbound, pipelineEvents,
    followUpStates, latestMessages, replyIntents,
  ] = await Promise.all([
    // Walked, not capped. `/api/identity?op=team.roster` takes one page of 200
    // and reports `hasMore` (N-S18's stated limit); here the whole roster is the
    // answer, because `usePipelineActions.memberName` resolves *any*
    // `leads.assigned_to` against it and a truncated roster would leave the
    // owners past row 200 nameless — the failure this slice exists to end.
    all<RosterMember>(READ_OPS.teamRoster),
    all<Instance>(READ_OPS.instances),
    all<CampaignMetrics>(READ_OPS.campaigns),
    // `from` only: no upper bound, and the endpoint's day→instant conversion
    // leaves `toExclusive` unset.
    all<DailyActivity>(READ_OPS.dailySeries, { from: since }),
    // Not a walk. The Health page renders the newest 200 runs; one page of 200
    // is that, and following the cursor would fetch the entire run history.
    readPage<SyncRun>(READ_OPS.syncRuns, { limit: SYNC_RUN_LIMIT }, fetchImpl)
      .then((page) => ({ items: [...page.items], unavailable: false })),
    all<Annotation>(READ_OPS.annotations),
    all<CampaignStep>(READ_OPS.campaignSteps),
    all<SavedSearch>(READ_OPS.savedSearches),
    all<Icp>(READ_OPS.icps),
    all<IcpPersona>(READ_OPS.icpPersonas),
    all<IcpIndustry>(READ_OPS.icpIndustries),
    all<Hypothesis>(READ_OPS.hypotheses),
    all<HypothesisCampaign>(READ_OPS.hypothesisCampaigns),
    all<Lead>(READ_OPS.leads, delta),
    // All-time and unranged. The endpoint does not declare this read `ranged`,
    // so a `from`/`to` sent here would be ignored rather than silently
    // undercounting — but it is not sent, because the asymmetry is the point.
    all<Message>(READ_OPS.inboundMessages, delta),
    all<Message>(READ_OPS.outboundMessages, { ...delta, from: since }),
    // `occurred_since`, not `updated_since`: the log is append-only and has no
    // `updated_at` at all, so its insertion time is its watermark.
    all<PipelineEvent>(READ_OPS.pipelineEvents, { occurred_since: updatedSince }),
    all<FollowUpState>(READ_OPS.followUpState),
    all<ConversationLatestMessage>(READ_OPS.latestMessage),
    all<ConversationReplyIntent>(READ_OPS.replyIntent),
  ])

  return {
    // The same projection the identity surface applies to the same rows,
    // reused rather than restated.
    teamMembers: teamMembers.items.map(toTeamMember),
    instances: instances.items,
    campaigns: campaigns.items,
    activity: activity.items,
    syncRuns: syncRuns.items,
    annotations: annotations.items,
    steps: steps.items,
    savedSearches: savedSearches.items,
    icps: icps.items,
    icpPersonas: icpPersonas.items,
    icpIndustries: icpIndustries.items,
    hypotheses: hypotheses.items,
    hypothesisCampaigns: hypothesisCampaigns.items,
    leads: leads.items,
    // The two directions are one array to the browser, newest first — the same
    // sort `fetchMessages` applies after its two walks, on `sent_at` alone.
    messages: [...inbound.items, ...outbound.items].sort((a, b) =>
      a.sent_at < b.sent_at ? 1 : a.sent_at > b.sent_at ? -1 : 0,
    ),
    pipelineEvents: pipelineEvents.items,
    followUpStates: followUpStates.items,
    latestConversationMessages: latestMessages.items,
    // The marker's whole reason for existing. `fetchFollowUpData` distinguishes a
    // pre-migration database from an empty queue and the UI renders the two
    // differently; a bare `[]` would have erased that. Either relation being
    // absent means the feature is unavailable.
    followUpsAvailable: !followUpStates.unavailable && !latestMessages.unavailable,
    conversationReplyIntents: replyIntents.items,
  }
}

// ---------------------------------------------------------------------------
// Route and component-local reads
// ---------------------------------------------------------------------------

/** One bounded payload for the active route. The operation itself returns one
 * JSON row, so following a cursor would indicate a server contract defect. */
export async function fetchNeonRouteSnapshot(
  request: RouteSnapshotRequest,
  fetchImpl?: ApiFetch,
): Promise<NeonRouteSnapshot> {
  const page = await readPage<NeonRouteSnapshot>(
    READ_OPS.routeSnapshot,
    {
      route: request.route,
      route_id: request.routeId,
      compare_ids: request.compareIds,
      limit: 1,
    },
    fetchImpl,
  )
  if (page.hasMore) {
    throw new Error(`${READ_OPS.routeSnapshot}: expected one route payload`)
  }
  return page.items[0] ?? {}
}

/** The fields `ConversationDrawer` renders. The operation's projection is
 *  narrower than the message cache's: the caller already holds the lead, so
 *  `instance_id`, `campaign_id` and `profile_url` are not sent back. */
export type ThreadMessage = Pick<
  Message,
  | 'id' | 'direction' | 'body' | 'sent_at' | 'sentiment' | 'reason'
  | 'classified_model' | 'source' | 'intent_level' | 'intent_reason'
  | 'intent_classified_model'
>

/**
 * One conversation's whole thread, both directions, oldest first.
 *
 * Scoped by instance **and** profile, always. `CLAUDE.md`'s rule is that the same
 * person can be reached from two LinkedIn accounts, so a profile-only read merges
 * two people's threads into one panel; the endpoint requires both halves and
 * 400s without them.
 */
export async function fetchNeonThread(
  instanceId: string,
  profileUrl: string,
  fetchImpl?: ApiFetch,
): Promise<ThreadMessage[]> {
  const result = await readAll<ThreadMessage>(
    READ_OPS.thread,
    { instance_id: instanceId, profile_url: profileUrl },
    fetchImpl,
  )
  return result.items
}

/** One lead's notes, newest first. The lead id is a `uuid` and the endpoint
 *  refuses a malformed one before the database sees it. */
export async function fetchNeonLeadNotes(
  leadId: string,
  fetchImpl?: ApiFetch,
): Promise<LeadNote[]> {
  const result = await readAll<LeadNote>(
    READ_OPS.leadNotes,
    { lead_id: leadId },
    fetchImpl,
  )
  return result.items
}

/**
 * One page of a conversation's follow-up history, newest first.
 *
 * Paged rather than walked, because the panel's own "load more" is the pager —
 * this is the one component read whose paging is a user action rather than a
 * completeness requirement. The cursor is the server's: an `id`-only seek
 * against an `(occurred_at, id)` order would skip a row whenever two
 * overlapping writes commit with the two orders inverted.
 */
/**
 * One conversation's follow-up state, for a drawer opened on a route whose data
 * carries none (Leads is page-local). `state` is null when the conversation has
 * no follow-up yet; `available` is false when the relation is absent, which is
 * the same condition the route snapshots report as `followUpsAvailable: false`.
 */
export async function fetchNeonFollowUpState(
  instanceId: string,
  profileUrl: string,
  fetchImpl?: ApiFetch,
): Promise<{ state: FollowUpState | null; available: boolean }> {
  const page = await readPage<FollowUpState>(
    READ_OPS.followUpState,
    { instance_id: instanceId, profile_url: profileUrl, limit: 1 },
    fetchImpl,
  )
  return { state: page.items[0] ?? null, available: page.unavailable !== true }
}

export async function fetchNeonFollowUpHistory(
  instanceId: string,
  profileUrl: string,
  limit: number,
  cursor: string | null,
  fetchImpl?: ApiFetch,
): Promise<{ events: FollowUpEvent[]; nextCursor: string | null; hasMore: boolean }> {
  const page = await readPage<FollowUpEvent>(
    READ_OPS.followUpHistory,
    { instance_id: instanceId, profile_url: profileUrl, limit, cursor },
    fetchImpl,
  )
  return {
    events: [...page.items],
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  }
}

/** The playbook as the page renders it. `updated_at` is what the header's
 *  "last saved" line reads. */
export interface PlaybookDocument {
  readonly content: string
  readonly updated_at: string | null
}

/**
 * The singleton playbook, or `null` when it has never been written.
 *
 * The distinction is the whole return type. `public.playbook` ships with the
 * baseline and no seeded row, so zero rows means "nobody has written one yet" —
 * which the page renders as an empty editor with its placeholder. A *failure* is a throw, never an
 * empty document: the caller unlocks the editor on success, and a blank box an
 * admin can Save over the real playbook is the one outcome this read must not
 * be able to produce. The endpoint does not tolerate an absent relation here
 * for the same reason.
 */
export async function fetchNeonPlaybook(
  fetchImpl?: ApiFetch,
): Promise<PlaybookDocument | null> {
  const result = await readAll<PlaybookDocument>(READ_OPS.playbook, {}, fetchImpl)
  return result.items[0] ?? null
}

/**
 * Every account's coaching digest, keyed by `instance_id` the way the panel
 * indexes it.
 *
 * Walked rather than capped, like the roster and for the same reason: the panel
 * looks up `digests[instance.id]` for each instance the dashboard knows about,
 * so a truncated read would leave the accounts past the cap silently
 * digest-less — indistinguishable from never having computed one.
 */
export async function fetchNeonCoachingDigests(
  fetchImpl?: ApiFetch,
): Promise<CoachingDigest[]> {
  const result = await readAll<CoachingDigest>(
    READ_OPS.coachingDigests,
    {},
    fetchImpl,
  )
  return result.items
}
