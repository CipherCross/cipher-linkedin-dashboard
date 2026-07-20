// Playbook writer + Search Library writer + ICP/Hypothesis writer.
//
// Historically this endpoint persisted only the single global Markdown playbook that
// grounds the AI conversation coach (/api/coach). It now also owns the Search Library
// (saved_searches) writes and the ICP/Hypothesis layer (migration 043) via an `action`
// dispatch — folded in here rather than a new file because frontend/api is at the
// Vercel Hobby 12-function cap. Reads for all of these happen through the anon key
// (the pages); only these WRITES need the service-role key, reused from
// /api/_lib/core.ts.
//
// Back-compatible: a POST with NO `action` key is the legacy playbook save
// ({content}); a POST with action:'save_search' | 'delete_search' hits the Search
// Library; action:'save_icp' | 'delete_icp' | 'save_icp_persona' | 'delete_icp_persona' |
// 'save_icp_industry' | 'delete_icp_industry' | 'save_hypothesis' | 'delete_hypothesis' |
// 'set_hypothesis_campaigns' | 'assign_search' hits the ICP/Hypothesis layer (see
// _lib/icp.ts). All paths share the same guard.
//
// Guard: mirrors /api/config — if ADMIN_SECRET is set on the Vercel project, callers
// must send it as an `x-admin-secret` header; if unset, the endpoint is open
// (acceptable only because this is an internal tool).
import { db } from './_lib/core.js'
import { validateSearch } from './_lib/savedSearch.js'
import {
  validateCampaignIds,
  validateHypothesis,
  validateIcp,
  validateIndustry,
  validatePersona,
} from './_lib/icp.js'

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

// --- ICP / Hypothesis layer (migration 043) ---------------------------------
// Four entities (icps, icp_personas, icp_industries, hypotheses) share the same
// insert-or-partial-patch-update shape as save_search above, so a generic pair of
// helpers covers all of them instead of four near-identical copies. save_search /
// delete_search above are left untouched (already shipped, has its own
// platform-scoped conflict message).

type EntityValidator<T> = (input: unknown, requireCore: boolean) => T | string

/** Insert (no id) or partial-patch update (id present) one row of `table`,
 *  keyed by `bodyKey` in the request payload (e.g. payload.icp). */
async function saveEntity<T extends Record<string, unknown>>(
  supa: ReturnType<typeof db>,
  table: string,
  bodyKey: string,
  payload: Record<string, unknown>,
  validate: EntityValidator<T>,
  conflictMessage: string,
): Promise<Response> {
  const raw = payload[bodyKey]
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return json({ error: `${bodyKey} (object) is required` }, 400)
  }
  const src = raw as Record<string, unknown>

  const id = src.id
  const isUpdate = id !== undefined && id !== null
  if (isUpdate && (typeof id !== 'number' || !Number.isInteger(id) || id <= 0)) {
    return json({ error: 'id must be a positive integer' }, 400)
  }

  const normalized = validate(src, !isUpdate)
  if (typeof normalized === 'string') return json({ error: normalized }, 400)

  if (isUpdate) {
    if (Object.keys(normalized).length === 0) {
      return json({ error: 'no fields to update' }, 400)
    }
    // Widen to Record<string, unknown> — supabase-js's .update<T>() runs an
    // excess-property check against its own inferred generic, which conflicts
    // with `normalized` still carrying saveEntity's generic T here.
    const { data, error } = await supa
      .from(table)
      .update(normalized as Record<string, unknown>)
      .eq('id', id)
      .select()
      .single()
    if (error) {
      if (errCode(error) === '23505') return json({ error: conflictMessage }, 409)
      if (errCode(error) === '23503') return json({ error: 'a referenced row does not exist' }, 400)
      if (errCode(error) === 'PGRST116') return json({ error: `unknown ${bodyKey} id` }, 404)
      return json({ error: error.message }, 500)
    }
    return json({ ok: true, [bodyKey]: data })
  }

  const { data, error } = await supa
    .from(table)
    .insert(normalized as Record<string, unknown>)
    .select()
    .single()
  if (error) {
    if (errCode(error) === '23505') return json({ error: conflictMessage }, 409)
    if (errCode(error) === '23503') return json({ error: 'a referenced row does not exist' }, 400)
    return json({ error: error.message }, 500)
  }
  return json({ ok: true, [bodyKey]: data })
}

