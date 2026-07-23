// Pure helpers for the Manager Review page. All date math is UTC to match the
// day/week slices used across leads.ts and the SQL views. Nothing here fetches or
// mutates — it re-shapes already-fetched leads/messages into cohort-matured funnel
// comparisons, the sentiment trend, and the CSV / Slack digest payloads.
//
// Funnel semantics are borrowed wholesale from leads.ts (invited_at → connected_at
// → replied_at milestones; the legacy `positive` accumulator now represents a
// durable "ever reached P3" count, so it is not erased by a later lower-intent reply.
// ACCEPT_LAG_SQL in frontend/api/_lib/core.ts: a cohort's rate can't be trusted until
// enough of its invites have had the CHANCE to accept / reply.
import type { CampaignMetrics, Instance, Lead, Message } from './types'
import { instanceName, lastWeeks, leadKey, weekStart } from './leads'
import type { ReplyInfo } from './leads'
import { SENTIMENT_ORDER } from './leads'

const DAY_MS = 86_400_000
const LAG_WINDOW_DAYS = 90

/** Below this many accepted leads in the 90-day window, the observed lag is too
 *  noisy to derive a maturity threshold from — fall back to fixed weeks. */
const THIN_SAMPLE = 20
const FALLBACK_ACCEPT_WEEKS = 2
const FALLBACK_REPLY_WEEKS = 4

/** A cohort with fewer invites than this has a noisy rate (same convention as
 *  CampaignCompareTable / MessageSequence). */
export const SMALL_COHORT = 30

// --- Lag percentiles -------------------------------------------------------

/** percentile_cont equivalent (linear interpolation between ranks), matching
 *  Postgres' percentile_cont used in ACCEPT_LAG_SQL. `sorted` must be ascending. */
function percentileCont(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const rank = p * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo])
}

function lagDays(leads: Lead[], to: keyof Lead): number[] {
  const cutoff = Date.now() - LAG_WINDOW_DAYS * DAY_MS
  const out: number[] = []
  for (const l of leads) {
    if (!l.invited_at) continue
    const invited = new Date(l.invited_at).getTime()
    if (invited <= cutoff) continue
    const end = l[to] as string | null
    if (!end) continue
    const d = (new Date(end).getTime() - invited) / DAY_MS
    if (d >= 0) out.push(d)
  }
  out.sort((a, b) => a - b)
  return out
}

/** p90 of (connected_at − invited_at) in days, over leads invited in the last 90
 *  days. Mirrors ACCEPT_LAG_SQL. Null when nobody has accepted in the window. */
export function acceptLagP90(leads: Lead[]): number | null {
  return percentileCont(lagDays(leads, 'connected_at'), 0.9)
}

/** p90 of (replied_at − invited_at) in days, over leads invited in the last 90
 *  days. The reply lag is longer than the accept lag — replies keep arriving weeks
 *  after the invite. Null when nobody has replied in the window. */
export function replyLagP90(leads: Lead[]): number | null {
  return percentileCont(lagDays(leads, 'replied_at'), 0.9)
}

export interface MaturityInfo {
  /** Full weeks after its Monday a cohort must age before its ACCEPT rate is trusted. */
  acceptWeeks: number
  /** …before its REPLY / P3 rates are trusted (always ≥ acceptWeeks in practice). */
  replyWeeks: number
  /** Observed p90 lags (days) that drove the thresholds; null when unobservable. */
  p90Accept: number | null
  p90Reply: number | null
  /** Accepted leads in the 90-day window — the sample the p90s rest on. */
  acceptedN: number
  /** True when the sample was too thin and the fixed 2w / 4w fallback was used. */
  thin: boolean
}

/** Derive the accept / reply maturity thresholds from the observed lag. A cohort
 *  week is accept-maturing until ceil(p90_accept / 7) full weeks have passed since
 *  its Monday, reply-maturing until ceil(p90_reply / 7) weeks. With too few accepted
 *  leads to trust the lag, fall back to a fixed 2 weeks (accept) / 4 weeks (reply). */
export function maturityInfo(leads: Lead[]): MaturityInfo {
  const accepted = lagDays(leads, 'connected_at')
  const p90Accept = percentileCont(accepted, 0.9)
  const p90Reply = percentileCont(lagDays(leads, 'replied_at'), 0.9)
  const acceptedN = accepted.length
  const thin = acceptedN < THIN_SAMPLE
  const acceptWeeks =
    thin || p90Accept == null ? FALLBACK_ACCEPT_WEEKS : Math.max(1, Math.ceil(p90Accept / 7))
  let replyWeeks =
    thin || p90Reply == null ? FALLBACK_REPLY_WEEKS : Math.max(1, Math.ceil(p90Reply / 7))
  // Replies lag acceptances, so a cohort can never be reply-mature before it is
  // accept-mature — enforce that ordering rather than merely assuming it.
  replyWeeks = Math.max(replyWeeks, acceptWeeks)
  return { acceptWeeks, replyWeeks, p90Accept, p90Reply, acceptedN, thin }
}

