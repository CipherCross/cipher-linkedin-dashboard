/**
 * The `app_system` vocabulary — what the machine halves of the AI layer may ask
 * the database for now that ledger step 007 is applied.
 *
 * ## What step 007 changed, and what it deliberately did not
 *
 * Until 007, `app_system` held no table grant at all: `USAGE` on `public` and
 * `EXECUTE` on the SELECT-only guard `public.ai_execute_sql` were its entire
 * privilege set, so `operations/ai.ts` could truthfully say the guard was the
 * whole capability. Step 007 added `SELECT, INSERT, UPDATE` — never `DELETE` —
 * on exactly five relations (`briefing_jobs`, `briefings`, `messages`, `leads`,
 * `saved_searches`), `USAGE, SELECT` on the two sequences among them, and one
 * `FOR ALL TO app_system` policy per relation gated on the published system
 * actor. Nothing else opened: `campaigns`, `instances`, `hypotheses`,
 * `hypothesis_campaigns` and `annotations` remain unreachable to a direct
 * `app_system` statement, and `public.pipeline_auto_advance()` remains
 * unexecutable by it.
 *
 * So this module has exactly two kinds of entry, and which kind an operation is
 * follows from the grant graph rather than from taste:
 *
 * - **Direct statements**, against the five granted relations. These are
 *   ordinary registry entries — SQL owned here, parameters bound — and the
 *   database authorizes each of them through the step-007 policy, which fails
 *   closed when `app.actor_id` is absent or is anything other than the nil
 *   uuid. They are the only writes `app_system` can perform anywhere.
 * - **Guard-backed named reads**, for the relations outside that grant. The
 *   guard's owner `app_ai_runner` reads every business table, so a read of
 *   `campaigns` is reachable — through `public.ai_execute_sql` and nowhere
 *   else. Those entries are built with the same `guardStatement`/`mapGuardRow`
 *   mechanism the AI registry uses and are imported from `ai.ts` rather than
 *   re-derived, so there is one definition of what a guard call looks like.
 *
 * The two shapes answer differently and the caller must not conflate them: a
 * guard call returns **one** row whose single `jsonb` column is an array of the
 * result rows (hence `firstGuardResult`), while a direct query returns N row
 * items in the ordinary way.
 *
 * ## Why a guard read rather than widening the grant
 *
 * The obvious alternative — add `SELECT ON campaigns, instances` to a step 008 —
 * was not taken. The guard already reads them under a 1000-row cap, a 10 s
 * timeout and a SELECT-only rule that a policy grant does not carry, and the
 * enrichment these reads feed is display text: a name beside a Slack snippet.
 * Buying that with a permanent widening of the machine principal's reach is the
 * wrong trade. The one thing a guard read cannot do is take a parameter — the
 * guard's signature is `ai_execute_sql(text)` and the query text would have to
 * carry the filter values — so these queries are deliberately unfiltered reads
 * of small relations, filtered in the caller. Interpolating a campaign id into
 * guard SQL to save a few rows would put caller-shaped text into a statement,
 * which is the one thing the registry exists to prevent.
 *
 * ## What is NOT here
 *
 * No mutation and no side-effecting function call goes through the guard. In
 * particular `public.pipeline_auto_advance()` — which the human-actor
 * classifier calls as `app_runtime` — has no entry here at all: `app_system`
 * holds no `EXECUTE` on it, and routing it through the guard to work around
 * that would turn a SELECT-only surface into a write path. The remedy is a
 * ledger step granting the EXECUTE (`008_ai_system_auto_advance_execute.sql`,
 * written and not yet applied), not a cleverer query.
 *
 * ## How an entry here gets its name
 *
 * Three kinds of entry now, and the naming follows the CALL SITE rather than
 * the principal — because a name's job is to identify a statement to the code
 * that issues it, while the thing the database authorizes is the registry an
 * operation was registered in, and a registry belongs to exactly one store.
 *
 * - **Minted `system.` names**, for statements no other call site issues. The
 *   notifier's claim cycle is only ever run by the machine path, and the MCP
 *   `save_search` surface is its own call site even though its two statements
 *   are the ones `libraryWrites.ts` reviewed for the human path.
 * - **Re-registrations under the caller's existing name**, for the cron halves
 *   of `classify.ts` and `briefing.ts`. There the machine path and the human
 *   path are ONE body — the same function, the same operation names, differing
 *   only in which store answers — so a second name would mean that body could
 *   no longer name one operation and would need a lookup table whose only
 *   purpose was to undo the rename. The statement is the same reviewed object,
 *   imported rather than retyped; what differs is that registering it here is a
 *   separate, deliberate allowlist entry for a separate principal.
 * - **`system.` names where the STATEMENT differs**, which is the briefing's
 *   five-relation team-context preload. Four of those relations are outside the
 *   007 grant, so the machine path reads them through the guard while the human
 *   path reads them directly. Same rows, different statements — giving both the
 *   one name would be a lie, so the shared call site names the two routes side
 *   by side and picks one.
 */

