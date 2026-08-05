/**
 * The conversation-history write vocabulary: manual thread import, the edit and
 * delete of a single imported message, and the six follow-up actions.
 *
 * Three subjects live here, and each one carries a different guarantee.
 *
 * ## 1. Import: a lock, then dedup, then two writes that must commit together
 *
 * LH2 stops capturing a thread once the SDR takes it over by hand, so the paste
 * flow writes `messages` with `source='manual'` and backfills whatever milestones
 * those messages prove. On the Supabase path that is four independent PostgREST
 * calls — read the lead, read the thread, upsert the rows, patch the lead — and
 * two things go wrong with it:
 *
 * - **The milestone patch failing is reported as `milestone_error` inside a
 *   200.** The messages are already committed, so there is nothing else the
 *   handler can do. The result is a thread whose inbound message exists while
 *   `leads.replied_at` stays NULL, which is precisely a lead that has replied and
 *   does not appear in the reply funnel.
 * - **Two concurrent imports of the same thread both read the same "already
 *   there" set** and both decide the same blocks are new. The identity-key
 *   `ON CONFLICT DO NOTHING` catches an exact duplicate, but a manual row's
 *   `sent_at` is the real message time while a synced row's is the LH2 action-run
 *   time, so two pastes of the same conversation with different parsed instants
 *   are *not* identical rows and both survive. The thread doubles.
 *
 * Both are closed here. All four statements run in one `DataStore.transaction`,
 * so the backfill failing rolls the messages back; and the transaction opens by
 * taking `pg_advisory_xact_lock` on the thread key, so the read-then-insert is
 * serialized per conversation instead of merely being inside a transaction —
 * READ COMMITTED alone would let both readers see the same pre-state.
 *
 * **The lock key deliberately matches `apply_follow_up_action`'s.** That
 * function, in baseline step `003`, locks
 * `hashtextextended(jsonb_build_array(instance_id, profile_url)::text, 0)`, and
 * reusing the identical expression means an import and a follow-up action on the
 * same conversation serialize against each other too. They touch different
 * tables, so this is stricter than strictly necessary; it is chosen because both
 * paths read and write the same lead, and because two lock namespaces over one
 * conceptual key is how a future caller takes the wrong one.
 *
 * ## 2. Dedup stays in JavaScript, and that is the safest available answer
 *
 * The rule (`CLAUDE.md`) is: dedup by **normalized body + direction**, never by
 * the `messages` unique key. The normalization — strip `\r`, trim, collapse
 * whitespace, lowercase — already exists twice, in `_lib/conversationImport.ts`
 * and in `src/lib/parseLinkedInThread.ts`, kept in step by a comment because
 * `api/` and `src/` are separate TS roots.
 *
 * Expressing it a third time as
 * `lower(btrim(regexp_replace(replace(body, E'\r', ''), '\s+', ' ', 'g')))`
 * would push the comparison into the database and save reading the thread. It was
 * rejected: a third definition in a *different language* is one that drifts
 * without any test noticing, and the failure mode is a doubled thread — the exact
 * outcome the rule exists to prevent. Postgres and JavaScript also do not agree
 * on what `\s` matches or on how `lower()` treats non-ASCII, so the two would be
 * subtly different from the day they were written.
 *
 * So `conversations.threadDedupKeys` reads `(direction, body)` for the thread and
 * the handler reuses the function it already has. The read is paged through the
 * store like any other, which is a small improvement on the Supabase path's
 * unpaginated `select` — the same latent cap defect the S13 consolidation
 * measured on `conversation_reply_intent`, here on a relation that could in
 * principle hold a thread of more than a thousand messages.
 *
 * ## 3. Follow-ups: nothing to make atomic, and the reason matters
 *
 * `apply_follow_up_action` is a single `SECURITY DEFINER` function in step `003`.
 * It already takes the advisory lock, already checks `expected_revision`
 * optimistically, already replays a repeated `mutation_id` after comparing a
 * `request_fingerprint`, and already writes `conversation_follow_up_state` and
 * `follow_up_events` in one statement's transaction. So the Supabase path here is
 * **not** "separate PostgREST calls": it is one RPC, and the port is one
 * `execute` of the same function. The atomicity, idempotency and locking this
 * session owes are already in the SQL and travel with the baseline; what this
 * module adds is proof that they still hold on Neon under `app_runtime`.
 *
 * It is registered and proven live, and **the endpoint does not route to it** —
 * see the handoff on the roster wall. `p_owner_id` is a `team_members.id`, and
 * while reads stay on Supabase the browser supplies that integer from the
 * Supabase roster, where the same value denotes a different person (N-B2).
 */

