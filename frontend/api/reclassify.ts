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

type Sentiment = (typeof SENTIMENTS)[number]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

async function handle(req: Request): Promise<Response> {
  let payload: { id?: unknown; sentiment?: unknown; reason?: unknown }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const id = Number(payload.id)
  if (!Number.isInteger(id) || id <= 0) {
    return json({ error: 'id must be a positive integer' }, 400)
  }
  if (!SENTIMENTS.includes(payload.sentiment as Sentiment)) {
    return json({ error: `sentiment must be one of ${SENTIMENTS.join(', ')}` }, 400)
  }
  const sentiment = payload.sentiment as Sentiment
  const reason =
    typeof payload.reason === 'string' && payload.reason.trim()
      ? payload.reason.trim().slice(0, 300)
      : 'manual override'

  const sb = db()
  const { data, error } = await sb
    .from('messages')
    .update({
      sentiment,
      reason,
      classified_at: new Date().toISOString(),
      classified_model: 'manual',
    })
    .eq('id', id)
    .eq('direction', 'in')
    .select('id,sentiment')
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
