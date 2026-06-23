// Notebook config writer. Persists the per-instance override blob that the sync
// agent reads on its next run (see apply_remote_config in sync-agent/agent.py),
// so notebooks can be reconfigured from the dashboard's Health page with no local
// edits. Reads happen with the user's session (RLS); only this WRITE needs the
// service-role key, reused from /api/_lib/core.ts.
//
// Auth: the server gates this route to admin+ (requireRole('admin') in
// server/index.ts), replacing the old ADMIN_SECRET header. By the time handle()
// runs the caller is already an authenticated admin.
import { db } from './_lib/core.js'

export const maxDuration = 10

// Bootstrap keys are needed locally just to connect/identify a notebook; a remote
// blob must never set them. The agent ignores them too, but we strip here so they
// never even land in the database.
const FORBIDDEN_KEYS = new Set([
  'supabase_url',
  'supabase_service_key',
  'instance_id',
  'ignore_remote_config',
])

const MAX_CONFIG_BYTES = 64_000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

async function handle(req: Request): Promise<Response> {
  let payload: { instance_id?: unknown; config?: unknown }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const instance_id = payload.instance_id
  const config = payload.config
  if (typeof instance_id !== 'string' || !instance_id) {
    return json({ error: 'instance_id (string) is required' }, 400)
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return json({ error: 'config must be an object' }, 400)
  }

  // Drop bootstrap keys defensively, then size-check what we'll store.
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (!FORBIDDEN_KEYS.has(k)) clean[k] = v
  }
  if (JSON.stringify(clean).length > MAX_CONFIG_BYTES) {
    return json({ error: 'config too large' }, 413)
  }

  const { data, error } = await db()
    .from('instances')
    .update({ config: clean, config_updated_at: new Date().toISOString() })
    .eq('id', instance_id)
    .select('id')
  if (error) return json({ error: error.message }, 500)
  if (!data?.length) return json({ error: 'unknown instance_id' }, 404)

  return json({ ok: true, instance_id })
}

export const POST = (req: Request) => handle(req)
