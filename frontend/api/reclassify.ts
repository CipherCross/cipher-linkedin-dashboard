// Manual reply reclassification. The conversation drawer posts a single inbound
// message id + the sentiment a human picked after reading the whole thread, and
// we write it back with classified_model='manual' so corrections are
// distinguishable from the AI batch classifier (/api/classify). Same
// service-role Supabase client as the rest of the AI layer.
//
// POST only, intentionally open like /api/classify's manual path: the write is
// a single row scoped to one inbound message and is idempotent.
import { db } from './_lib/core.js'

const SENTIMENTS = [
  'positive',
  'neutral',
  'negative',
  'objection',
  'referral',
  'auto',
] as const
const INTENTS = ['p1', 'p2', 'p3'] as const
const INTENT_TAXONOMY_VERSION = 'p123-v1'

type Sentiment = (typeof SENTIMENTS)[number]
type ReplyIntent = (typeof INTENTS)[number]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

async function handle(req: Request): Promise<Response> {
  let payload: {
    id?: unknown
    sentiment?: unknown
    intent_level?: unknown
    reason?: unknown
    intent_reason?: unknown
  }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const id = Number(payload.id)
  if (!Number.isInteger(id) || id <= 0) {
    return json({ error: 'id must be a positive integer' }, 400)
  }
  const hasSentiment = payload.sentiment !== undefined
  const hasIntent = payload.intent_level !== undefined
  if (!hasSentiment && !hasIntent) {
    return json({ error: 'sentiment or intent_level is required' }, 400)
  }
  if (hasSentiment && !SENTIMENTS.includes(payload.sentiment as Sentiment)) {
    return json({ error: `sentiment must be one of ${SENTIMENTS.join(', ')}` }, 400)
  }
  if (
    hasIntent &&
    payload.intent_level !== null &&
    !INTENTS.includes(payload.intent_level as ReplyIntent)
  ) {
    return json({ error: `intent_level must be null or one of ${INTENTS.join(', ')}` }, 400)
  }
  const sentiment = payload.sentiment as Sentiment | undefined
  const intent = payload.intent_level as ReplyIntent | null | undefined
  const reason =
    typeof payload.reason === 'string' && payload.reason.trim()
      ? payload.reason.trim().slice(0, 300)
      : 'manual override'
  const intentReason =
    typeof payload.intent_reason === 'string' && payload.intent_reason.trim()
      ? payload.intent_reason.trim().slice(0, 300)
      : 'manual override'

  const patch: Record<string, unknown> = {}
  if (hasSentiment) {
    Object.assign(patch, {
      sentiment,
      reason,
      classified_at: new Date().toISOString(),
      classified_model: 'manual',
    })
  }
  if (hasIntent) {
    Object.assign(patch, {
      intent_level: intent,
      intent_reason: intentReason,
      intent_classified_at: new Date().toISOString(),
      intent_classified_model: 'manual',
      intent_taxonomy_version: INTENT_TAXONOMY_VERSION,
    })
  }

  const sb = db()
  const { data, error } = await sb
    .from('messages')
    .update(patch)
    .eq('id', id)
    .eq('direction', 'in')
    .select('id,sentiment,intent_level')
    .single()

  if (error) return json({ error: error.message }, 500)
  if (!data) return json({ error: 'no inbound message with that id' }, 404)

  // A corrected sentiment may unblock automatic pipeline advancement. Non-fatal
  // and tolerant of migration 028 not being pushed yet: supabase-js returns
  // {error} (e.g. SQLSTATE 42883, function does not exist) rather than throwing,
  // but guard both. A missing/failed RPC just omits auto_advanced.
  const auto_advanced = await autoAdvancePipeline(sb)

  return json({
    ok: true,
    id: data.id,
    sentiment: data.sentiment,
    intent_level: data.intent_level,
    ...(auto_advanced !== undefined ? { auto_advanced } : {}),
  })
}

/** Run pipeline_auto_advance() (migration 028); returns its count or undefined
 *  if the RPC is missing / errors. Never throws. */
async function autoAdvancePipeline(sb: ReturnType<typeof db>): Promise<number | undefined> {
  try {
    const { data, error } = await sb.rpc('pipeline_auto_advance')
    if (error) {
      console.warn('pipeline_auto_advance skipped:', error.message)
      return undefined
    }
    return typeof data === 'number' ? data : undefined
  } catch (e) {
    console.warn('pipeline_auto_advance threw:', e)
    return undefined
  }
}

export const POST = (req: Request) => handle(req)
