/**
 * Fixture for the S12 daily-activity slice.
 *
 * Real rows in `public.events`, read back through the real `daily_activity`
 * view under RLS. Nothing is stubbed.
 *
 * Shape, and why:
 *
 * - `DAY_COUNT` consecutive UTC days × the three event types the dashboard's
 *   `ActivityChart` renders. That is 3 × 900 = 2,700 rows out of
 *   `daily_activity`, so a full walk needs **three** pages at the 1,000-row cap
 *   and the cursor has to chain twice. One page over the cap would not prove
 *   chaining.
 * - The per-day count varies (1–3) rather than being constant, so a bug that
 *   dropped or duplicated rows would change the totals instead of cancelling
 *   out.
 * - Deliberate day-boundary instants: `00:00:00.000Z`, `23:59:59.000Z` and
 *   `23:00:00.000Z`. The last one is the interesting one — it falls on the
 *   *next* day in any timezone east of UTC+1, so it fails if the session
 *   timezone is not UTC.
 *
 * `events` is uniquely keyed `NULLS NOT DISTINCT (instance_id, campaign_id,
 * profile_url, event_type)`, so a distinct `profile_url` per row plus
 * `ON CONFLICT DO NOTHING` makes seeding idempotent.
 */

import type { PoolClient } from 'pg'

/** Namespaced so the fixture cannot collide with S11's or with tenant data. */
export const ACTIVITY_SCOPE = 's12-activity'

/** The event types `ActivityChart` plots. */
export const ACTIVITY_EVENT_TYPES = [
  'invite_sent',
  'invite_accepted',
  'reply_received',
] as const

/** First day of the fixture window, inclusive, UTC. */
export const ACTIVITY_FIRST_DAY = '2024-01-01'

/** 900 days × 3 event types = 2,700 view rows → three pages at the cap. */
export const DAY_COUNT = 900

export const EXPECTED_VIEW_ROWS = DAY_COUNT * ACTIVITY_EVENT_TYPES.length

/** Events per (day, event_type): 1, 2 or 3, cycling by day index. */
export function countForDay(dayIndex: number): number {
  return (dayIndex % 3) + 1
}

/** Total `events` rows the fixture inserts. */
export const EXPECTED_EVENT_ROWS = Array.from(
  { length: DAY_COUNT },
  (_, index) => countForDay(index) * ACTIVITY_EVENT_TYPES.length,
).reduce((sum, n) => sum + n, 0)

export function dayAt(offset: number): string {
  const date = new Date(`${ACTIVITY_FIRST_DAY}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

/** Last day of the fixture window, inclusive. */
export const ACTIVITY_LAST_DAY = dayAt(DAY_COUNT - 1)

/**
 * The instant used for the n-th event of a day. Index 0 is exactly midnight,
 * index 1 is the last second of the day, index 2 is 23:00 — which belongs to
 * the next calendar day everywhere east of UTC+1.
 */
const TIME_OF_DAY = ['00:00:00.000', '23:59:59.000', '23:00:00.000']

export function instantFor(day: string, index: number): string {
  return `${day}T${TIME_OF_DAY[index % TIME_OF_DAY.length]}Z`
}

export interface SeededActivity {
  readonly eventRows: number
  readonly viewRows: number
}

/**
 * Idempotent seed. Runs as an active member, so the rows are written through
 * the same RLS policies the slice reads them back through.
 */
export async function seedActivityFixture(
  client: PoolClient,
): Promise<SeededActivity> {
  await client.query(
    `INSERT INTO public.instances (id, label)
     VALUES ($1, 'S12 activity slice fixture')
     ON CONFLICT (id) DO NOTHING`,
    [ACTIVITY_SCOPE],
  )

  const instanceIds: string[] = []
  const profileUrls: string[] = []
  const eventTypes: string[] = []
  const occurredAt: string[] = []

  for (let dayIndex = 0; dayIndex < DAY_COUNT; dayIndex++) {
    const day = dayAt(dayIndex)
    const perType = countForDay(dayIndex)
    for (const eventType of ACTIVITY_EVENT_TYPES) {
      for (let n = 0; n < perType; n++) {
        instanceIds.push(ACTIVITY_SCOPE)
        profileUrls.push(`s12/${day}/${eventType}/${n}`)
        eventTypes.push(eventType)
        occurredAt.push(instantFor(day, n))
      }
    }
  }

  await client.query(
    `INSERT INTO public.events (instance_id, profile_url, event_type, occurred_at)
     SELECT f.instance_id, f.profile_url, f.event_type, f.occurred_at::timestamptz
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
            AS f(instance_id, profile_url, event_type, occurred_at)
     ON CONFLICT DO NOTHING`,
    [instanceIds, profileUrls, eventTypes, occurredAt],
  )

  const counts = await client.query<{ event_rows: string; view_rows: string }>(
    `SELECT (SELECT count(*) FROM public.events WHERE instance_id = $1) AS event_rows,
            (SELECT count(*) FROM public.daily_activity WHERE instance_id = $1) AS view_rows`,
    [ACTIVITY_SCOPE],
  )

  return {
    eventRows: Number(counts.rows[0]?.event_rows ?? 0),
    viewRows: Number(counts.rows[0]?.view_rows ?? 0),
  }
}
