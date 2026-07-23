// Client-side analysis helpers over the raw leads table. All milestone logic
// mirrors the agent's derive_events: invited_at / connected_at / replied_at
// are the source of truth for funnel stages.
import type {
  CampaignMetrics, ConversationReplyIntent, DailyActivity, Gender, Hypothesis,
  HypothesisCampaign, Instance, IssueKind, IssueSeverity, Lead, Message, NextAction,
  PipelineEvent, ReplyIntent, Sentiment,
} from './types'

/** Display name for an instance: real LinkedIn account name when synced,
 *  else the configured label, else the raw id. */
export function instanceName(inst: Instance | undefined, fallback = ''): string {
  return inst?.account_name || inst?.label || inst?.id || fallback
}

/** Stable key for one lead's conversation thread. profile_url is near-unique,
 *  but scoping by instance too keeps the same person reached from two accounts
 *  separate. */
export const leadKey = (instance_id: string, profile_url: string) =>
  `${instance_id}|${profile_url}`

/** Sentiment display metadata, shared by LeadsExplorer and the conversation
 *  drawer. `cls` maps to the `.senti.*` colours in styles.css. */
export const SENTIMENT_META: Record<Sentiment, { label: string; cls: string }> = {
  positive: { label: 'Positive', cls: 'pos' },
  objection: { label: 'Objection', cls: 'obj' },
  neutral: { label: 'Neutral', cls: 'neu' },
  referral: { label: 'Referral', cls: 'ref' },
  negative: { label: 'Negative', cls: 'neg' },
  auto: { label: 'Auto', cls: 'auto' },
}

/** Display order by follow-up priority, not alphabetical. */
export const SENTIMENT_ORDER: Sentiment[] = [
  'positive',
  'objection',
  'neutral',
  'referral',
  'negative',
  'auto',
]

/** Commercial-intent display metadata. Intent is independent of sentiment. */
export const INTENT_META: Record<ReplyIntent, { label: string; short: string; cls: string }> = {
  p1: { label: 'Polite positive', short: 'P1', cls: 'p1' },
  p2: { label: 'Problem interest', short: 'P2', cls: 'p2' },
  p3: { label: 'Buying intent', short: 'P3', cls: 'p3' },
}

export const INTENT_ORDER: ReplyIntent[] = ['p3', 'p2', 'p1']

/** Coaching next-action display metadata. `cls` reuses the `.senti.*` colours so
 *  the action badge matches the rest of the UI: attention=obj, good=pos, etc. */
export const NEXT_ACTION_META: Record<NextAction, { label: string; cls: string }> = {
  reply: { label: 'Reply now', cls: 'obj' },
  book_call: { label: 'Book a call', cls: 'pos' },
  refer: { label: 'Ask for referral', cls: 'ref' },
  wait: { label: 'Wait', cls: 'neu' },
  close: { label: 'Close out', cls: 'neg' },
  none: { label: 'No action', cls: 'auto' },
}

/** Short human label per coaching issue kind, for the issue chips. */
export const ISSUE_KIND_LABEL: Record<IssueKind, string> = {
  ignored_question: 'Ignored question',
  too_long: 'Too long',
  too_salesy: 'Too salesy',
  generic: 'Generic',
  slow_followup: 'Slow follow-up',
  no_cta: 'No CTA',
  multiple_asks: 'Too many asks',
  pushy: 'Pushy',
  other: 'Issue',
}

/** Issue severity → `.senti.*` colour class (high=neg, med=obj, low=neu). */
export const SEVERITY_CLS: Record<IssueSeverity, string> = {
  high: 'neg',
  med: 'obj',
  low: 'neu',
}

/** The latest inbound reply (body + its classification) seen per lead. */
export interface ReplyInfo {
  body: string
  sentiment: Sentiment | null
  reason: string | null
  intent_level: ReplyIntent | null
  intent_reason: string | null
  /** Highest intent ever reached in this conversation (durable). */
  highest_intent: ReplyIntent | null
  sent_at: string
}

/** Latest inbound reply per lead, keyed by leadKey(). `messages` MUST be sorted
 *  by sent_at descending (as DataContext fetches them), so the first row seen
 *  for a key is the most recent; outbound and empty rows are skipped. */
export function latestRepliesByLead(messages: Message[]): Map<string, ReplyInfo> {
  const map = new Map<string, ReplyInfo>()
  for (const m of messages) {
    if (m.direction !== 'in' || !m.body) continue
    const k = leadKey(m.instance_id, m.profile_url)
    if (!map.has(k))
      map.set(k, {
        body: m.body,
        sentiment: m.sentiment,
        reason: m.reason,
        intent_level: m.intent_level ?? null,
        intent_reason: m.intent_reason ?? null,
        highest_intent: null,
        sent_at: m.sent_at,
      })
  }
  for (const [k, intent] of highestIntentByLead(messages)) {
    const row = map.get(k)
    if (row) row.highest_intent = intent.highest
  }
  return map
}

