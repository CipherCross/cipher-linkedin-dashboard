// Morning Briefing. The chat copilot (/api/chat) runs a deep autonomous SQL
// investigation over the whole pipeline — but only when someone asks. This wraps
// that SAME agentic loop (same `tools`, SCHEMA_DOC, executeSql) in a scheduled job
// that investigates on its own each morning, structures the result, stores it
// (one row per day) and pushes it to Slack. The Overview card reads the latest row.
//
// Triggers:
//   GET  — the daily Vercel cron at 07:00 UTC (guarded by CRON_SECRET), after the
//          06:00 classify cron so the day's replies are already sentiment-labelled.
//   POST — the "Refresh briefing" button on Overview. No secret: self-limiting
//          (idempotent upsert on briefing_date, one cheap call/day).
import { generateObject, generateText, stepCountIs } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import {
  CAMPAIGN_OVERVIEW_SQL,
  SCHEMA_DOC,
  WEEKLY_FUNNEL_SQL,
  db,
  executeSql,
} from './_lib/core.js'
import { tools } from './_lib/tools.js'
import { postBriefingToSlack } from './_lib/slack.js'

export const maxDuration = 300

const INVESTIGATE_MODEL = 'claude-opus-4-8' // deep autonomous investigation
const STRUCTURE_MODEL = 'claude-sonnet-4-6' // coerce the narrative into a schema

// Lightweight grounding queries run before the model investigates, so the briefing
// is anchored in current numbers even if it under-explores. Failures are skipped.
const SEED_QUERIES: { label: string; sql: string }[] = [
  { label: 'Per-campaign funnel (campaign_overview)', sql: CAMPAIGN_OVERVIEW_SQL },
  { label: 'Weekly invite cohorts (weekly_funnel)', sql: WEEKLY_FUNNEL_SQL },
  {
    label: 'Recent sync runs (freshness / failures)',
    sql: `select instance_id, status, started_at, finished_at, rows_upserted, error
          from sync_runs order by started_at desc limit 20`,
  },
  {
    label: 'Inbound replies in the last 24h by sentiment',
    sql: `select coalesce(sentiment, 'unclassified') as sentiment, count(*) as cnt
          from messages
          where direction = 'in' and sent_at > now() - interval '24 hours'
          group by 1 order by 2 desc`,
  },
  {
    label: 'Invites sent per account in the last 7 days (limit risk)',
    sql: `select instance_id, count(*) as invites_7d
          from leads where invited_at > now() - interval '7 days'
          group by 1 order by 2 desc`,
  },
  {
    label: 'Hot replies (positive/objection) still awaiting our response',
    sql: `with latest as (
            select distinct on (instance_id, profile_url)
              instance_id, profile_url, direction, sentiment, sent_at
            from messages
            order by instance_id, profile_url, sent_at desc
          )
          select instance_id, sentiment, count(*) as waiting
          from latest
          where direction = 'in' and sentiment in ('positive', 'objection')
          group by 1, 2 order by 3 desc`,
  },
]

const BRIEFING_SYSTEM = `You are the morning analyst for a LinkedIn outreach team. You have read-only SQL
access to the team's Supabase Postgres database through tools, and you produce ONE concise daily
briefing the team reads with their coffee. The accounts ("instances") are real LinkedIn accounts; each
runs campaigns through Linked Helper 2.

${SCHEMA_DOC}

HOW TO WORK
- You are given seed query results below as a starting point. Treat the briefing as a GOAL: keep
  calling tools to investigate anything notable until you can write it confidently. A good briefing
  takes 5-15 targeted queries. Do not stop after the seed data.
- Investigate what CHANGED and what's AT RISK: acceptance/reply-rate moves vs prior weeks (segment by
  account, campaign, and message step), accounts approaching LinkedIn's ~100-200 invites/week safe
  zone, hot replies (positive/objection) left unanswered, stale or failed syncs (check
  instances.last_sync_at and sync_runs), and stalled cohorts.
- Replies LAG invites — never compare raw invites-this-week vs replies-this-week; reason in cohorts and
  note when recent cohorts are simply still maturing rather than genuinely down.
- Ground every number in real query results; never guess. Be honest about small samples and stale data.
- RECONCILE rates before you cite them: a daily pace and a weekly/period total must be arithmetically
  consistent (a "~65/day" claim cannot sit next to "261 in the week", which is ~37/day). State the time
  window each figure is based on, and if recent days differ from the period average, say so explicitly
  rather than quoting two numbers that contradict each other.

THE BRIEFING (write it as your final message, in markdown)
- A one-line HEADLINE (one tight clause, ~max 120 chars) capturing the single most important thing.
- A short SUMMARY (2-4 sentences): the state of play and what changed since recent days.
- A few SECTIONS (titled) covering what changed, notable campaigns/accounts, and reply quality.
- RISKS: specific at-risk callouts (account near the invite limit, stale/failed sync, hot reply going
  cold, rate cliff) — each with a severity (low/med/high). Omit if genuinely nothing is wrong.
- EXACTLY 3 ACTIONS: the three highest-leverage things the team should do TODAY, most important first,
  each concrete and specific to the data (name the account/campaign/lead-count).
Be specific and brief. No filler, no generic advice.

LANGUAGE
- Write the ENTIRE briefing in UKRAINIAN (українською) — headline, summary, every section, every risk
  and every action. Use natural, concise business Ukrainian, not a word-for-word translation.
- Keep these VERBATIM (do not translate or transliterate): instance ids (e.g. notebook-3), account
  names, campaign names, agent versions, dates, all numbers, and any LinkedIn / Linked Helper product
  terms. The severity/priority codes stay as the literal values high / med / low.

TONE
- Keep it light and slightly sarcastic — dry, witty Ukrainian that makes the team smile over their
  morning coffee. A wry aside or a playful jab at the SITUATION is welcome, mostly in the headline and
  summary.
- The humor is seasoning, not the meal: never at the expense of clarity or accuracy. The numbers, the
  risks and the 3 actions stay precise and genuinely useful. If something is actually on fire (an
  account near a ban), say so plainly — gallows humor is fine, downplaying real risk is not.
- Punch up, not down: tease the metrics, the campaigns, the robots — never blame, shame or mock an
  individual person/SDR by name. Keep it kind; these are colleagues reading about their own accounts.

Today's date: ${new Date().toISOString().slice(0, 10)}.`

const briefingSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  sections: z.array(z.object({ title: z.string(), body: z.string() })).max(6),
  actions: z
    .array(z.object({ text: z.string(), priority: z.enum(['high', 'med', 'low']) }))
    .max(5),
  risks: z
    .array(
      z.object({
        kind: z.string(),
        severity: z.enum(['low', 'med', 'high']),
        text: z.string(),
      })
    )
    .max(6),
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Run the seed queries, returning a markdown block to anchor the investigation. */
async function renderSeed(): Promise<string> {
  const parts = await Promise.all(
    SEED_QUERIES.map(async ({ label, sql }) => {
      try {
        const { rows, rowCount, truncated } = await executeSql(sql)
        const note = truncated ? ` (showing ${rows.length} of ${rowCount})` : ''
        return `### ${label}${note}\n${JSON.stringify(rows)}`
      } catch (e) {
        return `### ${label}\n(query failed: ${e instanceof Error ? e.message : String(e)})`
      }
    })
  )
  return parts.join('\n\n')
}

async function buildBriefing(): Promise<Response> {
  const seed = await renderSeed()

  // Stage 1 — investigate with the same tools the chat copilot uses.
  const { text } = await generateText({
    model: anthropic(INVESTIGATE_MODEL),
    system: BRIEFING_SYSTEM,
    prompt:
      `Here are today's seed query results. Investigate further with the tools, then write the ` +
      `briefing.\n\n${seed}`,
    tools,
    stopWhen: stepCountIs(30),
    maxOutputTokens: 8000,
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive', display: 'summarized' } },
    },
  })

  // Stage 2 — coerce the narrative into the stored/Slack shape.
  const { object } = await generateObject({
    model: anthropic(STRUCTURE_MODEL),
    schema: briefingSchema,
    system:
      `Extract the structured briefing from the analyst's write-up below. Keep ALL text in UKRAINIAN ` +
      `(do not translate it back to English) and KEEP the writer's light, slightly sarcastic tone — ` +
      `do not flatten it into dry corporate phrasing. Preserve specifics verbatim (numbers, dates, ` +
      `account / campaign names, instance ids, agent versions). Keep actions to the 3 highest-leverage ` +
      `items, most important first. The severity/priority fields stay as the codes high/med/low. Do ` +
      `not invent anything not in the write-up.`,
    prompt: text,
  })

  const briefing_date = new Date().toISOString().slice(0, 10)
  const row = {
    briefing_date,
    headline: object.headline.slice(0, 300),
    summary: object.summary.slice(0, 2000),
    sections: object.sections,
    actions: object.actions,
    risks: object.risks,
    model: INVESTIGATE_MODEL,
  }

  const sb = db()
  const { data, error } = await sb
    .from('briefings')
    .upsert(row, { onConflict: 'briefing_date' })
    .select()
    .single()
  if (error) return json({ error: error.message }, 500)

  await postBriefingToSlack(process.env.SLACK_WEBHOOK_URL, {
    briefing_date,
    headline: row.headline,
    summary: row.summary,
    actions: row.actions,
    risks: row.risks,
    model: row.model,
  })

  return json(data)
}

async function handle(req: Request): Promise<Response> {
  // Cron path is guarded; the manual POST path is intentionally open (see top).
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return json({ error: 'unauthorized' }, 401)
    }
  }
  try {
    return await buildBriefing()
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
}

export const GET = (req: Request) => handle(req)
export const POST = (req: Request) => handle(req)
