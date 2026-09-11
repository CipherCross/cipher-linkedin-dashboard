/** Parameterized Neon commands used by the reply-review transaction service. */

import type { NeonCommandOperation, NeonRow, NeonStatement } from '../neon.js'
import type { DataStoreParams } from '../contracts.js'
import type { ReplyAction, ReplyIntentLevel, ReplyIntentState, ReplyReasonId, ReplySentiment } from '../../replyReview.js'

export interface ReplyThreadParams extends DataStoreParams {
  readonly instanceId: string
  readonly profileUrl: string
}
export interface SaveReviewParams extends ReplyThreadParams {
  readonly messageId: number
  readonly expectedRevision: number
  readonly sentiment: ReplySentiment | null
  readonly intentState: ReplyIntentState
  readonly intentLevel: ReplyIntentLevel | null
  readonly comment: string | null
  readonly taxonomyVersion: string
  readonly actorId: string
}
export interface ReplaceReasonsParams extends DataStoreParams {
  readonly messageId: number
  readonly reasonIds: readonly ReplyReasonId[]
}
export interface ProjectReviewParams extends SaveReviewParams {
  readonly reviewedAt: string
}
export interface SetWorkflowParams extends ReplyThreadParams {
  readonly expectedRevision: number
  readonly observedInboundRevision: number
  readonly action: ReplyAction | null
  readonly ownerId: number | null
  readonly nextFollowUpDate: string | null
  readonly doNotContact: boolean
  readonly supportingMessageId: number | null
  readonly actorId: string
  readonly mutationId: string
}
export interface AppendEventParams extends ReplyThreadParams {
  readonly messageId: number | null
  readonly actorId: string
  readonly provenance: 'human' | 'legacy_manual'
  readonly beforeJson: string
  readonly afterJson: string
  readonly mutationId: string
}
export interface SaveMutationParams extends DataStoreParams {
  readonly mutationId: string
  readonly actorId: string
  readonly payloadHash: string
  readonly resultJson: string
}
export interface ActivateParams extends DataStoreParams {
  readonly mutationId: string
  readonly actorId: string
  readonly batchSize: number
}

export interface RowCountResult { readonly rowCount: number }
export interface SavedReviewResult extends RowCountResult { readonly row?: Record<string, unknown> }
export interface SavedWorkflowResult extends RowCountResult { readonly row?: Record<string, unknown> }
export interface EventResult extends RowCountResult { readonly id?: string }
export interface MutationResult extends RowCountResult { readonly mutation_id?: string; readonly result?: unknown }
export interface ActivationResult extends RowCountResult {
  readonly mode?: string
  readonly activated_at?: string | null
  readonly complete?: boolean
  readonly processed?: number
  readonly remaining?: number
  readonly cursor?: number
  readonly replayed?: boolean
  readonly mutation_id?: string
}

export const REPLY_REVIEW_WRITE_OPERATIONS = {
  reviewForMessage: 'replies.reviewForMessage',
  workflowForThread: 'replies.workflowForThread',
} as const
export const REPLY_REVIEW_WRITE_COMMANDS = {
  lockThread: 'replies.lockThread',
  enableProjection: 'replies.enableProjection',
  saveReview: 'replies.saveReview',
  deleteReasons: 'replies.deleteReasons',
  insertReasons: 'replies.insertReasons',
  projectReview: 'replies.projectReview',
  setWorkflow: 'replies.setWorkflow',
  appendEvent: 'replies.appendEvent',
  saveMutation: 'replies.saveMutation',
  activate: 'replies.activate',
} as const

const replyKey = (params: ReplyThreadParams | undefined) => [params?.instanceId ?? '', params?.profileUrl ?? '']
const mapCount = (_rows: readonly NeonRow[], rowCount: number): RowCountResult => ({ rowCount })

