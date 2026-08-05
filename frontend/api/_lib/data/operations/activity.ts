/**
 * Application read operations for the daily-activity slice (S12).
 *
 * SQL lives here, behind a named operation. Handlers never see SQL text, a
 * driver object, a connection string or a provider resource ID.
 *
 * The query reads the `daily_activity` view rather than re-deriving the
 * aggregate, deliberately: the existing Supabase path reads the same view
 * (`frontend/src/lib/DataContext.tsx`), and the view's definition is
 * semantically identical in both schemas —
 * `supabase/migrations/001_init.sql` and
 * `postgres/tenant-baseline/v1/001_portable_business_baseline.sql`. Reading the
 * same view on both sides is what makes the parity claim about numbers rather
 * than about two independently-written aggregates.
 */

import type { NeonQueryOperation, NeonRow } from '../neon.js'

export const ACTIVITY_OPERATIONS = {
  /** Per-day, per-event-type counts for one instance over a UTC range. */
  dailySeries: 'activity.dailySeries',
} as const

/** One row of the `daily_activity` view, as the browser consumes it. */
export interface DailyActivityRow {
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string
  readonly instance_id: string
  readonly event_type: string
  readonly cnt: number
}

export interface DailyActivityParams {
  /**
   * One instance, or `null` for every instance the actor may read.
   *
   * S12 required an instance because its slice was a single-instance page.
   * `DataContext` fetches `daily_activity` for the whole team at once, so S13
   * widened the parameter rather than issuing one request per notebook. The
   * widening is additive: a non-null instance produces exactly the rows S12's
   * SQL produced, which is what keeps its 22 live assertions meaningful.
   *
   * "Every instance the actor may read" is not a widening of authority — the
   * view is `security_invoker`, so RLS decides the row set either way. Dropping
   * the predicate removes a filter the caller chose, never one the database
   * imposed.
   */
  readonly instanceId: string | null
  readonly [key: string]: string | null
}

/**
 * `day` is selected as text on purpose.
 *
 * The view's `day` column is a PostgreSQL `date`. A bare `date` crosses the
 * wire as OID 1082, which `pg` parses into a `Date` at *local* midnight — so on
 * a host at UTC+1 the day `2026-01-01` arrives as `2025-12-31T23:00:00.000Z`.
 * The driver now normalizes 1082 as well, but selecting `::text` keeps this
 * operation's contract explicit and independent of the driver's parser: a
 * calendar day is a calendar day, not an instant, and `YYYY-MM-DD` is exactly
 * what `frontend/src/lib/leads.ts` compares against.
 *
 * The range is applied to the view's own `day`, converted from the request's
 * UTC instants with `AT TIME ZONE 'UTC'`. Because the series is aggregated per
 * day, a boundary that fell mid-day would be ambiguous — the day is either in
 * the range or out of it. The handler therefore accepts only day-granular
 * (`YYYY-MM-DD`) bounds and expands them to UTC midnight instants, so
 * `[fromInclusive, toExclusive)` over instants and `[from, to]` over inclusive
 * calendar days denote exactly the same set of days. See
 * `dayRangeToUtcRange` in the handler.
 */
const DAILY_SERIES_SQL = `SELECT to_char(da.day, 'YYYY-MM-DD') AS day,
          da.instance_id,
          da.event_type,
          da.cnt::bigint AS cnt
     FROM public.daily_activity da
    WHERE ($1::text IS NULL OR da.instance_id = $1)
      AND ($2::timestamptz IS NULL
           OR da.day >= ($2::timestamptz AT TIME ZONE 'UTC')::date)
      AND ($3::timestamptz IS NULL
           OR da.day < ($3::timestamptz AT TIME ZONE 'UTC')::date)
    ORDER BY da.day, da.instance_id, da.event_type`

export const dailySeriesOperation: NeonQueryOperation<
  DailyActivityRow,
  DailyActivityParams
> = {
  build: ({ params, range }) => ({
    text: DAILY_SERIES_SQL,
    values: [
      // `undefined` and `null` both mean "every instance"; an empty string does
      // not, and is passed through so it matches nothing rather than silently
      // becoming an unscoped read.
      params?.instanceId ?? null,
      range?.fromInclusive ?? null,
      range?.toExclusive ?? null,
    ],
  }),
  mapRow: (row: NeonRow): DailyActivityRow => ({
    day: String(row.day),
    instance_id: String(row.instance_id),
    event_type: String(row.event_type),
    // `count(*)` is bigint; `pg` returns it as a string to avoid precision loss.
    cnt: Number(row.cnt),
  }),
}
