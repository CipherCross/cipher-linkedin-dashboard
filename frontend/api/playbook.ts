// Playbook writer + Search Library writer + ICP/Hypothesis/campaign-context writer.
//
// Historically this endpoint persisted only the single global Markdown playbook that
// grounds the AI conversation coach (/api/coach). It now also owns the Search Library
// (saved_searches) writes and the ICP/Hypothesis layer (migration 043) via an `action`
// dispatch — folded in here rather than new files because frontend/api is at the
// Vercel Hobby 12-function cap. The writes themselves live in
// _lib/neonLibraryWrites.ts; this file validates and dispatches.
//
// Back-compatible: a POST with NO `action` key is the legacy playbook save
// ({content}); a POST with action:'save_search' | 'delete_search' hits the Search
// Library; action:'save_icp' | 'delete_icp' | 'save_icp_persona' | 'delete_icp_persona' |
// 'save_icp_industry' | 'delete_icp_industry' | 'save_hypothesis' | 'delete_hypothesis' |
// 'set_hypothesis_campaigns' | 'assign_search' hits the ICP/Hypothesis layer (see
// _lib/icp.ts); action:'save_campaign_context' updates the team background supplied
// to AI briefings. Sequence Builder's list/detail/save/archive/comment actions
// also share this endpoint to stay within the function cap, but require any
// active member rather than an admin. All older paths keep the admin guard.
//
// Every other path requires a verified application admin.
import { AuthorizationError, authorizationResponse } from './_lib/auth.js'
import { unavailableResponse } from './_lib/data/availability.js'
import { validateSearch } from './_lib/savedSearch.js'
import {
  validateCampaignIds,
  validateHypothesis,
  validateIcp,
  validateIndustry,
  validatePersona,
} from './_lib/icp.js'
import {
  neonAssignSearch,
  neonDeleteEntity,
  neonSaveCampaignContext,
  neonSaveEntity,
  neonSavePlaybook,
  neonSetHypothesisCampaigns,
  type LibraryEntity,
} from './_lib/neonLibraryWrites.js'
import { neonWriter } from './_lib/neonWrites.js'
import { handleSequenceAction, isSequenceAction } from './_lib/sequenceBuilder.js'
import { handleSequencePublishAction, isSequencePublishAction } from './_lib/sequencePublish.js'

export const maxDuration = 10

// Generous cap — a playbook is prose, not a payload, but bound it so a runaway
// paste can't bloat every coach prompt (which embeds the whole document).
const MAX_CONTENT_BYTES = 100_000
const MAX_CAMPAIGN_CONTEXT_CHARS = 4_000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

// --- legacy: single global playbook (no `action` key) ----------------------

async function savePlaybook(
  payload: Record<string, unknown>,
  req: Request,
) {
  const content = payload.content
  if (typeof content !== 'string') {
    return json({ error: 'content (string) is required' }, 400)
  }
  if (content.length > MAX_CONTENT_BYTES) {
    return json({ error: 'playbook too large' }, 413)
  }

  return neonSavePlaybook(req, { content })
}

// --- save_search: insert (no id) or partial-patch update (id present) ------

const SEARCH_CONFLICT = 'a search with that name already exists for this platform'

async function saveSearch(
  payload: Record<string, unknown>,
  req: Request,
) {
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

  if (isUpdate && Object.keys(normalized).length === 0) {
    return json({ error: 'no fields to update' }, 400)
  }

  return neonSaveEntity(req, {
    entity: 'search',
    ...(isUpdate ? { id: id as number } : {}),
    patch: normalized,
    bodyKey: 'search',
    conflictMessage: SEARCH_CONFLICT,
  })
}

// --- delete_search: hard delete (page-only; NOT an AI tool) ----------------

async function deleteSearch(
  payload: Record<string, unknown>,
  req: Request,
) {
  const id = payload.id
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return json({ error: 'id must be a positive integer' }, 400)
  }
  return neonDeleteEntity(req, { entity: 'search', id })
}

// --- ICP / Hypothesis layer (migration 043) ---------------------------------
// Four entities (icps, icp_personas, icp_industries, hypotheses) share the same
// insert-or-partial-patch-update shape as save_search above, so a generic pair of
// helpers covers all of them instead of four near-identical copies. save_search /
// delete_search above keep their own platform-scoped conflict message.

type EntityValidator<T> = (input: unknown, requireCore: boolean) => T | string

/** Insert (no id) or partial-patch update (id present) one row of `entity`,
 *  keyed by `bodyKey` in the request payload (e.g. payload.icp). A relation may
 *  not be a run-time string behind an allowlist entry, so the closed union
 *  selects one of fifteen fixed statements. */
async function saveEntity<T extends Record<string, unknown>>(
  entity: LibraryEntity,
  bodyKey: string,
  payload: Record<string, unknown>,
  validate: EntityValidator<T>,
  conflictMessage: string,
  req: Request,
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

  if (isUpdate && Object.keys(normalized).length === 0) {
    return json({ error: 'no fields to update' }, 400)
  }

  return neonSaveEntity(req, {
    entity,
    ...(isUpdate ? { id: id as number } : {}),
    patch: normalized,
    bodyKey,
    conflictMessage,
  })
}

/** Hard delete one row of `entity` by id (cascades handle child rows —
 *  icp_personas/icp_industries/hypothesis_campaigns all `on delete cascade`). */
