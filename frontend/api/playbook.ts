// Playbook writer + Search Library writer.
//
// Historically this endpoint persisted only the single global Markdown playbook that
// grounds the AI conversation coach (/api/coach). It now also owns the Search Library
// (saved_searches) writes via an `action` dispatch — folded in here rather than a new
// file because frontend/api is at the Vercel Hobby 12-function cap. Reads for both
// happen through the anon key (the pages); only these WRITES need the service-role key,
// reused from /api/_lib/core.ts.
//
// Back-compatible: a POST with NO `action` key is the legacy playbook save
// ({content}); a POST with action:'save_search' | 'delete_search' hits the Search
// Library. All paths share the same guard.
//
// Guard: mirrors /api/config — if ADMIN_SECRET is set on the Vercel project, callers
// must send it as an `x-admin-secret` header; if unset, the endpoint is open
// (acceptable only because this is an internal tool).
import { db } from './_lib/core.js'
import { validateSearch } from './_lib/savedSearch.js'

export const maxDuration = 10

// Generous cap — a playbook is prose, not a payload, but bound it so a runaway
// paste can't bloat every coach prompt (which embeds the whole document).
const MAX_CONTENT_BYTES = 100_000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const errCode = (e: unknown) => (e as { code?: string } | null)?.code

// --- legacy: single global playbook (no `action` key) ----------------------

async function savePlaybook(supa: ReturnType<typeof db>, payload: Record<string, unknown>) {
  const content = payload.content
  if (typeof content !== 'string') {
    return json({ error: 'content (string) is required' }, 400)
  }
  if (content.length > MAX_CONTENT_BYTES) {
    return json({ error: 'playbook too large' }, 413)
  }

  // Upsert the singleton row (id=true, enforced by the table's check constraint).
  const { error } = await supa
    .from('playbook')
    .upsert({ id: true, content, updated_at: new Date().toISOString() }, { onConflict: 'id' })
  if (error) return json({ error: error.message }, 500)

  return json({ ok: true })
}

// --- save_search: insert (no id) or partial-patch update (id present) ------

async function saveSearch(supa: ReturnType<typeof db>, payload: Record<string, unknown>) {
  const search = payload.search
  if (search === null || typeof search !== 'object' || Array.isArray(search)) {
    return json({ error: 'search (object) is required' }, 400)
  }
  const src = search as Record<string, unknown>

  const id = src.id
  const isUpdate = id !== undefined && id !== null
  if (isUpdate && (typeof id !== 'number' || !Number.isInteger(id) || id <= 0)) {
    return json({ error: 'id must be a positive integer' }, 400)
  }

  // Same validation/normalization the AI tool uses (shared module). requireCore on
  // insert; partial patch on update.
  const normalized = validateSearch(src, !isUpdate)
  if (typeof normalized === 'string') return json({ error: normalized }, 400)

  if (isUpdate) {
    if (Object.keys(normalized).length === 0) {
      return json({ error: 'no fields to update' }, 400)
    }
    const { data, error } = await supa
      .from('saved_searches')
      .update(normalized)
      .eq('id', id)
      .select()
      .single()
    if (error) {
      if (errCode(error) === '23505') {
        return json({ error: 'a search with that name already exists for this platform' }, 409)
      }
      // .single() with no matched row -> PGRST116; the id doesn't exist.
      if (errCode(error) === 'PGRST116') {
        return json({ error: 'unknown search id' }, 404)
      }
      return json({ error: error.message }, 500)
    }
    return json({ ok: true, search: data })
  }

  const { data, error } = await supa
    .from('saved_searches')
    .insert(normalized)
    .select()
    .single()
  if (error) {
    if (errCode(error) === '23505') {
      return json({ error: 'a search with that name already exists for this platform' }, 409)
    }
    return json({ error: error.message }, 500)
  }
  return json({ ok: true, search: data })
}

// --- delete_search: hard delete (page-only; NOT an AI tool) ----------------

async function deleteSearch(supa: ReturnType<typeof db>, payload: Record<string, unknown>) {
  const id = payload.id
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return json({ error: 'id must be a positive integer' }, 400)
  }
  const { data, error } = await supa
    .from('saved_searches')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) return json({ error: error.message }, 500)
  if (!data?.length) return json({ error: 'unknown search id' }, 404)
  return json({ ok: true })
}

async function handle(req: Request): Promise<Response> {
  const secret = process.env.ADMIN_SECRET
  if (secret && req.headers.get('x-admin-secret') !== secret) {
    return json({ error: 'unauthorized' }, 401)
  }

  let payload: Record<string, unknown>
  try {
    payload = (await req.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const supa = db()

  // Route on `action`. Absent action => the legacy playbook save (unchanged).
  const action = (payload as { action?: unknown } | null)?.action
  if (typeof action === 'string') {
    switch (action) {
      case 'save_search':
        return saveSearch(supa, payload)
      case 'delete_search':
        return deleteSearch(supa, payload)
      default:
        return json({ error: 'unknown action' }, 400)
    }
  }

  return savePlaybook(supa, payload)
}

export const POST = (req: Request) => handle(req)
