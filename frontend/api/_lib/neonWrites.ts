/**
 * The Neon implementations of the non-AI writes.
 *
 * Each function here is the `neon` branch of one action in `api/pipeline.ts` or
 * `api/_lib/conversationImport.ts`. **Validation is not repeated here.** The
 * endpoint validates, then hands over already-checked values, so there is exactly
 * one definition of what a legal `stage` or a legal `next_follow_up_date` is and
 * the two providers cannot drift on it. What each function owns is the reads, the
 * writes, the transaction boundary and the response body — and the response body
 * is asserted to match the Supabase path's, because the browser does not know
 * which provider answered.
 *
 * ## Authorization: the database decides, and it decides differently from today
 *
 * `resolveApplicationActor` selects exactly the authenticator the deployed SPA
 * selected. Legacy deployments continue to send a Supabase bearer; identity
 * deployments send the self-hosted Better Auth HttpOnly cookie and explicitly
 * disable bearer fallback. Both subjects pass through `identity_resolve_actor`,
 * which answers with the canonical actor id and role from this database.
 *
 * Two consequences worth being explicit about:
 *
 * - **The role comes from Neon's `team_members`, not from a Supabase read.** On
 *   the Supabase path `guardMember` reads the role out of Supabase and the
 *   endpoint's admin check trusts it. Here the role is whatever the database that
 *   is about to be written says it is, which is the only place it can be checked
 *   without a race.
 * - **The admin refusal in the endpoint is response shaping, not the gate.**
 *   Every relation written here carries `FOR ALL TO app_runtime` with a
 *   `WITH CHECK` that re-derives the actor from `app.actor_id`, so a write by a
 *   non-member fails in the database whatever TypeScript did. The live suite
 *   proves that by writing with a non-member actor and watching it refuse.
 *
 * ## One transaction per action, and the actor name is read inside it
 *
 * Every function below opens exactly one `store.transaction`. The reads a write
 * depends on — the previous stage, the acting member's name, the thread's
 * existing bodies — happen inside it, so nothing is decided from a value that
 * another request could have changed in between. The cost is round trips inside
 * the transaction; the benefit is that the audit row and the mutation are the
 * same commit.
 */

import {
  AuthorizationError,
  authorizationResponse,
} from './auth.js'
import { getDataStore } from './data/store.js'
import {
  CONVERSATION_WRITE_COMMANDS,
  CONVERSATION_WRITE_OPERATIONS,
  PIPELINE_WRITE_COMMANDS,
  PIPELINE_WRITE_OPERATIONS,
  type ActorDisplayNameRow,
  type AppendEventResult,
  type BackfillMilestonesResult,
  type DeleteManualMessageResult,
  type DeleteResult,
  type EditManualMessageResult,
  type LeadDemographicsRow,
  type LeadForImportRow,
  type LeadNoteResult,
  type LeadPipelineFieldsRow,
  type SetGenderResult,
  type SetStageResult,
  type StageChangedAtMode,
  type ThreadDedupKeyRow,
} from './data/operations/index.js'
import {
  DataStoreContractError,
  MAX_PAGE_SIZE,
  type ActorContext,
  type DataStore,
  type DataStoreTransaction,
  type Page,
} from './data/contracts.js'
import {
  resolveApplicationActor,
  type ApplicationAuthPath,
} from './identity/application.js'
import type { IdentityProvider } from './identity/provider.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/**
 * Log a failure by class, never by message.
 *
 * The driver composes a failure as `` `${what}: ${originalMessage}` ``, and for a
 * connection-level failure the original text embeds the database hostname. There
 * are two other copies of this function, in `api/activity-daily.ts` and
 * `api/identity.ts`. A `_lib` module importing from a function file would invert
 * the dependency, and consolidating the three touches files this session does not
 * own, so the duplication is recorded rather than resolved.
 */
function safeErrorLabel(error: unknown): string {
  if (error instanceof DataStoreContractError) return `${error.name}(${error.code})`
  if (error instanceof Error) return error.name
  return 'UnknownError'
}

