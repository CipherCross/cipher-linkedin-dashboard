import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { SCHEMA_DOC, loadIcpRoster } from './_lib/core.js'
import { tools } from './_lib/tools.js'

export const maxDuration = 300

const SYSTEM_BASE = `You are the analytics copilot for a LinkedIn outreach dashboard. You have
read-only SQL access to the team's Supabase Postgres database through tools.

${SCHEMA_DOC}

HOW TO WORK
- Treat every analytical question as a GOAL: keep calling tools until you have
  built the full picture, then answer. Do not stop after one or two queries if
  open threads remain — follow up on every anomaly you surface. A thorough
  investigation of a "why" question typically takes 5-15 queries.
- Investigation loop: (1) establish the topline trend, (2) form hypotheses,
  (3) test each one with a targeted query — segment by account (instance),
  campaign, and message step; check annotations and sync_runs for known
  changes; compare cohort maturity — (4) only conclude when the remaining
  hypotheses are confirmed or ruled out by data.
- Always ground answers in real data: call tools, don't guess numbers.
- Distinguish "rates genuinely dropped" from "recent cohorts haven't matured
  yet" by comparing time-to-reply of older cohorts.
- Be honest about uncertainty and data limits (small samples, immature
  cohorts, stale syncs — check instances.last_sync_at if data looks off).
- Answer in concise markdown: small tables for numbers, then a short
  plain-language interpretation — what it means and what to do about it.
- Today's date: ${new Date().toISOString().slice(0, 10)}.`

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json()

  // Always-on ICP/hypothesis awareness (cheap: names + one-liners), so the copilot
  // doesn't need a tool call just to know what ICPs/hypotheses exist. Fetched per
  // request rather than baked into the module-level constant so a freshly-created
  // ICP shows up immediately, not just after the next cold start.
  const roster = await loadIcpRoster()
  const SYSTEM = roster
    ? `${SYSTEM_BASE}\n\n${roster}\n\nUse hypothesis_overview (or run_sql) for the funnel/keywords/personas behind any of these.`
    : SYSTEM_BASE

  const result = streamText({
    model: anthropic('claude-opus-4-8'),
    system: SYSTEM,
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: stepCountIs(40),
    maxOutputTokens: 16000,
    providerOptions: {
      anthropic: {
        thinking: { type: 'adaptive', display: 'summarized' },
      },
    },
  })

  return result.toUIMessageStreamResponse({ sendReasoning: true })
}
