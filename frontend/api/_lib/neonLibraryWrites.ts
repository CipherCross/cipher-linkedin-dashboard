/**
 * The Neon implementations of `/api/playbook`'s thirteen actions.
 *
 * Same contract as `neonWrites.ts`, and the same seams: **validation is not
 * repeated here** — `playbook.ts` validates with `_lib/savedSearch.ts` and
 * `_lib/icp.ts` and hands over an already-normalized patch, so one definition of
 * a legal ICP survives the split. What this module owns is the operation
 * selection, the transaction boundary, the status codes and the response body,
 * and the body is asserted to match the Supabase path's because the browser
 * cannot tell which provider answered.
 *
 * ## The genericity moved, it did not disappear
 *
 * `playbook.ts` serves nine actions from `saveEntity(supa, table, bodyKey, …)`,
 * generic over a **table-name string**. That shape cannot survive a
 * named-operation allowlist (see `operations/libraryWrites.ts`), so the SQL side
 * became fifteen fixed statements — and the dispatch side stayed generic, over a
 * closed union of five entities. `LIBRARY_ENTITIES` below is that union: adding
 * a table means adding operations *and* an entry, which is precisely the review
 * step the string parameter skipped.
 *
 * ## The admin rule is re-checked against the database being written
 *
 * `playbook.ts` gates every action with `guardAdmin`, which reads the role out of
 * **Supabase**. The relations written here carry only an *active member* policy
 * (`icps_active_member` and its siblings in baseline step `002`) — admin is an
 * application rule, not a database one — so a Neon write that trusted the
 * Supabase role would be authorized entirely by the provider it is leaving. The
 * role is therefore taken again from Neon's `team_members` through
 * `resolveRequestActor`, and both must say admin. That is strictly narrower than
 * today, and it is the same argument `neonWrites.ts` makes for the member gate.
 *
 * ## No transaction spans two actions, because no action writes twice
 *
 * Unlike `set_stage` or the import, every action here is a single statement —
 * even `set_hypothesis_campaigns`, whose delete-and-insert is inside the
 * baseline function. So each opens one `store.transaction` around one `execute`,
 * which is not ceremony: `transaction` is where the actor id is published, and
 * the RLS policies read it from there.
 */