export const lockThreadOperation: NeonCommandOperation<{ readonly locked: true }, ReplyThreadParams> = {
  build: ({ params }): NeonStatement => ({ text: `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, $2::text)::text, 0))`, values: replyKey(params) }),
  mapResult: () => ({ locked: true as const }),
}

export const enableProjectionOperation: NeonCommandOperation<{ readonly enabled: true }> = {
  build: () => ({ text: `SELECT set_config('app.reply_review_write', 'on', true)`, values: [] }),
  mapResult: () => ({ enabled: true as const }),
}

export const reviewForMessageOperation = {
  build: ({ params }: { params?: ReplyThreadParams & { messageId: number } }): NeonStatement => ({ text: `SELECT r.message_id::text AS message_id, r.sentiment, r.intent_state, r.intent_level, r.comment, r.taxonomy_version, r.reviewed_by::text AS reviewed_by, r.provenance, r.reviewed_at, r.revision FROM public.reply_reviews r JOIN public.messages m ON m.id = r.message_id WHERE r.message_id = $1::bigint AND m.instance_id = $2 AND m.profile_url = $3`, values: [params?.messageId ?? 0, params?.instanceId ?? '', params?.profileUrl ?? ''] }),
} satisfies { build: (context: { params?: ReplyThreadParams & { messageId: number } }) => NeonStatement }

export const workflowForThreadOperation = {
  build: ({ params }: { params?: ReplyThreadParams }): NeonStatement => ({ text: `SELECT instance_id, profile_url, action, owner_id, to_char(next_follow_up_date, 'YYYY-MM-DD') AS next_follow_up_date, do_not_contact, acknowledged_inbound_revision, revision, supporting_message_id, updated_at, updated_by FROM public.conversation_follow_up_state WHERE instance_id = $1 AND profile_url = $2`, values: replyKey(params) }),
} satisfies { build: (context: { params?: ReplyThreadParams }) => NeonStatement }

export const saveReviewOperation: NeonCommandOperation<SavedReviewResult, SaveReviewParams> = {
  build: ({ params }) => ({
    text: `INSERT INTO public.reply_reviews
            (message_id, sentiment, intent_state, intent_level, comment, taxonomy_version, reviewed_by, provenance, reviewed_at, revision, sentiment_provenance, intent_provenance)
     SELECT $1::bigint, $3::text, $4::text, $5::text, $6::text, $7::text, $8::uuid, 'human', clock_timestamp(), 1,
       CASE WHEN $3::text IS NULL THEN 'none' ELSE 'human' END,
       CASE WHEN $4::text = 'unreviewed' THEN 'none' ELSE 'human' END
      WHERE $2::bigint = 0
     ON CONFLICT (message_id) DO UPDATE SET sentiment = EXCLUDED.sentiment,
       intent_state = EXCLUDED.intent_state, intent_level = EXCLUDED.intent_level,
       comment = EXCLUDED.comment, taxonomy_version = EXCLUDED.taxonomy_version,
       reviewed_by = EXCLUDED.reviewed_by, provenance = 'human', reviewed_at = clock_timestamp(),
       sentiment_provenance = EXCLUDED.sentiment_provenance, intent_provenance = EXCLUDED.intent_provenance,
       revision = public.reply_reviews.revision + 1
       WHERE public.reply_reviews.revision = $2::bigint
     RETURNING message_id::text AS message_id, sentiment, intent_state, intent_level, comment,
       taxonomy_version, reviewed_by::text AS reviewed_by, provenance, reviewed_at, revision`,
    values: [params?.messageId ?? 0, params?.expectedRevision ?? 0, params?.sentiment ?? null, params?.intentState ?? 'unreviewed', params?.intentLevel ?? null, params?.comment ?? null, params?.taxonomyVersion ?? 'reply-review-v1', params?.actorId ?? ''],
  }),
  mapResult: (rows, rowCount): SavedReviewResult => ({ rowCount, row: rows[0] }),
}