import type {
  NeonCommandOperation,
  NeonOperationRegistry,
  NeonQueryOperation,
  NeonRow,
  NeonStatement,
} from '../neon.js'
import type { Page } from '../contracts.js'

import { guardStatement, mapGuardRow } from './ai.js'
import {
  AI_WRITE_OPERATIONS,
  classifyGenderBacklogOperation,
  classifyGenderBatchOperation,
  classifyPendingRepliesOperation,
  classifyRemainingCountOperation,
  classifyThreadContextOperation,
  classifyWriteGenderOperation,
  classifyWriteLabelsOperation,
} from './aiWrites.js'
import {
  BRIEFING_CONTEXT_GUARD_SQL,
  briefingAssignedSearchesOperation,
  briefingClaimJobOperation,
  briefingEnsureJobOperation,
  briefingFailStageOperation,
  briefingFinishStageOperation,
  briefingJobRowOperation,
  briefingPriorOperation,
  briefingResetJobOperation,
  briefingStaleErrorOperation,
  briefingUpsertBriefingOperation,
  briefingWeeklyReferenceOperation,
} from './briefingWrites.js'
import {
  insertSavedSearchOperation,
  updateSavedSearchOperation,
} from './libraryWrites.js'

export const SYSTEM_OPERATIONS = {
  // notify-replies.ts — the claim/announce/un-claim cycle.
  notifyCandidates: 'system.notifyCandidates',
  notifyClaim: 'system.notifyClaim',
  notifyUnclaim: 'system.notifyUnclaim',
  notifyRemaining: 'system.notifyRemaining',
  notifyLeadContext: 'system.notifyLeadContext',
  // Guard-backed context reads, for relations outside the 007 grant. The first
  // two serve the notifier's Slack snippets; `instanceNames` is also the
  // briefing cron's account read — one relation, one statement, one entry.
  campaignNames: 'system.campaignNames',
  instanceNames: 'system.instanceNames',
  // briefing.ts cron — the four remaining out-of-grant context relations. The
  // SQL is `briefingWrites.ts`'s, beside the direct statements it must agree
  // with; only the registration lives here.
  briefingCampaignsContext: 'system.briefingCampaignsContext',
  briefingHypothesesList: 'system.briefingHypothesesList',
  briefingAssignments: 'system.briefingAssignments',
  briefingRecentAnnotations: 'system.briefingRecentAnnotations',
  // mcp.ts save_search — the machine-authenticated library write.
  insertSavedSearch: 'system.insertSavedSearch',
  updateSavedSearch: 'system.updateSavedSearch',
} as const

/** Every system read under a minted `system.` name, for assertions. */
export const SYSTEM_QUERY_OPERATIONS = [
  SYSTEM_OPERATIONS.notifyCandidates,
  SYSTEM_OPERATIONS.notifyRemaining,
  SYSTEM_OPERATIONS.notifyLeadContext,
  SYSTEM_OPERATIONS.campaignNames,
  SYSTEM_OPERATIONS.instanceNames,
  SYSTEM_OPERATIONS.briefingCampaignsContext,
  SYSTEM_OPERATIONS.briefingHypothesesList,
  SYSTEM_OPERATIONS.briefingAssignments,
  SYSTEM_OPERATIONS.briefingRecentAnnotations,
] as const

