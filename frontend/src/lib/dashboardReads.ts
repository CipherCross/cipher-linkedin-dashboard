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
 * It is a plain module rather than logic inside `DataContext.tsx` for the reason
 * `conversationPaging.ts` records — originally a toolchain constraint
 * (`tsconfig.api.json` type-checked `tests/` and declared no `jsx`, so a test
 * importing a `.tsx` file could not compile), and now a straightforward one:
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
 * 1. **A partial result is never returned as if it were complete.** Same rule as
 *    `conversationPaging.ts`, applied to cursor walks: a failed page throws and
 *    discards the accumulator, and a walk that will not terminate throws rather
 *    than answering with the pages it managed to collect. This is deliberately
 *    *narrower* than `fetchAllPipelineEvents` on the Supabase path, which still
 *    returns its accumulator mid-walk (`N-S13-consolidation.md` Known limit 4).
 * 2. **The server's tolerance policy is the client's tolerance policy.** Ten
 *    reads answer an absent relation with `unavailable: true` and HTTP 200; the
 *    other twelve fail. This client adds no tolerance of its own — a non-200 is
 *    an error on every operation. See `fetchNeonDashboard` for what that changes
 *    against the Supabase path.
 * 3. **The fetch asymmetry is preserved by construction.** Inbound messages are
 *    read all-time with no `from`/`to`; outbound carries the 90-day floor. The
 *    endpoint refuses `from`/`to` on `messages.inboundHistory` by not declaring
 *    it `ranged`, so the asymmetry is enforced on both sides rather than
 *    remembered on one.
 * 4. **The roster crosses with the leads, on the same flag, or not at all.**
 *    `leads.assigned_to` and `conversation_follow_up_state.owner_id` are member
 *    ids in whichever provider's id space the rows came from, and the two spaces
 *    name different people (`N-B2.md`). S13 answered that by serving no roster
 *    here, which was right while `leads` came from Supabase and wrong the moment
 *    it did not: a Neon dashboard beside an empty roster states "0 Active
 *    teammates". So `identity.teamRoster` is one of the reads below, both ends
 *    of every member-id join arrive from one database, and the *writes* that
 *    would carry an id back to the other one are refused — see
 *    `rosterWrites.ts`, which is where that rule lives.
 */

