// Parser for a LinkedIn message thread copied out of the browser with the mouse.
// Feeds the "Import history" flow in the ConversationDrawer: raw paste in,
// message blocks (sender / time / body) out. Pure module — no React, no DOM —
// so it can be exercised from a plain script.
//
// The pasted text interleaves four kinds of lines:
//   header      "Anastasia Prokopenko   4:15 PM"   (2+ spaces before the time)
//   date        "Jun 20" | "Jun 20, 2025" | "Monday" | "Today" | "Yesterday"
//   noise       "… sent the following message(s) at …", "View X’s profile…",
//               "Seen by X at 8:31 PM."
//   body        everything else, attributed to the open header block
//
// English LinkedIn UI only for now; the regexes are named consts so other
// locales can be added without touching the state machine.

export interface ParsedMessage {
  sender: string
  /** The time as pasted, e.g. "4:15 PM" — kept for display next to edits. */
  timeText: string
  /** Resolved in the browser's local timezone. */
  sentAt: Date
  /** True when the block appeared before any date separator (date defaulted). */
  dateInferred: boolean
  /** True when this block resolved earlier than the one before it — usually a
   *  bad year guess on a thread older than a year. */
  outOfOrder: boolean
  body: string
}

export interface ParseResult {
  messages: ParsedMessage[]
  /** Distinct sender names in order of appearance (direction mapping is the
   *  caller's job — it needs the instance's account_name). */
  senders: string[]
  warnings: string[]
}

// Noise LinkedIn injects between messages. Checked BEFORE the header regex
// because these lines also contain times. "View X’s profile" is often glued to
// the next name with no space ("…profileAnastasia Prokopenko") — the whole line
// goes.
const NOISE_RES = [
  /sent the following messages? at/i,
  /^View\s.+?['’]s\s*profile/i,
  /^Seen by .+ at .+\.?$/i,
]

// "Name   4:15 PM" — 2+ whitespace between name and time (\s also matches the
// NBSP/U+202F LinkedIn uses around times). Meridiem optional so 24h-locale
// clocks ("17:49") parse too.
const HEADER_RE = /^(.+?)\s{2,}(\d{1,2}):(\d{2})(?:\s?([AP]M))?$/i

const RELATIVE_DAY_RE = /^(Today|Yesterday)$/i
const WEEKDAY_RE = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/i
const MONTH_DAY_RE =
  /^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\s+(\d{1,2})(?:,\s*(\d{4}))?$/i

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Local-midnight date for a separator line, or null if it isn't one. */
function resolveDate(line: string, now: Date): Date | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const rel = RELATIVE_DAY_RE.exec(line)
  if (rel) {
    if (rel[1].toLowerCase() === 'yesterday') today.setDate(today.getDate() - 1)
    return today
  }

  const wd = WEEKDAY_RE.exec(line)
  if (wd) {
    // Most recent occurrence strictly before today — LinkedIn labels the
    // current day "Today", never by its weekday name.
    const target = WEEKDAYS.indexOf(wd[1].toLowerCase())
    const delta = (today.getDay() - target + 7) % 7 || 7
    today.setDate(today.getDate() - delta)
    return today
  }

  const md = MONTH_DAY_RE.exec(line)
  if (md) {
    const month = MONTHS.indexOf(md[1].slice(0, 3).toLowerCase())
    const day = Number(md[2])
    if (md[3]) return new Date(Number(md[3]), month, day)
    // No year on the separator: current year, unless that lands in the future
    // (a "Dec 28" pasted in January is last year's December).
    const candidate = new Date(today.getFullYear(), month, day)
    if (candidate.getTime() > today.getTime()) candidate.setFullYear(candidate.getFullYear() - 1)
    return candidate
  }

  return null
}

interface OpenBlock {
  sender: string
  timeText: string
  hour: number
  minute: number
  /** null = header appeared before any date separator. */
  date: Date | null
  bodyLines: string[]
}

export function parseLinkedInThread(raw: string, now: Date = new Date()): ParseResult {
  const warnings: string[] = []
  const blocks: OpenBlock[] = []
  let current: OpenBlock | null = null
  let currentDate: Date | null = null
  let ignoredPreamble = false

  const flush = () => {
    if (!current) return
    // Trim blank edges but keep interior blank lines (paragraph breaks).
    const lines = [...current.bodyLines]
    while (lines.length && !lines[0].trim()) lines.shift()
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    if (lines.length) blocks.push({ ...current, bodyLines: lines })
    else warnings.push(`Skipped an empty message from ${current.sender} ${current.timeText} (reaction-only?).`)
    current = null
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()

    if (line && NOISE_RES.some((re) => re.test(line))) continue

    const header = HEADER_RE.exec(line)
    if (header) {
      let hour = Number(header[2])
      const minute = Number(header[3])
      const meridiem = header[4]?.toUpperCase()
      const validTime = minute <= 59 && (meridiem ? hour >= 1 && hour <= 12 : hour <= 23)
      if (validTime) {
        if (meridiem) hour = (hour % 12) + (meridiem === 'PM' ? 12 : 0)
        flush()
        current = {
          sender: header[1].trim(),
          timeText: `${header[2]}:${header[3]}${meridiem ? ' ' + meridiem : ''}`,
          hour,
          minute,
          date: currentDate,
          bodyLines: [],
        }
        continue
      }
      // Invalid time (e.g. "25:70") — fall through and treat as body.
    }

    const date = line ? resolveDate(line, now) : null
    if (date) {
      flush()
      currentDate = date
      continue
    }

    if (current) current.bodyLines.push(rawLine)
    else if (line) ignoredPreamble = true
  }
  flush()

  if (ignoredPreamble) warnings.push('Some text before the first message header was ignored.')
  if (!blocks.length) {
    warnings.push('No messages found — expected lines like "Name   4:15 PM" followed by the message text.')
    return { messages: [], senders: [], warnings }
  }

  // Blocks pasted before the first date separator (typically the connection-note
  // message at the top of a thread) have no date of their own: default to the
  // first dated block's day — or today — and flag for manual correction.
  const firstKnown = blocks.find((b) => b.date)?.date ?? new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const undated = blocks.filter((b) => !b.date).length
  if (undated) warnings.push(`${undated} message(s) had no date line above them — date guessed, please check.`)

  const messages: ParsedMessage[] = blocks.map((b) => {
    const d = b.date ?? firstKnown
    return {
      sender: b.sender,
      timeText: b.timeText,
      sentAt: new Date(d.getFullYear(), d.getMonth(), d.getDate(), b.hour, b.minute),
      dateInferred: !b.date,
      outOfOrder: false,
      body: b.bodyLines.join('\n'),
    }
  })
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].sentAt.getTime() < messages[i - 1].sentAt.getTime()) messages[i].outOfOrder = true
  }

  const senders = [...new Set(messages.map((m) => m.sender))]
  return { messages, senders, warnings }
}

/** Dedup identity of a message body: whitespace- and case-insensitive. Used to
 *  match pasted blocks against already-stored rows (the DB unique key can't —
 *  synced rows carry LH2 run-time timestamps, pasted rows carry real ones).
 *  Keep in sync with the copy in api/import-conversation.ts. */
export function normalizeForDedup(body: string): string {
  return body.replace(/\r/g, '').trim().replace(/\s+/g, ' ').toLowerCase()
}