/** A store failure the caller is not entitled to see the text of. */
function storeFailure(error: unknown, what: string): Response {
  const denial = authorizationResponse(error)
  if (denial) return denial
  console.error(`Neon write failed (${what}):`, safeErrorLabel(error))
  return json({ error: `Could not ${what}` }, 500)
}

export interface NeonWriter {
  readonly store: DataStore
  readonly actor: ActorContext
}

/**
 * The one test seam on this module.
 *
 * A store can be supplied instead of the module-scope one, which is how the live
 * suite proves atomicity: it builds the **real** application registry with one
 * audit-row operation swapped for one that raises, and shows the paired mutation
 * absent afterwards. Injecting the failure is the honest way to test a rollback —
 * the alternative is contriving a data value that happens to violate a
 * constraint, which tests the constraint rather than the transaction.
 *
 * It is an argument and not an environment variable for the reason S17 recorded:
 * an env var that exists only for tests is indistinguishable at a glance from one
 * a deployment is supposed to set. Every endpoint call site omits it.
 */
export interface NeonWriteDeps {
  readonly store?: DataStore
  /** Test seam for the deployment-selected application authenticator. */
  readonly authPath?: ApplicationAuthPath
  /** Identity provider used only when `authPath` is `identity`. */
  readonly identity?: IdentityProvider
  /**
   * The provider name the transitional bearer resolves under. Defaults to
   * `session.ts`'s `LEGACY_PROVIDER_NAME`, which is what production uses; the
   * live suite overrides it because the baseline's identity fixtures are seeded
   * under `provider = 'fixture'`. Same seam, same reason as
   * `createActivityDailyHandler({ legacyProviderName })`.
   */
  readonly legacyProviderName?: string
}

/**
 * Resolve the actor once per request.
 *
 * The application-auth selector lazily constructs the identity provider only
 * for an identity deployment. The legacy path therefore retains its original
 * deployment prerequisites, while the Neon/Better Auth path has no Supabase
 * verifier dependency or fallback.
 */
export async function neonWriter(
  request: Request,
  deps: NeonWriteDeps = {},
): Promise<NeonWriter> {
  const store = deps.store ?? getDataStore()
  const resolved = await resolveApplicationActor(request, {
    store,
    authPath: deps.authPath,
    identity: deps.identity,
    legacyProviderName: deps.legacyProviderName,
  })
  return { store, actor: resolved.actor }
}

/** The acting member's display name, for an audit row. Read inside the caller's
 *  transaction so it cannot disagree with the role the same actor resolved with. */
async function actorName(transaction: DataStoreTransaction): Promise<string> {
  const page = await transaction.query<ActorDisplayNameRow>({
    operation: PIPELINE_WRITE_OPERATIONS.actorDisplayName,
    params: { actorId: transaction.actor.actorId },
    page: { limit: 1 },
  })
  const name = page.items[0]?.name
  if (!name) {
    // `resolveActor` already refused an inactive member, so an empty answer here
    // means the roster changed mid-request. Refusing is the only safe outcome:
    // an audit row with no actor is worse than a failed action.
    throw new AuthorizationError(403, 'Your account is not an active team member')
  }
  return name
}

/** Walk every page of a store read. Used for the import's dedup set. */
async function readAll<TRow>(
  transaction: DataStoreTransaction,
  operation: string,
  params: Record<string, string>,
): Promise<TRow[]> {
  const rows: TRow[] = []
  let cursor: string | null = null
  for (;;) {
    const page: Page<TRow> = await transaction.query<TRow>({
      operation,
      params,
      page: { limit: MAX_PAGE_SIZE, cursor },
    })
    rows.push(...page.items)
    if (!page.hasMore || page.nextCursor === null) break
    cursor = page.nextCursor
  }
  return rows
}

// ---------------------------------------------------------------------------
// set_stage.
// ---------------------------------------------------------------------------