import { authFetch } from './api'
import { toTeamMember, type RosterMember } from './identityAuth'
import type {
  Annotation, CampaignMetrics, CampaignStep, CoachingDigest,
  ConversationLatestMessage, ConversationReplyIntent, DailyActivity,
  DashboardData, FollowUpEvent, FollowUpState, Hypothesis, HypothesisCampaign, Icp,
  IcpIndustry, IcpPersona, Instance, Lead, LeadNote, Message, PipelineEvent,
  OverviewSummary, SavedSearch, SyncRun, TeamMember,
  LeadsSearchPage, SequenceHubSnapshot,
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
  overviewSummary: 'overview.summary',
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
  const [path = '/'] = hash.replace(/^#/, '').split('?', 2)
  const account = path.match(/^\/account\/(.+)$/)
  if (account) {
    const routeId = decodeURIComponent(account[1])
    return { route: 'account', routeId, key: `account:${routeId}` }
  }
  const campaign = path.match(/^\/campaign\/(.+)$/)
  if (campaign) {
    const routeId = decodeURIComponent(campaign[1])
    return {
      route: 'campaign',
      routeId,
      key: `campaign:${routeId}`,
    }
  }
  const route = path.slice(1) as RouteSnapshotRoute
  if ([
    'pipeline', 'follow-ups', 'review', 'health', 'searches', 'icp', 'hypotheses',
  ].includes(route)) {
    return { route, key: route }
  }
  return null
}

/** The flag lookup. Dispatched before authentication and reads no database. */
export const READ_PATH_OPERATION = 'config.readPath'

export type ReadPath = 'supabase' | 'neon'

/**
 * Which lead-photo posture the deployment serves. `disabled` means initials
 * only: it is a deliberate no-photo policy and never falls through to storage.
 */
export type PhotoPath = 'disabled' | 'supabase' | 'neon'

export interface DeploymentPaths {
  readonly readPath: ReadPath
  readonly photoPath: PhotoPath
}

/**
 * The injectable transport. Defaults to `authFetch`, which attaches the
 * signed-in browser's credential — a Supabase bearer today, the identity cookie
 * once `VITE_AUTH_PATH` flips. Injectable so every rule below is testable
 * without a network or a session.
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
// The path flag
// ---------------------------------------------------------------------------

let pathsPromise: Promise<DeploymentPaths> | null = null

/** What `fallbackPaths` reads. Narrower than `ImportMetaEnv`, exactly as
 *  `authPath.ts` does it, so a test can pass a plain object. */
export type BrowserEnv = Readonly<Record<string, unknown>>

/**
 * Whether this build holds a legacy Supabase client at all.
 *
 * `src/lib/supabase.ts` constructs one only when both variables are present and
 * exports `null` otherwise, so this is the same condition read without importing
 * the client — the browser's equivalent of the server's `dataStoreConfigured`.
 */
function legacyClientConfigured(env: BrowserEnv): boolean {
  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_ANON_KEY
  return typeof url === 'string' && url !== '' && typeof key === 'string' && key !== ''
}

/**
 * What the browser assumes when the lookup gives it no usable answer.
 *
 * **Derived from the credential this build holds**, which is the same rule the
 * server's flags follow (`api/_lib/data/providerPath.ts`) and, for the same
 * reason, not a hardcoded side:
 *
 *   * **A build with no Supabase client falls back to `neon`.** The old fallback
 *     was `supabase` unconditionally, and on a tenant that is a `null` client —
 *     so one transient blip turned into *"Supabase is not configured — set
 *     VITE_SUPABASE_URL…"* until the tab was reloaded, a sentence about a
 *     provider the deployment does not have.
 *   * **A build that does hold one falls back to `supabase`.** Falling back to
 *     `neon` there would be a *new* way to break a working dashboard: those reads
 *     go straight to PostgREST and do not depend on this same-origin lookup at
 *     all, so a blip in the lookup would move a page that was about to work onto
 *     a path the deployment may have no credential for.
 *   * **The photo half follows the read half**, because it must: the two
 *     providers' lead ids name different rows. `disabled` is the honest answer to
 *     "we do not know yet" — `neon` would fire one 503 per avatar at a deployment
 *     that may not serve them.
 *
 * A fallback, not a guess we live with: a failed lookup is never memoised, so the
 * next caller asks again — see `resolveDeploymentPaths`.
 */
function fallbackPaths(
  env: BrowserEnv = import.meta.env as unknown as BrowserEnv,
): DeploymentPaths {
  return legacyClientConfigured(env)
    ? { readPath: 'supabase', photoPath: 'supabase' }
    : { readPath: 'neon', photoPath: 'disabled' }
}

/** A lookup's answer, and whether it *is* one. */
interface PathsLookup {
  readonly paths: DeploymentPaths
  /** `true` when `paths` came from `fallbackPaths` because the lookup failed. */
  readonly failed: boolean
}

/**
 * Ask the deployment which paths it serves — reads and photos, in one request.
 *
 * **Every lookup failure takes `fallbackPaths`**, which since S27 derives its
 * side from the credential this build holds rather than always answering
 * `supabase`. A malformed answer counts as a failure: the two exact strings are
 * the only readable answers, and a body carrying neither tells us nothing about
 * the deployment.
 *
 * A *readable* answer is believed in full, including two rules that survive
 * unchanged. An explicit `disabled` photo posture means initials-only and must
 * never fall through to a storage call. And the `neon` photo path can only be
 * `neon` when the read path is — the browser asks for photos by `lead.id`, and the
 * two providers' lead ids name different rows, so a dashboard reading Supabase
 * leads while asking Neon for their photos would render one person's face against
 * another's name.
 *
 * A readable read path with an unreadable *photo* field is still an answer, not a
 * failure: it is what a server built before S20 sends, and `supabase` photos were
 * right for it.
 */
async function lookupDeploymentPaths(
  fetchImpl: ApiFetch = globalThis.fetch.bind(globalThis),
  env?: BrowserEnv,
): Promise<PathsLookup> {
  const failure = (): PathsLookup => ({ paths: fallbackPaths(env), failed: true })
  try {
    const res = await fetchImpl(
      `${READ_ENDPOINT}?op=${encodeURIComponent(READ_PATH_OPERATION)}`,
    )
    if (!res.ok) return failure()
    const body = (await res.json()) as {
      readPath?: unknown
      photoPath?: unknown
    } | null
    if (body?.readPath !== 'neon' && body?.readPath !== 'supabase') {
      return failure()
    }
    const readPath: ReadPath = body.readPath
    return {
      failed: false,
      paths: {
        readPath,
        photoPath:
          body.photoPath === 'disabled'
            ? 'disabled'
            : readPath === 'neon' && body.photoPath === 'neon'
              ? 'neon'
              : 'supabase',
      },
    }
  } catch {
    return failure()
  }
}

/** The lookup's answer alone. The memoizing callers need to know whether it
 *  failed; everything else — and every test of the parsing rules — does not. */
export async function fetchDeploymentPaths(
  fetchImpl?: ApiFetch,
  env?: BrowserEnv,
): Promise<DeploymentPaths> {
  return (await lookupDeploymentPaths(fetchImpl, env)).paths
}

/**
 * Ask the deployment which read path it serves.
 *
 * **S27 stopped hardcoding the failure direction.** A network failure, a 500, a
 * body that is not the expected enum, an endpoint that does not exist yet — all
 * used to mean "keep reading Supabase", which was right while every build had a
 * Supabase client and wrong for a tenant, where there is no Supabase to keep
 * reading. They now take `fallbackPaths`, which asks what this build actually
 * holds, and none of them is remembered — so a failure costs one retry rather
 * than the session.
 *
 * Plain `fetch`, not `authFetch`: this operation is unauthenticated by design
 * (see `readPathResponse` in `api/activity-daily.ts`), and routing it through
 * the authenticator would make a dashboard on the *Supabase* path depend on a
 * credential just to be told to stay there.
 */
export async function fetchReadPath(
  fetchImpl: ApiFetch = globalThis.fetch.bind(globalThis),
  env?: BrowserEnv,
): Promise<ReadPath> {
  return (await fetchDeploymentPaths(fetchImpl, env)).readPath
}

/**
 * The flag, resolved once per page load and shared by `DataContext` and the
 * three components that read on demand.
 *
 * An **answer** is memoized: re-asking would let one session flap between
 * providers mid-flight — a five-minute refresh answering from Neon while an open
 * drawer still reads Supabase — and a deployment's answer does not change under a
 * running tab anyway.
 *
 * A **failure is not**, which is S27's correction. Caching one pinned the whole
 * page to a fallback until it was reloaded; dropping it means the Retry button,
 * the five-minute refresh and the next component each ask again, and the session
 * heals itself. This does not reopen the flapping the memo exists to prevent:
 * that needs two *successful* answers that disagree.
 */
export function resolveReadPath(
  fetchImpl?: ApiFetch,
  env?: BrowserEnv,
): Promise<ReadPath> {
  return resolveDeploymentPaths(fetchImpl, env).then((paths) => paths.readPath)
}

/**
 * The photo path, from the same memoized lookup.
 *
 * One request answers both, so an avatar rendering before `DataContext`'s first
 * load does not add a second startup round trip — and the two answers cannot
 * disagree, which they could if each were fetched separately and a deployment
 * changed between the two.
 */
export function resolvePhotoPath(
  fetchImpl?: ApiFetch,
  env?: BrowserEnv,
): Promise<PhotoPath> {
  return resolveDeploymentPaths(fetchImpl, env).then((paths) => paths.photoPath)
}

function resolveDeploymentPaths(
  fetchImpl?: ApiFetch,
  env?: BrowserEnv,
): Promise<DeploymentPaths> {
  pathsPromise ??= lookupDeploymentPaths(fetchImpl, env).then((lookup) => {
    // Concurrent callers still share this one in-flight request; what is dropped
    // is the *settled* fallback, so only the next caller pays for the retry.
    if (lookup.failed) pathsPromise = null
    return lookup.paths
  })
  return pathsPromise
}

/** Drop the memoized flags. For tests; nothing in the app calls it. */
export function resetReadPath(): void {
  pathsPromise = null
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
): Promise<ReadPage<T>> {
  const res = await fetchImpl(buildUrl(operation, query))
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
 * `teamMembers` is here as of the roster slice, and it is the same
 * `TeamMember[]` the Supabase path commits — see `fetchNeonDashboard` for what
 * differs *inside* those rows and why the difference is rendered rather than
 * smoothed.
 */
export interface NeonDashboardFetch {
  /**
   * Whose id space `teamMembers` — and every `assigned_to` and `owner_id` beside
   * it — belongs to. Constant `'neon'`, and it is here rather than written by
   * the caller for a measured reason: a mutation that set it to `'supabase'` in
   * `DataContext.tsx` reddened **no test**, because a `.tsx` file cannot be
   * imported by this repo's node-environment suite. It decides whether
   * `rosterWrites.ts` lets a member id be written back, so an untestable literal
   * was the wrong place for it.
   */
  readonly rosterPath: 'neon'
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
   * The 90-day floor, as an inclusive UTC calendar day (`YYYY-MM-DD`) — exactly
   * the string `DataContext` already computes and passes to PostgREST. It bounds
   * the daily-activity series and the outbound message window, and nothing else.
   */
  readonly since: string
  /**
   * The delta-refresh watermark, or `null` for a full load. Only the four reads
   * that can express a watermark receive it; everything else is re-read whole,
   * which is what the Supabase path does too.
   */
  readonly updatedSince: string | null
  readonly fetchImpl?: ApiFetch
}

/**
 * The Health page's cap. The Supabase path spells it `.limit(200)`; here it is a
 * page size and the first page is the answer — asking for one page of 200 and
 * not walking is the same "newest 200 runs" the page has always rendered.
 */
export const SYNC_RUN_LIMIT = 200

export interface NeonDashboardBootstrap {
  readonly rosterPath: 'neon'
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
    rosterPath: 'neon',
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
 * ## Three differences from the Supabase path, all deliberate
 *
 * **1. The roster comes from here too, and its rows mean something slightly
 * different.** Both ends of every member-id join now arrive from one database,
 * which is what makes the join correct and what makes serving the roster from
 * the *other* provider forbidden rather than merely untidy. Two consequences
 * this module does not paper over:
 *
 *   * **`auth_user_id` is `null` on every row**, and that is a statement, not a
 *     placeholder — `toTeamMember` in `identityAuth.ts` records the argument.
 *     There is no Supabase Auth user behind a `team_roster()` row. The field
 *     means "there is a Supabase login", the answer is no, and filling it with
 *     the canonical uuid would make an id from one space answer a question about
 *     another. What replaces it as the page's source of truth is the schema:
 *     `team_members.user_id` is `NOT NULL` in the portable baseline, so on this
 *     path every member *is* a login and "assignment only" is a state that
 *     cannot exist. `Team.tsx` renders that from the roster's provenance rather
 *     than from a fabricated column.
 *   * **The ids are this provider's.** They are safe to *display* beside leads
 *     read here and unsafe to *send* to a writer that is not here. The refusal
 *     lives in `rosterWrites.ts`.
 *
 * **2. No column ladders.** The two retry ladders (`LEAD_COLUMN_LADDER`,
 * `MESSAGE_COLUMN_LADDER`) exist because the Supabase schema drifted under a
 * deployed frontend. The ledger-applied baseline carries every column of the
 * widest rung, so a missing column there is a broken deployment rather than a
 * migration in flight, and it fails loudly. That argument is the operations'
 * (`api/_lib/data/operations/leads.ts`), not this file's; the consequence here
 * is simply that there is nothing to step down to.
 *
 * **3. No blanket error tolerance.** The Supabase path excludes seven reads'
 * errors from the aggregate `error` and takes `data ?? []`, so *any* failure on
 * the library relations or the pipeline log silently empties them. Here only an
 * absent relation is tolerated, by the server, per operation. A timeout or a
 * denial on `searches.saved` now fails the load — which the outer `catch` in
 * `DataContext` degrades to "prior data plus a visible banner", not a blank
 * dashboard.
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
    // `from` only: the Supabase path filters `day >= since` with no upper bound,
    // and the endpoint's day→instant conversion leaves `toExclusive` unset.
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
    rosterPath: 'neon',
    // The same projection the identity path applies to the same rows, reused
    // rather than restated: one mapping, one place where `auth_user_id` is
    // decided, and no chance of the two paths disagreeing about what a roster
    // row means.
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
    // absent means the feature is unavailable, which is how the Supabase path's
    // shared `try` already behaves.
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
 * completeness requirement. The cursor is the server's, which is what closes the
 * defect `N-S13-part3.md` design call 7 found in the Supabase path: an `id`-only
 * seek against an `(occurred_at, id)` order skips a row whenever two overlapping
 * writes commit with the two orders inverted.
 */
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
 *  "last saved" line reads; the Supabase path takes the same two columns. */
export interface PlaybookDocument {
  readonly content: string
  readonly updated_at: string | null
}

/**
 * The singleton playbook, or `null` when it has never been written.
 *
 * The distinction is the whole return type. `public.playbook` ships with the
 * baseline and no seeded row, so zero rows means "nobody has written one yet" —
 * which the page renders as an empty editor with its placeholder, exactly as
 * PostgREST's `maybeSingle()` produces today. A *failure* is a throw, never an
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