import type { NeonCommandOperation, NeonQueryOperation, NeonRow } from '../neon.js'

export const CONVERSATION_WRITE_OPERATIONS = {
  /** The lead a paste is anchored to, plus the milestones it may backfill. */
  leadForImport: 'conversations.leadForImport',
  /** `(direction, body)` for one thread, for the normalized-body dedup. */
  threadDedupKeys: 'conversations.threadDedupKeys',
} as const

export const CONVERSATION_WRITE_COMMANDS = {
  lockThread: 'conversations.lockThread',
  insertImportedMessages: 'conversations.insertImportedMessages',
  backfillMilestones: 'conversations.backfillMilestones',
  editManualMessage: 'conversations.editManualMessage',
  deleteManualMessage: 'conversations.deleteManualMessage',
  applyFollowUpAction: 'conversations.applyFollowUpAction',
} as const

const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

// ---------------------------------------------------------------------------
// The import's two reads.
// ---------------------------------------------------------------------------

export interface LeadForImportRow {
  readonly id: string
  readonly instance_id: string
  readonly connected_at: string | null
  readonly first_message_at: string | null
  readonly replied_at: string | null
}

export interface LeadForImportParams {
  readonly campaignId: string
  readonly profileUrl: string
  readonly [key: string]: string
}

/**
 * Keyed by `(campaign_id, profile_url)` and not by lead id, because that is what
 * the drawer knows. The lead must exist: it anchors the `messages → campaigns`
 * foreign key and it is the backfill target.
 */
const LEAD_FOR_IMPORT_SQL = `SELECT l.id::text AS id,
          l.instance_id,
          l.connected_at,
          l.first_message_at,
          l.replied_at
     FROM public.leads l
    WHERE l.campaign_id = $1 AND l.profile_url = $2`

export const leadForImportOperation: NeonQueryOperation<
  LeadForImportRow,
  LeadForImportParams
> = {
  build: ({ params }) => ({
    text: LEAD_FOR_IMPORT_SQL,
    values: [params?.campaignId ?? '', params?.profileUrl ?? ''],
  }),
  mapRow: (row: NeonRow): LeadForImportRow => ({
    id: String(row.id),
    instance_id: String(row.instance_id),
    connected_at: nullableText(row.connected_at),
    first_message_at: nullableText(row.first_message_at),
    replied_at: nullableText(row.replied_at),
  }),
}

export interface ThreadDedupKeyRow {
  readonly direction: string
  readonly body: string | null
}

export interface ThreadKeyParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly [key: string]: string
}

/**
 * Ordered by `id` so the page walk is stable. The projection is two columns on
 * purpose: the caller needs only enough to build a dedup key, and a thread of a
 * few hundred messages should not drag seventeen columns across the wire.
 */
const THREAD_DEDUP_KEYS_SQL = `SELECT m.direction, m.body
     FROM public.messages m
    WHERE m.instance_id = $1 AND m.profile_url = $2
    ORDER BY m.id`

export const threadDedupKeysOperation: NeonQueryOperation<
  ThreadDedupKeyRow,
  ThreadKeyParams
> = {
  build: ({ params }) => ({
    text: THREAD_DEDUP_KEYS_SQL,
    values: [params?.instanceId ?? '', params?.profileUrl ?? ''],
  }),
  mapRow: (row: NeonRow): ThreadDedupKeyRow => ({
    direction: String(row.direction),
    body: nullableText(row.body),
  }),
}

// ---------------------------------------------------------------------------
// The thread lock.
// ---------------------------------------------------------------------------

/**
 * `pg_advisory_xact_lock`, released at COMMIT or ROLLBACK by the server.
 *
 * The transaction-scoped variant, never the session one: the pooled endpoint
 * hands the same backend to unrelated clients, so a session lock that outlived a
 * request would be held by whoever got the connection next — the same class of
 * leak as `set_config(…, false)`, which N-S13 already paid for once.
 */
export const lockThreadOperation: NeonCommandOperation<
  { readonly locked: true },
  ThreadKeyParams
> = {
  build: ({ params }) => ({
    text:
      `SELECT pg_advisory_xact_lock(` +
      `hashtextextended(jsonb_build_array($1::text, $2::text)::text, 0))`,
    values: [params?.instanceId ?? '', params?.profileUrl ?? ''],
  }),
  mapResult: () => ({ locked: true as const }),
}

// ---------------------------------------------------------------------------
// The import's two writes.
// ---------------------------------------------------------------------------

