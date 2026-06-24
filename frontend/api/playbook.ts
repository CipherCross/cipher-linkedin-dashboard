// Playbook writer. Persists the single global Markdown playbook that grounds the
// AI conversation coach (/api/coach) for every account. Reads happen through the
// anon key (the Playbook page); only this WRITE needs the service-role key,
// reused from /api/_lib/core.ts.
//
// Guard: mirrors /api/config — if ADMIN_SECRET is set on the Vercel project,
// callers must send it as an `x-admin-secret` header; if unset, the endpoint is
// open (acceptable only because this is an internal tool).
import { db } from './_lib/core.js'

export const maxDuration = 10

// Generous cap — a playbook is prose, not a payload, but bound it so a runaway
// paste can't bloat every coach prompt (which embeds the whole document).
const MAX_CONTENT_BYTES = 100_000

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

  let payload: { content?: unknown }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const content = payload.content
  if (typeof content !== 'string') {
    return json({ error: 'content (string) is required' }, 400)
  }
  if (content.length > MAX_CONTENT_BYTES) {
    return json({ error: 'playbook too large' }, 413)
  }

  // Upsert the singleton row (id=true, enforced by the table's check constraint).
  const { error } = await db()
    .from('playbook')
    .upsert({ id: true, content, updated_at: new Date().toISOString() }, { onConflict: 'id' })
  if (error) return json({ error: error.message }, 500)

  return json({ ok: true })
}

export const POST = (req: Request) => handle(req)
