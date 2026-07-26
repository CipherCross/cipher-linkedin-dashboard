// Admin-guarded editor for the durable, team-provided background used by AI
// briefings. Metrics cannot reveal campaign intent (for example, that a batch is
// re-engaging leads previously contacted from another account), so this context
// is stored explicitly and attributed as team input in the briefing prompt.
import { db } from './_lib/core.js'

export const maxDuration = 10

const MAX_CONTEXT_CHARS = 4_000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

async function handle(req: Request): Promise<Response> {
  const secret = process.env.ADMIN_SECRET
  if (secret && req.headers.get('x-admin-secret') !== secret) {
    return json({ error: 'unauthorized' }, 401)
  }

  let payload: { campaign_id?: unknown; briefing_context?: unknown }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  if (typeof payload.campaign_id !== 'string' || !payload.campaign_id) {
    return json({ error: 'campaign_id (string) is required' }, 400)
  }
  if (typeof payload.briefing_context !== 'string') {
    return json({ error: 'briefing_context (string) is required' }, 400)
  }

  const context = payload.briefing_context.trim()
  if (context.length > MAX_CONTEXT_CHARS) {
    return json({ error: `briefing_context must be at most ${MAX_CONTEXT_CHARS} characters` }, 413)
  }

  const updatedAt = new Date().toISOString()
  const { data, error } = await db()
    .from('campaigns')
    .update({
      briefing_context: context || null,
      briefing_context_updated_at: updatedAt,
    })
    .eq('id', payload.campaign_id)
    .select('id,briefing_context,briefing_context_updated_at')
  if (error) return json({ error: error.message }, 500)
  if (!data?.length) return json({ error: 'unknown campaign_id' }, 404)

  return json({
    ok: true,
    campaign_id: data[0].id,
    briefing_context: data[0].briefing_context,
    briefing_context_updated_at: data[0].briefing_context_updated_at,
  })
}

export const POST = (req: Request) => handle(req)
