// Slack delivery. Started as briefing-only, kept isolated from the generator
// (api/briefing.ts) so another sender could be added later without touching that
// logic — this is that extension point, now also used by api/review-digest.ts
// for the manager weekly-review post. Both senders are fail-soft by design: a
// missing webhook or a Slack outage never fails the caller — briefings still
// store and show on the dashboard, and review-digest reports the failure back
// to its caller (502) rather than throwing.

interface BriefingForSlack {
  briefing_date: string
  headline: string | null
  summary: string | null
  changes: { text: string; trend?: string }[]
  actions: { text: string; priority?: string }[]
  risks: { kind?: string; severity?: string; text: string }[]
  model: string | null
}

type Block = Record<string, unknown>

const SEV_EMOJI: Record<string, string> = { high: '🔴', med: '🟠', low: '🟡' }

// Day-over-day deltas. Trend → glyph (matches the dashboard card's TREND_ICON).
const TREND_EMOJI: Record<string, string> = {
  up: '▲',
  down: '▼',
  flat: '▬',
  new: '✚',
  resolved: '✓',
}

/** Ukrainian plural for "ризик" (1 ризик / 2-4 ризики / 5+ ризиків). */
function risksUk(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} ризик`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ризики`
  return `${n} ризиків`
}

/** Build the Slack Block Kit payload for one briefing. */
function blocksFor(b: BriefingForSlack): Block[] {
  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📣 ${b.headline || 'Щоденний брифінг'}`.slice(0, 150) },
    },
  ]

  if (b.summary) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: b.summary.slice(0, 2900) } })
  }

  const changes = (b.changes ?? []).slice(0, 6)
  if (changes.length) {
    const text =
      '*Зміни з учора*\n' +
      changes.map((c) => `${TREND_EMOJI[c.trend ?? ''] ?? '•'} ${c.text}`).join('\n')
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } })
  }

  const actions = (b.actions ?? []).slice(0, 5)
  if (actions.length) {
    blocks.push({ type: 'divider' })
    const text =
      '*Дії на сьогодні*\n' +
      actions.map((a, i) => `${i + 1}. ${a.text}`).join('\n')
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } })
  }

  const risks = (b.risks ?? []).slice(0, 6)
  if (risks.length) {
    const text =
      '*Ризики*\n' +
      risks.map((r) => `${SEV_EMOJI[r.severity ?? ''] ?? '•'} ${r.text}`).join('\n')
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } })
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${b.briefing_date} · ${risksUk(risks.length)} · ${b.model ?? 'ai'}`,
      },
    ],
  })

  return blocks
}

export interface ReviewDigestRow {
  campaign: string
  account: string
  invites: number
  accept_rate: number | null
  reply_rate: number | null
  positive_share: number | null
  d_accept: number | null // pp change vs prior cohort, null when there's nothing to compare to
  d_reply: number | null
}

export interface ReviewDigestForSlack {
  cohort_week: string
  scope: string
  maturity_note: string
  totals: { invites: number; accepted: number; replied: number; positive: number }
  rows: ReviewDigestRow[]
}

// Rates arrive already-computed percentages (0-100), matching the dashboard's own
// `rate()` formatter in src/lib/format.ts — one decimal, em-dash for null.
const pct = (r: number | null): string => (r == null ? '—' : `${r.toFixed(1)}%`)

// Deltas are numeric (percentage-point change), not the briefing's string trend
// enum — map sign to the same arrow glyphs as TREND_EMOJI.up/down/flat.
const deltaArrow = (d: number | null): string => {
  if (d == null) return ''
  if (d > 0) return ` ${TREND_EMOJI.up}`
  if (d < 0) return ` ${TREND_EMOJI.down}`
  return ` ${TREND_EMOJI.flat}`
}

/** Build the Slack Block Kit payload for one weekly review digest. */
function blocksForDigest(d: ReviewDigestForSlack): Block[] {
  const blocks: Block[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📊 Weekly review — cohort of ${d.cohort_week}`.slice(0, 150),
      },
    },
  ]

  const t = d.totals
  const acceptPct = t.invites > 0 ? `${((100 * t.accepted) / t.invites).toFixed(1)}%` : '—'
  const replyPct = t.invites > 0 ? `${((100 * t.replied) / t.invites).toFixed(1)}%` : '—'
  const positivePct = t.replied > 0 ? `${((100 * t.positive) / t.replied).toFixed(1)}%` : '—'
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        `*Totals* — Invites: ${t.invites} · Accepted: ${t.accepted} (${acceptPct}) · ` +
        `Replied: ${t.replied} (${replyPct}) · Positive: ${t.positive} (${positivePct})`,
    },
  })

  const rows = (d.rows ?? []).slice(0, 10)
  if (rows.length) {
    const text = rows
      .map(
        (r) =>
          `*${r.campaign}* — ${r.account}: ${r.invites} inv, ` +
          `${pct(r.accept_rate)} accept${deltaArrow(r.d_accept)}, ` +
          `${pct(r.reply_rate)} reply${deltaArrow(r.d_reply)}, ` +
          `${pct(r.positive_share)} positive`
      )
      .join('\n')
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } })
  }

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `${d.maturity_note} · ${d.scope}`.slice(0, 2900) },
    ],
  })

  return blocks
}

/** POST a weekly review digest to Slack. No-op when webhookUrl is empty; never throws. */
export async function postReviewDigestToSlack(
  webhookUrl: string | undefined,
  digest: ReviewDigestForSlack
): Promise<boolean> {
  if (!webhookUrl) return false
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `📊 Weekly review — cohort of ${digest.cohort_week}`, // notification fallback
        blocks: blocksForDigest(digest),
      }),
    })
    if (!res.ok) {
      console.error(`Slack webhook returned ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return false
    }
    return true
  } catch (e) {
    console.error('Slack webhook failed:', e instanceof Error ? e.message : String(e))
    return false
  }
}

/** POST the briefing to Slack. No-op when webhookUrl is empty; never throws. */
export async function postBriefingToSlack(
  webhookUrl: string | undefined,
  briefing: BriefingForSlack
): Promise<boolean> {
  if (!webhookUrl) return false
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `📣 ${briefing.headline || 'Щоденний брифінг'}`, // notification fallback
        blocks: blocksFor(briefing),
      }),
    })
    if (!res.ok) {
      console.error(`Slack webhook returned ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return false
    }
    return true
  } catch (e) {
    console.error('Slack webhook failed:', e instanceof Error ? e.message : String(e))
    return false
  }
}