/** Every system write under a minted name. All relations behind them are 007's. */
export const SYSTEM_COMMAND_OPERATIONS = [
  SYSTEM_OPERATIONS.notifyClaim,
  SYSTEM_OPERATIONS.notifyUnclaim,
  SYSTEM_OPERATIONS.insertSavedSearch,
  SYSTEM_OPERATIONS.updateSavedSearch,
] as const

/**
 * The reads that are guard calls rather than direct table reads, named so a
 * test can assert the distinction instead of trusting the comment above.
 */
export const SYSTEM_GUARD_OPERATIONS = [
  SYSTEM_OPERATIONS.campaignNames,
  SYSTEM_OPERATIONS.instanceNames,
  SYSTEM_OPERATIONS.briefingCampaignsContext,
  SYSTEM_OPERATIONS.briefingHypothesesList,
  SYSTEM_OPERATIONS.briefingAssignments,
  SYSTEM_OPERATIONS.briefingRecentAnnotations,
] as const

/**
 * The cron halves' reads, registered under the names their shared body already
 * uses. Every relation behind them — `messages`, `leads`, `briefing_jobs`,
 * `briefings`, `saved_searches` — is inside step 007's grant, so all of these
 * are direct statements and none is a guard call.
 *
 * `classify.autoAdvance` is deliberately absent and must stay absent: it calls
 * `public.pipeline_auto_advance()`, on which `app_system` holds no `EXECUTE`.
 * Ledger step 008 is written and unapplied, and until it is applied the cron
 * reports the gap rather than routing around it.
 */
export const SYSTEM_CRON_QUERY_OPERATIONS = [
  AI_WRITE_OPERATIONS.classifyPendingReplies,
  AI_WRITE_OPERATIONS.classifyThreadContext,
  AI_WRITE_OPERATIONS.classifyRemainingCount,
  AI_WRITE_OPERATIONS.classifyGenderBatch,
  AI_WRITE_OPERATIONS.classifyGenderBacklog,
  AI_WRITE_OPERATIONS.briefingJobRow,
  AI_WRITE_OPERATIONS.briefingPrior,
  AI_WRITE_OPERATIONS.briefingWeeklyReference,
  AI_WRITE_OPERATIONS.briefingAssignedSearches,
] as const

/** The cron halves' writes, under the same names, all inside the 007 grant. */
export const SYSTEM_CRON_COMMAND_OPERATIONS = [
  AI_WRITE_OPERATIONS.classifyWriteLabels,
  AI_WRITE_OPERATIONS.classifyWriteGender,
  AI_WRITE_OPERATIONS.briefingEnsureJob,
  AI_WRITE_OPERATIONS.briefingClaimJob,
  AI_WRITE_OPERATIONS.briefingFinishStage,
  AI_WRITE_OPERATIONS.briefingFailStage,
  AI_WRITE_OPERATIONS.briefingResetJob,
  AI_WRITE_OPERATIONS.briefingStaleError,
  AI_WRITE_OPERATIONS.briefingUpsertBriefing,
] as const

const text = (row: NeonRow, column: string): string => String(row[column])
const nullableText = (row: NeonRow, column: string): string | null =>
  row[column] === null || row[column] === undefined ? null : String(row[column])

/**
 * The rows of a guard-backed read.
 *
 * A guard call is one row carrying an array, so a page of it has exactly one
 * item and that item is the result set. Written once, here, because getting it
 * wrong reads as "the query returned nothing" rather than as a type error.
 */
export function firstGuardResult(page: Page<unknown[]>): readonly unknown[] {
  return page.items[0] ?? []
}

// ---------------------------------------------------------------------------
// notify-replies.ts — direct, because `messages` and `leads` are both in the
// step-007 grant.
// ---------------------------------------------------------------------------

/**
 * What counts as an unannounced reply, in one place.
 *
 * Inbound, synced (a manually imported thread is history the SDR already has),
 * never announced, and carrying a body — the notifier renders snippets, so a
 * body-less row has nothing to say. The candidate read and the remaining count
 * share this text so the number the response reports cannot drift from the set
 * the next invocation will claim.
 */
const NOTIFY_CANDIDATE_FILTER = `direction = 'in'
              AND source = 'sync'
              AND notified_at IS NULL
              AND body IS NOT NULL`

export interface NotifyCandidateRow {
  readonly id: number
}

