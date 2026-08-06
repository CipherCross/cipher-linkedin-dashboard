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
  // The two guard-backed context reads, for relations outside the 007 grant.
  campaignNames: 'system.campaignNames',
  instanceNames: 'system.instanceNames',
  // mcp.ts save_search — the machine-authenticated library write.
  insertSavedSearch: 'system.insertSavedSearch',
  updateSavedSearch: 'system.updateSavedSearch',
} as const

/** Every system read, for assertions. */
export const SYSTEM_QUERY_OPERATIONS = [
  SYSTEM_OPERATIONS.notifyCandidates,
  SYSTEM_OPERATIONS.notifyRemaining,
  SYSTEM_OPERATIONS.notifyLeadContext,
  SYSTEM_OPERATIONS.campaignNames,
  SYSTEM_OPERATIONS.instanceNames,
] as const

/** Every system write. All five relations behind them are step 007's. */
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
 *  fleet is single digits of notebooks. */
export const INSTANCE_NAMES_SQL = `
select id, account_name, label
from instances
order by id
`.trim()

/**
 * Every guard-backed system query and the SQL it runs. Keyed by the operation
 * names themselves, so a guard operation declared without its SQL — or SQL
 * without an operation — does not compile.
 */
export const SYSTEM_GUARD_SQL: Record<
  (typeof SYSTEM_GUARD_OPERATIONS)[number],
  string
> = {
  [SYSTEM_OPERATIONS.campaignNames]: CAMPAIGN_NAMES_SQL,
  [SYSTEM_OPERATIONS.instanceNames]: INSTANCE_NAMES_SQL,
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

  return registry
}
