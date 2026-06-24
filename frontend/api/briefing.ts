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
    sql: `select coalesce(i.account_name, i.label, s.instance_id) as account, s.instance_id,
                 s.status, s.started_at, s.finished_at, s.rows_upserted, s.error
          from sync_runs s join instances i on i.id = s.instance_id
          order by s.started_at desc limit 20`,
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
    sql: `select coalesce(i.account_name, i.label, l.instance_id) as account, l.instance_id,
                 count(*) as invites_7d
          from leads l join instances i on i.id = l.instance_id
          where l.invited_at > now() - interval '7 days'
          group by 1, 2 order by 3 desc`,
  },
  {
    label: 'Reply quality in the last 14 days by account (volume + sentiment)',
    sql: `select coalesce(i.account_name, i.label, m.instance_id) as account,
                 m.sentiment, count(*) as replies
          from messages m join instances i on i.id = m.instance_id
          where m.direction = 'in' and m.sent_at > now() - interval '14 days'
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
  zone, stale or failed syncs (check instances.last_sync_at and sync_runs), and stalled cohorts.
- Replies LAG invites — never compare raw invites-this-week vs replies-this-week; reason in cohorts and
  note when recent cohorts are simply still maturing rather than genuinely down.
- DO NOT judge follow-up status from message threads. Linked Helper syncs its internal DB on a lag, so
  outbound replies the SDR has ALREADY sent may not be in the data yet — a thread that looks
  "unanswered" usually isn't. NEVER claim conversations are awaiting our reply or going cold, NEVER
  count "N hot replies waiting", and NEVER turn response latency into an action or a risk. Use the
  messages data only for reply VOLUME and SENTIMENT (did a reply come in, and what kind), never for
  who-replied-last.
- Ground every number in real query results; never guess. Be honest about small samples and stale data.
- RECONCILE rates before you cite them: a daily pace and a weekly/period total must be arithmetically
  consistent (a "~65/day" claim cannot sit next to "261 in the week", which is ~37/day). State the time
  window each figure is based on, and if recent days differ from the period average, say so explicitly
  rather than quoting two numbers that contradict each other.

THE BRIEFING (write it as your final message, in markdown)
- A one-line HEADLINE (one tight clause, ~max 120 chars) capturing the single most important thing.
- A SUMMARY of 2-3 short sentences. Lead with the single most important fact; don't recap everything.
- At most 2 short SECTIONS (titled), 1-2 sentences each — and only if they add something the summary
  doesn't. Omit sections entirely on a quiet day.
- RISKS: specific at-risk callouts (account near the invite limit, stale/failed sync, rate cliff,
  stalled cohort) — each ONE short line with a severity (low/med/high). Omit if nothing is wrong.
- EXACTLY 3 ACTIONS: the three highest-leverage moves for TODAY, most important first — each ONE
  imperative sentence naming the account/campaign and the single number that justifies it.

LANGUAGE
- Write the ENTIRE briefing in UKRAINIAN (українською) — headline, summary, every section, every risk
  and every action. Use natural, concise business Ukrainian, not a word-for-word translation.
- NAME ACCOUNTS BY THEIR LINKEDIN ACCOUNT NAME — that's what the team recognises. Every account-level
  seed row has an "account" column with the name to use; fall back to the label, then the instance id,
  ONLY when no name exists. Never surface a raw instance id like "notebook-3" when a name is available.
- Keep these VERBATIM (do not translate or transliterate): account names, campaign names, agent
  versions, dates, all numbers, and any LinkedIn / Linked Helper product terms. The severity/priority
  codes stay as the literal values high / med / low.

VOICE
- Energetic, vivid, plain-spoken Ukrainian. Reach for punchy, concrete verbs ("шпарить", "холонуть",
  "простоює") — they make it lively and quick to read.
- NO sarcasm, NO jokes, NO snark, no cute asides — lively and direct, not a comedy set. Stay
  respectful: describe what an ACCOUNT is doing, never blame or mock a person/SDR by name.

BREVITY — the team must scan this in ~20 seconds, so keep it tight and airy
- Short sentences over compound ones. Cut every word that isn't carrying weight.
- ONE number per claim — the most telling one. Don't stack "263/week + 78/day + 7.3% + 186 queued"
  into one sentence; pick the single figure that makes the point.
- No repetition: if a point is in an action, don't re-explain it in the summary or risks. A risk an
  action already handles gets one bare line, not the fix again.

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
      `(do not translate it back to English) and KEEP the lively, punchy voice — but TIGHTEN it: trim ` +
      `bloat, drop repetition, make every action ONE short imperative sentence and every risk ONE ` +
      `short line. Preserve specifics verbatim (numbers, dates, account / campaign names, agent ` +
      `versions) but keep only the single most telling number per point. Refer to accounts by their ` +
      `LinkedIn account name, never by a raw instance id like "notebook-3". Keep the 3 highest-` +
      `leverage actions, most important first. The severity/priority fields stay as the codes ` +
      `high/med/low. Do not invent anything not in the write-up.`,
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
  if (error) {
    console.error('briefing upsert failed:', error.message)
    return json({ error: 'Failed to store the briefing.' }, 500)
  }

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
    console.error('briefing failed:', e instanceof Error ? e.message : String(e))
    return json({ error: 'Failed to generate the briefing — check server logs.' }, 500)
  }
}

export const GET = (req: Request) => handle(req)
export const POST = (req: Request) => handle(req)
