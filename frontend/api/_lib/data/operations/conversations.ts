/**
 * The conversation-keyed reads: follow-up state, its audit history, the
 * latest-message projection and the durable reply-intent milestones.
 *
 * Every relation here is keyed by `(instance_id, profile_url)` — the thread key
 * `leadKey()` builds in `frontend/src/lib/leads.ts`. The scoping rule from
 * `CLAUDE.md` is why the instance is always half of it: the same person can be
 * reached from two LinkedIn accounts, and a `profile_url` on its own names two
 * different conversations.
 *
 * ## One sort key for all three team-wide reads, and it is keyset
 *
 * `ORDER BY instance_id, profile_url` with a seek predicate
 * `(instance_id, profile_url) > (…)`. The same key on all three, because it is
 * the same key in the schema: it is the primary key of
 * `conversation_follow_up_state`, and it is the `DISTINCT ON` key of
 * `conversation_latest_message` and the `GROUP BY` key of
 * `conversation_reply_intent` — so it is unique in each of their outputs by
 * construction, which is exactly the total order keyset requires. The two views
 * carry no constraint saying so, so the live suite asserts no key repeats across
 * a full walk rather than trusting the reading.
 *
 * Both halves of the comparison run under the columns' own collation, in the same
 * statement, so the `ORDER BY` and the seek cannot disagree about what "greater"
 * means. The cursor carries the two values as JSON strings and PostgreSQL parses
 * them back to the same texts.
 *
 * **Why keyset and not the offset the aggregate reads use.** These are not small:
 * one row per conversation the team has ever held, which on four notebooks is
 * already past PostgREST's 1,000-row cap and grows with every new thread. And
 * unlike `messages`, the win here is *available today* rather than pending an
 * index: the seek predicate is on the grouping columns of the two views, which is
 * a qual PostgreSQL can push down into the aggregate's input, while an `OFFSET`
 * applied outside can only be evaluated after the whole aggregate has been
 * computed. The handoff records what that measured.
 *
 * ## `conversation_reply_intent` was being silently truncated
 *
 * Not a migration target — a live defect. `DataContext.tsx:636` fetches this view
 * with `select('*')` and no pagination at all, so on the running dashboard it
 * stops at PostgREST's 1,000-row cap. Every conversation past the thousandth is
 * missing its `highest_intent` and its P3 milestone, which is the denominator for
 * post-P3 booking conversion — so the figure is not merely incomplete, it is
 * biased, and nothing anywhere reports a problem. This path pages it. The
 * Supabase path is untouched by this session and still truncates; that is the
 * owner's to schedule, and it is reported separately from the migration.
 *
 * ## `owner_id` is the same hazard as `assigned_to`, under another name
 *
 * `conversation_follow_up_state.owner_id` and `follow_up_events.previous_owner_id`
 * / `new_owner_id` are `team_members.id` values in the **source** id space. The
 * same integers on Neon denote different people (N-B2 has the map), so a roster
 * join here mislabels the owner of a follow-up task and fails nothing. The
 * columns are selected and never resolved, exactly as `leads.assigned_to` is, and
 * `frontend/tests/dashboardSlice.test.ts` asserts the distinction per operation.
 *
 * `follow_up_events` also carries `previous_owner_name` / `new_owner_name`, which
 * are text snapshots taken when the event was written. Those are safe: they need
 * no roster to read and they stay correct after a member is removed — which is
 * why the history panel is legible without any of this.
 *
 * ## What tolerates a missing relation, and what does not
 *
 * `conversations.followUpState` and `conversations.latestMessage` tolerate it,
 * because `fetchFollowUpData` does: a pre-046 database is an *unavailable* state
 * rather than an empty queue, and the UI says so. That distinction is why the
 * endpoint answers with an explicit `unavailable: true` rather than a bare `[]` —
 * an empty follow-up queue and an absent one look identical in an array, and the
 * browser has to be able to tell them apart to keep rendering what it renders
 * today. `conversations.replyIntent` tolerates it for the same reason its
 * Supabase error is excluded from the aggregate error today.
 *
 * `conversations.followUpHistory` does **not**. It is fetched on demand by a panel
 * that has its own error state and shows it; swallowing a failure there would
 * replace a visible message with a blank history.
 */

