/** Transactional manual reply-review service for Neon tenants.
 *
 * The HTTP dispatchers call these functions after payload parsing.  The service
 * still validates at its boundary because it is also used by reclassify and by
 * tests.  There is one transaction per mutation: capability, thread lock,
 * replay, optimistic revisions, projection, workflow and audit commit together.
 */

import { AuthorizationError, authorizationResponse } from './auth.js'
import { getDataStore } from './data/store.js'
import {
  DataStoreContractError,
  DataStoreSchemaError,
  DataStoreUnavailableError,
  type ActorContext,
  type DataStore,
  type DataStoreTransaction,
} from './data/contracts.js'
import { unavailableResponse } from './data/availability.js'
import { resolveApplicationActor, type ApplicationAuthPath } from './identity/application.js'
import type { IdentityProvider } from './identity/provider.js'
import {
  REPLY_REVIEW_OPERATIONS,
} from './data/operations/replyReviews.js'
import {
  REPLY_REVIEW_WRITE_COMMANDS,
  type EventResult,
  type ActivationResult,
  type SavedReviewResult,
  type SavedWorkflowResult,
} from './data/operations/replyReviewWrites.js'
import {
  REPLY_REVIEW_TAXONOMY_VERSION,
  type ReplyCapability,
  type ReplyReviewDto,
  type ReplyMutationResult,
  type ReplyWorkflowDto,
  type ReplyWorkflowInput,
  type SaveReplyReviewRequest,
  type SetReplyWorkflowRequest,
  type ActivateManualReplyReviewRequest,
  ReplyReviewConflictError,
  ReplyReviewUnavailableError,
  ReplyReviewNotFoundError,
  ReplyReviewValidationError,
  replyMutationFingerprint,
  validateReplyReviewInput,
  validateReplyWorkflowInput,
  validateThreadKey,
} from './replyReview.js'

export interface ReplyReviewWriteDeps {
  readonly store?: DataStore
  readonly authPath?: ApplicationAuthPath
  readonly legacyProviderName?: string
  readonly identity?: IdentityProvider
}