/** Hard delete one row of `table` by id (cascades handle child rows —
 *  icp_personas/icp_industries/hypothesis_campaigns all `on delete cascade`). */
async function deleteEntity(
  supa: ReturnType<typeof db>,
  table: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const id = payload.id
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return json({ error: 'id must be a positive integer' }, 400)
  }
  const { data, error } = await supa.from(table).delete().eq('id', id).select('id')
  if (error) return json({ error: error.message }, 500)
  if (!data?.length) return json({ error: `unknown ${table} id` }, 404)
  return json({ ok: true })
}

/** Replace a hypothesis's campaign set atomically via the set_hypothesis_campaigns
 *  RPC (migration 043) — a plain function, not a supabase-js multi-call sequence,
 *  so a campaign can't be left half-migrated between hypotheses. */
async function setHypothesisCampaigns(
  supa: ReturnType<typeof db>,
  payload: Record<string, unknown>,
): Promise<Response> {
  const hypothesis_id = payload.hypothesis_id
  if (typeof hypothesis_id !== 'number' || !Number.isInteger(hypothesis_id) || hypothesis_id <= 0) {
    return json({ error: 'hypothesis_id must be a positive integer' }, 400)
  }
  const campaignIds = validateCampaignIds(payload.campaign_ids)
  if (typeof campaignIds === 'string') return json({ error: campaignIds }, 400)

  const { error } = await supa.rpc('set_hypothesis_campaigns', {
    p_hypothesis_id: hypothesis_id,
    p_campaign_ids: campaignIds,
  })
  if (error) {
    if (errCode(error) === '23503') return json({ error: 'one or more campaign_ids do not exist' }, 400)
    if (error.message?.includes('unknown hypothesis id')) {
      return json({ error: 'unknown hypothesis id' }, 404)
    }
    return json({ error: error.message }, 500)
  }
  return json({ ok: true })
}

/** Set or clear which hypothesis a saved search executes (saved_searches.hypothesis_id). */
async function assignSearch(
  supa: ReturnType<typeof db>,
  payload: Record<string, unknown>,
): Promise<Response> {
  const search_id = payload.search_id
  if (typeof search_id !== 'number' || !Number.isInteger(search_id) || search_id <= 0) {
    return json({ error: 'search_id must be a positive integer' }, 400)
  }
  const hypothesis_id = payload.hypothesis_id
  if (
    hypothesis_id !== null &&
    (typeof hypothesis_id !== 'number' || !Number.isInteger(hypothesis_id) || hypothesis_id <= 0)
  ) {
    return json({ error: 'hypothesis_id must be a positive integer or null' }, 400)
  }
  const { data, error } = await supa
    .from('saved_searches')
    .update({ hypothesis_id })
    .eq('id', search_id)
    .select()
    .single()
  if (error) {
    if (errCode(error) === '23503') return json({ error: 'unknown hypothesis id' }, 400)
    if (errCode(error) === 'PGRST116') return json({ error: 'unknown search id' }, 404)
    return json({ error: error.message }, 500)
  }
  return json({ ok: true, search: data })
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
      case 'save_icp':
        return saveEntity(supa, 'icps', 'icp', payload, validateIcp, 'an ICP with that name already exists')
      case 'delete_icp':
        return deleteEntity(supa, 'icps', payload)
      case 'save_icp_persona':
        return saveEntity(
          supa, 'icp_personas', 'persona', payload, validatePersona,
          'a persona of that kind already exists for this ICP',
        )
      case 'delete_icp_persona':
        return deleteEntity(supa, 'icp_personas', payload)
      case 'save_icp_industry':
        return saveEntity(
          supa, 'icp_industries', 'industry', payload, validateIndustry,
          'an industry with that name already exists for this ICP',
        )
      case 'delete_icp_industry':
        return deleteEntity(supa, 'icp_industries', payload)
      case 'save_hypothesis':
        return saveEntity(
          supa, 'hypotheses', 'hypothesis', payload, validateHypothesis,
          'a hypothesis with that name already exists',
        )
      case 'delete_hypothesis':
        return deleteEntity(supa, 'hypotheses', payload)
      case 'set_hypothesis_campaigns':
        return setHypothesisCampaigns(supa, payload)
      case 'assign_search':
        return assignSearch(supa, payload)
      default:
        return json({ error: 'unknown action' }, 400)
    }
  }

  return savePlaybook(supa, payload)
}

export const POST = (req: Request) => handle(req)
