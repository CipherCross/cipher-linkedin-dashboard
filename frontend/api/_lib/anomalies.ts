// Deterministic anomaly signals for the Morning Briefing. Plain SQL + arithmetic,
// computed BEFORE any model call, so a "declining/stalled/at-risk" claim in the
// briefing can be grounded in a real, pre-verified multi-day pattern instead of a
// model's read of one snapshot. Never model-judged; fail-soft like the seed queries.
import { INVITE_QUEUE_SQL, WEEKLY_FUNNEL_BY_ACCOUNT_SQL, db, executeSql } from './core.js'

export type AnomalySignal = {
  account: string
  instanceId: string
  metric: 'invite_sent' | 'invite_accepted' | 'reply_received' | 'reply_rate'
  kind: 'trend' | 'stall' | 'cohort_decline'
  direction: 'up' | 'down'
  severity: 'high' | 'med'
  detail: string
}

const DAILY_TREND_SQL = `
  select day, instance_id, event_type, cnt
  from daily_activity
  where day > current_date - interval '21 days'
    and event_type in ('invite_sent', 'invite_accepted', 'reply_received')
  order by day
`.trim()

const RECENT_OFFSETS = [1, 2, 3] // t-1..t-3 (today excluded — likely still partial)
const BASELINE_OFFSETS = [4, 5, 6, 7, 8, 9, 10] // t-4..t-10
const TREND_THRESHOLD = 0.3 // relative deviation to flag a sustained move
const HIGH_SEVERITY_THRESHOLD = 0.5
const MIN_BASELINE_AVG = 1 // per day — below this a % deviation is noise, not signal
const MIN_SUSTAINED_DAYS = 2 // of the 3 recent days must individually confirm the move

const COHORT_MATURITY_DAYS = 14 // a cohort needs this long to have had time to reply
const COHORT_BASELINE_SIZE = 4 // trailing mature cohorts to average against
const MIN_COHORT_BASELINE = 2
const MIN_COHORT_ACCEPTED = 5 // skip cohorts too small for a reply-rate % to mean anything
const COHORT_DECLINE_THRESHOLD = 0.25
const COHORT_HIGH_SEVERITY_THRESHOLD = 0.5

function dayString(offset: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - offset)
  return d.toISOString().slice(0, 10)
}

type DailyRow = { day: string; instance_id: string; event_type: string; cnt: number }

function trendAndStallSignals(rows: DailyRow[], accountNames: Map<string, string>): AnomalySignal[] {
  const byKey = new Map<string, Map<string, number>>() // `${instanceId}|${metric}` -> day -> cnt
  for (const r of rows) {
    const key = `${r.instance_id}|${r.event_type}`
    if (!byKey.has(key)) byKey.set(key, new Map())
    byKey.get(key)!.set(r.day, Number(r.cnt))
  }

  const recentDays = RECENT_OFFSETS.map(dayString)
  const baselineDays = BASELINE_OFFSETS.map(dayString)

  const signals: AnomalySignal[] = []
  for (const [key, byDay] of byKey) {
    const [instanceId, metric] = key.split('|')
    const baselineVals = baselineDays.map((d) => byDay.get(d) ?? 0)
    const baselineAvg = baselineVals.reduce((a, b) => a + b, 0) / baselineVals.length
    if (baselineAvg < MIN_BASELINE_AVG) continue // too sparse to say anything meaningful

    const recentVals = recentDays.map((d) => byDay.get(d) ?? 0)
    const account = accountNames.get(instanceId) ?? instanceId

    if (recentVals.every((v) => v === 0)) {
      signals.push({
        account,
        instanceId,
        metric: metric as AnomalySignal['metric'],
        kind: 'stall',
        direction: 'down',
        severity: 'high',
        detail:
          `${metric} stopped entirely for the last 3 days ` +
          `(was averaging ${baselineAvg.toFixed(1)}/day over the prior week)`,
      })
      continue
    }

    const recentAvg = recentVals.reduce((a, b) => a + b, 0) / recentVals.length
    const deviation = (recentAvg - baselineAvg) / baselineAvg
    if (Math.abs(deviation) < TREND_THRESHOLD) continue

    const direction: 'up' | 'down' = deviation > 0 ? 'up' : 'down'
    const sustainedDays = recentVals.filter((v) => {
      const dayDeviation = (v - baselineAvg) / baselineAvg
      return direction === 'up' ? dayDeviation >= TREND_THRESHOLD : dayDeviation <= -TREND_THRESHOLD
    }).length
    if (sustainedDays < MIN_SUSTAINED_DAYS) continue // one noisy day, not a real move

    signals.push({
      account,
      instanceId,
      metric: metric as AnomalySignal['metric'],
      kind: 'trend',
      direction,
      severity: Math.abs(deviation) >= HIGH_SEVERITY_THRESHOLD ? 'high' : 'med',
      detail:
        `${metric} ${direction} ${Math.round(Math.abs(deviation) * 100)}% over the last 3 days vs ` +
        `the prior week (${recentAvg.toFixed(1)}/day vs ${baselineAvg.toFixed(1)}/day baseline)`,
    })
  }
  return signals
}

type CohortRow = {
  instance_id: string
  account: string
  invite_week: string
  invites: number
  accepted: number
  replied: number
  reply_rate_of_accepted: number | null
}

