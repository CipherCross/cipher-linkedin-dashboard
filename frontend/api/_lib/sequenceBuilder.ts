import { authorizationResponse } from './auth.js'
import { unavailableResponse } from './data/availability.js'
import {
  PIPELINE_WRITE_OPERATIONS,
  SEQUENCE_COMMANDS,
  SEQUENCE_OPERATIONS,
  type ActorDisplayNameRow,
  type CommentThreadWriteResult,
  type SequenceCommentRow,
  type SequenceDocumentRow,
  type SequenceDocumentWriteResult,
  type SequenceRowCountResult,
  type SequenceVersionRow,
} from './data/operations/index.js'
import {
  DataStoreConstraintError,
  DataStoreContractError,
  DataStoreSchemaError,
  MAX_PAGE_SIZE,
  type DataStore,
  type DataStoreTransaction,
  type Page,
} from './data/contracts.js'
import { neonWriter } from './neonWrites.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STABLE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/
const MAX_DOCUMENT_BYTES = 250_000
const MAX_SEQUENCE_NAME = 160
const MAX_STEP_COUNT = 30
const MAX_VARIATIONS_PER_STEP = 12
const MAX_BRANCH_COUNT = 12
const MAX_MESSAGE_CHARS = 5_000
const MAX_COMMENT_CHARS = 4_000

export const SEQUENCE_ACTIONS = new Set([
  'list_sequences',
  'get_sequence',
  'create_sequence',
  'save_sequence',
  'archive_sequence',
  'create_sequence_comment',
  'reply_sequence_comment',
  'set_sequence_comment_resolved',
])

export function isSequenceAction(value: unknown): value is string {
  return typeof value === 'string' && SEQUENCE_ACTIONS.has(value)
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })

function safeErrorLabel(error: unknown): string {
  if (error instanceof DataStoreContractError) return `${error.name}(${error.code})`
  if (error instanceof Error) return error.name
  return 'UnknownError'
}

function failure(error: unknown, action: string): Response {
  const denial = authorizationResponse(error)
  if (denial) return denial
  const unavailable = unavailableResponse(error)
  if (unavailable) return unavailable
  if (error instanceof DataStoreSchemaError) {
    return json(
      {
        error: 'Sequence Builder database step is not available yet.',
        code: 'LEDGER_STEP_PENDING',
      },
      503,
    )
  }
  if (error instanceof DataStoreConstraintError) {
    return json(
      { error: error.kind === 'foreign_key' ? 'Referenced sequence or comment was not found.' : 'Conflicting sequence data.' },
      error.kind === 'foreign_key' ? 404 : 409,
    )
  }
  console.error(`Sequence Builder failed (${action}):`, safeErrorLabel(error))
  return json({ error: `Could not ${action}.` }, 500)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stableId(value: unknown): value is string {
  return typeof value === 'string' && STABLE_ID_PATTERN.test(value)
}

function sequenceId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function normalizedName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length >= 1 && name.length <= MAX_SEQUENCE_NAME ? name : null
}

