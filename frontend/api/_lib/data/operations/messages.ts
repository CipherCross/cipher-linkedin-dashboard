/**
 * The conversation cache: `messages.inboundHistory` and `messages.outboundRecent`.
 *
 * ## Why two operations rather than one with a `direction` parameter
 *
 * Because the asymmetry between them is a product decision, not a filter value.
 * `CLAUDE.md` states it as an invariant: inbound messages are fetched **in full**,
 * all-time, because sentiment and reply-intent counts — including the durable P3
 * milestone that is the denominator for post-P3 booking conversion — are displayed
 * beside all-time lead totals, so a window silently undercounts them on a busy
 * account. Outbound is windowed to 90 days because it is only recent display.
 *
 * A single `messages.byDirection(direction, since)` would have made that invariant
 * a caller's responsibility, and the first caller to pass a `since` for inbound
 * would break the P3 numbers without breaking a test. Two named operations put the
 * decision in the vocabulary, where G2 asked for it: the application offers "the
 * inbound history" and "recent outbound", and neither can be asked for the other's
 * shape.
 *
 * ## Both are keyset-paginated, and inbound is why the facility exists
 *
 * N-S12 pre-decided keyset for the inbound read and required it be written
 * **before** the read rather than retrofitted. Outbound is keyset too: it is bounded
 * by 90 days rather than by nothing, but on a four-notebook team that is still past
 * the 1,000-row cap, and the sort key and predicate are identical — so making one
 * offset and one keyset would have been two code paths for one shape.
 *
 * **What was measured, stated without flattery.** At the fixture's 2,103 inbound
 * rows, server-side `EXPLAIN ANALYZE` p50 over 7 runs:
 *
 * | page | execution |
 * |---|---|
 * | `OFFSET 0` | 8.23 ms |
 * | `OFFSET 2000` | 7.57 ms |
 * | keyset seek to row 2000 | 6.93 ms |
 *
 * So **keyset is not measurably faster here.** The spread is inside the noise, and
 * the *first* offset page is the slowest of the three. Anyone reading a keyset
 * implementation should know that its justification at this scale is not a
 * benchmark.
 *
 * The justification is the plan, and the plan also shows why the win is not
 * available yet. Both formulations produce `Seq Scan on messages` feeding a
 * `top-N heapsort`: the sort key `(sent_at DESC, id DESC)` has **no unpartial index
 * behind it** in the baseline — `messages_thread_latest_nonempty_idx` carries those
 * columns but is partial and prefixed by `(instance_id, profile_url)`, and
 * `messages_intent_backlog_idx` is partial on the intent backlog. The ROW comparison
 * lands as a filter, not as an index condition. So today neither formulation avoids
 * scanning, and their costs converge.
 *
 * Keyset is still the right shape to write, for two reasons that do not depend on
 * today's numbers: `OFFSET n` is O(n) in rows discarded and therefore quadratic
 * over a full walk once the relation is large, and a seek predicate is the only one
 * of the two that an index *can* satisfy. Adding
 * `messages (direction, sent_at DESC, id DESC)` would turn this into an index scan
 * and make the difference real — that is a ledger step, so it belongs to a session
 * that may apply schema, not to this one. It is recorded in the handoff's Known
 * limits as the open half of this decision.
 */

import type {
  NeonKeysetValue,
  NeonQueryOperation,
  NeonRow,
  NeonStatement,
} from '../neon.js'
import type { UtcRange } from '../contracts.js'

export const MESSAGES_OPERATIONS = {
  /** Every inbound reply, all-time, newest first. Never windowed. */
  inboundHistory: 'messages.inboundHistory',
  /** Outbound sends inside the caller's window, newest first. */
  outboundRecent: 'messages.outboundRecent',
} as const

/** One message row, in the browser's own column names (`Message` in `types.ts`). */
export interface MessageRow {
  readonly id: number
  readonly instance_id: string
  readonly campaign_id: string | null
  readonly profile_url: string
  readonly direction: string
  readonly body: string | null
  readonly sent_at: string
  readonly sentiment: string | null
  readonly reason: string | null
  readonly classified_at: string | null
  readonly classified_model: string | null
  readonly source: string | null
  readonly intent_level: string | null
  readonly intent_reason: string | null
  readonly intent_classified_at: string | null
  readonly intent_classified_model: string | null
  readonly intent_taxonomy_version: string | null
}

export interface MessagesParams {
  /**
   * Delta-refresh watermark on `updated_at`. See the same parameter on
   * `leads.directory` for why this is a parameter and not the request's `range`:
   * here the distinction is sharper still, because `messages.outboundRecent` uses
   * `range` for its `sent_at` window at the same time.
   */
  readonly updatedSince: string | null
  readonly [key: string]: string | null
}