import { AuthorizationError, authorizationResponse } from './auth.js'
import {
  LIBRARY_WRITE_COMMANDS,
  type CampaignContextResult,
  type EntityWriteResult,
  type HypothesisRow,
  type IcpIndustryRow,
  type IcpPersonaRow,
  type IcpRow,
  type SavedSearchRow,
} from './data/operations/index.js'
import {
  DataStoreConstraintError,
  type DataStoreTransaction,
} from './data/contracts.js'
import { neonWriter, type NeonWriteDeps, type NeonWriter } from './neonWrites.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/**
 * The five entities `saveEntity`/`deleteEntity` were generic over, named.
 *
 * `notFoundLabel` reproduces the Supabase path's two different phrasings rather
 * than tidying them: `saveEntity` says `unknown ${bodyKey} id` ("unknown icp
 * id") and `deleteEntity` says `unknown ${table} id` ("unknown icps id"). They
 * are inconsistent, they are what the browser sees today, and unifying them is a
 * product change this session is not making.
 */
export type LibraryEntity = 'icp' | 'persona' | 'industry' | 'hypothesis' | 'search'

interface EntityOperations {
  readonly insert: string
  readonly update: string
  readonly remove: string
  /** The `unknown … id` text a failed UPDATE answers with. */
  readonly updateNotFound: string
  /** The `unknown … id` text a failed DELETE answers with. */
  readonly deleteNotFound: string
}

const LIBRARY_ENTITIES: Readonly<Record<LibraryEntity, EntityOperations>> = {
  icp: {
    insert: LIBRARY_WRITE_COMMANDS.insertIcp,
    update: LIBRARY_WRITE_COMMANDS.updateIcp,
    remove: LIBRARY_WRITE_COMMANDS.deleteIcp,
    updateNotFound: 'unknown icp id',
    deleteNotFound: 'unknown icps id',
  },
  persona: {
    insert: LIBRARY_WRITE_COMMANDS.insertPersona,
    update: LIBRARY_WRITE_COMMANDS.updatePersona,
    remove: LIBRARY_WRITE_COMMANDS.deletePersona,
    updateNotFound: 'unknown persona id',
    deleteNotFound: 'unknown icp_personas id',
  },
  industry: {
    insert: LIBRARY_WRITE_COMMANDS.insertIndustry,
    update: LIBRARY_WRITE_COMMANDS.updateIndustry,
    remove: LIBRARY_WRITE_COMMANDS.deleteIndustry,
    updateNotFound: 'unknown industry id',
    deleteNotFound: 'unknown icp_industries id',
  },
  hypothesis: {
    insert: LIBRARY_WRITE_COMMANDS.insertHypothesis,
    update: LIBRARY_WRITE_COMMANDS.updateHypothesis,
    remove: LIBRARY_WRITE_COMMANDS.deleteHypothesis,
    updateNotFound: 'unknown hypothesis id',
    deleteNotFound: 'unknown hypotheses id',
  },
  search: {
    insert: LIBRARY_WRITE_COMMANDS.insertSavedSearch,
    update: LIBRARY_WRITE_COMMANDS.updateSavedSearch,
    remove: LIBRARY_WRITE_COMMANDS.deleteSavedSearch,
    updateNotFound: 'unknown search id',
    deleteNotFound: 'unknown search id',
  },
}

/** The row type each entity's statements return, for the caller's response. */
export type LibraryRow =
  | IcpRow
  | IcpPersonaRow
  | IcpIndustryRow
  | HypothesisRow
  | SavedSearchRow

function safeErrorLabel(error: unknown): string {
  if (error instanceof Error) return error.name
  return 'UnknownError'
}

/**
 * Turn a store failure into the response the Supabase path would have given.
 *
 * The two constraint kinds are the whole reason `DataStoreConstraintError`
 * exists: PostgREST reports them as `error.code` `23505` / `23503` and
 * `playbook.ts` maps those to 409 and 400. Everything else is a 500 whose text
 * is composed, never quoted — the driver's message can carry a hostname.
 */
function libraryFailure(
  error: unknown,
  what: string,
  conflictMessage: string,
): Response {
  const denial = authorizationResponse(error)
  if (denial) return denial
  if (error instanceof DataStoreConstraintError) {
    if (error.kind === 'unique') return json({ error: conflictMessage }, 409)
    return json({ error: 'a referenced row does not exist' }, 400)
  }
  console.error(`Neon library write failed (${what}):`, safeErrorLabel(error))
  return json({ error: `Could not ${what}` }, 500)
}

/**
 * Resolve the actor and refuse a non-admin.
 *
 * The refusal is `AuthorizationError`, so it reaches the caller through
 * `authorizationResponse` with the same 403 body `guardAdmin` produces — the
 * browser sees one message whichever provider or whichever check refused.
 */
async function adminWriter(
  request: Request,
  deps: NeonWriteDeps,
): Promise<NeonWriter> {
  const writer = await neonWriter(request, deps)
  if (writer.actor.role !== 'admin') {
    throw new AuthorizationError(403, 'Admin access required')
  }
  return writer
}

/** One `execute` inside one transaction, which is every action in this module. */
async function inTransaction<TResult>(
  request: Request,
  deps: NeonWriteDeps,
  work: (transaction: DataStoreTransaction) => Promise<TResult>,
): Promise<TResult> {
  const writer = await adminWriter(request, deps)
  return writer.store.transaction(writer.actor, work)
}

// ---------------------------------------------------------------------------
// save_icp / save_icp_persona / save_icp_industry / save_hypothesis / save_search
// ---------------------------------------------------------------------------

export interface NeonSaveEntityInput {
  readonly entity: LibraryEntity
  /** Present for an update, absent for an insert. Already range-checked. */
  readonly id?: number
  /**
   * The validated, normalized patch — only keys the caller supplied.
   *
   * Typed as an index-free object rather than `Record<string, unknown>` so the
   * validators' named result types (`NormalizedSearch` has no index signature)
   * pass without a cast at every call site. Nothing here reads a key; the patch
   * is serialized whole and the *statement* decides which columns exist.
   */
  readonly patch: object
  /** The key the row is returned under, e.g. `icp`. */
  readonly bodyKey: string
  /** The 409 text, which differs per entity and belongs to the endpoint. */
  readonly conflictMessage: string
}

export async function neonSaveEntity(
  request: Request,
  input: NeonSaveEntityInput,
  deps: NeonWriteDeps = {},
): Promise<Response> {
  const entity = LIBRARY_ENTITIES[input.entity]
  const isUpdate = input.id !== undefined
  try {
    return await inTransaction(request, deps, async (transaction) => {
      const result = await transaction.execute<EntityWriteResult<LibraryRow>>({
        operation: isUpdate ? entity.update : entity.insert,
        params: isUpdate
          ? { id: input.id ?? 0, patchJson: JSON.stringify(input.patch) }
          : { patchJson: JSON.stringify(input.patch) },
      })
      // An UPDATE that matched nothing is an unknown id; an INSERT cannot
      // return zero rows without having raised, so this branch is the update's.
      if (result.rowCount === 0) {
        return json({ error: entity.updateNotFound }, 404)
      }
      return json({ ok: true, [input.bodyKey]: result.row })
    })
  } catch (error) {
    return libraryFailure(error, 'save the entry', input.conflictMessage)
  }
}

// ---------------------------------------------------------------------------
// the five deletes
// ---------------------------------------------------------------------------

export async function neonDeleteEntity(
  request: Request,
  input: { readonly entity: LibraryEntity; readonly id: number },
  deps: NeonWriteDeps = {},
): Promise<Response> {
  const entity = LIBRARY_ENTITIES[input.entity]
  try {
    return await inTransaction(request, deps, async (transaction) => {
      const result = await transaction.execute<
        EntityWriteResult<{ readonly id: number }>
      >({
        operation: entity.remove,
        params: { id: input.id },
      })
      if (result.rowCount === 0) {
        return json({ error: entity.deleteNotFound }, 404)
      }
      return json({ ok: true })
    })
  } catch (error) {
    return libraryFailure(error, 'delete the entry', 'conflict')
  }
}

// ---------------------------------------------------------------------------
// set_hypothesis_campaigns
// ---------------------------------------------------------------------------

/**
 * The baseline function raises `unknown hypothesis id` as a plain exception,
 * which the driver wraps into a `DataStoreTransactionError` whose message is
 * `` `${what}: ${originalMessage}` ``. The Supabase path reads that same text
 * (`error.message?.includes('unknown hypothesis id')`) to answer 404, and this
 * does too — restricted to a **substring this application authored**, in a
 * message that names no relation and no host. It is the one place in the slice
 * where a status is decided from driver text, and it is recorded rather than
 * hidden: removing it means the function has to signal the case structurally,
 * which is a baseline change and therefore a ledger step.
 */
export async function neonSetHypothesisCampaigns(
  request: Request,
  input: {
    readonly hypothesisId: number
    readonly campaignIds: readonly string[]
  },
  deps: NeonWriteDeps = {},
): Promise<Response> {
  try {
    return await inTransaction(request, deps, async (transaction) => {
      await transaction.execute<{ readonly ok: true }>({
        operation: LIBRARY_WRITE_COMMANDS.setHypothesisCampaigns,
        params: {
          hypothesisId: input.hypothesisId,
          campaignIds: input.campaignIds,
        },
      })
      return json({ ok: true })
    })
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('unknown hypothesis id')
    ) {
      return json({ error: 'unknown hypothesis id' }, 404)
    }
    if (
      error instanceof DataStoreConstraintError &&
      error.kind === 'foreign_key'
    ) {
      return json({ error: 'one or more campaign_ids do not exist' }, 400)
    }
    return libraryFailure(error, 'save the campaign set', 'conflict')
  }
}

