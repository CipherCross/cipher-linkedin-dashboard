// Slack delivery for the Morning Briefing. Kept isolated from the generator
// (api/briefing.ts) so another channel (email, etc.) can be added later without
// touching the briefing logic. Fail-soft by design: a missing webhook or a Slack
// outage never fails the briefing — it still stores and shows on the dashboard.

interface BriefingForSlack {
  briefing_date: string
  headline: string | null
  summary: string | null
  actions: { text: string; priority?: string }[]
  risks: { kind?: string; severity?: string; text: string }[]
  model: string | null
}

type Block = Record<string, unknown>

const SEV_EMOJI: Record<string, string> = { high: '🔴', med: '🟠', low: '🟡' }

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