/**
 * Oldest first, so a backlog drains in order. The tiebreak on `id` is not
 * cosmetic: synced batches stamp many rows with one `sent_at`, and the driver
 * pages this read, so an order that is not total could return the same row
 * twice across pages. The batch ceiling is the caller's page limit.
 */
export const notifyCandidatesOperation: NeonQueryOperation<NotifyCandidateRow> = {
  build: (): NeonStatement => ({
    text: `SELECT id::text AS id
             FROM public.messages
            WHERE ${NOTIFY_CANDIDATE_FILTER}
            ORDER BY sent_at, id`,
    values: [],
  }),
  mapRow: (row): NotifyCandidateRow => ({ id: Number(row.id) }),
}

export interface ClaimedMessageRow {
  readonly id: number
  readonly instance_id: string
  readonly campaign_id: string | null
  readonly profile_url: string
  readonly body: string | null
  readonly sent_at: string
}

export interface NotifyClaimParams {
  readonly notifiedAt: string
  readonly ids: readonly number[]
  readonly [key: string]: string | readonly number[]
}

/**
 * The claim, and the reason this endpoint is safe to run concurrently at all.
 *
 * Several notebooks sync on ~30-minute crons that drift into alignment, so
 * overlapping invocations are the COMMON case rather than the exotic one. This
 * is ONE statement: PostgreSQL re-checks `notified_at IS NULL` under the row
 * lock, so of two runs that read the same candidate ids exactly one gets the
 * row back and the loser sees zero rows and announces nothing. Splitting it —
 * a read to confirm, then an update — would reintroduce the double-post this
 * shape exists to prevent, and no amount of application-side care recovers it.
 */
export const notifyClaimOperation: NeonCommandOperation<
  readonly ClaimedMessageRow[],
  NotifyClaimParams
> = {
  build: ({ params }): NeonStatement => {
    if (!params) throw new Error('system.notifyClaim requires parameters')
    return {
      text: `UPDATE public.messages
                SET notified_at = $1::timestamptz
              WHERE id = ANY($2::bigint[])
                AND notified_at IS NULL
          RETURNING id::text AS id, instance_id, campaign_id, profile_url,
                    body, sent_at`,
      values: [params.notifiedAt, params.ids],
    }
  },
  mapResult: (rows): readonly ClaimedMessageRow[] =>
    rows.map((row) => ({
      id: Number(row.id),
      instance_id: text(row, 'instance_id'),
      campaign_id: nullableText(row, 'campaign_id'),
      profile_url: text(row, 'profile_url'),
      body: nullableText(row, 'body'),
      sent_at: text(row, 'sent_at'),
    })),
}

export interface NotifyIdsParams {
  readonly ids: readonly number[]
  readonly [key: string]: readonly number[]
}

/**
 * Give the claim back when Slack refused it, so the next ping retries.
 *
 * Unguarded by `notified_at IS NOT NULL` on purpose: the ids passed here are
 * the ones this invocation just claimed, which no other run can hold, so a
 * predicate would only be able to disagree with itself.
 */
export const notifyUnclaimOperation: NeonCommandOperation<
  { readonly rowCount: number },
  NotifyIdsParams
> = {
  build: ({ params }): NeonStatement => ({
    text: `UPDATE public.messages
              SET notified_at = NULL
            WHERE id = ANY($1::bigint[])`,
    values: [params?.ids ?? []],
  }),
  mapResult: (_rows, rowCount) => ({ rowCount }),
}

export const notifyRemainingOperation: NeonQueryOperation<{
  readonly remaining: number
}> = {
  build: (): NeonStatement => ({
    text: `SELECT count(*)::int AS remaining
             FROM public.messages
            WHERE ${NOTIFY_CANDIDATE_FILTER}`,
    values: [],
  }),
  mapRow: (row) => ({ remaining: Number(row.remaining) }),
}

export interface NotifyLeadRow {
  readonly instance_id: string
  readonly campaign_id: string
  readonly profile_url: string
  readonly full_name: string | null
  readonly headline: string | null
  readonly company: string | null
}

export interface NotifyLeadContextParams {
  readonly instances: readonly string[]
  readonly profiles: readonly string[]
  readonly [key: string]: readonly string[]
}