export interface NeonSetStageInput {
  readonly leadId: string
  readonly stage: string | null
  readonly substatus: string | null
  readonly lostReason: string | null
}

export async function neonSetStage(
  request: Request,
  input: NeonSetStageInput,
  deps: NeonWriteDeps = {},
): Promise<Response> {
  let writer: NeonWriter
  try {
    writer = await neonWriter(request, deps)
  } catch (error) {
    return storeFailure(error, 'verify team access')
  }

  try {
    return await writer.store.transaction(writer.actor, async (transaction) => {
      const previous = await transaction.query<LeadPipelineFieldsRow>({
        operation: PIPELINE_WRITE_OPERATIONS.leadPipelineFields,
        params: { leadId: input.leadId },
        page: { limit: 1 },
      })
      const lead = previous.items[0]
      if (!lead) return json({ error: 'unknown lead_id' }, 404)

      // Identical short-circuit to the Supabase path, and it must stay identical:
      // it is what stops a board re-render appending an audit row per repaint.
      if (
        input.stage === lead.pipeline_stage &&
        input.substatus === lead.pipeline_substatus &&
        input.lostReason === lead.lost_reason
      ) {
        return json({ ok: true, changed: false })
      }

      const stageChanged = input.stage !== lead.pipeline_stage
      const changedAtMode: StageChangedAtMode =
        input.stage === null ? 'clear' : stageChanged ? 'set' : 'keep'
      const changedAt = changedAtMode === 'set' ? new Date().toISOString() : null

      const name = await actorName(transaction)

      const updated = await transaction.execute<SetStageResult>({
        operation: PIPELINE_WRITE_COMMANDS.setStage,
        params: {
          leadId: input.leadId,
          stage: input.stage,
          substatus: input.substatus,
          lostReason: input.lostReason,
          changedAtMode,
          changedAt,
        },
      })
      if (updated.rowCount === 0) return json({ error: 'unknown lead_id' }, 404)

      // The pairing. If this throws, the UPDATE above is rolled back and the
      // caller gets a 500 — where the Supabase path reports `event_error`
      // inside a 200 and leaves the stage moved with no audit row.
      await transaction.execute<AppendEventResult>({
        operation: PIPELINE_WRITE_COMMANDS.appendStageEvent,
        params: {
          leadId: input.leadId,
          actor: name,
          fromStage: lead.pipeline_stage,
          toStage: input.stage,
          fromSubstatus: lead.pipeline_substatus,
          toSubstatus: input.substatus,
          lostReason: input.lostReason,
        },
      })

      return json({
        ok: true,
        changed: true,
        pipeline_stage: updated.row?.pipeline_stage ?? null,
        pipeline_substatus: updated.row?.pipeline_substatus ?? null,
        lost_reason: updated.row?.lost_reason ?? null,
        ...(changedAtMode === 'clear'
          ? { pipeline_stage_changed_at: null }
          : changedAtMode === 'set'
            ? {
                pipeline_stage_changed_at:
                  updated.row?.pipeline_stage_changed_at ?? null,
              }
            : {}),
      })
    })
  } catch (error) {
    return storeFailure(error, 'save the stage change')
  }
}

// ---------------------------------------------------------------------------
// add_note / delete_note.
// ---------------------------------------------------------------------------

export async function neonAddNote(
  request: Request,
  input: { readonly leadId: string; readonly body: string },
  deps: NeonWriteDeps = {},
): Promise<Response> {
  let writer: NeonWriter
  try {
    writer = await neonWriter(request, deps)
  } catch (error) {
    return storeFailure(error, 'verify team access')
  }

  try {
    return await writer.store.transaction(writer.actor, async (transaction) => {
      const author = await actorName(transaction)
      const result = await transaction.execute<LeadNoteResult>({
        operation: PIPELINE_WRITE_COMMANDS.addNote,
        params: { leadId: input.leadId, author, body: input.body },
      })
      // Zero rows means the `SELECT … FROM leads` matched nothing. See the
      // operation's own note on why that is a row count and not an error.
      if (result.rowCount === 0) return json({ error: 'unknown lead_id' }, 404)
      return json({ ok: true, note: result.row })
    })
  } catch (error) {
    return storeFailure(error, 'save the note')
  }
}