/** Full weeks elapsed since a cohort's Monday (UTC), as of now. */
export function weeksSinceWeek(week: string): number {
  return Math.floor((Date.now() - Date.parse(`${week}T00:00:00Z`)) / (7 * DAY_MS))
}

// --- Cohort matrix ---------------------------------------------------------

export interface CohortCell {
  week: string
  invites: number
  accepted: number
  replied: number
  positive: number
  /** Old enough for its acceptance rate to be trusted. */
  acceptMatured: boolean
  /** Old enough for its reply / positive rates to be trusted. */
  replyMatured: boolean
}

export interface CohortRow {
  campaignId: string
  campaignName: string
  instanceId: string
  /** Cell per week that had ≥1 invite in this campaign (keyed by week Monday). */
  cells: Map<string, CohortCell>
  /** Invites summed across the window — the row sort key. */
  totalInvites: number
}

export interface CohortData {
  /** Continuous Monday columns, oldest → newest. */
  weeks: string[]
  rows: CohortRow[]
  maturity: MaturityInfo
}

const emptyCell = (week: string): CohortCell => ({
  week,
  invites: 0,
  accepted: 0,
  replied: 0,
  positive: 0,
  acceptMatured: false,
  replyMatured: false,
})

/** Per campaign, bucket leads by the week their invite went out over the last
 *  `weeks` weeks; count invites / accepted / replied / P3 per cohort.
 *  The internal `positive` field is retained for digest wire compatibility but
 *  counts durable highest_intent=P3. */
export function cohortRows(
  leads: Lead[],
  campaigns: CampaignMetrics[],
  latestReplies: Map<string, ReplyInfo>,
  weeks: number,
): CohortData {
  const weekList = lastWeeks(weeks)
  const weekSet = new Set(weekList)
  const maturity = maturityInfo(leads)
  const matured = (week: string) => ({
    acceptMatured: weeksSinceWeek(week) >= maturity.acceptWeeks,
    replyMatured: weeksSinceWeek(week) >= maturity.replyWeeks,
  })

  const meta = new Map(campaigns.map((c) => [c.campaign_id, c]))
  const rows = new Map<string, CohortRow>()

  for (const l of leads) {
    if (!l.invited_at) continue
    const week = weekStart(l.invited_at)
    if (!weekSet.has(week)) continue

    let row = rows.get(l.campaign_id)
    if (!row) {
      const m = meta.get(l.campaign_id)
      row = {
        campaignId: l.campaign_id,
        campaignName: m?.campaign_name ?? l.campaign_id,
        instanceId: m?.instance_id ?? l.instance_id,
        cells: new Map(),
        totalInvites: 0,
      }
      rows.set(l.campaign_id, row)
    }

    let cell = row.cells.get(week)
    if (!cell) {
      cell = { ...emptyCell(week), ...matured(week) }
      row.cells.set(week, cell)
    }
    cell.invites++
    row.totalInvites++
    if (l.connected_at) cell.accepted++
    if (l.replied_at) {
      cell.replied++
      if (latestReplies.get(leadKey(l.instance_id, l.profile_url))?.highest_intent === 'p3')
        cell.positive++
    }
  }

  const sorted = [...rows.values()].sort(
    (a, b) => b.totalInvites - a.totalInvites || a.campaignName.localeCompare(b.campaignName),
  )
  return { weeks: weekList, rows: sorted, maturity }
}

/** A cohort is fully matured (every rate trustworthy) once both thresholds pass. */
export const cellFullyMatured = (c: CohortCell) => c.acceptMatured && c.replyMatured

const round1 = (n: number) => Math.round(n * 10) / 10
const ratePct = (num: number, den: number): number | null => (den > 0 ? round1((100 * num) / den) : null)

export const cellAcceptRate = (c: CohortCell) => ratePct(c.accepted, c.invites)
export const cellReplyRate = (c: CohortCell) => ratePct(c.replied, c.accepted)
export const cellPositiveShare = (c: CohortCell) => ratePct(c.positive, c.replied)

// --- Pooled rates (template comparison) ------------------------------------

export interface PooledRates {
  invites: number
  accepted: number
  replied: number
  positive: number
  acceptRate: number | null
  replyRate: number | null
  positiveShare: number | null
}