function cohortDeclineSignals(rows: CohortRow[]): AnomalySignal[] {
  const byInstance = new Map<string, CohortRow[]>()
  for (const r of rows) {
    if (!byInstance.has(r.instance_id)) byInstance.set(r.instance_id, [])
    byInstance.get(r.instance_id)!.push(r)
  }

  const maturityCutoff = dayString(COHORT_MATURITY_DAYS) // cohorts starting on/before this date have had time to reply
  const signals: AnomalySignal[] = []
  for (const [instanceId, cohorts] of byInstance) {
    const mature = cohorts
      .filter((c) => c.invite_week <= maturityCutoff && c.accepted >= MIN_COHORT_ACCEPTED)
      .sort((a, b) => (a.invite_week < b.invite_week ? 1 : -1)) // most recent first
    if (mature.length < MIN_COHORT_BASELINE + 1) continue // need latest + a real baseline

    const [latest, ...rest] = mature
    const baseline = rest.slice(0, COHORT_BASELINE_SIZE)
    if (baseline.length < MIN_COHORT_BASELINE) continue

    const baselineAvg =
      baseline.reduce((sum, c) => sum + (c.reply_rate_of_accepted ?? 0), 0) / baseline.length
    if (baselineAvg <= 0) continue

    const latestRate = latest.reply_rate_of_accepted ?? 0
    const decline = (baselineAvg - latestRate) / baselineAvg
    if (decline < COHORT_DECLINE_THRESHOLD) continue

    signals.push({
      account: latest.account,
      instanceId,
      metric: 'reply_rate',
      kind: 'cohort_decline',
      direction: 'down',
      severity: decline >= COHORT_HIGH_SEVERITY_THRESHOLD ? 'high' : 'med',
      detail:
        `reply rate for the cohort invited week of ${latest.invite_week} is ${latestRate}%, vs ` +
        `${baselineAvg.toFixed(1)}% trailing average across the last ${baseline.length} mature cohorts`,
    })
  }
  return signals
}

type QueueRow = {
  campaign_id: string
  campaign: string
  instance_id: string
  account: string
  has_invite_step: boolean
  leads_awaiting_invite: number
  in_pre_invite_warmup: number
  added_last_3d: number
}

/** Append per-campaign invite-queue context to invite_sent declines, so the model
 *  reads the CAUSE (batch still warming up vs out of leads) from a deterministic
 *  source instead of inventing one ("campaign paused"). LH2's runtime state isn't
 *  synced — the queue is the only observable distinction between the two. */
function withInviteQueueContext(signals: AnomalySignal[], queueRows: QueueRow[]): AnomalySignal[] {
  const byInstance = new Map<string, QueueRow[]>()
  for (const r of queueRows) {
    if (!r.has_invite_step) continue // never sends invites (scraping/analysis-only campaign)
    if (!byInstance.has(r.instance_id)) byInstance.set(r.instance_id, [])
    byInstance.get(r.instance_id)!.push(r)
  }
  return signals.map((s) => {
    if (s.metric !== 'invite_sent' || s.direction !== 'down') return s
    const rows = byInstance.get(s.instanceId)
    if (!rows || rows.length === 0) return s
    const parts = rows.map((r) => {
      const waiting = Number(r.leads_awaiting_invite)
      const warming = Number(r.in_pre_invite_warmup)
      if (waiting <= 0) return `${r.campaign}: queue EMPTY (needs new leads, not "reactivation")`
      if (warming > 0)
        return (
          `${r.campaign}: ${waiting} awaiting invite, ${warming} mid pre-invite warm-up ` +
          `(invites expected as warm-up completes — NOT a stopped campaign)`
        )
      return `${r.campaign}: ${waiting} awaiting invite (none mid warm-up yet)`
    })
    return { ...s, detail: `${s.detail}; invite queue — ${parts.join('; ')}` }
  })
}

/** Compute deterministic anomaly signals (sustained trends, stalls, cohort reply-rate
 *  declines). Never throws — a failure here should never break briefing generation. */
export async function computeAnomalySignals(): Promise<AnomalySignal[]> {
  try {
    const [daily, cohorts, instances, queue] = await Promise.all([
      executeSql(DAILY_TREND_SQL),
      executeSql(WEEKLY_FUNNEL_BY_ACCOUNT_SQL),
      db().from('instances').select('id, account_name, label'),
      // Enrichment only — a queue failure must never suppress the signals themselves.
      executeSql(INVITE_QUEUE_SQL).catch((e) => {
        console.error('invite queue query failed:', e instanceof Error ? e.message : String(e))
        return { rows: [] as unknown[], rowCount: 0, truncated: false }
      }),
    ])
    const accountNames = new Map<string, string>()
    for (const i of instances.data ?? []) {
      accountNames.set(i.id, i.account_name || i.label || i.id)
    }
    const signals = [
      ...trendAndStallSignals(daily.rows as DailyRow[], accountNames),
      ...cohortDeclineSignals(cohorts.rows as CohortRow[]),
    ]
    return withInviteQueueContext(signals, queue.rows as QueueRow[])
  } catch (e) {
    console.error('anomaly signal computation failed:', e instanceof Error ? e.message : String(e))
    return []
  }
}

/** Render flagged signals only (not raw daily series) as a compact markdown block. */
export function renderSignals(signals: AnomalySignal[]): string {
  const header = '### Anomaly signals (deterministic — sustained multi-day trends, stalls, cohort declines only)'
  if (signals.length === 0) return `${header}\n(no sustained anomalies detected)`
  const ordered = [...signals].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1))
  const lines = ordered.map((s) => `- [${s.severity}] ${s.account} — ${s.detail}`)
  return `${header}\n${lines.join('\n')}`
}
