// Slack delivery. Started as briefing-only, kept isolated from the generator
// (api/briefing.ts) so another sender could be added later without touching that
// logic — this is that extension point, now also used by api/review-digest.ts
// for the manager weekly-review post and api/notify-replies.ts for new-reply
// alerts. All senders are fail-soft by design: a missing webhook or a Slack
// outage never fails the caller — briefings still store and show on the
// dashboard, review-digest and notify-replies report the failure back to their
// callers (502) rather than throwing.

interface BriefingForSlack {
  briefing_date: string
  headline: string | null
  summary: string | null
  changes: { text: string; trend?: string }[]
  actions: { text: string; priority?: string }[]
  risks: { kind?: string; severity?: string; text: string }[]
  // Optional structured key-metrics strip (added later; guard for absence on old rows).
  metrics?: { label: string; value: string; note?: string }[]
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

  // Key-metrics strip: a 2-column fields grid (Slack caps a section at 10 fields).
  const metrics = (b.metrics ?? []).slice(0, 8)
  if (metrics.length) {
    blocks.push({
      type: 'section',
      fields: metrics.map((m) => ({
        type: 'mrkdwn',
        text: `*${m.value}*\n${m.label}`.slice(0, 2000),
      })),
    })
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
  const p3Pct = t.replied > 0 ? `${((100 * t.positive) / t.replied).toFixed(1)}%` : '—'
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        `*Totals* — Invites: ${t.invites} · Accepted: ${t.accepted} (${acceptPct}) · ` +
        `Replied: ${t.replied} (${replyPct}) · P3 intent: ${t.positive} (${p3Pct})`,
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
          `${pct(r.positive_share)} P3`
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

export interface NewReplyForSlack {
  lead_name: string // leads.full_name, or the profile-URL slug fallback
  headline: string | null
  company: string | null
  campaign: string | null // campaigns.name
  account: string // instances.account_name ?? label ?? instance_id
  sent_at: string // LH2 capture time — lags the real reply (see context block)
  snippets: string[] // 1-2 bodies, pre-sliced by the caller, oldest first
  extra_count: number // messages in this thread beyond the rendered snippets
  link?: string // optional dashboard deep link (DASHBOARD_URL)
}

// Unlike the other senders (whose strings are AI-generated or internal), reply
// alerts render EXTERNAL text — a lead's name, headline, and message body. Slack
// treats <...> as live syntax (<!channel>, <@U…>, <url|text>), so unescaped
// external content could ping the channel or spoof links.
const mrkdwnEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Build the Slack Block Kit payload for a batch of new inbound replies. */
function blocksForReplies(replies: NewReplyForSlack[]): Block[] {
  const blocks: Block[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `💬 ${replies.length} new lead ${replies.length === 1 ? 'reply' : 'replies'}`.slice(0, 150),
      },
    },
  ]

  for (const r of replies) {
    const leadName = mrkdwnEscape(r.lead_name)
    const name = r.link ? `<${r.link}|${leadName}>` : `*${leadName}*`
    const who = [r.headline, r.company].filter(Boolean).map((s) => mrkdwnEscape(s!)).join(' @ ')
    const where = [r.campaign, r.account].filter(Boolean).join(' · ')
    const lines = [
      `${name}${who ? ` — ${who}` : ''}`,
      ...(where ? [`_${mrkdwnEscape(where)}_`] : []),
      ...r.snippets.map((s) => `> ${mrkdwnEscape(s).replace(/\n+/g, '\n> ')}`),
      ...(r.extra_count > 0 ? [`_(+${r.extra_count} more message${r.extra_count === 1 ? '' : 's'})_`] : []),
    ]
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) },
    })
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: 'Times are LH2 capture times and may lag the actual reply.',
      },
    ],
  })

  return blocks
}

/** POST a batch of new replies to Slack. No-op when webhookUrl is empty; never throws. */
export async function postNewRepliesToSlack(
  webhookUrl: string | undefined,
  replies: NewReplyForSlack[]
): Promise<boolean> {
  if (!webhookUrl || !replies.length) return false
  const names = replies.slice(0, 3).map((r) => mrkdwnEscape(r.lead_name)).join(', ')
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // notification fallback
        text: `💬 ${replies.length} new lead ${replies.length === 1 ? 'reply' : 'replies'} (${names}${replies.length > 3 ? ', …' : ''})`,
        blocks: blocksForReplies(replies),
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