/** Pooled funnel rates for one campaign's leads over the last `weeks` weeks,
 *  counting only cohorts old enough to trust: accept rate over accept-matured
 *  cohorts, reply / P3 share over reply-matured cohorts. Big cohorts dominate
 *  (Σ ÷ Σ), the honest copy-comparison figure. */
export function pooledMaturedRates(
  leads: Lead[],
  latestReplies: Map<string, ReplyInfo>,
  maturity: MaturityInfo,
  weeks: number,
): PooledRates {
  const weekSet = new Set(lastWeeks(weeks))
  let invA = 0
  let accA = 0
  let accR = 0
  let repR = 0
  let posR = 0
  for (const l of leads) {
    if (!l.invited_at) continue
    const week = weekStart(l.invited_at)
    if (!weekSet.has(week)) continue
    const since = weeksSinceWeek(week)
    if (since >= maturity.acceptWeeks) {
      invA++
      if (l.connected_at) accA++
    }
    if (since >= maturity.replyWeeks) {
      if (l.connected_at) accR++
      if (l.replied_at) {
        repR++
        if (latestReplies.get(leadKey(l.instance_id, l.profile_url))?.highest_intent === 'p3')
          posR++
      }
    }
  }
  return {
    invites: invA,
    accepted: accA,
    replied: repR,
    positive: posR,
    acceptRate: ratePct(accA, invA),
    replyRate: ratePct(repR, accR),
    positiveShare: ratePct(posR, repR),
  }
}

// --- Sentiment trend -------------------------------------------------------

/** All sentiment buckets shown on the trend, in display order, plus unclassified. */
export const TREND_BUCKETS = [...SENTIMENT_ORDER, 'unclassified'] as const
export type TrendBucket = (typeof TREND_BUCKETS)[number]

export interface SentiWeek {
  week: string
  counts: Record<TrendBucket, number>
  total: number
}

/** Inbound replies bucketed by the week they landed, counted per sentiment (plus
 *  `unclassified` for not-yet-classified rows), over the last `weeks` weeks. Filter
 *  to one account / campaign when given. Message times are LH2 action-run times for
 *  synced rows, so the weekly split is approximate — surfaced in the chart footnote. */
export function sentimentTrend(
  messages: Message[],
  opts: { instanceId?: string; campaignId?: string; weeks: number },
): SentiWeek[] {
  const weekList = lastWeeks(opts.weeks)
  const rows = new Map<string, SentiWeek>()
  for (const week of weekList) {
    rows.set(week, {
      week,
      counts: Object.fromEntries(TREND_BUCKETS.map((b) => [b, 0])) as Record<TrendBucket, number>,
      total: 0,
    })
  }
  for (const m of messages) {
    if (m.direction !== 'in') continue
    if (opts.instanceId && m.instance_id !== opts.instanceId) continue
    if (opts.campaignId && m.campaign_id !== opts.campaignId) continue
    const week = weekStart(m.sent_at)
    const row = rows.get(week)
    if (!row) continue
    const bucket: TrendBucket = (m.sentiment ?? 'unclassified') as TrendBucket
    row.counts[bucket] = (row.counts[bucket] ?? 0) + 1
    row.total++
  }
  return weekList.map((w) => rows.get(w)!)
}

export const INTENT_TREND_BUCKETS = ['p1', 'p2', 'p3', 'no_intent', 'unclassified'] as const
export type IntentTrendBucket = (typeof INTENT_TREND_BUCKETS)[number]

export interface IntentWeek {
  week: string
  counts: Record<IntentTrendBucket, number>
  total: number
}

/** Separate P1–P3 trend; never mixes intent levels into sentiment buckets. */
export function intentTrend(
  messages: Message[],
  opts: { instanceId?: string; campaignId?: string; weeks: number },
): IntentWeek[] {
  const weekList = lastWeeks(opts.weeks)
  const rows = new Map<string, IntentWeek>()
  for (const week of weekList) {
    rows.set(week, {
      week,
      counts: Object.fromEntries(INTENT_TREND_BUCKETS.map((b) => [b, 0])) as Record<IntentTrendBucket, number>,
      total: 0,
    })
  }
  for (const m of messages) {
    if (m.direction !== 'in') continue
    if (opts.instanceId && m.instance_id !== opts.instanceId) continue
    if (opts.campaignId && m.campaign_id !== opts.campaignId) continue
    const row = rows.get(weekStart(m.sent_at))
    if (!row) continue
    const bucket: IntentTrendBucket =
      m.intent_level ?? (m.intent_taxonomy_version ? 'no_intent' : 'unclassified')
    row.counts[bucket]++
    row.total++
  }
  return weekList.map((w) => rows.get(w)!)
}