export async function neonDeleteNote(
  request: Request,
  input: { readonly noteId: number },
  deps: NeonWriteDeps = {},
): Promise<Response> {
  let writer: NeonWriter
  try {
    writer = await neonWriter(request, deps)
  } catch (error) {
    return storeFailure(error, 'verify team access')
  }

  try {
    return await writer.store.transaction(writer.actor, async (transaction) => {
      const result = await transaction.execute<DeleteResult>({
        operation: PIPELINE_WRITE_COMMANDS.deleteNote,
        params: { noteId: input.noteId },
      })
      if (result.rowCount === 0) return json({ error: 'no note with that id' }, 404)
      return json({ ok: true, deleted: input.noteId })
    })
  } catch (error) {
    return storeFailure(error, 'delete the note')
  }
}

// ---------------------------------------------------------------------------
// set_gender.
// ---------------------------------------------------------------------------

export async function neonSetGender(
  request: Request,
  input: { readonly leadId: string; readonly gender: string | null },
  deps: NeonWriteDeps = {},
): Promise<Response> {
  let writer: NeonWriter
  try {
    writer = await neonWriter(request, deps)
  } catch (error) {
    return storeFailure(error, 'verify team access')
  }

  try {
    return await writer.store.transaction(writer.actor, async (transaction) => {
      const found = await transaction.query<LeadDemographicsRow>({
        operation: PIPELINE_WRITE_OPERATIONS.leadDemographics,
        params: { leadId: input.leadId },
        page: { limit: 1 },
      })
      const lead = found.items[0]
      if (!lead) return json({ error: 'unknown lead_id' }, 404)

      const reviewer = await actorName(transaction)
      const now = new Date().toISOString()
      const clearing = input.gender === null

      const updated = await transaction.execute<SetGenderResult>({
        operation: PIPELINE_WRITE_COMMANDS.setGender,
        params: {
          instanceId: lead.instance_id,
          profileUrl: lead.profile_url,
          gender: input.gender,
          confidence: clearing ? null : 1,
          demoModel: clearing ? null : 'manual',
          inferredAt: clearing ? null : now,
        },
      })

      // The audit row snapshots what the human overrode, so a value the human
      // themselves last set is *not* a prediction and is recorded as null —
      // identical to the Supabase path, and it is what keeps model precision
      // measurable from this table.
      const wasManual = lead.demo_model === 'manual'
      await transaction.execute<{ readonly id: string }>({
        operation: PIPELINE_WRITE_COMMANDS.appendGenderReview,
        params: {
          leadId: lead.id,
          instanceId: lead.instance_id,
          profileUrl: lead.profile_url,
          action: clearing ? 'clear' : 'set',
          predictedGender: wasManual ? null : lead.gender,
          predictedConfidence: wasManual ? null : lead.gender_confidence,
          predictedModel: wasManual ? null : lead.demo_model,
          predictedVersion: wasManual ? null : lead.gender_model_version,
          reviewedGender: input.gender,
          reviewer: reviewer.slice(0, 120),
        },
      })

      const row = updated.rows.find((candidate) => candidate.id === input.leadId)
      return json({ ok: true, ...(row ?? {}) })
    })
  } catch (error) {
    return storeFailure(error, 'save the demographics override')
  }
}

// ---------------------------------------------------------------------------
// set_instance_config.
// ---------------------------------------------------------------------------

