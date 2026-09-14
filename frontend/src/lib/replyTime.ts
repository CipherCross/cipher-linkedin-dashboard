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