// --- CSV export ------------------------------------------------------------

/** Long-format CSV: one row per (campaign, cohort week) that had invites. Rates
 *  are raw numbers (one decimal) regardless of maturity; the `matured` column
 *  flags whether every rate on the row is old enough to trust. */
export function reviewCsvRows(
  data: CohortData,
  instances: Instance[],
): Array<Record<string, string | number | null>> {
  const nameOf = (id: string) => instanceName(instances.find((i) => i.id === id), id)
  const out: Array<Record<string, string | number | null>> = []
  for (const row of data.rows) {
    for (const week of data.weeks) {
      const cell = row.cells.get(week)
      if (!cell || cell.invites === 0) continue
      out.push({
        campaign: row.campaignName,
        account: nameOf(row.instanceId),
        cohort_week: week,
        invites: cell.invites,
        accepted: cell.accepted,
        accept_rate: cellAcceptRate(cell),
        replied: cell.replied,
        reply_rate: cellReplyRate(cell),
        p3_intent: cell.positive,
        p3_share: cellPositiveShare(cell),
        matured: cellFullyMatured(cell) ? 'yes' : 'no',
      })
    }
  }
  return out
}

// --- Slack digest ----------------------------------------------------------

export interface DigestRow {
  campaign: string
  account: string
  invites: number
  accept_rate: number | null
  reply_rate: number | null
  positive_share: number | null
  /** Percentage-point change vs the campaign's prior matured cohort; null if none. */
  d_accept: number | null
  d_reply: number | null
}

export interface DigestPayload {
  cohort_week: string
  scope: string
  maturity_note: string
  totals: { invites: number; accepted: number; replied: number; positive: number }
  rows: DigestRow[]
}

const DIGEST_ROW_CAP = 30

/** The most recent cohort week (in the window) that is fully matured, or null when
 *  every cohort is still too fresh to judge. */
export function latestMaturedWeek(data: CohortData): string | null {
  for (let i = data.weeks.length - 1; i >= 0; i--) {
    const w = data.weeks[i]
    if (weeksSinceWeek(w) >= data.maturity.acceptWeeks && weeksSinceWeek(w) >= data.maturity.replyWeeks)
      return w
  }
  return null
}

/** Build the Slack digest: per-campaign snapshot of its most recent fully-matured
 *  cohort with pct-point WoW deltas vs the prior matured cohort, plus pooled totals
 *  across every matured cohort in range. Returns null when nothing has matured yet. */
export function buildDigest(
  data: CohortData,
  instances: Instance[],
  scope: string,
): DigestPayload | null {
  const cohortWeek = latestMaturedWeek(data)
  if (!cohortWeek) return null
  const nameOf = (id: string) => instanceName(instances.find((i) => i.id === id), id)
  const { acceptWeeks, replyWeeks } = data.maturity

  const totals = { invites: 0, accepted: 0, replied: 0, positive: 0 }
  const rows: DigestRow[] = []

  for (const row of data.rows) {
    // This campaign's matured cohorts, oldest → newest.
    const matured = data.weeks
      .map((w) => row.cells.get(w))
      .filter((c): c is CohortCell => !!c && c.invites > 0 && cellFullyMatured(c))
    for (const c of matured) {
      totals.invites += c.invites
      totals.accepted += c.accepted
      totals.replied += c.replied
      totals.positive += c.positive
    }
    if (matured.length === 0) continue
    const cur = matured[matured.length - 1]
    const prior = matured.length > 1 ? matured[matured.length - 2] : null
    const delta = (a: number | null, b: number | null): number | null =>
      a == null || b == null ? null : round1(a - b)
    rows.push({
      campaign: row.campaignName,
      account: nameOf(row.instanceId),
      invites: cur.invites,
      accept_rate: cellAcceptRate(cur),
      reply_rate: cellReplyRate(cur),
      positive_share: cellPositiveShare(cur),
      d_accept: prior ? delta(cellAcceptRate(cur), cellAcceptRate(prior)) : null,
      d_reply: prior ? delta(cellReplyRate(cur), cellReplyRate(prior)) : null,
    })
  }

  rows.sort((a, b) => b.invites - a.invites || a.campaign.localeCompare(b.campaign))
  return {
    cohort_week: cohortWeek,
    scope,
    maturity_note: `cohorts < ${acceptWeeks}w (accept) / < ${replyWeeks}w (reply) excluded — still maturing`,
    totals,
    rows: rows.slice(0, DIGEST_ROW_CAP),
  }
}