export const deleteReasonsOperation: NeonCommandOperation<RowCountResult, Pick<ReplaceReasonsParams, 'messageId'>> = {
  build: ({ params }) => ({
    text: `DELETE FROM public.reply_review_reasons WHERE message_id = $1::bigint`,
    values: [params?.messageId ?? 0],
  }),
  mapResult: (_rows, rowCount): RowCountResult => ({ rowCount }),
}

export const insertReasonsOperation: NeonCommandOperation<RowCountResult, ReplaceReasonsParams> = {
  build: ({ params }) => ({
    text: `INSERT INTO public.reply_review_reasons (message_id, reason_id)
           SELECT $1::bigint, unnest($2::text[])`,
    values: [params?.messageId ?? 0, params?.reasonIds ?? []],
  }),
  mapResult: (_rows, rowCount): RowCountResult => ({ rowCount }),
}

export const projectReviewOperation: NeonCommandOperation<SavedReviewResult, ProjectReviewParams> = {
  build: ({ params }) => ({
    text: `UPDATE public.messages SET
      sentiment = $2::text,
      reason = CASE WHEN $2::text IS NULL THEN NULL ELSE $5::text END,
      classified_at = CASE WHEN $2::text IS NULL THEN NULL ELSE clock_timestamp() END,
      classified_model = CASE WHEN $2::text IS NULL THEN NULL ELSE 'manual' END,
      intent_level = CASE WHEN $3::text = 'level' THEN $4::text ELSE NULL END,
      intent_reason = CASE WHEN $3::text = 'level' THEN $5::text ELSE NULL END,
      intent_classified_at = CASE WHEN $3::text = 'unreviewed' THEN NULL ELSE clock_timestamp() END,
      intent_classified_model = CASE WHEN $3::text = 'unreviewed' THEN NULL ELSE 'manual' END,
      intent_taxonomy_version = CASE WHEN $3::text = 'unreviewed' THEN NULL ELSE $7::text END
      WHERE id = $1::bigint AND instance_id = $8::text AND profile_url = $9::text`,
    values: [params?.messageId ?? 0, params?.sentiment ?? null, params?.intentState ?? 'unreviewed', params?.intentLevel ?? null, params?.comment ?? null, params?.reviewedAt ?? new Date(0).toISOString(), params?.taxonomyVersion ?? 'reply-review-v1', params?.instanceId ?? '', params?.profileUrl ?? ''],
  }),
  mapResult: mapCount,
}

export const setWorkflowOperation: NeonCommandOperation<SavedWorkflowResult, SetWorkflowParams> = {
  build: ({ params }) => ({
    text: `INSERT INTO public.conversation_follow_up_state
      (instance_id, profile_url, action, owner_id, next_follow_up_date, do_not_contact,
       acknowledged_inbound_revision, supporting_message_id, revision, last_mutation_id, updated_by, updated_at)
      SELECT $1, $2, $4, $5::bigint, $6::date, $7::boolean, $8::bigint, $9::bigint, 1, $10::uuid, $11::text, clock_timestamp()
      WHERE $3::bigint = 0
      ON CONFLICT (instance_id, profile_url) DO UPDATE SET action = EXCLUDED.action, owner_id = EXCLUDED.owner_id,
        next_follow_up_date = EXCLUDED.next_follow_up_date, do_not_contact = EXCLUDED.do_not_contact,
        acknowledged_inbound_revision = EXCLUDED.acknowledged_inbound_revision,
        supporting_message_id = EXCLUDED.supporting_message_id, revision = conversation_follow_up_state.revision + 1,
        last_mutation_id = EXCLUDED.last_mutation_id, updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()
        WHERE conversation_follow_up_state.revision = $3::bigint
          AND conversation_follow_up_state.acknowledged_inbound_revision <= $8::bigint
      RETURNING instance_id, profile_url, action, owner_id, next_follow_up_date, do_not_contact,
        acknowledged_inbound_revision, supporting_message_id, revision, updated_at, updated_by`,
    values: [params?.instanceId ?? '', params?.profileUrl ?? '', params?.expectedRevision ?? 0, params?.action ?? null, params?.ownerId ?? null, params?.nextFollowUpDate ?? null, params?.doNotContact ?? false, params?.observedInboundRevision ?? 0, params?.supportingMessageId ?? null, params?.mutationId ?? '', params?.actorId ?? ''],
  }),
  mapResult: (rows, rowCount): SavedWorkflowResult => ({ rowCount, row: rows[0] }),
}