export interface ConversationIntentInfo {
  highest: ReplyIntent
  first_at: string
}

/** Highest intent ever reached per conversation; unlike latest reply, this is
 * durable and therefore safe for P3 worklists and filters. */
export function highestIntentByLead(messages: Message[]): Map<string, ConversationIntentInfo> {
  const map = new Map<string, ConversationIntentInfo>()
  for (const m of messages) {
    if (m.direction !== 'in' || !m.intent_level) continue
    const k = leadKey(m.instance_id, m.profile_url)
    const prev = map.get(k)
    if (
      !prev ||
      INTENT_RANK[m.intent_level] > INTENT_RANK[prev.highest] ||
      (m.intent_level === prev.highest && m.sent_at < prev.first_at)
    ) {
      map.set(k, { highest: m.intent_level, first_at: m.sent_at })
    }
  }
  return map
}

export type Stage = 'queued' | 'invited' | 'accepted' | 'replied'

export const STAGES: Array<{ id: Stage; label: string; color: string }> = [
  { id: 'queued', label: 'Queued', color: '#7c89a8' },
  { id: 'invited', label: 'Invited', color: '#4f8ef7' },
  { id: 'accepted', label: 'Accepted', color: '#34c98e' },
  { id: 'replied', label: 'Replied', color: '#f7b94f' },
]

export function stageOf(l: Lead): Stage {
  if (l.replied_at) return 'replied'
  if (l.connected_at) return 'accepted'
  if (l.invited_at) return 'invited'
  return 'queued'
}

export const stageMeta = (s: Stage) => STAGES.find((x) => x.id === s)!

export function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000
  return d < 0 ? null : d
}

