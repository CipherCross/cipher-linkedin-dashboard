/**
 * Date and time display. One explicit locale (`en-GB`), and one explicit rule
 * about which clock a value belongs to:
 *
 *   - **Operational business dates** — a reply arrived, a follow-up is due —
 *     render in Europe/Madrid, the team's working day, and always carry a
 *     visible `Madrid` marker: `14 Sep, 13:20 · Madrid`.
 *   - **Analytical interval slices** — cohort weeks, daily-activity buckets —
 *     render in UTC with a visible `UTC` marker, because that is the boundary
 *     the SQL views and `lib/leads.ts` actually slice on.
 *
 * The UTC data contract is not changed by any of this; only the labelling is.
 */

export const BUSINESS_TIME_ZONE = 'Europe/Madrid'
export const BUSINESS_TIME_ZONE_LABEL = 'Madrid'
export const ANALYTICS_TIME_ZONE_LABEL = 'UTC'
export const UI_LOCALE = 'en-GB'

const businessDay = new Intl.DateTimeFormat(UI_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE, day: 'numeric', month: 'short',
})
const businessDayYear = new Intl.DateTimeFormat(UI_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric',
})
const businessClock = new Intl.DateTimeFormat(UI_LOCALE, {
  timeZone: BUSINESS_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
})
const utcDay = new Intl.DateTimeFormat(UI_LOCALE, {
  timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
})

function asDate(value: string | Date): Date {
  return typeof value === 'string' ? new Date(value) : value
}

/** `14 Sep, 13:20` — a business time without the zone marker. */
export function businessTime(value: string | Date, withDay = false): string {
  const date = asDate(value)
  const clock = businessClock.format(date)
  return withDay ? `${businessDay.format(date)}, ${clock}` : clock
}

/** `14 Sep, 13:20 · Madrid` — the labelled form for anything standalone. */
export function businessTimeLabelled(value: string | Date, withDay = true): string {
  return `${businessTime(value, withDay)} · ${BUSINESS_TIME_ZONE_LABEL}`
}

/** `14 Sep 2026` in the business zone. */
export function businessDate(value: string | Date): string {
  return businessDayYear.format(asDate(value))
}

/** `14 Sep 2026` sliced in UTC — use for anything that feeds an interval. */
export function analyticsDate(value: string | Date): string {
  return utcDay.format(asDate(value))
}

/** `YYYY-MM-DD` in the business zone — the key the follow-up queue works in. */
export function businessDateKey(value: string | Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    })
      .formatToParts(asDate(value))
      .map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** `Today` / `Yesterday` / `14 September 2026`, in the business zone. */
export function businessDayHeading(value: string | Date, now: Date = new Date()): string {
  const day = businessDateKey(value)
  const today = businessDateKey(now)
  if (day === today) return 'Today'
  const yesterday = new Date(`${today}T12:00:00Z`)
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  if (day === businessDateKey(yesterday)) return 'Yesterday'
  return new Intl.DateTimeFormat(UI_LOCALE, {
    timeZone: BUSINESS_TIME_ZONE, day: 'numeric', month: 'long', year: 'numeric',
  }).format(asDate(value))
}

/**
 * A relative label ("5 minutes ago") always needs the absolute value within
 * reach — pair the returned `label` with `title` on the element.
 */
export function relativeTime(value: string | Date | null | undefined): {
  label: string
  title: string
} {
  if (!value) return { label: '—', title: 'No timestamp recorded' }
  const date = asDate(value)
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000)
  const label =
    minutes < 1 ? 'just now'
      : minutes < 60 ? `${minutes}m ago`
        : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h ago`
          : `${Math.round(minutes / 1440)}d ago`
  return { label, title: businessTimeLabelled(date) }
}
