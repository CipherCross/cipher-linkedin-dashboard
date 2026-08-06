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
 * `conversationPaging.ts` records: `tsconfig.api.json` type-checks `tests/` and
 * declares no `jsx`, so a test that imports a `.tsx` file fails to compile even
 * though vitest would happily run it. Everything this path *decides* — which
 * operation, which parameters, when a walk stops, what an `unavailable` marker
 * means — therefore lives here and is covered by `tests/dashboardReads.test.ts`.
 * `DataContext.tsx` and the three components keep a call site each.
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
 * 4. **The roster does not cross.** `team_members` has no operation, on purpose:
 *    `leads.assigned_to` and `conversation_follow_up_state.owner_id` are member
 *    ids in whichever provider's id space the leads came from, and the two
 *    spaces name different people (`N-B2.md`). So on this path the roster is
 *    empty rather than fetched from the other provider — a nameless owner chip
 *    instead of a confidently wrong name. See `fetchNeonDashboard`.
 */

import { authFetch } from './api'
import type {
  Annotation, CampaignMetrics, CampaignStep, ConversationLatestMessage,
  ConversationReplyIntent, DailyActivity, FollowUpEvent, FollowUpState,
  Hypothesis, HypothesisCampaign, Icp, IcpIndustry, IcpPersona, Instance,
  Lead, LeadNote, Message, PipelineEvent, SavedSearch, SyncRun,
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
  dailySeries: 'activity.dailySeries',
  instances: 'instances.overview',
  campaigns: 'campaigns.performance',
  campaignSteps: 'campaigns.sequenceSteps',
  syncRuns: 'sync.recentRuns',
  annotations: 'annotations.timeline',
  leads: 'leads.directory',
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
} as const

/** The flag lookup. Dispatched before authentication and reads no database. */
export const READ_PATH_OPERATION = 'config.readPath'

export type ReadPath = 'supabase' | 'neon'

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

let readPathPromise: Promise<ReadPath> | null = null

/**
 * Ask the deployment which read path it serves.
 *
 * **Every failure resolves to `supabase`**, and that direction is the whole
 * point: the flag lookup must not be able to break a dashboard that works. A
 * network failure, a 500, a body that is not the expected enum, an endpoint that
 * does not exist yet — all mean "keep reading Supabase". Only the exact string
 * `neon` moves the browser, mirroring `deploymentReadPath()` on the server and
 * `deploymentAuthPath()` in the browser.
 *
 * Plain `fetch`, not `authFetch`: this operation is unauthenticated by design
 * (see `readPathResponse` in `api/activity-daily.ts`), and routing it through
 * the authenticator would make a dashboard on the *Supabase* path depend on a
 * credential just to be told to stay there.
 */
export async function fetchReadPath(
  fetchImpl: ApiFetch = globalThis.fetch.bind(globalThis),
): Promise<ReadPath> {
  try {
    const res = await fetchImpl(
      `${READ_ENDPOINT}?op=${encodeURIComponent(READ_PATH_OPERATION)}`,
    )
    if (!res.ok) return 'supabase'
    const body = (await res.json()) as { readPath?: unknown } | null
    return body?.readPath === 'neon' ? 'neon' : 'supabase'
  } catch {
    return 'supabase'
  }
}

/**
 * The flag, resolved once per page load and shared by `DataContext` and the
 * three components that read on demand.
 *
 * Memoized rather than re-asked, and the resolved value is cached even when it
 * came from a failure. Re-asking would let one session flap between providers
 * mid-flight — a five-minute refresh answering from Neon while an open drawer
 * still reads Supabase — which is strictly worse than being consistently on the
 * path that works.
 */
export function resolveReadPath(fetchImpl?: ApiFetch): Promise<ReadPath> {
  readPathPromise ??= fetchReadPath(fetchImpl)
  return readPathPromise
}

/** Drop the memoized flag. For tests; nothing in the app calls it. */
export function resetReadPath(): void {
  readPathPromise = null
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
 * `teamMembers` is absent, deliberately — see `fetchNeonDashboard`.
 */
export interface NeonDashboardFetch {
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

/**
 * Load the whole dashboard from the application API.
 *
 * ## Three differences from the Supabase path, all deliberate
 *
 * **1. The roster is empty.** There is no `team_members` operation and there
 * must not be one while `leads` is read from Neon: `assigned_to` would be a Neon
 * member id and any roster served beside it from Supabase would name a different
 * person for the same integer (`N-B2.md` has the map). An owner chip with no
 * name is a visible gap; an owner chip with the wrong name is not. This is the
 * single largest known limit of this path and it is why the flag cannot be
 * flipped until the roster session lands.
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
    instances, campaigns, activity, syncRuns, annotations, steps,
    savedSearches, icps, icpPersonas, icpIndustries, hypotheses, hypothesisCampaigns,
    leads, inbound, outbound, pipelineEvents,
    followUpStates, latestMessages, replyIntents,
  ] = await Promise.all([
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
// The three component-local reads
// ---------------------------------------------------------------------------

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
