// Client-side analysis helpers over the raw leads table. All milestone logic
// mirrors the agent's derive_events: invited_at / connected_at / replied_at
// are the source of truth for funnel stages.
import type { CampaignMetrics, DailyActivity, Instance, Lead } from './types'

/** Display name for an instance: real LinkedIn account name when synced,
 *  else the configured label, else the raw id. */
export function instanceName(inst: Instance | undefined, fallback = ''): string {
  return inst?.account_name || inst?.label || inst?.id || fallback
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

const SEGMENT_RULES: Array<[string, RegExp]> = [
  ['Founder / Owner', /founder|owner|entrepreneur/i],
  ['C-level', /\bceo\b|\bcto\b|\bcoo\b|\bcfo\b|\bcmo\b|\bcio\b|chief/i],
  ['VP / Director / Head', /\bvp\b|vice president|director|head of/i],
  ['Manager / Lead', /manager|\blead\b/i],
  ['Engineering', /engineer|developer|architect|devops/i],
  ['Sales / Marketing', /sales|marketing|growth|business development/i],
  ['Recruiting / HR', /recruit|talent|\bhr\b|people ops/i],
]

export function segmentOf(headline: string | null): string {
  if (headline) {
    for (const [name, re] of SEGMENT_RULES) if (re.test(headline)) return name
  }
  return 'Other / Unknown'
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

export const shortDate = (ts: string | null) => (ts ? ts.slice(0, 10) : '—')

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

export function tsInRange(ts: string | null, r: DateRange): boolean {
  if (!ts) return false
  const day = ts.slice(0, 10)
  if (r.from && day < r.from) return false
  if (r.to && day > r.to) return false
  return true
}

export interface Totals {
  leads: number
  invites: number
  accepted: number
  replies: number
}

/** Event flows within `r` (invites/accepted/replies counted by the day their
 *  milestone landed). `leads` is the snapshot count of the input set (not
 *  range-scoped — pipeline size is a current-state metric). */
export function rangeTotals(leads: Lead[], r: DateRange): Totals {
  let invites = 0
  let accepted = 0
  let replies = 0
  for (const l of leads) {
    if (tsInRange(l.invited_at, r)) invites++
    if (tsInRange(l.connected_at, r)) accepted++
    if (tsInRange(l.replied_at, r)) replies++
  }
  return { leads: leads.length, invites, accepted, replies }
}

export interface AccountStats extends Totals {
  acceptPct: string
  replyPct: string
}

/** Totals for one account's leads scoped to `r`, with display-ready rates
 *  (acceptance of invites in range, replies of accepted in range). */
export function accountStats(leads: Lead[], r: DateRange): AccountStats {
  const t = rangeTotals(leads, r)
  const pct = (a: number, b: number) => (b > 0 ? ((100 * a) / b).toFixed(1) + '%' : '—')
  return { ...t, acceptPct: pct(t.accepted, t.invites), replyPct: pct(t.replies, t.accepted) }
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
  type Acc = { invites: number; accepted: number; replies: number; total: number; last: string | null }
  const acc = new Map<string, Acc>()
  for (const l of leads) {
    let row = acc.get(l.campaign_id)
    if (!row) {
      row = { invites: 0, accepted: 0, replies: 0, total: 0, last: null }
      acc.set(l.campaign_id, row)
    }
    row.total++
    const touch = (ts: string | null) => {
      if (tsInRange(ts, r) && (!row!.last || ts! > row!.last)) row!.last = ts
    }
    if (tsInRange(l.invited_at, r)) row.invites++
    if (tsInRange(l.connected_at, r)) row.accepted++
    if (tsInRange(l.replied_at, r)) row.replies++
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
      invites_sent: row.invites,
      accepted: row.accepted,
      replies: row.replies,
      acceptance_rate: row.invites > 0 ? (100 * row.accepted) / row.invites : null,
      reply_rate: row.accepted > 0 ? (100 * row.replies) / row.accepted : null,
      last_activity_at: row.last,
    })
  }
  out.sort((a, b) => b.invites_sent - a.invites_sent || a.campaign_name.localeCompare(b.campaign_name))
  return out
}