/** Monday (UTC) of the week containing ts, as YYYY-MM-DD. */
export function weekStart(ts: string): string {
  const d = new Date(ts)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

/** Continuous Mondays from `from` through the current week, so quiet weeks
 *  show as zero instead of vanishing from a chart's x-axis. */
export function weekRange(from: string): string[] {
  const out: string[] = []
  const last = weekStart(new Date().toISOString())
  for (const d = new Date(`${from}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 7)) {
    const week = d.toISOString().slice(0, 10)
    if (week > last) break
    out.push(week)
  }
  return out
}

/** Continuous days from `from` through today (UTC), so quiet days show as
 *  zero instead of vanishing from a chart's x-axis. */
export function dayRange(from: string): string[] {
  const out: string[] = []
  const last = new Date().toISOString().slice(0, 10)
  for (const d = new Date(`${from}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10)
    if (day > last) break
    out.push(day)
  }
  return out
}

export function lastWeeks(n: number): string[] {
  const out: string[] = []
  const monday = new Date(weekStart(new Date().toISOString()))
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(monday)
    d.setUTCDate(d.getUTCDate() - i * 7)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

export type RiskFlag = 'pending_2w' | 'no_reply_2w'

export const RISK_LABEL: Record<RiskFlag, string> = {
  pending_2w: 'pending 14d+',
  no_reply_2w: 'no reply 14d+',
}

/** pending_2w: invite unanswered ≥14d (withdrawal candidate);
 *  no_reply_2w: accepted ≥14d ago, never replied (follow-up candidate). */
export function riskOf(l: Lead): RiskFlag | null {
  const cutoff = Date.now() - 14 * 86_400_000
  if (l.invited_at && !l.connected_at && new Date(l.invited_at).getTime() < cutoff)
    return 'pending_2w'
  if (l.connected_at && !l.replied_at && new Date(l.connected_at).getTime() < cutoff)
    return 'no_reply_2w'
  return null
}

/** Re-derive per-day activity rows from lead milestones (same shape as the
 *  daily_activity view) so charts can be scoped to any lead subset. */
export function leadsToActivity(leads: Lead[]): DailyActivity[] {
  const counts = new Map<string, DailyActivity>()
  const add = (l: Lead, ts: string | null, event_type: string) => {
    if (!ts) return
    const day = ts.slice(0, 10)
    const key = `${day}|${l.instance_id}|${event_type}`
    const row = counts.get(key) ?? { day, instance_id: l.instance_id, event_type, cnt: 0 }
    row.cnt += 1
    counts.set(key, row)
  }
  for (const l of leads) {
    add(l, l.invited_at, 'invite_sent')
    add(l, l.connected_at, 'invite_accepted')
    add(l, l.replied_at, 'reply_received')
  }
  return [...counts.values()]
}

/** Leads bucketed by UTC day of added_at; undated = rows with NULL added_at
 *  (unknown add date, not "never added"). */
export function addedByDay(leads: Lead[]): { byDay: Map<string, number>; undated: number } {
  const byDay = new Map<string, number>()
  let undated = 0
  for (const l of leads) {
    if (!l.added_at) {
      undated++
      continue
    }
    const day = l.added_at.slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }
  return { byDay, undated }
}

/** Leads each LinkedIn account can safely add per week. LinkedIn's real limit is
 *  a rolling ~200/week; kept as a code constant (per-account overrides were
 *  dropped in migration 006). */
export const WEEKLY_ADD_LIMIT = 200

/** A lead's add date: added_at when known, else the earliest non-null milestone
 *  (rows synced before added_at existed carry only a backfilled approximation —
 *  hence the fallback). null = no dated activity at all. */
function addedDate(l: Lead): string | null {
  if (l.added_at) return l.added_at
  let earliest: string | null = null
  for (const ts of [l.invited_at, l.connected_at, l.first_message_at, l.replied_at]) {
    if (ts && (!earliest || ts < earliest)) earliest = ts
  }
  return earliest
}

/** How many of one account's leads were added within the current calendar week
 *  (Mon–Sun, UTC), for the 200/week capacity gauge. Uses each lead's add date
 *  (added_at ?? earliest milestone), so it degrades gracefully for rows that
 *  predate the added_at column. */
export function weeklyAdded(leads: Lead[], instanceId: string): number {
  const thisWeek = weekStart(new Date().toISOString())
  let count = 0
  for (const l of leads) {
    if (l.instance_id !== instanceId) continue
    const added = addedDate(l)
    if (added && weekStart(added) === thisWeek) count++
  }
  return count
}

export function toCsv(rows: Array<Record<string, string | number | null>>): string {
  if (rows.length === 0) return ''
  const cols = Object.keys(rows[0])
  const cell = (v: string | number | null) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

// --- Date ranges --------------------------------------------------------
// Inclusive [from, to] day strings (YYYY-MM-DD); null = open end. All math is
// in UTC to match the day slices used by the activity view and lead milestones.
export interface DateRange {
  id: string
  label: string
  from: string | null
  to: string | null
}

const dayStr = (d: Date) => d.toISOString().slice(0, 10)

/** Prebuilt ranges relative to `now` (defaults to today). */
export function presetRanges(now: Date = new Date()): DateRange[] {
  const today = dayStr(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  const shift = (base: string, n: number) => {
    const d = new Date(`${base}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + n)
    return dayStr(d)
  }
  const thisWeek = weekStart(now.toISOString())
  const y = now.getUTCFullYear()
  const mo = now.getUTCMonth()
  const monthStart = (yr: number, m: number) => `${yr}-${pad(m + 1)}-01`
  const monthEnd = (yr: number, m: number) => dayStr(new Date(Date.UTC(yr, m + 1, 0)))
  const prevY = mo === 0 ? y - 1 : y
  const prevM = mo === 0 ? 11 : mo - 1
  return [
    { id: 'today', label: 'Today', from: today, to: today },
    { id: 'this_week', label: 'This week', from: thisWeek, to: today },
    { id: 'last_week', label: 'Last week', from: shift(thisWeek, -7), to: shift(thisWeek, -1) },
    { id: 'this_month', label: 'This month', from: monthStart(y, mo), to: today },
    { id: 'last_month', label: 'Last month', from: monthStart(prevY, prevM), to: monthEnd(prevY, prevM) },
    { id: '3_months', label: '3 months', from: shift(today, -89), to: today },
    { id: 'all', label: 'All time', from: null, to: null },
  ]
}

/** The open-ended range covering everything — the default when a hypothesis
 *  funnel is shown without an explicit date filter. */
export const ALL_TIME_RANGE: DateRange = { id: 'all', label: 'All time', from: null, to: null }

/** The equal-length window immediately before `r`, for range-over-range deltas.
 *  Null when `r` has an open end — an all-time range has no comparable prior
 *  period. Purely date arithmetic; it doesn't touch funnel semantics. */
export function previousRange(r: DateRange): DateRange | null {
  if (!r.from || !r.to) return null
  const days =
    Math.round(
      (new Date(`${r.to}T00:00:00Z`).getTime() - new Date(`${r.from}T00:00:00Z`).getTime()) /
        86_400_000,
    ) + 1
  const shift = (base: string, n: number) => {
    const d = new Date(`${base}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + n)
    return dayStr(d)
  }
  return {
    id: `${r.id}_prev`,
    label: `Previous ${days}d`,
    from: shift(r.from, -days),
    to: shift(r.from, -1),
  }
}

const ddmmyyyy = (day: string) => {
  const [y, m, d] = day.split('-')
  return `${d}.${m}.${y}`
}

/** Serialize a DateRange to a compact URL param value: a preset keeps its id;
 *  a custom range becomes "from~to" (either side may be empty for an open end). */
export function rangeToParam(r: DateRange): string {
  if (r.id !== 'custom') return r.id
  return `${r.from ?? ''}~${r.to ?? ''}`
}

/** Resolve a URL param back to a DateRange: a known preset id, else a "from~to"
 *  custom range, else null (caller supplies its own default). Labels are rebuilt
 *  so the trigger/flow labels stay meaningful after a refresh or shared link. */
export function rangeFromParam(v: string | null, presets: DateRange[]): DateRange | null {
  if (!v) return null
  const preset = presets.find((p) => p.id === v)
  if (preset) return preset
  if (!v.includes('~')) return null
  const [rawFrom, rawTo] = v.split('~')
  const from = rawFrom || null
  const to = rawTo || null
  if (!from && !to) return null
  const label =
    from && to ? `${ddmmyyyy(from)} – ${ddmmyyyy(to)}`
      : from ? `since ${ddmmyyyy(from)}`
        : `until ${ddmmyyyy(to!)}`
  return { id: 'custom', label, from, to }
}

export function tsInRange(ts: string | null, r: DateRange): boolean {
  if (!ts) return false
  const day = ts.slice(0, 10)
  if (r.from && day < r.from) return false
  if (r.to && day > r.to) return false
  return true
}

const INTENT_RANK: Record<ReplyIntent, number> = { p1: 1, p2: 2, p3: 3 }
const DAY_MS = 86_400_000

export interface ReplyIntentMetrics {
  /** Conversations first reaching each level inside the selected range. */
  p1: number
  p2: number
  p3: number
  /** Recorded call bookings whose timestamp is strictly after first P3. */
  p3Booked: number
  p3BookingRate: number | null
  /** P3 cohorts at least 14 days old and their post-P3 bookings. */
  matureP3: number
  matureP3Booked: number
  matureP3BookingRate: number | null
  /** P3 + post-P3 outbound + 30d silence + no later booking. */
  p3Ghosted: number
  p3GhostingRate: number | null
}

interface FirstIntent {
  at: string
  campaignId: string | null
}

/**
 * Conversation-scoped P1/P2/P3 outcomes. The first intent timestamp is durable:
 * later lower-intent messages never erase P3. Campaign attribution is fixed to
 * the campaign carried by the first message at that level.
 */
export function replyIntentMetrics(
  leads: Lead[],
  messages: Message[],
  pipelineEvents: PipelineEvent[],
  range: DateRange,
  opts: {
    instanceId?: string
    campaignId?: string
    now?: Date
    intentRows?: ConversationReplyIntent[]
  } = {},
): ReplyIntentMetrics {
  const first = new Map<string, Partial<Record<ReplyIntent, FirstIntent>>>()
  for (const m of messages) {
    if (m.direction !== 'in' || !m.intent_level) continue
    const k = leadKey(m.instance_id, m.profile_url)
    const levels = first.get(k) ?? {}
    const prev = levels[m.intent_level]
    if (!prev || m.sent_at < prev.at) {
      levels[m.intent_level] = { at: m.sent_at, campaignId: m.campaign_id }
      first.set(k, levels)
    }
  }
  // The view sees the complete thread and is authoritative when available.
  for (const row of opts.intentRows ?? []) {
    const k = leadKey(row.instance_id, row.profile_url)
    const levels = first.get(k) ?? {}
    if (row.first_p3_at) {
      levels.p3 = {
        at: row.first_p3_at,
        campaignId: row.first_p3_campaign_id,
      }
    }
    first.set(k, levels)
  }
  const intentRowByKey = new Map(
    (opts.intentRows ?? []).map((row) => [leadKey(row.instance_id, row.profile_url), row]),
  )

  const inScope = (key: string, hit: FirstIntent) => {
    const sep = key.indexOf('|')
    const instanceId = key.slice(0, sep)
    if (opts.instanceId && instanceId !== opts.instanceId) return false
    if (opts.campaignId && hit.campaignId !== opts.campaignId) return false
    return tsInRange(hit.at, range)
  }

  const cohorts: Record<ReplyIntent, Map<string, FirstIntent>> = {
    p1: new Map(),
    p2: new Map(),
    p3: new Map(),
  }
  for (const [k, levels] of first) {
    for (const level of Object.keys(INTENT_RANK) as ReplyIntent[]) {
      const hit = levels[level]
      if (hit && inScope(k, hit)) cohorts[level].set(k, hit)
    }
  }

  const leadById = new Map(leads.map((l) => [l.id, l]))
  const bookingTimes = new Map<string, string[]>()
  const rememberBooking = (k: string, at: string | null) => {
    if (!at) return
    const rows = bookingTimes.get(k)
    if (rows) rows.push(at)
    else bookingTimes.set(k, [at])
  }
  for (const e of pipelineEvents) {
    if (e.kind !== 'stage' || e.to_stage !== 'call_booked') continue
    const l = leadById.get(e.lead_id)
    if (l) rememberBooking(leadKey(l.instance_id, l.profile_url), e.occurred_at)
  }
  // Compatibility for rows staged before pipeline_events existed.
  for (const l of leads) {
    if (l.pipeline_stage === 'call_booked')
      rememberBooking(leadKey(l.instance_id, l.profile_url), l.pipeline_stage_changed_at)
  }

  const threadMessages = new Map<string, Message[]>()
  for (const m of messages) {
    const k = leadKey(m.instance_id, m.profile_url)
    const arr = threadMessages.get(k)
    if (arr) arr.push(m)
    else threadMessages.set(k, [m])
  }

  const now = opts.now ?? new Date()
  const matureCutoff = now.getTime() - 14 * DAY_MS
  const ghostCutoff = now.getTime() - 30 * DAY_MS
  let p3Booked = 0
  let matureP3 = 0
  let matureP3Booked = 0
  let p3Ghosted = 0

  for (const [k, p3] of cohorts.p3) {
    const bookedAfterP3 = (bookingTimes.get(k) ?? []).some((at) => at > p3.at)
    if (bookedAfterP3) p3Booked++
    if (Date.parse(p3.at) <= matureCutoff) {
      matureP3++
      if (bookedAfterP3) matureP3Booked++
    }

    if (bookedAfterP3) continue
    const thread = threadMessages.get(k) ?? []
    const projection = intentRowByKey.get(k)
    let lastOutboundAfterP3: string | null = projection?.last_out_after_p3_at ?? null
    if (!projection) {
      for (const m of thread) {
        if (m.direction === 'out' && m.sent_at > p3.at && (!lastOutboundAfterP3 || m.sent_at > lastOutboundAfterP3))
          lastOutboundAfterP3 = m.sent_at
      }
    }
    if (!lastOutboundAfterP3 || Date.parse(lastOutboundAfterP3) > ghostCutoff) continue
    const repliedAfterFollowUp = projection
      ? !!projection.last_in_after_p3_at && projection.last_in_after_p3_at > lastOutboundAfterP3
      : thread.some((m) => m.direction === 'in' && m.sent_at > lastOutboundAfterP3!)
    if (!repliedAfterFollowUp) p3Ghosted++
  }

  const p3 = cohorts.p3.size
  const pctOrNull = (n: number, d: number) => (d > 0 ? (100 * n) / d : null)
  return {
    p1: cohorts.p1.size,
    p2: cohorts.p2.size,
    p3,
    p3Booked,
    p3BookingRate: pctOrNull(p3Booked, p3),
    matureP3,
    matureP3Booked,
    matureP3BookingRate: pctOrNull(matureP3Booked, matureP3),
    p3Ghosted,
    p3GhostingRate: pctOrNull(p3Ghosted, p3),
  }
}

export interface Totals {
  leads: number
  invites: number
  accepted: number
  replies: number
  /** Replies whose latest inbound message classified as 'positive'. Only
   *  counted when a latest-replies map is supplied (else 0). */
  positive: number
  /** Rate numerators mirroring the campaign_metrics view (migrations 019/030):
   *  acceptedOfInvited = connected-in-range leads whose invite exists
   *  (invited_at not null); repliedOfConnected = replied-in-range leads whose
   *  connection exists (connected_at not null). The displayed counts above stay
   *  totals; only the RATE numerators carry the constraint, so a lead connected
   *  in-range but invited earlier no longer pushes a rate past 100%. */
  acceptedOfInvited: number
  repliedOfConnected: number
}

/** Event flows within `r` (invites/accepted/replies counted by the day their
 *  milestone landed). `leads` is the snapshot count of the input set (not
 *  range-scoped — pipeline size is a current-state metric). When `latest` is
 *  given, also count replies in range whose latest inbound message is positive
 *  (so positive ≤ replies always holds). */
export function rangeTotals(
  leads: Lead[],
  r: DateRange,
  latest?: Map<string, ReplyInfo>,
): Totals {
  let invites = 0
  let accepted = 0
  let replies = 0
  let positive = 0
  let acceptedOfInvited = 0
  let repliedOfConnected = 0
  for (const l of leads) {
    if (tsInRange(l.invited_at, r)) invites++
    if (tsInRange(l.connected_at, r)) {
      accepted++
      // Acceptance-rate numerator counts connected leads only where the invite
      // exists — matches campaign_metrics view (migrations 019/030).
      if (l.invited_at) acceptedOfInvited++
    }
    if (tsInRange(l.replied_at, r)) {
      replies++
      // Reply-rate numerator counts replied leads only where the connection
      // exists — matches campaign_metrics view (migrations 019/030).
      if (l.connected_at) repliedOfConnected++
      if (latest?.get(leadKey(l.instance_id, l.profile_url))?.sentiment === 'positive')
        positive++
    }
  }
  return { leads: leads.length, invites, accepted, replies, positive, acceptedOfInvited, repliedOfConnected }
}

export interface AccountStats extends Totals {
  acceptPct: string
  replyPct: string
}

/** Totals for one account's leads scoped to `r`, with display-ready rates
 *  (acceptance of invites in range, replies of accepted in range). */
export function accountStats(
  leads: Lead[],
  r: DateRange,
  latest?: Map<string, ReplyInfo>,
): AccountStats {
  const t = rangeTotals(leads, r, latest)
  const pct = (a: number, b: number) => (b > 0 ? ((100 * a) / b).toFixed(1) + '%' : '—')
  // Rate numerators are the constrained counts (connected-with-invite,
  // replied-with-connect) to match campaign_metrics view (migrations 019/030);
  // denominators stay the in-range totals.
  return {
    ...t,
    acceptPct: pct(t.acceptedOfInvited, t.invites),
    replyPct: pct(t.repliedOfConnected, t.accepted),
  }
}

const WARM_SENTIMENTS: Sentiment[] = ['objection', 'referral']

/** A warm-reply lead whose thread has no manually-imported messages, so what
 *  happened after the reply is invisible — an "import history" candidate. */
export interface BlindSpotLead {
  lead: Lead
  reply: ReplyInfo
}

/** Leads whose conversation reached P2/P3 (or has a referral/objection) but
 *  whose thread (by leadKey) carries ZERO manually-imported messages
 *  (messages.source === 'manual', counted across both directions). LH2 stops
 *  capturing once the SDR takes the thread over by hand, so these warm threads
 *  are sync-only — their post-reply state is unknown until the SDR imports the
 *  history. Sorted by follow-up priority (P3 > P2 > objection > referral), then
 *  newest reply first. Reuses latestRepliesByLead (`messages` must be sorted
 *  desc, as DataContext fetches them). */
export function blindSpotLeads(leads: Lead[], messages: Message[]): BlindSpotLead[] {
  const latest = latestRepliesByLead(messages)
  const manualKeys = new Set<string>()
  for (const m of messages) {
    if (m.source === 'manual') manualKeys.add(leadKey(m.instance_id, m.profile_url))
  }
  const priority = (r: ReplyInfo) => {
    if (r.highest_intent === 'p3') return 0
    if (r.highest_intent === 'p2') return 1
    if (r.sentiment === 'objection') return 2
    if (r.sentiment === 'referral') return 3
    // Migration-lag compatibility before the historical intent backfill drains.
    if (!r.highest_intent && r.sentiment === 'positive') return 4
    return 99
  }
  const out: BlindSpotLead[] = []
  for (const l of leads) {
    const k = leadKey(l.instance_id, l.profile_url)
    const reply = latest.get(k)
    if (!reply) continue
    const warm =
      reply.highest_intent === 'p2' ||
      reply.highest_intent === 'p3' ||
      (!!reply.sentiment && WARM_SENTIMENTS.includes(reply.sentiment)) ||
      (!reply.highest_intent && reply.sentiment === 'positive')
    if (!warm) continue
    if (manualKeys.has(k)) continue
    out.push({ lead: l, reply })
  }
  out.sort(
    (a, b) =>
      priority(a.reply) - priority(b.reply) ||
      b.reply.sent_at.localeCompare(a.reply.sent_at),
  )
  return out
}

/** Per-campaign metrics computed from raw leads scoped to `r`, shaped like the
 *  campaign_metrics view. Names/instance pulled from `base` (the all-time view
 *  rows). Sorted by invites in range, then name. */
export function rangedCampaigns(
  leads: Lead[],
  base: CampaignMetrics[],
  r: DateRange,
): CampaignMetrics[] {
  const meta = new Map(base.map((c) => [c.campaign_id, c]))
  type Acc = {
    added: number; invites: number; accepted: number; replies: number
    // Rate numerators, constrained like the campaign_metrics view (see below).
    acceptedOfInvited: number; repliedOfConnected: number
    total: number; last: string | null
  }
  const acc = new Map<string, Acc>()
  for (const l of leads) {
    let row = acc.get(l.campaign_id)
    if (!row) {
      row = { added: 0, invites: 0, accepted: 0, replies: 0, acceptedOfInvited: 0, repliedOfConnected: 0, total: 0, last: null }
      acc.set(l.campaign_id, row)
    }
    row.total++
    // last_activity_at is the campaign's TRUE most-recent milestone (matching the
    // all-time campaign_metrics view it stands in for), independent of the range
    // filter — which only scopes the invite/accept/reply counts.
    const touch = (ts: string | null) => {
      if (ts && (!row!.last || ts > row!.last)) row!.last = ts
    }
    if (tsInRange(l.added_at, r)) row.added++
    if (tsInRange(l.invited_at, r)) row.invites++
    if (tsInRange(l.connected_at, r)) {
      row.accepted++
      if (l.invited_at) row.acceptedOfInvited++
    }
    if (tsInRange(l.replied_at, r)) {
      row.replies++
      if (l.connected_at) row.repliedOfConnected++
    }
    touch(l.invited_at)
    touch(l.connected_at)
    touch(l.replied_at)
  }
  const out: CampaignMetrics[] = []
  for (const [cid, row] of acc) {
    const m = meta.get(cid)
    out.push({
      campaign_id: cid,
      campaign_name: m?.campaign_name ?? cid,
      instance_id: m?.instance_id ?? '',
      status: m?.status ?? '',
      total_leads: row.total,
      leads_added: row.added,
      invites_sent: row.invites,
      accepted: row.accepted,
      replies: row.replies,
      // Constrained numerators (connected-with-invite, replied-with-connect)
      // over the total denominators — matches campaign_metrics view
      // (migrations 019/030), so displayed counts stay totals but rates ≤ 100%.
      acceptance_rate: row.invites > 0 ? (100 * row.acceptedOfInvited) / row.invites : null,
      reply_rate: row.accepted > 0 ? (100 * row.repliedOfConnected) / row.accepted : null,
      last_activity_at: row.last,
    })
  }
  out.sort((a, b) => b.invites_sent - a.invites_sent || a.campaign_name.localeCompare(b.campaign_name))
  return out
}

// --- Hypothesis rollups (see migration 043) -----------------------------
// A hypothesis's stats span MULTIPLE campaigns, so the same person can appear
// more than once (cross-campaign person duplication is a known hazard — see
// messenger-campaign-person-dupes / invite-count-leads-dedup memories). Every
// aggregate below dedupes by leadKey before counting.

/** One synthetic Lead per person (leadKey), merging milestone timestamps across
 *  all of their rows into the EARLIEST non-null occurrence of each — so a person
 *  invited via one campaign and only messaged via another still shows one honest
 *  funnel, instead of either double-counting them or silently dropping a
 *  milestone that happened on a row that wasn't picked. Feeds straight into
 *  rangeTotals. Non-milestone display fields (full_name, headline, …) come from
 *  whichever row is seen first — arbitrary, display-only. */
function dedupeByPerson(leads: Lead[]): Lead[] {
  const earliest = (a: string | null, b: string | null) =>
    a == null ? b : b == null ? a : a < b ? a : b
  const byKey = new Map<string, Lead>()
  for (const l of leads) {
    const k = leadKey(l.instance_id, l.profile_url)
    const prev = byKey.get(k)
    if (!prev) {
      byKey.set(k, l)
      continue
    }
    byKey.set(k, {
      ...prev,
      added_at: earliest(prev.added_at, l.added_at),
      invited_at: earliest(prev.invited_at, l.invited_at),
      connected_at: earliest(prev.connected_at, l.connected_at),
      first_message_at: earliest(prev.first_message_at, l.first_message_at),
      replied_at: earliest(prev.replied_at, l.replied_at),
    })
  }
  return [...byKey.values()]
}

/** The campaign_ids currently assigned to one hypothesis. */
function campaignIdsOf(hyp: Hypothesis, hypCampaigns: HypothesisCampaign[]): Set<string> {
  return new Set(
    hypCampaigns.filter((hc) => hc.hypothesis_id === hyp.id).map((hc) => hc.campaign_id),
  )
}

/** Funnel totals for one hypothesis, deduped by leadKey across its campaigns
 *  (decision 6) — a person present in two of the hypothesis's campaigns counts
 *  once, at their earliest milestone per stage. Defaults to ALL_TIME_RANGE. */
export function hypothesisTotals(
  hyp: Hypothesis,
  hypCampaigns: HypothesisCampaign[],
  leads: Lead[],
  range: DateRange = ALL_TIME_RANGE,
  latest?: Map<string, ReplyInfo>,
): Totals {
  const ids = campaignIdsOf(hyp, hypCampaigns)
  const scoped = leads.filter((l) => ids.has(l.campaign_id))
  return rangeTotals(dedupeByPerson(scoped), range, latest)
}

/** Per-campaign breakdown for one hypothesis (which of its campaigns drive
 *  results) — NOT deduped: each campaign reports its own leads, and one person
 *  can legitimately count in more than one row here even though the hypothesis
 *  TOTAL above counts them once. */
export function hypothesisCampaignBreakdown(
  hyp: Hypothesis,
  hypCampaigns: HypothesisCampaign[],
  leads: Lead[],
  base: CampaignMetrics[],
  range: DateRange = ALL_TIME_RANGE,
): CampaignMetrics[] {
  const ids = campaignIdsOf(hyp, hypCampaigns)
  const scoped = leads.filter((l) => ids.has(l.campaign_id))
  const scopedBase = base.filter((c) => ids.has(c.campaign_id))
  return rangedCampaigns(scoped, scopedBase, range)
}

// --- Demographics + photos ----------------------------------------------
// Age is arithmetic from inferred birth-year bounds; gender is inferred (Haiku)
// or SDR-confirmed. Both may be absent on a pre-migration DB (LEAD_COLUMNS
// ladder drops the rung) — every helper is null-safe. `unknown` gender and
// unknown age are first-class values, never a failure state. All year math is
// in UTC to match the rest of this module.

/** Public URL for a lead's synced profile photo, or null when there's no photo
 *  (or Supabase isn't configured). The `lead-photos` bucket is public (these
 *  avatars are already public on LinkedIn), so no signing/auth is needed.
 *  Display only — photos are never an inference input. */
export function leadPhotoUrl(lead: Lead): string | null {
  const path = lead.photo_path
  if (!path) return null
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined
  if (!base) return null
  return `${base}/storage/v1/object/public/lead-photos/${path}`
}

/** A lead's inferred age from the MIDPOINT of its birth-year range (current UTC
 *  year − mid-birth-year), floored to whole years; null when either bound is
 *  missing. Basis for both the age bucket and the campaign histogram. */
export function ageOf(lead: Lead): number | null {
  const lo = lead.birth_year_min
  const hi = lead.birth_year_max
  if (lo == null || hi == null) return null
  return Math.floor(new Date().getUTCFullYear() - (lo + hi) / 2)
}

/** Display age range from a lead's birth-year bounds, e.g. "30–35". The OLDER
 *  age comes from birth_year_min, the YOUNGER from birth_year_max
 *  (age = year − birthYear). Equal bounds collapse to a single number; a null
 *  bound → null (unknown). */
export function ageRange(lead: Lead): string | null {
  const lo = lead.birth_year_min
  const hi = lead.birth_year_max
  if (lo == null || hi == null) return null
  const year = new Date().getUTCFullYear()
  const ageMin = year - hi
  const ageMax = year - lo
  return ageMin === ageMax ? String(ageMin) : `${ageMin}–${ageMax}`
}

/** Coarse age buckets for the LeadsExplorer filter dropdown and grouped charts. */
export type AgeBucket = 'under_25' | '25_34' | '35_44' | '45_54' | '55_plus'

export const AGE_BUCKETS: Array<{ id: AgeBucket; label: string }> = [
  { id: 'under_25', label: '<25' },
  { id: '25_34', label: '25–34' },
  { id: '35_44', label: '35–44' },
  { id: '45_54', label: '45–54' },
  { id: '55_plus', label: '55+' },
]

/** Coarse age bucket for a lead from its birth-year midpoint; null when unknown. */
export function ageBucketOf(lead: Lead): AgeBucket | null {
  const age = ageOf(lead)
  if (age == null) return null
  if (age < 25) return 'under_25'
  if (age < 35) return '25_34'
  if (age < 45) return '35_44'
  if (age < 55) return '45_54'
  return '55_plus'
}

/** Short / long gender display labels, keyed by the stored value. */
export const GENDER_SHORT: Record<Gender, string> = { male: 'M', female: 'F', unknown: '?' }
export const GENDER_LONG: Record<Gender, string> = {
  male: 'Male',
  female: 'Female',
  unknown: 'Unknown',
}

export interface Demographics {
  /** Gender split; `unknown` includes leads with no inferred gender yet. */
  gender: Array<{ id: Gender; label: string; count: number }>
  /** 5-year age buckets from birth-year midpoint, continuous across the observed
   *  span (empty when no lead has an inferred age). */
  ages: Array<{ label: string; count: number }>
  /** Leads (persons) whose age is unknown — surfaced explicitly, never dropped. */
  ageUnknown: number
  /** Unique persons (leadKey-deduped) counted. */
  total: number
}

const GENDER_ORDER: Gender[] = ['female', 'male', 'unknown']

/** Gender split + a 5-year-bucket age histogram over a lead set, deduped by
 *  leadKey so a person present in several campaigns of one account counts once
 *  (memory: notebook-1:4 duplicates people across campaigns). A person's
 *  demographics are read from the first row seen for their leadKey — all of a
 *  person's rows carry the same synced/inferred values. */
export function campaignDemographics(leads: Lead[]): Demographics {
  const seen = new Set<string>()
  const genderCount: Record<Gender, number> = { male: 0, female: 0, unknown: 0 }
  const ages: number[] = []
  let ageUnknown = 0
  let total = 0
  for (const l of leads) {
    const k = leadKey(l.instance_id, l.profile_url)
    if (seen.has(k)) continue
    seen.add(k)
    total++
    genderCount[l.gender ?? 'unknown']++
    const age = ageOf(l)
    if (age == null) ageUnknown++
    else ages.push(age)
  }
  return {
    gender: GENDER_ORDER.map((id) => ({ id, label: GENDER_LONG[id], count: genderCount[id] })),
    ages: ageHistogram5yr(ages),
    ageUnknown,
    total,
  }
}

/** Continuous 5-year buckets ("25–29", "30–34", …) spanning the observed ages,
 *  so quiet buckets in the middle render as zero instead of vanishing. */
function ageHistogram5yr(ages: number[]): Array<{ label: string; count: number }> {
  if (ages.length === 0) return []
  let lo = Infinity
  let hi = -Infinity
  for (const a of ages) {
    if (a < lo) lo = a
    if (a > hi) hi = a
  }
  const start = Math.floor(lo / 5) * 5
  const end = Math.floor(hi / 5) * 5
  const buckets: Array<{ label: string; count: number }> = []
  for (let b = start; b <= end; b += 5) buckets.push({ label: `${b}–${b + 4}`, count: 0 })
  for (const a of ages) {
    const idx = Math.min(buckets.length - 1, Math.floor((a - start) / 5))
    buckets[idx].count++
  }
  return buckets
}