export interface ReplyReviewWriter {
  readonly store: DataStore
  readonly actor: ActorContext
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function asWorkflow(row: Record<string, unknown> | undefined): ReplyWorkflowDto | null {
  if (!row) return null
  return {
    action: row.action === null || row.action === undefined ? null : String(row.action) as ReplyWorkflowDto['action'], owner_id: row.owner_id === null || row.owner_id === undefined ? null : Number(row.owner_id), next_follow_up_date: row.next_follow_up_date === null || row.next_follow_up_date === undefined ? null : String(row.next_follow_up_date), do_not_contact: row.do_not_contact === true, acknowledged_inbound_revision: Number(row.acknowledged_inbound_revision ?? 0), inbound_revision: Number(row.inbound_revision ?? 0), revision: Number(row.revision ?? 0), supporting_message_id: row.supporting_message_id === null || row.supporting_message_id === undefined ? null : Number(row.supporting_message_id), updated_at: String(row.updated_at ?? new Date(0).toISOString()), updated_by: row.updated_by === null || row.updated_by === undefined ? null : String(row.updated_by),
  }
}

function safeErrorLabel(error: unknown): string {
  if (error instanceof DataStoreContractError) return `${error.name}(${error.code})`
  if (error instanceof Error) return error.name
  return 'UnknownError'
}

function writeFailure(error: unknown, what: string): Response {
  const auth = authorizationResponse(error)
  if (auth) return auth
  const unavailable = unavailableResponse(error)
  if (unavailable) return unavailable
  if (error instanceof ReplyReviewValidationError) return json({ error: error.message, code: error.code }, 400)
  if (error instanceof ReplyReviewNotFoundError) return json({ error: error.message, code: error.code }, 404)
  if (error instanceof ReplyReviewConflictError) return json({ error: error.message, code: error.code, current: error.current }, 409)
  if (error instanceof ReplyReviewUnavailableError || error instanceof DataStoreSchemaError) return json({ error: 'Manual reply review is unavailable for this tenant', code: 'REPLY_REVIEW_UNAVAILABLE' }, 503)
  if (error instanceof DataStoreUnavailableError) return unavailableResponse(error) ?? json({ error: 'Database unavailable' }, 503)
  console.error(`Neon reply review failed (${what}):`, safeErrorLabel(error))
  return json({ error: `Could not ${what}` }, 500)
}

export async function replyReviewWriter(request: Request, deps: ReplyReviewWriteDeps = {}): Promise<ReplyReviewWriter> {
  const store = deps.store ?? getDataStore()
  const resolved = await resolveApplicationActor(request, { store, authPath: deps.authPath, identity: deps.identity, legacyProviderName: deps.legacyProviderName })
  return { store, actor: resolved.actor }
}

function assertHumanActor(actor: ActorContext): void {
  if (actor.kind !== 'user') throw new AuthorizationError(403, 'Only an authenticated team member may review replies')
}

async function capability(tx: DataStoreTransaction, writable = true): Promise<ReplyCapability> {
  const page = await tx.query<ReplyCapability>({ operation: REPLY_REVIEW_OPERATIONS.capabilities, page: { limit: 1 } })
  const value = page.items[0]
  if (!value?.available || (value.mode !== 'manual' && value.mode !== 'prepared') || (writable && value.mode !== 'manual')) throw new ReplyReviewUnavailableError()
  return value
}

async function replay(tx: DataStoreTransaction, mutationId: string, actorId: string, payload: unknown): Promise<ReplyMutationResult | null> {
  const page = await tx.query<{ mutation_id: string; actor_id: string; payload_hash: string; result: unknown }>({ operation: REPLY_REVIEW_OPERATIONS.mutation, params: { mutationId }, page: { limit: 1 } })
  const old = page.items[0]
  if (!old) return null
  const hash = replyMutationFingerprint(payload)
  if (old.actor_id !== actorId || old.payload_hash !== hash) throw new ReplyReviewConflictError('mutation_id was already used for another payload')
  return old.result as ReplyMutationResult
}

function ensureMutationId(value: string): void {
  if (!UUID.test(value)) throw new ReplyReviewValidationError('mutation_id must be a UUID')
}

async function readReview(tx: DataStoreTransaction, input: { instanceId: string; profileUrl: string; messageId: number }): Promise<ReplyReviewDto | null> {
  const page = await tx.query<ReplyReviewDto>({ operation: REPLY_REVIEW_OPERATIONS.reviewForMessage, params: { instanceId: input.instanceId, profileUrl: input.profileUrl, messageId: input.messageId }, page: { limit: 1 } })
  return page.items[0] ?? null
}

async function readWorkflow(tx: DataStoreTransaction, instanceId: string, profileUrl: string): Promise<ReplyWorkflowDto | null> {
  const page = await tx.query<Record<string, unknown>>({ operation: REPLY_REVIEW_OPERATIONS.workflowForThread, params: { instanceId, profileUrl }, page: { limit: 1 } })
  return asWorkflow(page.items[0])
}

async function saveMutation(tx: DataStoreTransaction, mutationId: string, actorId: string, payload: unknown, result: ReplyMutationResult): Promise<void> {
  const saved = await tx.execute<{ rowCount: number }>({ operation: REPLY_REVIEW_WRITE_COMMANDS.saveMutation, params: { mutationId, actorId, payloadHash: replyMutationFingerprint(payload), resultJson: JSON.stringify(result) } })
  if (saved.rowCount === 0) {
    // A mutation id can be reused across two thread locks.  The primary key is
    // the final serialization point; never report a second, unrecorded result.
    const replayed = await replay(tx, mutationId, actorId, payload)
    if (!replayed) throw new ReplyReviewConflictError('mutation_id could not be committed')
  }
}

export async function saveReplyReview(store: DataStore, actor: ActorContext, request: SaveReplyReviewRequest): Promise<ReplyMutationResult> {
  assertHumanActor(actor)
  validateThreadKey(request.instance_id, request.profile_url)
  ensureMutationId(request.mutation_id)
  if (!Number.isSafeInteger(request.message_id) || request.message_id <= 0) throw new ReplyReviewValidationError('message_id must be a positive integer')
  if (!Number.isSafeInteger(request.expected_review_revision) || request.expected_review_revision < 0) throw new ReplyReviewValidationError('expected_review_revision must be a non-negative integer')
  const review = validateReplyReviewInput(request.review)
  if (request.workflow) validateReplyWorkflowInput(request.workflow)
  if (review.reason_ids.includes('do_not_contact') && (!request.workflow || !request.workflow.do_not_contact)) {
    throw new ReplyReviewValidationError('do_not_contact reason requires the workflow flag in the same save')
  }
  return store.transaction(actor, async (tx) => {
    await capability(tx)
    await tx.execute({ operation: REPLY_REVIEW_WRITE_COMMANDS.lockThread, params: { instanceId: request.instance_id, profileUrl: request.profile_url } })
    const prior = await replay(tx, request.mutation_id, actor.actorId, request)
    if (prior) return prior
    const message = await tx.query<{ id: number; direction: 'in' | 'out'; sent_at: string }>({ operation: REPLY_REVIEW_OPERATIONS.messageForReview, params: { instanceId: request.instance_id, profileUrl: request.profile_url, messageId: request.message_id }, page: { limit: 1 } })
    if (!message.items[0]) throw new ReplyReviewNotFoundError('The requested message or thread was not found')
    if (message.items[0].direction !== 'in') throw new ReplyReviewValidationError('reply review requires an inbound message')
    const previous = await readReview(tx, { instanceId: request.instance_id, profileUrl: request.profile_url, messageId: request.message_id })
    if ((previous?.revision ?? 0) !== request.expected_review_revision) throw new ReplyReviewConflictError('review revision is stale', previous)
    const saved = await tx.execute<SavedReviewResult>({ operation: REPLY_REVIEW_WRITE_COMMANDS.saveReview, params: { messageId: request.message_id, expectedRevision: request.expected_review_revision, sentiment: review.sentiment, intentState: review.intent_state, intentLevel: review.intent_level, comment: review.comment, taxonomyVersion: REPLY_REVIEW_TAXONOMY_VERSION, actorId: actor.actorId } })
    if (!saved.row || saved.rowCount === 0) throw new ReplyReviewConflictError('review revision is stale', previous)
    // PostgreSQL does not guarantee visibility between sibling data-changing
    // CTEs.  Keep replacement in the same transaction, but issue two fixed
    // commands so an overlap of old/new reasons cannot leave stale rows.
    await tx.execute({ operation: REPLY_REVIEW_WRITE_COMMANDS.deleteReasons, params: { messageId: request.message_id } })
    await tx.execute({ operation: REPLY_REVIEW_WRITE_COMMANDS.insertReasons, params: { messageId: request.message_id, reasonIds: review.reason_ids } })
    await tx.execute({ operation: REPLY_REVIEW_WRITE_COMMANDS.enableProjection })
    await tx.execute({ operation: REPLY_REVIEW_WRITE_COMMANDS.projectReview, params: { instanceId: request.instance_id, profileUrl: request.profile_url, messageId: request.message_id, expectedRevision: request.expected_review_revision, sentiment: review.sentiment, intentState: review.intent_state, intentLevel: review.intent_level, comment: review.comment, taxonomyVersion: REPLY_REVIEW_TAXONOMY_VERSION, actorId: actor.actorId, reviewedAt: new Date().toISOString() } })
    const workflow = request.workflow ? await applyWorkflowInTransaction(tx, actor, request.instance_id, request.profile_url, request.workflow, request.mutation_id) : await readWorkflow(tx, request.instance_id, request.profile_url)
    const currentReview = await readReview(tx, { instanceId: request.instance_id, profileUrl: request.profile_url, messageId: request.message_id })
    // Read the inbound revision once after the mutation.  A thread may not yet
    // have a workflow row; that still means revision zero has not acknowledged
    // any inbound reply, so the response must surface confirmation as needed.
    const currentInboundRevision = await inboundRevision(tx, request.instance_id, request.profile_url)
    const result: ReplyMutationResult = { review: currentReview, workflow, inbound_revision: currentInboundRevision, needs_action_confirmation: (workflow?.acknowledged_inbound_revision ?? 0) < currentInboundRevision, mutation_id: request.mutation_id }
    await audit(tx, request.instance_id, request.profile_url, request.message_id, actor.actorId, previous, currentReview, request.mutation_id)
    await saveMutation(tx, request.mutation_id, actor.actorId, request, result)
    return result
  })
}

async function inboundRevision(tx: DataStoreTransaction, instanceId: string, profileUrl: string): Promise<number> {
  const page = await tx.query<{ inbound_revision: number }>({ operation: REPLY_REVIEW_OPERATIONS.inboundRevision, params: { instanceId, profileUrl }, page: { limit: 1 } })
  return Number(page.items[0]?.inbound_revision ?? 0)
}

async function applyWorkflowInTransaction(tx: DataStoreTransaction, actor: ActorContext, instanceId: string, profileUrl: string, input: ReplyWorkflowInput, mutationId: string): Promise<ReplyWorkflowDto | null> {
  const thread = await tx.query<{ exists: boolean }>({ operation: REPLY_REVIEW_OPERATIONS.threadExists, params: { instanceId, profileUrl }, page: { limit: 1 } })
  if (!thread.items[0]?.exists) throw new ReplyReviewNotFoundError('The requested thread was not found')
  const current = await readWorkflow(tx, instanceId, profileUrl)
  const currentInboundRevision = await inboundRevision(tx, instanceId, profileUrl)
  if ((current?.revision ?? 0) !== input.expected_revision) throw new ReplyReviewConflictError('workflow revision is stale', current)
  if (currentInboundRevision !== input.observed_inbound_revision) throw new ReplyReviewConflictError('inbound revision is stale', { workflow: current, inbound_revision: currentInboundRevision })
  if (input.observed_inbound_revision > (current?.acknowledged_inbound_revision ?? 0) && input.action === null) {
    throw new ReplyReviewValidationError('acknowledgement requires an explicit action')
  }
  if (current?.do_not_contact && !input.do_not_contact) {
    if (!input.action || !input.change_reason?.trim()) throw new ReplyReviewValidationError('clearing do_not_contact requires an explicit next action and comment')
  }
  const result = await tx.execute<SavedWorkflowResult>({ operation: REPLY_REVIEW_WRITE_COMMANDS.setWorkflow, params: { instanceId, profileUrl, expectedRevision: input.expected_revision, observedInboundRevision: input.observed_inbound_revision, action: input.action, ownerId: input.owner_id, nextFollowUpDate: input.next_follow_up_date, doNotContact: input.do_not_contact, supportingMessageId: input.supporting_message_id ?? null, actorId: actor.actorId, mutationId } })
  if (result.rowCount === 0) throw new ReplyReviewConflictError('workflow revision is stale', current)
  // Read the projection back through the same actor-scoped operation so the
  // response includes inbound_revision and server-normalized date/timestamps.
  return readWorkflow(tx, instanceId, profileUrl)
}

async function audit(tx: DataStoreTransaction, instanceId: string, profileUrl: string, messageId: number | null, actorId: string, before: unknown, after: unknown, mutationId: string): Promise<void> {
  await tx.execute<EventResult>({ operation: REPLY_REVIEW_WRITE_COMMANDS.appendEvent, params: { instanceId, profileUrl, messageId, actorId, provenance: 'human', beforeJson: JSON.stringify(before ?? {}), afterJson: JSON.stringify(after ?? {}), mutationId } })
}

export async function setReplyWorkflow(store: DataStore, actor: ActorContext, request: SetReplyWorkflowRequest): Promise<ReplyMutationResult> {
  assertHumanActor(actor)
  validateThreadKey(request.instance_id, request.profile_url); ensureMutationId(request.mutation_id); validateReplyWorkflowInput(request.workflow)
  return store.transaction(actor, async (tx) => {
    await capability(tx); await tx.execute({ operation: REPLY_REVIEW_WRITE_COMMANDS.lockThread, params: { instanceId: request.instance_id, profileUrl: request.profile_url } })
    const prior = await replay(tx, request.mutation_id, actor.actorId, request); if (prior) return prior
    const workflow = await applyWorkflowInTransaction(tx, actor, request.instance_id, request.profile_url, request.workflow, request.mutation_id)
    const result: ReplyMutationResult = { review: null, workflow, inbound_revision: workflow?.inbound_revision ?? request.workflow.observed_inbound_revision, needs_action_confirmation: workflow ? workflow.acknowledged_inbound_revision < workflow.inbound_revision : false, mutation_id: request.mutation_id }
    // The database workflow trigger writes the canonical workflow audit event;
    // emitting a second synthetic event here would double-count the history.
    await saveMutation(tx, request.mutation_id, actor.actorId, request, result); return result
  })
}

export async function neonSaveReplyReview(request: Request, payload: SaveReplyReviewRequest, deps: ReplyReviewWriteDeps = {}): Promise<Response> {
  try { const writer = await replyReviewWriter(request, deps); return json(await saveReplyReview(writer.store, writer.actor, payload)) } catch (error) { return writeFailure(error, 'save reply review') }
}

export async function neonSetReplyWorkflow(request: Request, payload: SetReplyWorkflowRequest, deps: ReplyReviewWriteDeps = {}): Promise<Response> {
  try { const writer = await replyReviewWriter(request, deps); return json(await setReplyWorkflow(writer.store, writer.actor, payload)) } catch (error) { return writeFailure(error, 'save reply workflow') }
}

/** The activation command is intentionally admin-only and never applies schema. */
export async function neonActivateManualReplyReview(request: Request, payload: ActivateManualReplyReviewRequest = { action: 'activate_manual_reply_review', mutation_id: '' }, deps: ReplyReviewWriteDeps = {}): Promise<Response> {
  try {
    const writer = await replyReviewWriter(request, deps)
    if (writer.actor.kind !== 'user' || writer.actor.role !== 'admin') throw new AuthorizationError(403, 'Admin access required')
    ensureMutationId(payload.mutation_id)
    const batchSize = payload.batch_size ?? 500
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) throw new ReplyReviewValidationError('batch_size must be an integer between 1 and 1000')
    return json(await writer.store.transaction(writer.actor, async (tx) => {
      await capability(tx, false)
      const result = await tx.execute<ActivationResult>({ operation: REPLY_REVIEW_WRITE_COMMANDS.activate, params: { mutationId: payload.mutation_id, actorId: writer.actor.actorId, batchSize } })
      return {
        ok: true,
        activated: result.complete === true || result.mode === 'manual',
        mode: result.mode ?? (result.complete === true ? 'manual' : 'prepared'),
        complete: result.complete ?? false,
        processed: result.processed ?? 0,
        remaining: result.remaining ?? null,
        cursor: result.cursor ?? null,
        progress: { processed: result.processed ?? 0, remaining: result.remaining ?? null, cursor: result.cursor ?? null },
        replayed: result.replayed ?? false,
        mutation_id: result.mutation_id ?? payload.mutation_id,
        activated_at: result.activated_at ?? null,
      }
    }))
  } catch (error) { return writeFailure(error, 'activate manual reply review') }
}