async function deleteEntity(
  entity: LibraryEntity,
  payload: Record<string, unknown>,
  req: Request,
): Promise<Response> {
  const id = payload.id
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return json({ error: 'id must be a positive integer' }, 400)
  }
  return neonDeleteEntity(req, { entity, id })
}

/** Replace a hypothesis's campaign set atomically, so a campaign can't be left
 *  half-migrated between hypotheses. */
async function setHypothesisCampaigns(
  payload: Record<string, unknown>,
  req: Request,
): Promise<Response> {
  const hypothesis_id = payload.hypothesis_id
  if (typeof hypothesis_id !== 'number' || !Number.isInteger(hypothesis_id) || hypothesis_id <= 0) {
    return json({ error: 'hypothesis_id must be a positive integer' }, 400)
  }
  const campaignIds = validateCampaignIds(payload.campaign_ids)
  if (typeof campaignIds === 'string') return json({ error: campaignIds }, 400)

  return neonSetHypothesisCampaigns(req, { hypothesisId: hypothesis_id, campaignIds })
}

/** Set or clear which hypothesis a saved search executes (saved_searches.hypothesis_id). */
async function assignSearch(
  payload: Record<string, unknown>,
  req: Request,
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
  return neonAssignSearch(req, { searchId: search_id, hypothesisId: hypothesis_id })
}

async function saveCampaignContext(
  payload: Record<string, unknown>,
  req: Request,
): Promise<Response> {
  const campaignId = payload.campaign_id
  const rawContext = payload.briefing_context
  if (typeof campaignId !== 'string' || !campaignId) {
    return json({ error: 'campaign_id (string) is required' }, 400)
  }
  if (typeof rawContext !== 'string') {
    return json({ error: 'briefing_context (string) is required' }, 400)
  }
  const context = rawContext.trim()
  if (context.length > MAX_CAMPAIGN_CONTEXT_CHARS) {
    return json(
      { error: `briefing_context must be at most ${MAX_CAMPAIGN_CONTEXT_CHARS} characters` },
      413,
    )
  }

  return neonSaveCampaignContext(req, { campaignId, context })
}

async function handle(req: Request): Promise<Response> {
  // Sequence Builder shares this endpoint to stay within the Vercel Hobby
  // function cap, but unlike the older strategy libraries it is a workspace for
  // every active member. Peek through a cloned body so the existing admin paths
  // keep their original authenticate-before-parse behavior.
  let sequencePayload: Record<string, unknown> | null = null
  try {
    const candidate = (await req.clone().json()) as unknown
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      sequencePayload = candidate as Record<string, unknown>
    }
  } catch {
    // The canonical parse below preserves the existing invalid-JSON response.
  }
  if (isSequenceAction(sequencePayload?.action)) {
    return handleSequenceAction(req, sequencePayload as Record<string, unknown>)
  }
  if (isSequencePublishAction(sequencePayload?.action)) {
    return handleSequencePublishAction(req, sequencePayload as Record<string, unknown>)
  }

  try {
    const writer = await neonWriter(req)
    if (writer.actor.role !== 'admin') {
      throw new AuthorizationError(403, 'Admin access required')
    }
  } catch (error) {
    const denial = authorizationResponse(error)
    if (denial) return denial
    // The database was not reached, so no membership decision was taken and
    // the answer below would be a claim about one. Named cause, honest status.
    const unavailable = unavailableResponse(error)
    if (unavailable) return unavailable
    console.error(
      'Playbook authorization failed:',
      error instanceof Error ? error.name : 'UnknownError',
    )
    return json({ error: 'Could not verify team access' }, 500)
  }

  let payload: Record<string, unknown>
  try {
    payload = (await req.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  // Route on `action`. Absent action => the legacy playbook save (unchanged).
  const action = (payload as { action?: unknown } | null)?.action
  if (typeof action === 'string') {
    switch (action) {
      case 'save_search':
        return saveSearch(payload, req)
      case 'delete_search':
        return deleteSearch(payload, req)
      case 'save_icp':
        return saveEntity(
          'icp', 'icp', payload, validateIcp,
          'an ICP with that name already exists', req,
        )
      case 'delete_icp':
        return deleteEntity('icp', payload, req)
      case 'save_icp_persona':
        return saveEntity(
          'persona', 'persona', payload, validatePersona,
          'a persona of that kind already exists for this ICP', req,
        )
      case 'delete_icp_persona':
        return deleteEntity('persona', payload, req)
      case 'save_icp_industry':
        return saveEntity(
          'industry', 'industry', payload, validateIndustry,
          'an industry with that name already exists for this ICP', req,
        )
      case 'delete_icp_industry':
        return deleteEntity('industry', payload, req)
      case 'save_hypothesis':
        return saveEntity(
          'hypothesis', 'hypothesis', payload, validateHypothesis,
          'a hypothesis with that name already exists', req,
        )
      case 'delete_hypothesis':
        return deleteEntity('hypothesis', payload, req)
      case 'set_hypothesis_campaigns':
        return setHypothesisCampaigns(payload, req)
      case 'assign_search':
        return assignSearch(payload, req)
      case 'save_campaign_context':
        return saveCampaignContext(payload, req)
      default:
        return json({ error: 'unknown action' }, 400)
    }
  }

  return savePlaybook(payload, req)
}

export const POST = (req: Request) => handle(req)
