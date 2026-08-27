import { authPost } from './api'
import type {
  SequenceCommentAnchor,
  SequenceDetail,
  SequenceDocument,
  SequenceRecord,
} from './sequenceBuilder'

interface ErrorBody {
  error?: unknown
  code?: unknown
  sequence?: unknown
}

export class SequenceBuilderApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly current: SequenceRecord | null

  constructor(status: number, body: ErrorBody) {
    super(typeof body.error === 'string' ? body.error : `Request failed (${status})`)
    this.name = 'SequenceBuilderApiError'
    this.status = status
    this.code = typeof body.code === 'string' ? body.code : null
    this.current = body.sequence && typeof body.sequence === 'object'
      ? (body.sequence as SequenceRecord)
      : null
  }
}

async function call<T>(payload: Record<string, unknown>): Promise<T> {
  const response = await authPost('/api/playbook', payload)
  const body = (await response.json().catch(() => ({}))) as ErrorBody & T
  if (!response.ok) throw new SequenceBuilderApiError(response.status, body)
  return body
}

export async function listSequences(): Promise<SequenceRecord[]> {
  const body = await call<{ sequences: SequenceRecord[] }>({ action: 'list_sequences' })
  return body.sequences ?? []
}

export async function getSequence(id: string): Promise<SequenceDetail> {
  return call<SequenceDetail>({ action: 'get_sequence', id })
}

export async function createSequence(
  name: string,
  document: SequenceDocument,
): Promise<SequenceRecord> {
  const body = await call<{ sequence: SequenceRecord }>({
    action: 'create_sequence',
    name,
    document,
  })
  return body.sequence
}

export async function saveSequence(input: {
  id: string
  expectedRevision: number
  name: string
  document: SequenceDocument
}): Promise<SequenceRecord> {
  const body = await call<{ sequence: SequenceRecord }>({
    action: 'save_sequence',
    id: input.id,
    expected_revision: input.expectedRevision,
    name: input.name,
    document: input.document,
  })
  return body.sequence
}

export async function setSequenceArchived(id: string, archived: boolean): Promise<SequenceRecord> {
  const body = await call<{ sequence: SequenceRecord }>({
    action: 'archive_sequence',
    id,
    archived,
  })
  return body.sequence
}

export async function createSequenceComment(input: {
  sequenceId: string
  stepId: string | null
  variationId: string | null
  anchor: SequenceCommentAnchor | null
  body: string
}): Promise<void> {
  await call({
    action: 'create_sequence_comment',
    sequence_id: input.sequenceId,
    step_id: input.stepId,
    variation_id: input.variationId,
    anchor: input.anchor,
    body: input.body,
  })
}

export async function replySequenceComment(threadId: string, body: string): Promise<void> {
  await call({ action: 'reply_sequence_comment', thread_id: threadId, body })
}

export async function setSequenceCommentResolved(
  threadId: string,
  resolved: boolean,
): Promise<void> {
  await call({ action: 'set_sequence_comment_resolved', thread_id: threadId, resolved })
}
