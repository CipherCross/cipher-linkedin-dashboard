// The member-facing half of the Airtable mirror, served on `/api/import`
// (the deployment is at its function cap):
//
//   POST ?op=airtable.sync   {full?: boolean}
//     any active member; runs the incremental sync within a time budget and
//     answers `done: false` when the caller should call again to resume.
//   POST ?op=company.link    {instance_id, profile_url, base_key, record_id | null}
//     any active member; sets (or, with record_id null, drops) a manual link.
//
// Both resolve the actor from the session before any database call; RLS
// re-checks it.

import { authorizationResponse } from './auth.js'
import { unavailableResponse } from './data/availability.js'
import { AIRTABLE_MIRROR_COMMANDS, type LinkRow } from './data/operations/airtableMirror.js'
import { neonWriter, type NeonWriteDeps } from './neonWrites.js'
import { syncAirtable, type AirtableSyncDeps } from './airtableSync.js'
import { isAirtableBase } from '../../src/lib/airtableBases.js'

export const AIRTABLE_SYNC_OP = 'airtable.sync'
export const COMPANY_LINK_OP = 'company.link'

/** Leaves room inside the route's 60 s for the link refresh and the response. */
export const MEMBER_SYNC_BUDGET_MS = 40_000

const RECORD_ID = /^rec[A-Za-z0-9]{14}$/

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

async function readBody(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const parsed = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return json({ error: 'JSON body must be an object' }, 400)
    }
    return parsed as Record<string, unknown>
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
}

function failure(error: unknown, label: string): Response {
  const denial = authorizationResponse(error)
  if (denial) return denial
  const unavailable = unavailableResponse(error)
  if (unavailable) return unavailable
  console.error(`${label} failed:`, error instanceof Error ? error.name : 'UnknownError')
  return json({ error: `${label} failed` }, 500)
}

export interface AirtableRouteDeps extends NeonWriteDeps {
  readonly sync?: Partial<Omit<AirtableSyncDeps, 'store' | 'actor'>>
}

export async function handleAirtableSync(req: Request, deps: AirtableRouteDeps = {}): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') return json({ error: `${req.method} is not allowed` }, 405)
  try {
    const writer = await neonWriter(req, deps)
    const body = await readBody(req)
    if (body instanceof Response) return body
    const result = await syncAirtable(
      { ...deps.sync, store: writer.store, actor: writer.actor },
      { budgetMs: MEMBER_SYNC_BUDGET_MS, full: body.full === true },
    )
    return json(result)
  } catch (error) {
    return failure(error, 'Airtable sync')
  }
}

export async function handleCompanyLink(req: Request, deps: NeonWriteDeps = {}): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') return json({ error: `${req.method} is not allowed` }, 405)
  try {
    const writer = await neonWriter(req, deps)
    const body = await readBody(req)
    if (body instanceof Response) return body
    const instanceId = typeof body.instance_id === 'string' ? body.instance_id.trim() : ''
    const profileUrl = typeof body.profile_url === 'string' ? body.profile_url.trim() : ''
    if (!instanceId || instanceId.length > 200 || !profileUrl || profileUrl.length > 1000) {
      return json({ error: 'instance_id and profile_url are required' }, 400)
    }

    if (body.record_id === null) {
      await writer.store.transaction(writer.actor, (transaction) =>
        transaction.execute<number>({
          operation: AIRTABLE_MIRROR_COMMANDS.clearManualLink,
          params: { instanceId, profileUrl },
        }),
      )
      return json({ ok: true, link: null })
    }

    const baseKey = body.base_key
    const recordId = typeof body.record_id === 'string' ? body.record_id.trim() : ''
    if (!isAirtableBase(baseKey) || !RECORD_ID.test(recordId)) {
      return json({ error: 'base_key and record_id must name an Airtable company' }, 400)
    }
    const link = await writer.store.transaction(writer.actor, (transaction) =>
      transaction.execute<LinkRow | null>({
        operation: AIRTABLE_MIRROR_COMMANDS.setManualLink,
        params: { instanceId, profileUrl, baseKey, recordId },
      }),
    )
    if (!link) return json({ error: 'lead or company not found' }, 404)
    return json({ ok: true, link })
  } catch (error) {
    return failure(error, 'Company link')
  }
}
