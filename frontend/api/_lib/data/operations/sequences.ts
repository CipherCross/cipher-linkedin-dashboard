import type { NeonCommandOperation, NeonQueryOperation, NeonRow } from '../neon.js'
import { jsonObject, nullableText } from './library.js'

export const SEQUENCE_OPERATIONS = {
  list: 'sequences.list',
  detail: 'sequences.detail',
  versions: 'sequences.versions',
  comments: 'sequences.comments',
} as const

export const SEQUENCE_COMMANDS = {
  create: 'sequences.create',
  save: 'sequences.save',
  archive: 'sequences.archive',
  insertVersion: 'sequences.insertVersion',
  createCommentThread: 'sequences.createCommentThread',
  addCommentMessage: 'sequences.addCommentMessage',
  setCommentResolved: 'sequences.setCommentResolved',
} as const

export interface SequenceIdParams {
  readonly sequenceId: string
  readonly [key: string]: string
}

export interface SequenceDocumentRow {
  readonly id: string
  readonly name: string
  readonly document: Record<string, unknown>
  readonly revision: number
  readonly archived: boolean
  readonly created_by: string
  readonly created_by_name: string
  readonly updated_by: string
  readonly updated_by_name: string
  readonly created_at: string
  readonly updated_at: string
}

export interface SequenceVersionRow {
  readonly id: number
  readonly sequence_id: string
  readonly revision: number
  readonly name: string
  readonly document: Record<string, unknown>
  readonly saved_by: string
  readonly saved_by_name: string
  readonly saved_at: string
}

export interface SequenceCommentRow {
  readonly thread_id: string
  readonly sequence_id: string
  readonly step_id: string | null
  readonly variation_id: string | null
  readonly anchor: Record<string, unknown> | null
  readonly created_by: string
  readonly created_by_name: string
  readonly resolved_at: string | null
  readonly resolved_by: string | null
  readonly resolved_by_name: string | null
  readonly thread_created_at: string
  readonly thread_updated_at: string
  readonly message_id: number
  readonly message_author_id: string
  readonly message_author_name: string
  readonly message_body: string
  readonly message_created_at: string
}

const mapDocument = (row: NeonRow): SequenceDocumentRow => ({
  id: String(row.id),
  name: String(row.name),
  document: jsonObject(row.document),
  revision: Number(row.revision),
  archived: row.archived === true,
  created_by: String(row.created_by),
  created_by_name: String(row.created_by_name),
  updated_by: String(row.updated_by),
  updated_by_name: String(row.updated_by_name),
  created_at: String(row.created_at),
  updated_at: String(row.updated_at),
})

const DOCUMENT_COLUMNS = `d.id::text AS id,
          d.name,
          d.document,
          d.revision,
          d.archived,
          d.created_by::text AS created_by,
          d.created_by_name,
          d.updated_by::text AS updated_by,
          d.updated_by_name,
          d.created_at,
          d.updated_at`

export const listSequencesOperation: NeonQueryOperation<SequenceDocumentRow> = {
  build: () => ({
    text: `SELECT ${DOCUMENT_COLUMNS}
             FROM public.sequence_documents d
            ORDER BY d.archived, d.updated_at DESC, d.id`,
  }),
  mapRow: mapDocument,
}

export const sequenceDetailOperation: NeonQueryOperation<
  SequenceDocumentRow,
  SequenceIdParams
> = {
  build: ({ params }) => ({
    text: `SELECT ${DOCUMENT_COLUMNS}
             FROM public.sequence_documents d
            WHERE d.id = $1::uuid`,
    values: [params?.sequenceId],
  }),
  mapRow: mapDocument,
}

export const sequenceVersionsOperation: NeonQueryOperation<
  SequenceVersionRow,
  SequenceIdParams
> = {
  build: ({ params }) => ({
    text: `SELECT v.id::text AS id,
                  v.sequence_id::text AS sequence_id,
                  v.revision,
                  v.name,
                  v.document,
                  v.saved_by::text AS saved_by,
                  v.saved_by_name,
                  v.saved_at
             FROM public.sequence_versions v
            WHERE v.sequence_id = $1::uuid
            ORDER BY v.revision DESC, v.id DESC`,
    values: [params?.sequenceId],
  }),
  mapRow: (row) => ({
    id: Number(row.id),
    sequence_id: String(row.sequence_id),
    revision: Number(row.revision),
    name: String(row.name),
    document: jsonObject(row.document),
    saved_by: String(row.saved_by),
    saved_by_name: String(row.saved_by_name),
    saved_at: String(row.saved_at),
  }),
}

