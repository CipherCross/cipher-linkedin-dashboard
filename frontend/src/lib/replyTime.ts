import { BUSINESS_TIME_ZONE, UI_LOCALE } from '../ui/datetime'

const ZONE = BUSINESS_TIME_ZONE

function parts(value: Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat(UI_LOCALE, {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value).map((part) => [part.type, part.value]))
}

export function replyDateKey(value: string | Date): string {
  const p = parts(typeof value === 'string' ? new Date(value) : value)
  return `${p.year}-${p.month}-${p.day}`
}

export function replyTime(value: string, withDay = false): string {
  return new Intl.DateTimeFormat(UI_LOCALE, {
    timeZone: ZONE, ...(withDay ? { day: 'numeric', month: 'short' } : {}),
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

/**
 * `13 Sep` / `13 Sep 2025` — the calendar day of a message on the team's
 * working clock. Table columns that show *when a reply arrived* must use this
 * and not `shortDate()`: that one slices the raw UTC prefix, so a reply at
 * 01:54 Madrid showed as the previous day beside the Replies workspace's own
 * rendering of the very same message. UTC day slices (cohorts, daily activity,
 * milestones) stay on `shortDate` — they are the interval the SQL cuts on.
 */
export function replyDate(value: string): string {
  const date = new Date(value)
  const sameYear = replyDateKey(new Date()).slice(0, 4) === replyDateKey(date).slice(0, 4)
  return new Intl.DateTimeFormat(UI_LOCALE, {
    timeZone: ZONE, day: 'numeric', month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date)
}

export function replyDayHeading(value: string, now = new Date()): string {
  const day = replyDateKey(value)
  const today = replyDateKey(now)
  if (day === today) return 'Today'
  const yesterday = new Date(`${today}T12:00:00Z`)
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  if (day === replyDateKey(yesterday)) return 'Yesterday'
  return new Intl.DateTimeFormat(UI_LOCALE, {
    timeZone: ZONE, day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(value))
}

/** Operational reply times are the team's working clock, and the label says so. */
export const REPLY_TIME_ZONE_LABEL = 'Madrid time'