import type { NeonKeysetValue, NeonQueryOperation, NeonRow } from '../neon.js'

export const CONVERSATION_OPERATIONS = {
  /** Current follow-up projection per conversation, team-wide. */
  followUpState: 'conversations.followUpState',
  /** Newest non-empty message per conversation, team-wide. */
  latestMessage: 'conversations.latestMessage',
  /** Durable reply-intent milestones per conversation, team-wide. */
  replyIntent: 'conversations.replyIntent',
  /** The follow-up audit trail for one conversation, newest first. */
  followUpHistory: 'conversations.followUpHistory',
} as const

// ---------------------------------------------------------------------------
// Row shapes, in the browser's own column names.
// ---------------------------------------------------------------------------

export interface FollowUpStateRow {
  readonly instance_id: string
  readonly profile_url: string
  /** A `date`, a calendar day rather than an instant. `YYYY-MM-DD` or null. */
  readonly next_follow_up_date: string | null
  /** A source-space `team_members.id`. Never resolved here. */
  readonly owner_id: number | null
  readonly revision: number
  readonly last_event_id: number | null
  readonly last_mutation_id: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly updated_by: string
  readonly archived_at: string | null
}

export interface ConversationLatestMessageRow {
  readonly instance_id: string
  readonly profile_url: string
  readonly message_id: number
  readonly direction: string
  readonly body: string
  readonly sent_at: string
  readonly source: string | null
}

export interface ConversationReplyIntentRow {
  readonly instance_id: string
  readonly profile_url: string
  readonly highest_intent: string | null
  readonly first_p1_at: string | null
  readonly first_p2_at: string | null
  readonly first_p3_at: string | null
  readonly first_p3_campaign_id: string | null
  readonly last_out_after_p3_at: string | null
  readonly last_in_after_p3_at: string | null
}

export interface FollowUpEventRow {
  readonly id: number
  readonly instance_id: string
  readonly profile_url: string
  readonly mutation_id: string
  readonly event_ordinal: number
  readonly request_fingerprint: string
  readonly event_kind: string
  readonly previous_due_date: string | null
  readonly new_due_date: string | null
  /** Source-space member ids. Never resolved; the `_name` columns are snapshots. */
  readonly previous_owner_id: number | null
  readonly new_owner_id: number | null
  readonly previous_owner_name: string | null
  readonly new_owner_name: string | null
  readonly state_revision: number
  readonly actor: string
  readonly reason: string | null
  readonly occurred_at: string
}

// ---------------------------------------------------------------------------
// Parameters.
// ---------------------------------------------------------------------------

/** One conversation, by thread key. Both halves are required — see the header. */
export interface ConversationParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly [key: string]: string | null
}

// ---------------------------------------------------------------------------
// Mapping helpers.
// ---------------------------------------------------------------------------

const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

/**
 * The shared seek predicate and order for the three team-wide reads. Written
 * once because it is one key; the parameter positions are fixed so each
 * operation's `values` array has the same shape.
 */
const CONVERSATION_KEYSET = { columns: ['instance_id', 'profile_url'] } as const

const conversationSeek = (alias: string) =>
  `($1::text IS NULL
           OR (${alias}.instance_id, ${alias}.profile_url) > ($1::text, $2::text))
    ORDER BY ${alias}.instance_id, ${alias}.profile_url`

const conversationSeekValues = (
  after: readonly NeonKeysetValue[] | undefined,
): readonly unknown[] => [after?.[0] ?? null, after?.[1] ?? null]

// ---------------------------------------------------------------------------
// conversations.followUpState
// ---------------------------------------------------------------------------

/**
 * `next_follow_up_date` is rendered as text for the same reason
 * `annotations.noted_at` and `daily_activity.day` are: it is a calendar day, and
 * the browser compares it against `YYYY-MM-DD` strings. A follow-up due "today"
 * is due on the operator's calendar, not at an instant, so parsing it as one and
 * re-formatting is how a task shows up a day early in one timezone.
 */