/**
 * Display names for the claimed batch. The two array parameters are the same
 * cross-product filter the Supabase path's chained `.in()` pair applies, not a
 * pairwise match, so a row may come back for a person reached from another
 * account in the batch — the caller keys the lookup properly. The total order
 * is for the caller's paged walk, exactly as in the candidate read.
 */
export const notifyLeadContextOperation: NeonQueryOperation<
  NotifyLeadRow,
  NotifyLeadContextParams
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT instance_id, campaign_id, profile_url, full_name, headline, company
             FROM public.leads
            WHERE instance_id = ANY($1::text[])
              AND profile_url = ANY($2::text[])
            ORDER BY instance_id, profile_url, campaign_id`,
    values: [params?.instances ?? [], params?.profiles ?? []],
  }),
  mapRow: (row): NotifyLeadRow => ({
    instance_id: text(row, 'instance_id'),
    campaign_id: text(row, 'campaign_id'),
    profile_url: text(row, 'profile_url'),
    full_name: nullableText(row, 'full_name'),
    headline: nullableText(row, 'headline'),
    company: nullableText(row, 'company'),
  }),
}

// ---------------------------------------------------------------------------
// The guard-backed context reads. Both relations are outside the 007 grant, so
// a direct statement would be refused with 42501 and these are the only way to
// them. Both are whole-relation reads of small relations, for the reason the
// module header records: the guard takes no parameter but the query text.
// ---------------------------------------------------------------------------

/** Campaign display names. One row per campaign — dozens, far under the
 *  guard's 1000-row cap, and the caller filters to the batch's ids. */
export const CAMPAIGN_NAMES_SQL = `
select id, name
from campaigns
order by id
`.trim()

/** Account display names, the same three columns the anomaly feed reads. The
 *  fleet is single digits of notebooks. Read by the notifier for its Slack
 *  snippets and by the briefing cron for its team-context block: one relation,
 *  one statement, and the briefing's mapper reads by column name, so the
 *  column ORDER here is not part of the contract. */
export const INSTANCE_NAMES_SQL = `
select id, account_name, label
from instances
order by id
`.trim()

/**
 * Every guard-backed system query and the SQL it runs. Keyed by the operation
 * names themselves, so a guard operation declared without its SQL — or SQL
 * without an operation — does not compile.
 *
 * The four briefing entries import their text from `briefingWrites.ts`, where
 * it sits beside the direct statement it must stay equivalent to; the two
 * notifier entries are declared above because nothing else reads those columns.
 * Each entry's row-count headroom against the guard's 1000-row cap is recorded
 * next to the text — see `BRIEFING_CONTEXT_GUARD_SQL` for the briefing four.
 */
export const SYSTEM_GUARD_SQL: Record<
  (typeof SYSTEM_GUARD_OPERATIONS)[number],
  string
> = {
  [SYSTEM_OPERATIONS.campaignNames]: CAMPAIGN_NAMES_SQL,
  [SYSTEM_OPERATIONS.instanceNames]: INSTANCE_NAMES_SQL,
  [SYSTEM_OPERATIONS.briefingCampaignsContext]:
    BRIEFING_CONTEXT_GUARD_SQL.campaignsContext,
  [SYSTEM_OPERATIONS.briefingHypothesesList]:
    BRIEFING_CONTEXT_GUARD_SQL.hypothesesList,
  [SYSTEM_OPERATIONS.briefingAssignments]: BRIEFING_CONTEXT_GUARD_SQL.assignments,
  [SYSTEM_OPERATIONS.briefingRecentAnnotations]:
    BRIEFING_CONTEXT_GUARD_SQL.recentAnnotations,
}

// ---------------------------------------------------------------------------
// mcp.ts save_search.
// ---------------------------------------------------------------------------

/**
 * The two `saved_searches` statements are **not** rewritten here. They are the
 * ones S14 reviewed and registered for the human path in `libraryWrites.ts`,
 * registered a second time under a system name because a registry belongs to a
 * store and the two stores connect as different principals. One statement, two
 * allowlist entries, so the row an MCP client writes as `app_system` and the
 * row a signed-in member writes as `app_runtime` are the same row by
 * construction rather than by inspection.
 */
export { insertSavedSearchOperation, updateSavedSearchOperation }

// ---------------------------------------------------------------------------
// The cron halves of classify.ts and briefing.ts.
//
// Nothing is rewritten here either. These are the operation objects the human
// path already runs, imported and registered a second time so the AI store's
// allowlist admits them for `app_system` — a separate, deliberate entry per
// statement, made against a separate registry, for a separate principal. What
// they are NOT is a shared registry: `buildApplicationRegistry` still holds its
// own entries, and revoking one here revokes it for the machine path alone.
//
// Registering `classify.autoAdvance` here would compile and would then be
// refused at run time by the grant graph — `app_system` holds no EXECUTE on
// `public.pipeline_auto_advance()`. It is left out rather than left to fail, so
// the omission is legible at review time instead of at 06:00 UTC.
// ---------------------------------------------------------------------------

/**
 * Register the classify + briefing cron vocabulary. Split out from
 * `registerSystemOperations` only so the two halves of the AI store's write
 * surface — the endpoints that are only ever machine-run, and the endpoints
 * whose machine half shares a body with a human half — can be read apart.
 */
function registerCronOperations(
  registry: NeonOperationRegistry,
): NeonOperationRegistry {
  // classify.ts GET — `messages` and `leads`, both in the 007 grant.
  registry.registerQuery(
    AI_WRITE_OPERATIONS.classifyPendingReplies,
    classifyPendingRepliesOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.classifyThreadContext,
    classifyThreadContextOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.classifyRemainingCount,
    classifyRemainingCountOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.classifyGenderBatch,
    classifyGenderBatchOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.classifyGenderBacklog,
    classifyGenderBacklogOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.classifyWriteLabels,
    classifyWriteLabelsOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.classifyWriteGender,
    classifyWriteGenderOperation,
  )

  // briefing.ts GET — the job machine on `briefing_jobs`, the delivered
  // briefing on `briefings`, and the one context read whose relation
  // (`saved_searches`) step 007 did grant.
  registry.registerQuery(AI_WRITE_OPERATIONS.briefingJobRow, briefingJobRowOperation)
  registry.registerQuery(AI_WRITE_OPERATIONS.briefingPrior, briefingPriorOperation)
  registry.registerQuery(
    AI_WRITE_OPERATIONS.briefingWeeklyReference,
    briefingWeeklyReferenceOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.briefingAssignedSearches,
    briefingAssignedSearchesOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingEnsureJob,
    briefingEnsureJobOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingClaimJob,
    briefingClaimJobOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingFinishStage,
    briefingFinishStageOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingFailStage,
    briefingFailStageOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingResetJob,
    briefingResetJobOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingStaleError,
    briefingStaleErrorOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingUpsertBriefing,
    briefingUpsertBriefingOperation,
  )

  return registry
}

/**
 * Add the system vocabulary to a registry. Called by `buildAiRegistry`, so the
 * one AI store serves both halves of the machine path: the guard for reads, a
 * narrow named surface for the writes step 007 opened.
 */
export function registerSystemOperations(
  registry: NeonOperationRegistry,
): NeonOperationRegistry {
  registry.registerQuery(
    SYSTEM_OPERATIONS.notifyCandidates,
    notifyCandidatesOperation,
  )
  registry.registerQuery(
    SYSTEM_OPERATIONS.notifyRemaining,
    notifyRemainingOperation,
  )
  registry.registerQuery(
    SYSTEM_OPERATIONS.notifyLeadContext,
    notifyLeadContextOperation,
  )

  for (const [operation, sql] of Object.entries(SYSTEM_GUARD_SQL)) {
    registry.registerQuery<unknown[]>(operation, {
      build: () => guardStatement(sql),
      mapRow: mapGuardRow,
    })
  }

  registry.registerCommand(SYSTEM_OPERATIONS.notifyClaim, notifyClaimOperation)
  registry.registerCommand(
    SYSTEM_OPERATIONS.notifyUnclaim,
    notifyUnclaimOperation,
  )
  registry.registerCommand(
    SYSTEM_OPERATIONS.insertSavedSearch,
    insertSavedSearchOperation,
  )
  registry.registerCommand(
    SYSTEM_OPERATIONS.updateSavedSearch,
    updateSavedSearchOperation,
  )

  return registerCronOperations(registry)
}