export const sequenceCommentsOperation: NeonQueryOperation<
  SequenceCommentRow,
  SequenceIdParams
> = {
  build: ({ params }) => ({
    text: `SELECT t.id::text AS thread_id,
                  t.sequence_id::text AS sequence_id,
                  t.step_id,
                  t.variation_id,
                  t.anchor,
                  t.created_by::text AS created_by,
                  t.created_by_name,
                  t.resolved_at,
                  t.resolved_by::text AS resolved_by,
                  t.resolved_by_name,
                  t.created_at AS thread_created_at,
                  t.updated_at AS thread_updated_at,
                  m.id::text AS message_id,
                  m.author_id::text AS message_author_id,
                  m.author_name AS message_author_name,
                  m.body AS message_body,
                  m.created_at AS message_created_at
             FROM public.sequence_comment_threads t
             JOIN public.sequence_comment_messages m ON m.thread_id = t.id
            WHERE t.sequence_id = $1::uuid
            ORDER BY t.created_at, t.id, m.created_at, m.id`,
    values: [params?.sequenceId],
  }),
  mapRow: (row) => ({
    thread_id: String(row.thread_id),
    sequence_id: String(row.sequence_id),
    step_id: nullableText(row.step_id),
    variation_id: nullableText(row.variation_id),
    anchor: row.anchor === null || row.anchor === undefined ? null : jsonObject(row.anchor),
    created_by: String(row.created_by),
    created_by_name: String(row.created_by_name),
    resolved_at: nullableText(row.resolved_at),
    resolved_by: nullableText(row.resolved_by),
    resolved_by_name: nullableText(row.resolved_by_name),
    thread_created_at: String(row.thread_created_at),
    thread_updated_at: String(row.thread_updated_at),
    message_id: Number(row.message_id),
    message_author_id: String(row.message_author_id),
    message_author_name: String(row.message_author_name),
    message_body: String(row.message_body),
    message_created_at: String(row.message_created_at),
  }),
}

export interface CreateSequenceParams {
  readonly name: string
  readonly documentJson: string
  readonly actorName: string
  readonly [key: string]: string
}

export interface SaveSequenceParams {
  readonly sequenceId: string
  readonly expectedRevision: number
  readonly name: string
  readonly documentJson: string
  readonly actorName: string
  readonly [key: string]: string | number
}

export interface ArchiveSequenceParams {
  readonly sequenceId: string
  readonly archived: boolean
  readonly actorName: string
  readonly [key: string]: string | boolean
}

export interface InsertSequenceVersionParams {
  readonly sequenceId: string
  readonly revision: number
  readonly name: string
  readonly documentJson: string
  readonly actorName: string
  readonly [key: string]: string | number
}

export interface CreateCommentThreadParams {
  readonly sequenceId: string
  readonly stepId: string | null
  readonly variationId: string | null
  readonly anchorJson: string | null
  readonly actorName: string
  readonly [key: string]: string | null
}

export interface AddCommentMessageParams {
  readonly threadId: string
  readonly body: string
  readonly actorName: string
  readonly [key: string]: string
}

export interface SetCommentResolvedParams {
  readonly threadId: string
  readonly resolved: boolean
  readonly actorName: string
  readonly [key: string]: string | boolean
}

export interface RowCountResult {
  readonly rowCount: number
}

export interface SequenceDocumentWriteResult extends RowCountResult {
  readonly row: SequenceDocumentRow | null
}

export interface CommentThreadWriteResult extends RowCountResult {
  readonly threadId: string | null
}

const mapDocumentWrite = (
  rows: readonly NeonRow[],
  rowCount: number,
): SequenceDocumentWriteResult => ({
  rowCount,
  row: rows[0] ? mapDocument(rows[0]) : null,
})

export const createSequenceOperation: NeonCommandOperation<
  SequenceDocumentWriteResult,
  CreateSequenceParams