const FOLLOW_UP_STATE_SQL = `SELECT s.instance_id,
          s.profile_url,
          to_char(s.next_follow_up_date, 'YYYY-MM-DD') AS next_follow_up_date,
          s.owner_id,
          s.revision::text AS revision,
          s.last_event_id::text AS last_event_id,
          s.last_mutation_id::text AS last_mutation_id,
          s.created_at,
          s.updated_at,
          s.updated_by,
          s.archived_at
     FROM public.conversation_follow_up_state s
    WHERE ${conversationSeek('s')}`

export const followUpStateOperation: NeonQueryOperation<FollowUpStateRow> = {
  keyset: CONVERSATION_KEYSET,
  build: ({ after }) => ({
    text: FOLLOW_UP_STATE_SQL,
    values: conversationSeekValues(after),
  }),
  mapRow: (row: NeonRow): FollowUpStateRow => ({
    instance_id: String(row.instance_id),
    profile_url: String(row.profile_url),
    next_follow_up_date: nullableText(row.next_follow_up_date),
    // `bigint` → string from `pg`; the browser holds a number. Selected and
    // never joined: see the header on the id-space collision.
    owner_id: nullableNumber(row.owner_id),
    revision: Number(row.revision),
    last_event_id: nullableNumber(row.last_event_id),
    last_mutation_id: nullableText(row.last_mutation_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    updated_by: String(row.updated_by),
    archived_at: nullableText(row.archived_at),
  }),
}

// ---------------------------------------------------------------------------
// conversations.latestMessage
// ---------------------------------------------------------------------------

const LATEST_MESSAGE_SQL = `SELECT m.instance_id,
          m.profile_url,
          m.message_id::text AS message_id,
          m.direction,
          m.body,
          m.sent_at,
          m.source
     FROM public.conversation_latest_message m
    WHERE ${conversationSeek('m')}`

export const conversationLatestMessageOperation: NeonQueryOperation<ConversationLatestMessageRow> = {
  keyset: CONVERSATION_KEYSET,
  build: ({ after }) => ({
    text: LATEST_MESSAGE_SQL,
    values: conversationSeekValues(after),
  }),
  mapRow: (row: NeonRow): ConversationLatestMessageRow => ({
    instance_id: String(row.instance_id),
    profile_url: String(row.profile_url),
    message_id: Number(row.message_id),
    direction: String(row.direction),
    // The view's own predicate excludes empty and NULL bodies, so this is a
    // string by construction — which is why the browser type is not nullable.
    body: String(row.body),
    sent_at: String(row.sent_at),
    source: nullableText(row.source),
  }),
}

// ---------------------------------------------------------------------------
// conversations.replyIntent
// ---------------------------------------------------------------------------

const REPLY_INTENT_SQL = `SELECT i.instance_id,
          i.profile_url,
          i.highest_intent,
          i.first_p1_at,
          i.first_p2_at,
          i.first_p3_at,
          i.first_p3_campaign_id,
          i.last_out_after_p3_at,
          i.last_in_after_p3_at
     FROM public.conversation_reply_intent i
    WHERE ${conversationSeek('i')}`

export const conversationReplyIntentOperation: NeonQueryOperation<ConversationReplyIntentRow> = {
  keyset: CONVERSATION_KEYSET,
  build: ({ after }) => ({
    text: REPLY_INTENT_SQL,
    values: conversationSeekValues(after),
  }),
  mapRow: (row: NeonRow): ConversationReplyIntentRow => ({
    instance_id: String(row.instance_id),
    profile_url: String(row.profile_url),
    // The view derives this with `max(intent_level) FILTER (…)`, which is NULL
    // only if the conversation has no labelled inbound row — in which case it
    // has no row here at all. Nullable anyway rather than asserting a view's
    // internals through a cast.
    highest_intent: nullableText(row.highest_intent),
    first_p1_at: nullableText(row.first_p1_at),
    first_p2_at: nullableText(row.first_p2_at),
    first_p3_at: nullableText(row.first_p3_at),
    first_p3_campaign_id: nullableText(row.first_p3_campaign_id),
    last_out_after_p3_at: nullableText(row.last_out_after_p3_at),
    last_in_after_p3_at: nullableText(row.last_in_after_p3_at),
  }),
}

// ---------------------------------------------------------------------------
// conversations.followUpHistory
// ---------------------------------------------------------------------------

/**
 * Newest first, `(occurred_at, id)` descending, with a ROW comparison as the
 * seek — and `follow_up_events_thread_time_idx` is
 * `(instance_id, profile_url, occurred_at DESC, id DESC)`, so this is the one
 * read in the slice whose sort key already has an exactly-matching index. The
 * handoff records what that measured against offset.
 *
 * **The client's existing seek predicate does not match its own order, and this
 * one does.** `FollowUpPanel.tsx:112` orders by `(occurred_at DESC, id DESC)` and
 * then pages with `.lt('id', lastId)` — a predicate on `id` alone. The two agree
 * only while `id` order and `occurred_at` order agree, which is *usually* true
 * for an append-only log and is not guaranteed: `occurred_at` defaults to `now()`,
 * which is transaction-start time, while `id` comes from a sequence at insert
 * time, so two overlapping transactions can commit with the orders inverted. When
 * that happens the panel's "load more" can skip or repeat a row. The ROW
 * comparison below has no such gap. The browser is not this session's to change —
 * it is reported as a finding.
 */
const FOLLOW_UP_HISTORY_SQL = `SELECT e.id::text AS id,
          e.instance_id,
          e.profile_url,
          e.mutation_id::text AS mutation_id,
          e.event_ordinal,
          e.request_fingerprint,
          e.event_kind,
          to_char(e.previous_due_date, 'YYYY-MM-DD') AS previous_due_date,
          to_char(e.new_due_date, 'YYYY-MM-DD') AS new_due_date,
          e.previous_owner_id,
          e.new_owner_id,
          e.previous_owner_name,
          e.new_owner_name,
          e.state_revision::text AS state_revision,
          e.actor,
          e.reason,
          e.occurred_at
     FROM public.follow_up_events e
    WHERE e.instance_id = $1
      AND e.profile_url = $2
      AND ($3::timestamptz IS NULL
           OR (e.occurred_at, e.id) < ($3::timestamptz, $4::bigint))
    ORDER BY e.occurred_at DESC, e.id DESC`

export const followUpHistoryOperation: NeonQueryOperation<
  FollowUpEventRow,
  ConversationParams
> = {
  keyset: { columns: ['occurred_at', 'id'] },
  build: ({ params, after }) => ({
    text: FOLLOW_UP_HISTORY_SQL,
    values: [
      params?.instanceId ?? null,
      params?.profileUrl ?? null,
      (after?.[0] as NeonKeysetValue | undefined) ?? null,
      (after?.[1] as NeonKeysetValue | undefined) ?? null,
    ],
  }),
  mapRow: (row: NeonRow): FollowUpEventRow => ({
    id: Number(row.id),
    instance_id: String(row.instance_id),
    profile_url: String(row.profile_url),
    mutation_id: String(row.mutation_id),
    // `smallint`, which `pg` already returns as a number.
    event_ordinal: Number(row.event_ordinal),
    request_fingerprint: String(row.request_fingerprint),
    event_kind: String(row.event_kind),
    previous_due_date: nullableText(row.previous_due_date),
    new_due_date: nullableText(row.new_due_date),
    previous_owner_id: nullableNumber(row.previous_owner_id),
    new_owner_id: nullableNumber(row.new_owner_id),
    previous_owner_name: nullableText(row.previous_owner_name),
    new_owner_name: nullableText(row.new_owner_name),
    state_revision: Number(row.state_revision),
    actor: String(row.actor),
    reason: nullableText(row.reason),
    occurred_at: String(row.occurred_at),
  }),
}