function validateDocument(value: unknown): Record<string, unknown> | string {
  const document = record(value)
  if (!document || document.version !== 1 || !Array.isArray(document.steps)) {
    return 'document must be a version 1 sequence object'
  }
  if (document.steps.length < 1 || document.steps.length > MAX_STEP_COUNT) {
    return `document must contain 1–${MAX_STEP_COUNT} steps`
  }

  const stepIds = new Set<string>()
  const allVariationIds = new Set<string>()
  const variationsByStep = new Map<string, Set<string>>()
  let connectionCount = 0
  for (const [index, rawStep] of document.steps.entries()) {
    const step = record(rawStep)
    if (!step || !stableId(step.id)) return `step ${index + 1} has an invalid id`
    if (stepIds.has(step.id)) return 'step ids must be unique'
    stepIds.add(step.id)
    if (step.kind !== 'connection' && step.kind !== 'message') {
      return `step ${index + 1} has an invalid kind`
    }
    if (step.kind === 'connection') connectionCount += 1
    if (index === 0 && step.kind !== 'connection') return 'the first step must be the connection request'
    if (index > 0 && step.kind !== 'message') return 'the connection request must remain first'
    if (!Array.isArray(step.variations) || step.variations.length < 1 || step.variations.length > MAX_VARIATIONS_PER_STEP) {
      return `each step must contain 1–${MAX_VARIATIONS_PER_STEP} variations`
    }
    const variationIds = new Set<string>()
    for (const rawVariation of step.variations) {
      const variation = record(rawVariation)
      if (!variation || !stableId(variation.id)) return 'variation has an invalid id'
      if (variationIds.has(variation.id)) return 'variation ids must be unique inside a step'
      if (allVariationIds.has(variation.id)) return 'variation ids must be unique across the sequence'
      variationIds.add(variation.id)
      allVariationIds.add(variation.id)
      if (typeof variation.label !== 'string' || variation.label.length > 80) {
        return 'variation label is invalid'
      }
      if (typeof variation.text !== 'string' || variation.text.length > MAX_MESSAGE_CHARS) {
        return `variation text must be at most ${MAX_MESSAGE_CHARS} characters`
      }
    }
    variationsByStep.set(step.id, variationIds)
  }
  if (connectionCount !== 1) return 'document must contain exactly one connection request'

  if (!Array.isArray(document.branches) || document.branches.length > MAX_BRANCH_COUNT) {
    return `document may contain at most ${MAX_BRANCH_COUNT} branches`
  }
  const branchIds = new Set<string>()
  for (const rawBranch of document.branches) {
    const branch = record(rawBranch)
    if (!branch || !stableId(branch.id)) return 'branch has an invalid id'
    if (branchIds.has(branch.id)) return 'branch ids must be unique'
    branchIds.add(branch.id)
    if (typeof branch.name !== 'string' || branch.name.trim().length < 1 || branch.name.length > 80) {
      return 'branch name is invalid'
    }
    const selections = record(branch.selections)
    if (!selections) return 'branch selections must be an object'
    for (const [stepId, variationId] of Object.entries(selections)) {
      if (!stepIds.has(stepId) || typeof variationId !== 'string') {
        return 'branch contains an unknown step or variation'
      }
      if (!variationsByStep.get(stepId)?.has(variationId)) {
        return 'branch contains an unknown step or variation'
      }
    }
  }

  const sampleData = record(document.sampleData)
  if (!sampleData) return 'sampleData must be an object'
  for (const [key, sample] of Object.entries(sampleData)) {
    if (!['firstName', 'companyName', 'jobTitle', 'senderName'].includes(key)) {
      return 'sampleData contains an unsupported key'
    }
    if (typeof sample !== 'string' || sample.length > 120) return 'sampleData value is invalid'
  }

  const serialized = JSON.stringify(document)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
    return 'sequence document is too large'
  }
  return document
}

function validateAnchor(value: unknown): Record<string, unknown> | null | string {
  if (value === null || value === undefined) return null
  const anchor = record(value)
  if (!anchor) return 'anchor must be an object'
  const { start, end, quote } = anchor
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    Number(start) < 0 ||
    Number(end) <= Number(start) ||
    typeof quote !== 'string' ||
    quote.length < 1 ||
    quote.length > 1_000
  ) {
    return 'anchor must contain a valid selected text range'
  }
  return { start: Number(start), end: Number(end), quote }
}

async function actorName(transaction: DataStoreTransaction): Promise<string> {
  const page = await transaction.query<ActorDisplayNameRow>({
    operation: PIPELINE_WRITE_OPERATIONS.actorDisplayName,
    params: { actorId: transaction.actor.actorId },
    page: { limit: 1 },
  })
  const name = page.items[0]?.name
  if (!name) throw new Error('Active actor has no display name')
  return name
}

async function readAll<TRow>(
  store: DataStore,
  actor: Parameters<DataStore['query']>[0],
  operation: string,
  params?: Record<string, string>,
): Promise<TRow[]> {
  const items: TRow[] = []
  let cursor: string | null = null
  for (;;) {
    const page: Page<TRow> = await store.query(actor, {
      operation,
      params,
      page: { limit: MAX_PAGE_SIZE, cursor },
    })
    items.push(...page.items)
    if (!page.hasMore || !page.nextCursor) break
    cursor = page.nextCursor
  }
  return items
}

function groupComments(rows: readonly SequenceCommentRow[]) {
  const threads = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    let thread = threads.get(row.thread_id)
    if (!thread) {
      thread = {
        id: row.thread_id,
        sequence_id: row.sequence_id,
        step_id: row.step_id,
        variation_id: row.variation_id,
        anchor: row.anchor,
        created_by: row.created_by,
        created_by_name: row.created_by_name,
        resolved_at: row.resolved_at,
        resolved_by: row.resolved_by,
        resolved_by_name: row.resolved_by_name,
        created_at: row.thread_created_at,
        updated_at: row.thread_updated_at,
        messages: [],
      }
      threads.set(row.thread_id, thread)
    }
    ;(thread.messages as Record<string, unknown>[]).push({
      id: row.message_id,
      author_id: row.message_author_id,
      author_name: row.message_author_name,
      body: row.message_body,
      created_at: row.message_created_at,
    })
  }
  return [...threads.values()]
}