export async function neonSetInstanceConfig(
  request: Request,
  input: {
    readonly instanceId: string
    /** Already stripped of bootstrap keys and size-checked by the endpoint. */
    readonly config: Record<string, unknown>
  },
  deps: NeonWriteDeps = {},
): Promise<Response> {
  let writer: NeonWriter
  try {
    writer = await neonWriter(request, deps)
  } catch (error) {
    return storeFailure(error, 'verify team access')
  }

  try {
    return await writer.store.transaction(writer.actor, async (transaction) => {
      const result = await transaction.execute<DeleteResult>({
        operation: PIPELINE_WRITE_COMMANDS.setInstanceConfig,
        params: {
          instanceId: input.instanceId,
          configJson: JSON.stringify(input.config),
        },
      })
      if (result.rowCount === 0) return json({ error: 'unknown instance_id' }, 404)
      return json({ ok: true, instance_id: input.instanceId })
    })
  } catch (error) {
    return storeFailure(error, 'save the notebook configuration')
  }
}

// ---------------------------------------------------------------------------
// conversation_import.
// ---------------------------------------------------------------------------

export interface NeonImportMessage {
  readonly direction: 'in' | 'out'
  readonly body: string
  /** ISO UTC, already normalized by the endpoint. */
  readonly sent_at: string
  readonly force: boolean
  /** `md5(body)`, computed by the endpoint so both providers use one definition. */
  readonly contentHash: string
}

export interface NeonImportInput {
  readonly instanceId: string
  readonly campaignId: string
  readonly profileUrl: string
  readonly messages: readonly NeonImportMessage[]
  /** The endpoint's own `normalizeForDedup`, passed in rather than re-implemented. */
  readonly normalize: (body: string) => string
}

export async function neonImportConversation(
  request: Request,
  input: NeonImportInput,
  deps: NeonWriteDeps = {},
): Promise<Response> {
  let writer: NeonWriter
  try {
    writer = await neonWriter(request, deps)
  } catch (error) {
    return storeFailure(error, 'verify team access')
  }

  try {
    return await writer.store.transaction(writer.actor, async (transaction) => {
      // First statement in the transaction, before anything is read: the lock is
      // what makes the read-then-insert below safe against a concurrent paste of
      // the same thread. See `conversationWrites.ts` on the shared key.
      await transaction.execute<{ readonly locked: true }>({
        operation: CONVERSATION_WRITE_COMMANDS.lockThread,
        params: {
          instanceId: input.instanceId,
          profileUrl: input.profileUrl,
        },
      })

      const found = await transaction.query<LeadForImportRow>({
        operation: CONVERSATION_WRITE_OPERATIONS.leadForImport,
        params: { campaignId: input.campaignId, profileUrl: input.profileUrl },
        page: { limit: 1 },
      })
      const lead = found.items[0]
      if (!lead) {
        return json({ error: 'unknown lead (campaign_id + profile_url)' }, 404)
      }
      if (lead.instance_id !== input.instanceId) {
        return json({ error: 'instance_id does not match the lead' }, 400)
      }

      const existing = await readAll<ThreadDedupKeyRow>(
        transaction,
        CONVERSATION_WRITE_OPERATIONS.threadDedupKeys,
        { instanceId: input.instanceId, profileUrl: input.profileUrl },
      )

      const seen = new Set(
        existing.map((row) => `${row.direction}|${input.normalize(row.body ?? '')}`),
      )
      const directions: string[] = []
      const bodies: string[] = []
      const sentAts: string[] = []
      const contentHashes: string[] = []
      let skipped = 0
      for (const message of input.messages) {
        const key = `${message.direction}|${input.normalize(message.body)}`
        if (!message.force && seen.has(key)) {
          skipped += 1
          continue
        }
        // A block pasted twice inside one request dedupes against itself.
        seen.add(key)
        directions.push(message.direction)
        bodies.push(message.body)
        sentAts.push(message.sent_at)
        contentHashes.push(message.contentHash)
      }

      let inserted = 0
      if (directions.length > 0) {
        const result = await transaction.execute<{ readonly inserted: number }>({
          operation: CONVERSATION_WRITE_COMMANDS.insertImportedMessages,
          params: {
            instanceId: input.instanceId,
            campaignId: input.campaignId,
            profileUrl: input.profileUrl,
            directions,
            bodies,
            sentAts,
            contentHashes,
          },
        })
        inserted = result.inserted
        skipped += directions.length - inserted
      }

      // Derived from the FULL validated payload, not from the rows that landed:
      // a completely deduped re-import must still fill a milestone an earlier
      // partial import missed. The statement's `COALESCE` is what makes that
      // idempotent rather than this arithmetic.
      const earliest = (direction: 'in' | 'out'): string | null => {
        const times = input.messages
          .filter((message) => message.direction === direction)
          .map((message) => message.sent_at)
        return times.length ? times.reduce((a, b) => (a < b ? a : b)) : null
      }
      const minIn = earliest('in')
      const minOut = earliest('out')
      const minAny =
        [minIn, minOut].filter((time): time is string => time !== null).sort()[0] ??
        null

      const backfilled = await transaction.execute<BackfillMilestonesResult>({
        operation: CONVERSATION_WRITE_COMMANDS.backfillMilestones,
        params: {
          leadId: lead.id,
          repliedAt: minIn,
          firstMessageAt: minOut,
          connectedAt: minAny,
        },
      })

      // Report what actually changed, by comparing against the pre-state read
      // inside this same transaction. The Supabase path reports the patch it
      // *intended*; this reports what the row now says, which is the same thing
      // only when the write succeeded — and here a failure would have rolled the
      // messages back rather than reaching this line.
      const milestones: Record<string, string> = {}
      const after = backfilled.row
      if (after) {
        if (!lead.replied_at && after.replied_at) {
          milestones.replied_at = after.replied_at
        }
        if (!lead.first_message_at && after.first_message_at) {
          milestones.first_message_at = after.first_message_at
        }
        if (!lead.connected_at && after.connected_at) {
          milestones.connected_at = after.connected_at
        }
      }

      return json({
        ok: true,
        inserted,
        skipped,
        ...(Object.keys(milestones).length ? { milestones } : {}),
      })
    })
  } catch (error) {
    return storeFailure(error, 'import the conversation')
  }
}

