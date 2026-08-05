/**
 * `pipeline.eventLog` — the append-only audit log of manual pipeline actions.
 *
 * The dashboard does not display this log. It *reconstructs* from it: a lead's
 * current `pipeline_stage` is only where the lead is now, and the pipeline funnel
 * needs "ever reached stage X", which exists nowhere else. So an incomplete read
 * here does not blank a panel — it lowers a funnel number, and nothing says so.
 *
 * That is the whole reason the two decisions below go the way they do.
 *
 * ## Keyset, and the delta key is `occurred_at` rather than `updated_at`
 *
 * The relation is append-only and unbounded — one row per manual stage move or
 * assignment, for the lifetime of the team — so it is a base-table walk like
 * `leads` and `messages`, and it seeks rather than counts. The order is
 * `(occurred_at, id)` **ascending**, matching the Supabase path, so the seek is
 * `(occurred_at, id) > (…)`.
 *
 * The `id` tiebreaker is load-bearing rather than decorative: a bulk
 * stage auto-advance inserts many rows inside one transaction, and
 * `occurred_at DEFAULT now()` is *transaction* time, so those rows share an
 * instant exactly. `DataContext` adds the same tiebreaker and says why.
 *
 * **The delta watermark is `occurredSince`, not `updatedSince`, and the
 * difference is not cosmetic.** This table has no `updated_at` column at all;
 * being append-only, its insertion time *is* its watermark. Two consequences
 * kept it a separate parameter name rather than a reuse of the one on
 * `leads.directory`:
 *
 * - A reader of the registry can tell, from the name alone, which column a
 *   delta filters — and here that column is also the row's own event time, which
 *   is the one case where the two could be confused.
 * - It is still **not** the request's `range`, for the reason `leads.directory`
 *   gives at length: `range` means "the window these rows belong to". A caller
 *   that passed the dashboard's 90-day display window here would silently drop
 *   every older stage move and shrink "ever reached" for the whole team, with no
 *   error and no visible symptom. The operation therefore ignores `range`.
 *
 * ## Errors are tolerated only for a missing relation — a narrowing, deliberately
 *
 * `fetchAllPipelineEvents` in `DataContext` returns `all` — the rows accumulated
 * so far — on **any** error from **any** page, mid-walk. So a transient failure
 * on page three of four currently yields a silently truncated audit log, and the
 * funnel renders confidently short.
 *
 * This path tolerates `DataStoreSchemaError` and nothing else: a database without
 * the table answers `[]` with `unavailable: true` (the pre-migration case the
 * comment there actually justifies), and every other failure is a 500. That is
 * narrower than today's behaviour on purpose. A blank panel is recoverable; a
 * plausible wrong number is not.
 *
 * ## `from_assignee` / `to_assignee` are names, not ids
 *
 * Worth stating because it is the exception. Every other reference to a team
 * member in this schema is a `team_members.id` and therefore carries N-B2's
 * collision — the same integer denotes different people on the two providers.
 * This log snapshots the member's *name* as text at the time of the action, so it
 * is readable with no roster and no join, and it stays readable after the member
 * is removed.
 */

import type { NeonKeysetValue, NeonQueryOperation, NeonRow } from '../neon.js'

export const PIPELINE_OPERATIONS = {
  /** Every manual stage move and assignment, oldest first. */
  eventLog: 'pipeline.eventLog',
} as const

/** One row, in the browser's own column names (`PipelineEvent` in `types.ts`). */
export interface PipelineEventRow {
  readonly id: number
  readonly lead_id: string
  readonly kind: string
  readonly actor: string | null
  readonly from_stage: string | null
  readonly to_stage: string | null
  readonly from_substatus: string | null
  readonly to_substatus: string | null
  /** A member *name*, snapshotted. Not an id — see the header. */
  readonly from_assignee: string | null
  readonly to_assignee: string | null
  readonly lost_reason: string | null
  readonly occurred_at: string
}

export interface PipelineEventLogParams {
  /**
   * Delta-refresh watermark on `occurred_at`. `null` fetches the whole log.
   * See the header for why this is neither `updatedSince` nor the request range.
   */
  readonly occurredSince: string | null
  readonly [key: string]: string | null
}

const PIPELINE_EVENTS_SQL = `SELECT e.id::text AS id,
          e.lead_id::text AS lead_id,
          e.kind,
          e.actor,
          e.from_stage,
          e.to_stage,
          e.from_substatus,
          e.to_substatus,
          e.from_assignee,
          e.to_assignee,
          e.lost_reason,
          e.occurred_at
     FROM public.pipeline_events e
    WHERE ($1::timestamptz IS NULL OR e.occurred_at >= $1::timestamptz)
      AND ($2::timestamptz IS NULL
           OR (e.occurred_at, e.id) > ($2::timestamptz, $3::bigint))
    ORDER BY e.occurred_at, e.id`

const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

export const pipelineEventLogOperation: NeonQueryOperation<
  PipelineEventRow,
  PipelineEventLogParams
> = {
  keyset: { columns: ['occurred_at', 'id'] },
  build: ({ params, after }) => ({
    text: PIPELINE_EVENTS_SQL,
    values: [
      params?.occurredSince ?? null,
      // Declared arity is 2; the driver refuses any other width before this runs.
      (after?.[0] as NeonKeysetValue | undefined) ?? null,
      (after?.[1] as NeonKeysetValue | undefined) ?? null,
    ],
  }),
  mapRow: (row: NeonRow): PipelineEventRow => ({
    // `bigint`, handed over as a string by `pg`. The browser's
    // `PipelineEvent.id` is a number and `mergeById` keys on it.
    id: Number(row.id),
    lead_id: String(row.lead_id),
    kind: String(row.kind),
    // NOT NULL with a default of `'unknown'` in the baseline; the browser type
    // is nullable, so the wider of the two is emitted.
    actor: nullableText(row.actor),
    from_stage: nullableText(row.from_stage),
    to_stage: nullableText(row.to_stage),
    from_substatus: nullableText(row.from_substatus),
    to_substatus: nullableText(row.to_substatus),
    from_assignee: nullableText(row.from_assignee),
    to_assignee: nullableText(row.to_assignee),
    lost_reason: nullableText(row.lost_reason),
    occurred_at: String(row.occurred_at),
  }),
}