export const appendEventOperation: NeonCommandOperation<EventResult, AppendEventParams> = {
  build: ({ params }) => ({ text: `INSERT INTO public.reply_review_events
      (instance_id, profile_url, message_id, actor_id, provenance, before, after, occurred_at, mutation_id)
      VALUES ($1, $2, $3::bigint, $4::uuid, $5, $6::jsonb, $7::jsonb, clock_timestamp(), $8::uuid)
      RETURNING id::text AS id`, values: [params?.instanceId ?? '', params?.profileUrl ?? '', params?.messageId ?? null, params?.actorId ?? '', params?.provenance ?? 'human', params?.beforeJson ?? '{}', params?.afterJson ?? '{}', params?.mutationId ?? '']}),
  mapResult: (rows, rowCount): EventResult => ({ rowCount, id: rows[0]?.id === undefined ? undefined : String(rows[0].id) }),
}

export const saveMutationOperation: NeonCommandOperation<MutationResult, SaveMutationParams> = {
  build: ({ params }) => ({ text: `INSERT INTO public.reply_review_mutations (mutation_id, actor_id, payload_hash, result, committed_at) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, clock_timestamp()) ON CONFLICT (mutation_id) DO NOTHING RETURNING mutation_id::text AS mutation_id, result`, values: [params?.mutationId ?? '', params?.actorId ?? '', params?.payloadHash ?? '', params?.resultJson ?? '{}']}),
  mapResult: (rows, rowCount): MutationResult => ({ rowCount, mutation_id: rows[0]?.mutation_id === undefined ? undefined : String(rows[0].mutation_id), result: rows[0]?.result }),
}

export const activateOperation: NeonCommandOperation<ActivationResult, ActivateParams> = {
  build: ({ params }) => ({ text: `SELECT public.activate_manual_reply_review($1::uuid, $2::integer) AS result`, values: [params?.mutationId ?? '', params?.batchSize ?? 500] }),
  mapResult: (rows, rowCount): ActivationResult => {
    const result = rows[0]?.result && typeof rows[0].result === 'object' ? rows[0].result as Record<string, unknown> : {}
    return {
      rowCount,
      mode: result.mode === undefined ? undefined : String(result.mode),
      activated_at: result.activated_at === undefined || result.activated_at === null ? null : String(result.activated_at),
      complete: result.complete === undefined ? undefined : result.complete === true,
      processed: result.processed === undefined || result.processed === null ? undefined : Number(result.processed),
      remaining: result.remaining === undefined || result.remaining === null ? undefined : Number(result.remaining),
      cursor: result.cursor === undefined || result.cursor === null ? undefined : Number(result.cursor),
      replayed: result.replayed === undefined ? undefined : result.replayed === true,
      mutation_id: result.mutation_id === undefined || result.mutation_id === null ? undefined : String(result.mutation_id),
    }
  },
}

/** Explicit registry payload for the integration worker; commands stay named
 * and independently executable inside one DataStore transaction. */
export const allReplyReviewWriteOperations = {
  lockThreadOperation,
  enableProjectionOperation,
  saveReviewOperation,
  deleteReasonsOperation,
  insertReasonsOperation,
  projectReviewOperation,
  setWorkflowOperation,
  appendEventOperation,
  saveMutationOperation,
  activateOperation,
} as const