// ---------------------------------------------------------------------------
// edit_message / delete_message.
// ---------------------------------------------------------------------------

export async function neonEditMessage(
  request: Request,
  input: {
    readonly messageId: number
    readonly body: string
    readonly contentHash: string
  },
  deps: NeonWriteDeps = {},
): Promise<Response> {
  let writer: NeonWriter
  try {
    writer = await neonWriter(request, deps)
  } catch (error) {
    return storeFailure(error, 'verify team access')
  }

  try {
    return await writer.store.transaction(writer.actor, async (transaction) => {
      const result = await transaction.execute<EditManualMessageResult>({
        operation: CONVERSATION_WRITE_COMMANDS.editManualMessage,
        params: {
          messageId: input.messageId,
          body: input.body,
          contentHash: input.contentHash,
        },
      })
      if (result.rowCount === 0) {
        return json({ error: 'no manual message with that id' }, 404)
      }
      return json({ ok: true, edited: input.messageId, body: input.body })
    })
  } catch (error) {
    return storeFailure(error, 'edit the message')
  }
}

export async function neonDeleteMessage(
  request: Request,
  input: { readonly messageId: number },
  deps: NeonWriteDeps = {},
): Promise<Response> {
  let writer: NeonWriter
  try {
    writer = await neonWriter(request, deps)
  } catch (error) {
    return storeFailure(error, 'verify team access')
  }

  try {
    return await writer.store.transaction(writer.actor, async (transaction) => {
      const result = await transaction.execute<DeleteManualMessageResult>({
        operation: CONVERSATION_WRITE_COMMANDS.deleteManualMessage,
        params: { messageId: input.messageId },
      })
      if (!result.deleted) {
        return json({ error: 'no manual message with that id' }, 404)
      }
      return json({
        ok: true,
        deleted: input.messageId,
        milestones_recomputed: result.milestones_recomputed,
      })
    })
  } catch (error) {
    return storeFailure(error, 'delete the message')
  }
}