// ---------------------------------------------------------------------------
// assign_search
// ---------------------------------------------------------------------------

/**
 * Note the deliberate asymmetry with `saveEntity`: a dangling `hypothesis_id`
 * here is `unknown hypothesis id`, not the generic `a referenced row does not
 * exist`, because the payload has exactly one foreign key and naming it is the
 * Supabase path's behaviour.
 */
export async function neonAssignSearch(
  request: Request,
  input: {
    readonly searchId: number
    readonly hypothesisId: number | null
  },
  deps: NeonWriteDeps = {},
): Promise<Response> {
  try {
    return await inTransaction(request, deps, async (transaction) => {
      const result = await transaction.execute<
        EntityWriteResult<SavedSearchRow>
      >({
        operation: LIBRARY_WRITE_COMMANDS.assignSearchHypothesis,
        params: {
          searchId: input.searchId,
          hypothesisId: input.hypothesisId,
        },
      })
      if (result.rowCount === 0) return json({ error: 'unknown search id' }, 404)
      return json({ ok: true, search: result.row })
    })
  } catch (error) {
    if (
      error instanceof DataStoreConstraintError &&
      error.kind === 'foreign_key'
    ) {
      return json({ error: 'unknown hypothesis id' }, 400)
    }
    return libraryFailure(error, 'assign the search', 'conflict')
  }
}

// ---------------------------------------------------------------------------
// save_campaign_context
// ---------------------------------------------------------------------------

export async function neonSaveCampaignContext(
  request: Request,
  input: { readonly campaignId: string; readonly context: string },
  deps: NeonWriteDeps = {},
): Promise<Response> {
  try {
    return await inTransaction(request, deps, async (transaction) => {
      const result = await transaction.execute<CampaignContextResult>({
        operation: LIBRARY_WRITE_COMMANDS.saveCampaignContext,
        params: { campaignId: input.campaignId, context: input.context },
      })
      if (result.rowCount === 0) {
        return json({ error: 'unknown campaign_id' }, 404)
      }
      return json({
        ok: true,
        campaign_id: result.row?.id ?? input.campaignId,
        briefing_context: result.row?.briefing_context ?? null,
        briefing_context_updated_at:
          result.row?.briefing_context_updated_at ?? null,
      })
    })
  } catch (error) {
    return libraryFailure(error, 'save the campaign context', 'conflict')
  }
}

// ---------------------------------------------------------------------------
// the legacy playbook save
// ---------------------------------------------------------------------------

export async function neonSavePlaybook(
  request: Request,
  input: { readonly content: string },
  deps: NeonWriteDeps = {},
): Promise<Response> {
  try {
    return await inTransaction(request, deps, async (transaction) => {
      await transaction.execute<{ readonly updated_at: string }>({
        operation: LIBRARY_WRITE_COMMANDS.savePlaybook,
        params: { content: input.content },
      })
      return json({ ok: true })
    })
  } catch (error) {
    return libraryFailure(error, 'save the playbook', 'conflict')
  }
}