/**
 * The message column list the Supabase path's widest rung asks for, in the same
 * order. Its three-rung ladder (`MESSAGE_COLUMN_LADDER`) is dropped for the same
 * reasons `leads.directory` drops its four — see that file's header; the argument
 * is identical and the baseline likewise already carries every column, including
 * the migration-047 intent set.
 *
 * `content_hash`, `notified_at` and `updated_at` exist on the relation and are not
 * selected: the first two belong to the sync agent and the notifier, and no page
 * reads any of them.
 *
 * `WHERE` is assembled from three independent predicates, and the parameter
 * positions are fixed so both operations share one statement shape:
 *
 * - `$1` the delta watermark on `updated_at`
 * - `$2`, `$3` the keyset seek on `(sent_at, id)`
 * - `$4`, `$5` the `sent_at` window, which only `outboundRecent` supplies
 *
 * The row comparison `(sent_at, id) < ($2, $3)` is a lexicographic ROW compare,
 * which is exactly the descending sort order — so it resumes at the row after the
 * previous page's last, with no dependence on `sent_at` being unique. It is not:
 * a bulk sync stamps identical times across many rows, which is why `id` is in the
 * key at all, and why the Supabase path adds the same tiebreaker.
 */
function messagesSql(direction: 'in' | 'out'): string {
  return `SELECT m.id::text AS id,
          m.instance_id,
          m.campaign_id,
          m.profile_url,
          m.direction,
          m.body,
          m.sent_at,
          m.sentiment,
          m.reason,
          m.classified_at,
          m.classified_model,
          m.source,
          m.intent_level,
          m.intent_reason,
          m.intent_classified_at,
          m.intent_classified_model,
          m.intent_taxonomy_version
     FROM public.messages m
    WHERE m.direction = '${direction}'
      AND ($1::timestamptz IS NULL OR m.updated_at >= $1::timestamptz)
      AND ($2::timestamptz IS NULL
           OR (m.sent_at, m.id) < ($2::timestamptz, $3::bigint))
      AND ($4::timestamptz IS NULL OR m.sent_at >= $4::timestamptz)
      AND ($5::timestamptz IS NULL OR m.sent_at < $5::timestamptz)
    ORDER BY m.sent_at DESC, m.id DESC`
}

// Interpolated, and safe because it is not caller input: the two literals are
// chosen by which operation is registered, from this module's own closed set. The
// alternative — a `$n` placeholder — would leave the planner without a constant
// for a column that carries a check constraint, for no gain in safety.
const INBOUND_SQL = messagesSql('in')
const OUTBOUND_SQL = messagesSql('out')

function messageValues(
  params: MessagesParams | undefined,
  after: readonly NeonKeysetValue[] | undefined,
  range: UtcRange | undefined,
): readonly unknown[] {
  return [
    params?.updatedSince ?? null,
    // Declared arity is 2, and the driver refuses any other width before this
    // runs. Both are null on the first page.
    after?.[0] ?? null,
    after?.[1] ?? null,
    range?.fromInclusive ?? null,
    range?.toExclusive ?? null,
  ]
}

const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

function mapMessage(row: NeonRow): MessageRow {
  return {
    // `bigint`, handed over as a string by `pg` to protect precision. The
    // browser's `Message.id` is a number and `mergeById` keys on it, so it is
    // coerced here rather than forking the type.
    id: Number(row.id),
    instance_id: String(row.instance_id),
    campaign_id: nullableText(row.campaign_id),
    profile_url: String(row.profile_url),
    direction: String(row.direction),
    body: nullableText(row.body),
    sent_at: String(row.sent_at),
    sentiment: nullableText(row.sentiment),
    reason: nullableText(row.reason),
    classified_at: nullableText(row.classified_at),
    classified_model: nullableText(row.classified_model),
    source: nullableText(row.source),
    intent_level: nullableText(row.intent_level),
    intent_reason: nullableText(row.intent_reason),
    intent_classified_at: nullableText(row.intent_classified_at),
    intent_classified_model: nullableText(row.intent_classified_model),
    intent_taxonomy_version: nullableText(row.intent_taxonomy_version),
  }
}

/**
 * `sent_at` is the raw column, not `to_char`'d, because it is an instant and not a
 * calendar day — the driver normalizes `timestamptz` to ISO-8601 UTC, which is
 * what `Message.sent_at` has always held and what `leads.ts` compares. That also
 * makes it a cursor-safe scalar: the keyset value round-trips through JSON as the
 * same string PostgreSQL will parse back to the same instant.
 */
const KEYSET = { columns: ['sent_at', 'id'] } as const

export const inboundHistoryOperation: NeonQueryOperation<
  MessageRow,
  MessagesParams
> = {
  keyset: KEYSET,
  // `range` is accepted by the contract and deliberately ignored: the inbound
  // history is all-time by product decision, and passing a window here would
  // undercount the sentiment and P3 figures rendered beside all-time totals.
  build: ({ params, after }): NeonStatement => ({
    text: INBOUND_SQL,
    values: messageValues(params, after, undefined),
  }),
  mapRow: mapMessage,
}

export const outboundRecentOperation: NeonQueryOperation<
  MessageRow,
  MessagesParams
> = {
  keyset: KEYSET,
  build: ({ params, after, range }): NeonStatement => ({
    text: OUTBOUND_SQL,
    values: messageValues(params, after, range),
  }),
  mapRow: mapMessage,
}