async function detail(store: DataStore, actor: Parameters<DataStore['query']>[0], id: string) {
  const [sequencePage, versions, comments] = await Promise.all([
    store.query<SequenceDocumentRow>(actor, {
      operation: SEQUENCE_OPERATIONS.detail,
      params: { sequenceId: id },
      page: { limit: 1 },
    }),
    readAll<SequenceVersionRow>(store, actor, SEQUENCE_OPERATIONS.versions, { sequenceId: id }),
    readAll<SequenceCommentRow>(store, actor, SEQUENCE_OPERATIONS.comments, { sequenceId: id }),
  ])
  const sequence = sequencePage.items[0]
  return sequence ? { sequence, versions, comments: groupComments(comments) } : null
}

export async function handleSequenceAction(
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const action = payload.action
  if (!isSequenceAction(action)) return json({ error: 'unknown action' }, 400)

  let writer: Awaited<ReturnType<typeof neonWriter>>
  try {
    writer = await neonWriter(request)
    if (writer.actor.role !== 'member' && writer.actor.role !== 'admin') {
      return json({ error: 'Your account is not an active team member' }, 403)
    }
  } catch (error) {
    return failure(error, 'verify team access')
  }

  try {
    if (action === 'list_sequences') {
      const sequences = await readAll<SequenceDocumentRow>(
        writer.store,
        writer.actor,
        SEQUENCE_OPERATIONS.list,
      )
      return json({ ok: true, sequences })
    }

    if (action === 'get_sequence') {
      if (!sequenceId(payload.id)) return json({ error: 'valid sequence id is required' }, 400)
      const result = await detail(writer.store, writer.actor, payload.id)
      return result ? json({ ok: true, ...result }) : json({ error: 'unknown sequence' }, 404)
    }

    if (action === 'create_sequence') {
      const name = normalizedName(payload.name)
      if (!name) return json({ error: 'name must be 1–160 characters' }, 400)
      const document = validateDocument(payload.document)
      if (typeof document === 'string') return json({ error: document }, 400)
      const documentJson = JSON.stringify(document)
      const sequence = await writer.store.transaction(writer.actor, async (transaction) => {
        const nameOfActor = await actorName(transaction)
        const created = await transaction.execute<SequenceDocumentWriteResult>({
          operation: SEQUENCE_COMMANDS.create,
          params: { name, documentJson, actorName: nameOfActor },
        })
        if (!created.row) throw new Error('Sequence insert returned no row')
        await transaction.execute<SequenceRowCountResult>({
          operation: SEQUENCE_COMMANDS.insertVersion,
          params: {
            sequenceId: created.row.id,
            revision: created.row.revision,
            name: created.row.name,
            documentJson: JSON.stringify(created.row.document),
            actorName: nameOfActor,
          },
        })
        return created.row
      })
      return json({ ok: true, sequence }, 201)
    }

    if (action === 'save_sequence') {
      if (!sequenceId(payload.id)) return json({ error: 'valid sequence id is required' }, 400)
      if (!Number.isInteger(payload.expected_revision) || Number(payload.expected_revision) < 1) {
        return json({ error: 'expected_revision must be a positive integer' }, 400)
      }
      const name = normalizedName(payload.name)
      if (!name) return json({ error: 'name must be 1–160 characters' }, 400)
      const document = validateDocument(payload.document)
      if (typeof document === 'string') return json({ error: document }, 400)
      const documentJson = JSON.stringify(document)
      const outcome = await writer.store.transaction(writer.actor, async (transaction) => {
        const nameOfActor = await actorName(transaction)
        const saved = await transaction.execute<SequenceDocumentWriteResult>({
          operation: SEQUENCE_COMMANDS.save,
          params: {
            sequenceId: payload.id as string,
            expectedRevision: Number(payload.expected_revision),
            name,
            documentJson,
            actorName: nameOfActor,
          },
        })
        if (!saved.row) {
          const current = await transaction.query<SequenceDocumentRow>({
            operation: SEQUENCE_OPERATIONS.detail,
            params: { sequenceId: payload.id as string },
            page: { limit: 1 },
          })
          return { kind: 'conflict' as const, current: current.items[0] ?? null }
        }
        await transaction.execute<SequenceRowCountResult>({
          operation: SEQUENCE_COMMANDS.insertVersion,
          params: {
            sequenceId: saved.row.id,
            revision: saved.row.revision,
            name: saved.row.name,
            documentJson: JSON.stringify(saved.row.document),
            actorName: nameOfActor,
          },
        })
        return { kind: 'saved' as const, sequence: saved.row }
      })
      if (outcome.kind === 'conflict') {
        return outcome.current
          ? json({ error: 'Sequence changed in another session.', sequence: outcome.current }, 409)
          : json({ error: 'unknown sequence' }, 404)
      }
      return json({ ok: true, sequence: outcome.sequence })
    }

    if (action === 'archive_sequence') {
      if (!sequenceId(payload.id)) return json({ error: 'valid sequence id is required' }, 400)
      if (typeof payload.archived !== 'boolean') return json({ error: 'archived must be boolean' }, 400)
      const sequence = await writer.store.transaction(writer.actor, async (transaction) => {
        const nameOfActor = await actorName(transaction)
        const result = await transaction.execute<SequenceDocumentWriteResult>({
          operation: SEQUENCE_COMMANDS.archive,
          params: { sequenceId: payload.id as string, archived: payload.archived as boolean, actorName: nameOfActor },
        })
        return result.row
      })
      return sequence ? json({ ok: true, sequence }) : json({ error: 'unknown sequence' }, 404)
    }

    if (action === 'create_sequence_comment') {
      if (!sequenceId(payload.sequence_id)) return json({ error: 'valid sequence_id is required' }, 400)
      if (payload.step_id !== null && payload.step_id !== undefined && !stableId(payload.step_id)) {
        return json({ error: 'step_id is invalid' }, 400)
      }
      if (payload.variation_id !== null && payload.variation_id !== undefined && !stableId(payload.variation_id)) {
        return json({ error: 'variation_id is invalid' }, 400)
      }
      const body = typeof payload.body === 'string' ? payload.body.trim() : ''
      if (!body || body.length > MAX_COMMENT_CHARS) return json({ error: 'comment body is required' }, 400)
      const anchor = validateAnchor(payload.anchor)
      if (typeof anchor === 'string') return json({ error: anchor }, 400)
      const threadId = await writer.store.transaction(writer.actor, async (transaction) => {
        const existing = await transaction.query<SequenceDocumentRow>({
          operation: SEQUENCE_OPERATIONS.detail,
          params: { sequenceId: payload.sequence_id as string },
          page: { limit: 1 },
        })
        if (!existing.items[0]) return null
        const nameOfActor = await actorName(transaction)
        const thread = await transaction.execute<CommentThreadWriteResult>({
          operation: SEQUENCE_COMMANDS.createCommentThread,
          params: {
            sequenceId: payload.sequence_id as string,
            stepId: typeof payload.step_id === 'string' ? payload.step_id : null,
            variationId: typeof payload.variation_id === 'string' ? payload.variation_id : null,
            anchorJson: anchor ? JSON.stringify(anchor) : null,
            actorName: nameOfActor,
          },
        })
        if (!thread.threadId) throw new Error('Comment thread insert returned no id')
        await transaction.execute<SequenceRowCountResult>({
          operation: SEQUENCE_COMMANDS.addCommentMessage,
          params: { threadId: thread.threadId, body, actorName: nameOfActor },
        })
        return thread.threadId
      })
      return threadId ? json({ ok: true, thread_id: threadId }, 201) : json({ error: 'unknown sequence' }, 404)
    }

    if (action === 'reply_sequence_comment') {
      if (!sequenceId(payload.thread_id)) return json({ error: 'valid thread_id is required' }, 400)
      const body = typeof payload.body === 'string' ? payload.body.trim() : ''
      if (!body || body.length > MAX_COMMENT_CHARS) return json({ error: 'comment body is required' }, 400)
      await writer.store.transaction(writer.actor, async (transaction) => {
        const nameOfActor = await actorName(transaction)
        await transaction.execute<SequenceRowCountResult>({
          operation: SEQUENCE_COMMANDS.addCommentMessage,
          params: { threadId: payload.thread_id as string, body, actorName: nameOfActor },
        })
      })
      return json({ ok: true })
    }

    if (action === 'set_sequence_comment_resolved') {
      if (!sequenceId(payload.thread_id)) return json({ error: 'valid thread_id is required' }, 400)
      if (typeof payload.resolved !== 'boolean') return json({ error: 'resolved must be boolean' }, 400)
      const rowCount = await writer.store.transaction(writer.actor, async (transaction) => {
        const nameOfActor = await actorName(transaction)
        const result = await transaction.execute<SequenceRowCountResult>({
          operation: SEQUENCE_COMMANDS.setCommentResolved,
          params: {
            threadId: payload.thread_id as string,
            resolved: payload.resolved as boolean,
            actorName: nameOfActor,
          },
        })
        return result.rowCount
      })
      return rowCount ? json({ ok: true }) : json({ error: 'unknown comment thread' }, 404)
    }

    return json({ error: 'unknown action' }, 400)
  } catch (error) {
    return failure(error, action.replaceAll('_', ' '))
  }
}