/**
 * One statement for any number of rows, via parallel arrays and `unnest`.
 *
 * The alternative was one `execute` per message, which for a 500-block paste is
 * 500 round trips inside a transaction holding an advisory lock — long enough to
 * matter and long enough to hit the 8 s statement budget. Parallel arrays keep it
 * to one statement with six bound parameters whatever the row count, and
 * `DataStoreParam` already admits arrays of scalars, so the contract did not have
 * to widen.
 *
 * `ON CONFLICT … DO NOTHING` on `messages_identity_key` is retained from the
 * Supabase path and does the same job: a forced exact re-import is a silent skip
 * rather than a 409. It is a backstop, not the dedup — see the module header.
 * `RETURNING id` therefore counts only the rows that really landed, which is what
 * the response's `inserted` reports.
 */
export interface InsertImportedMessagesParams {
  readonly instanceId: string
  readonly campaignId: string
  readonly profileUrl: string
  readonly directions: readonly string[]
  readonly bodies: readonly string[]
  readonly sentAts: readonly string[]
  readonly contentHashes: readonly string[]
  readonly [key: string]: string | readonly string[]
}

const INSERT_IMPORTED_MESSAGES_SQL = `INSERT INTO public.messages
            (instance_id, campaign_id, profile_url,
             direction, body, sent_at, content_hash, source)
     SELECT $1, $2, $3, d.direction, d.body, d.sent_at, d.content_hash, 'manual'
       FROM unnest($4::text[], $5::text[], $6::timestamptz[], $7::text[])
              AS d(direction, body, sent_at, content_hash)
ON CONFLICT (instance_id, profile_url, direction, sent_at, content_hash)
         DO NOTHING
  RETURNING id`

export const insertImportedMessagesOperation: NeonCommandOperation<
  { readonly inserted: number },
  InsertImportedMessagesParams
> = {
  build: ({ params }) => ({
    text: INSERT_IMPORTED_MESSAGES_SQL,
    values: [
      params?.instanceId ?? '',
      params?.campaignId ?? '',
      params?.profileUrl ?? '',
      params?.directions ?? [],
      params?.bodies ?? [],
      params?.sentAts ?? [],
      params?.contentHashes ?? [],
    ],
  }),
  mapResult: (_rows, rowCount) => ({ inserted: rowCount }),
}

/**
 * `COALESCE` per column, which makes the idempotency structural.
 *
 * The Supabase handler builds a patch object containing only the columns that
 * are currently NULL, so its "fill only what is missing" rule lives in
 * JavaScript and a future edit could drop it silently. Here every column is
 * assigned `COALESCE(column, $n)`, so a non-NULL milestone can only ever be
 * written back to itself: LH2 stays ground truth for anything it recorded, and a
 * re-import of a fully deduped paste still fills a milestone an earlier partial
 * import missed.
 *
 * It also cannot fight `leads_keep_milestones` (step `003`, migration 026's
 * trigger), which rejects a non-NULL → NULL regression on these columns —
 * `COALESCE` never produces NULL from a non-NULL input, so the two agree by
 * construction rather than by coincidence.
 */
export interface BackfillMilestonesParams {
  readonly leadId: string
  readonly repliedAt: string | null
  readonly firstMessageAt: string | null
  readonly connectedAt: string | null
  readonly [key: string]: string | null
}

export interface BackfillMilestonesResult {
  readonly rowCount: number
  readonly row: {
    readonly connected_at: string | null
    readonly first_message_at: string | null
    readonly replied_at: string | null
  } | null
}

const BACKFILL_MILESTONES_SQL = `UPDATE public.leads
      SET replied_at = COALESCE(replied_at, $2::timestamptz),
          first_message_at = COALESCE(first_message_at, $3::timestamptz),
          connected_at = COALESCE(connected_at, $4::timestamptz)
    WHERE id = $1::uuid
RETURNING connected_at, first_message_at, replied_at`

export const backfillMilestonesOperation: NeonCommandOperation<
  BackfillMilestonesResult,
  BackfillMilestonesParams
> = {
  build: ({ params }) => ({
    text: BACKFILL_MILESTONES_SQL,
    values: [
      params?.leadId ?? '',
      params?.repliedAt ?? null,
      params?.firstMessageAt ?? null,
      params?.connectedAt ?? null,
    ],
  }),
  mapResult: (rows, rowCount): BackfillMilestonesResult => ({
    rowCount,
    row: rows[0]
      ? {
          connected_at: nullableText(rows[0].connected_at),
          first_message_at: nullableText(rows[0].first_message_at),
          replied_at: nullableText(rows[0].replied_at),
        }
      : null,
  }),
}

// ---------------------------------------------------------------------------
// Manual edit and delete.
// ---------------------------------------------------------------------------