> = {
  build: ({ actor, params }) => ({
    text: `INSERT INTO public.sequence_documents
              (name, document, created_by, created_by_name, updated_by, updated_by_name)
           VALUES ($1, $2::jsonb, $3::uuid, $4, $3::uuid, $4)
        RETURNING ${DOCUMENT_COLUMNS.replaceAll('d.', '')}`,
    values: [params?.name, params?.documentJson, actor.actorId, params?.actorName],
  }),
  mapResult: mapDocumentWrite,
}

export const saveSequenceOperation: NeonCommandOperation<
  SequenceDocumentWriteResult,
  SaveSequenceParams
> = {
  build: ({ actor, params }) => ({
    text: `UPDATE public.sequence_documents d
              SET name = $3,
                  document = $4::jsonb,
                  revision = d.revision + 1,
                  updated_by = $5::uuid,
                  updated_by_name = $6
            WHERE d.id = $1::uuid
              AND d.revision = $2::integer
        RETURNING ${DOCUMENT_COLUMNS}`,
    values: [
      params?.sequenceId,
      params?.expectedRevision,
      params?.name,
      params?.documentJson,
      actor.actorId,
      params?.actorName,
    ],
  }),
  mapResult: mapDocumentWrite,
}

export const archiveSequenceOperation: NeonCommandOperation<
  SequenceDocumentWriteResult,
  ArchiveSequenceParams
> = {
  build: ({ actor, params }) => ({
    text: `UPDATE public.sequence_documents d
              SET archived = $2::boolean,
                  updated_by = $3::uuid,
                  updated_by_name = $4
            WHERE d.id = $1::uuid
        RETURNING ${DOCUMENT_COLUMNS}`,
    values: [params?.sequenceId, params?.archived, actor.actorId, params?.actorName],
  }),
  mapResult: mapDocumentWrite,
}

export const insertSequenceVersionOperation: NeonCommandOperation<
  RowCountResult,
  InsertSequenceVersionParams
> = {
  build: ({ actor, params }) => ({
    text: `INSERT INTO public.sequence_versions
              (sequence_id, revision, name, document, saved_by, saved_by_name)
           VALUES ($1::uuid, $2::integer, $3, $4::jsonb, $5::uuid, $6)`,
    values: [
      params?.sequenceId,
      params?.revision,
      params?.name,
      params?.documentJson,
      actor.actorId,
      params?.actorName,
    ],
  }),
  mapResult: (_rows, rowCount) => ({ rowCount }),
}

export const createCommentThreadOperation: NeonCommandOperation<
  CommentThreadWriteResult,
  CreateCommentThreadParams
> = {
  build: ({ actor, params }) => ({
    text: `INSERT INTO public.sequence_comment_threads
              (sequence_id, step_id, variation_id, anchor, created_by, created_by_name)
           VALUES ($1::uuid, $2, $3, $4::jsonb, $5::uuid, $6)
        RETURNING id::text AS thread_id`,
    values: [
      params?.sequenceId,
      params?.stepId,
      params?.variationId,
      params?.anchorJson,
      actor.actorId,
      params?.actorName,
    ],
  }),
  mapResult: (rows, rowCount) => ({
    rowCount,
    threadId: rows[0] ? String(rows[0].thread_id) : null,
  }),
}

export const addCommentMessageOperation: NeonCommandOperation<
  RowCountResult,
  AddCommentMessageParams
> = {
  build: ({ actor, params }) => ({
    text: `INSERT INTO public.sequence_comment_messages
              (thread_id, author_id, author_name, body)
           VALUES ($1::uuid, $2::uuid, $3, $4)`,
    values: [params?.threadId, actor.actorId, params?.actorName, params?.body],
  }),
  mapResult: (_rows, rowCount) => ({ rowCount }),
}

export const setCommentResolvedOperation: NeonCommandOperation<
  RowCountResult,
  SetCommentResolvedParams
> = {
  build: ({ actor, params }) => ({
    text: `UPDATE public.sequence_comment_threads
              SET resolved_at = CASE WHEN $2::boolean THEN now() ELSE NULL END,
                  resolved_by = CASE WHEN $2::boolean THEN $3::uuid ELSE NULL END,
                  resolved_by_name = CASE WHEN $2::boolean THEN $4 ELSE NULL END
            WHERE id = $1::uuid`,
    values: [params?.threadId, params?.resolved, actor.actorId, params?.actorName],
  }),
  mapResult: (_rows, rowCount) => ({ rowCount }),
}
