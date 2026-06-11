import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { SCHEMA_DOC } from './_lib/core'
import { tools } from './_lib/tools'

export const maxDuration = 60

const SYSTEM = `You are the analytics copilot for a LinkedIn outreach dashboard. You have
read-only SQL access to the team's Supabase Postgres database through tools.

${SCHEMA_DOC}

HOW TO WORK
- Always ground answers in real data: call tools, don't guess numbers. Run as
  many queries as you need; iterate when a result raises a follow-up question.
- For diagnostic questions ("why did X happen?"), investigate like an analyst:
  start broad (weekly_funnel / campaign_overview), then segment — by account
  (instance), campaign, message step — and check annotations for known changes.
  Distinguish "rates genuinely dropped" from "recent cohorts haven't matured
  yet" by comparing time-to-reply distributions of older cohorts.
- Be honest about uncertainty and data limits (small samples, immature cohorts,
  sync gaps — check instances.last_sync_at if data looks stale).
- Answer in concise markdown. Use small tables for numbers, then a short
  plain-language interpretation: what it means and what to do about it.
- Today's date: ${new Date().toISOString().slice(0, 10)}.`

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json()

  const result = streamText({
    model: anthropic('claude-opus-4-8'),
    system: SYSTEM,
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: stepCountIs(15),
  })

  return result.toUIMessageStreamResponse()
}