/**
 * `AND source = 'manual'` is in the `WHERE`, not checked beforehand.
 *
 * A synced row is not editable, and making that part of the predicate means an
 * unknown id and a synced id are the same zero row count — so the handler answers
 * 404 for both and discloses nothing about which messages exist. The
 * `content_hash` is recomputed here because it is `md5(body)` by definition and a
 * body edited without it would stop matching the agent's own hash on the next
 * sync.
 */
export interface EditManualMessageParams {
  readonly messageId: number
  readonly body: string
  readonly contentHash: string
  readonly [key: string]: string | number
}

export interface EditManualMessageResult {
  readonly rowCount: number
  readonly id: string | null
}

const EDIT_MANUAL_MESSAGE_SQL = `UPDATE public.messages
      SET body = $2, content_hash = $3
    WHERE id = $1::bigint AND source = 'manual'
RETURNING id::text AS id`

export const editManualMessageOperation: NeonCommandOperation<
  EditManualMessageResult,
  EditManualMessageParams
> = {
  build: ({ params }) => ({
    text: EDIT_MANUAL_MESSAGE_SQL,
    values: [params?.messageId ?? 0, params?.body ?? '', params?.contentHash ?? ''],
  }),
  mapResult: (rows, rowCount): EditManualMessageResult => ({
    rowCount,
    id: rows[0] ? String(rows[0].id) : null,
  }),
}

/**
 * `public.delete_manual_message` (step `003`), not a `DELETE`.
 *
 * The function refuses a `source='sync'` row and, having deleted a manual one,
 * **recomputes the milestones that row's import had backfilled** — which a plain
 * `DELETE` cannot do, because nothing else records that a milestone came from
 * that message. Its `jsonb` result carries `deleted` and
 * `milestones_recomputed`; a false `deleted` covers both an unknown id and a
 * synced row, so the handler's 404 discloses nothing.
 */
export interface DeleteManualMessageParams {
  readonly messageId: number
  readonly [key: string]: number
}

export interface DeleteManualMessageResult {
  readonly deleted: boolean
  readonly milestones_recomputed: number
}

export const deleteManualMessageOperation: NeonCommandOperation<
  DeleteManualMessageResult,
  DeleteManualMessageParams
> = {
  build: ({ params }) => ({
    text: `SELECT public.delete_manual_message($1::bigint) AS result`,
    values: [params?.messageId ?? 0],
  }),
  mapResult: (rows): DeleteManualMessageResult => {
    const result = (rows[0]?.result ?? {}) as {
      deleted?: boolean
      milestones_recomputed?: number
    }
    return {
      deleted: result.deleted === true,
      milestones_recomputed: Number(result.milestones_recomputed ?? 0),
    }
  },
}

// ---------------------------------------------------------------------------
// The six follow-up actions, as one command.
// ---------------------------------------------------------------------------

/**
 * One operation for all six, because the function takes the action as an
 * argument and shares its lock, its revision check and its replay path across
 * them. Six allowlist entries differing only in a string literal would suggest
 * six behaviours where there is one.
 *
 * The action is still validated in the handler against a closed set, and the
 * function itself raises SQLSTATE `22023` for anything outside it — so an
 * unexpected value is refused twice and reaches no branch either way.
 */
export type FollowUpAction =
  | 'schedule'
  | 'reschedule'
  | 'reassign'
  | 'complete'
  | 'skip'
  | 'cancel'

export interface ApplyFollowUpActionParams {
  readonly action: FollowUpAction
  readonly instanceId: string
  readonly profileUrl: string
  readonly actor: string
  readonly expectedRevision: number
  readonly mutationId: string
  readonly ownerId: number | null
  readonly nextFollowUpDate: string | null
  readonly reason: string | null
  readonly [key: string]: string | number | null
}

const APPLY_FOLLOW_UP_ACTION_SQL = `SELECT public.apply_follow_up_action(
          $1::text, $2::text, $3::text, $4::text, $5::bigint, $6::uuid,
          $7::bigint, $8::date, $9::text) AS result`

export const applyFollowUpActionOperation: NeonCommandOperation<
  Record<string, unknown>,
  ApplyFollowUpActionParams
> = {
  build: ({ params }) => ({
    text: APPLY_FOLLOW_UP_ACTION_SQL,
    values: [
      params?.action ?? '',
      params?.instanceId ?? '',
      params?.profileUrl ?? '',
      params?.actor ?? '',
      params?.expectedRevision ?? 0,
      params?.mutationId ?? '',
      params?.ownerId ?? null,
      params?.nextFollowUpDate ?? null,
      params?.reason ?? null,
    ],
  }),
  mapResult: (rows) => (rows[0]?.result ?? {}) as Record<string, unknown>,
}
