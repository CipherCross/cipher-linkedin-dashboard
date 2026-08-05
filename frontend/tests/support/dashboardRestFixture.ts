/**
 * Fixture for S13 part 3 — the medium relations, the sourcing library and the
 * three reads that used to live inside a component.
 *
 * Real rows, written and read back through the baseline's own RLS policies.
 * Nothing is stubbed.
 *
 * **Its own scope, and it assumes nothing.** Part 2's `s13-dashboard` rows are on
 * the shared project today, but that is a mutation of a shared database rather
 * than a contract, so this file seeds everything it needs under `s13-rest` and
 * every assertion filters to it. The library relations (`icps`, `hypotheses`,
 * `saved_searches`, …) are *not* instance-scoped at all — nothing in the schema
 * partitions them — so those rows are identified by a name prefix instead.
 *
 * ## What each number is for
 *
 * - **2,100 labelled conversations → three pages, two cursor chains.** That is
 *   what `conversation_reply_intent` needs to prove the read is complete past
 *   PostgREST's 1,000-row cap, which is the live defect this part of S13 exists to
 *   fix. Two pages would prove the cap is passed; three prove the cursor chains
 *   more than once.
 * - **Plus 40 conversations with an *unlabelled* inbound reply.** So
 *   `conversation_reply_intent` (2,100 rows) and
 *   `conversation_latest_message` (2,140 rows) have deliberately *different*
 *   counts. A test that confused the two, or an operation that read the wrong
 *   view, cannot pass.
 * - **700 of the labelled conversations reach P3 and then receive an outbound
 *   reply.** That populates `first_p3_at` and `last_out_after_p3_at`, so the
 *   view's `LEFT JOIN` branch is exercised rather than assumed, and it makes the
 *   latest message *outbound* for exactly those conversations.
 * - **2,100 pipeline events in groups of seven sharing one `occurred_at`.** Seven
 *   is coprime with 1,000, so a page boundary falls *inside* a group — the case
 *   that fails if `id` leaves the sort key or the seek predicate. The same
 *   property that made part 2's message fixture worth its size, applied to the
 *   append-only audit log the pipeline funnel is reconstructed from.
 * - **120 follow-up events on one conversation, with a planted order
 *   disagreement.** `occurred_at` is a pure function of the index, and two
 *   adjacent indices have theirs swapped, so `id` order and `occurred_at` order
 *   genuinely disagree at one point — which is the situation
 *   `FollowUpPanel.tsx:112`'s `id`-only seek gets wrong and a ROW comparison gets
 *   right. `FOLLOW_UP_PAGE` is 50, matching the panel's own page size, and the
 *   disagreement is positioned to straddle the first boundary.
 * - **26 notes on one lead, one of them with a NULL `created_at`.** The column is
 *   nullable in the baseline, and NULL placement under a bare `DESC` is exactly
 *   the kind of thing that silently differs between two query builders.
 *
 * No `Date.now()` anywhere: every instant is derived from a fixed calendar anchor,
 * so a re-run a month later asserts the same numbers.
 *
 * ## Idempotency
 *
 * Several of these relations have **no natural unique key** — `pipeline_events`,
 * `lead_notes`, `icps`, `hypotheses`, `saved_searches` and the two ICP children
 * are all `GENERATED ALWAYS AS IDENTITY` with nothing unique to conflict on. So
 * where `ON CONFLICT` is available it is used, and where it is not, the insert is
 * guarded by a `NOT EXISTS` on a value this fixture owns (a scope marker in
 * `pipeline_events.actor`, a name prefix on the library rows). A second run of the
 * suite therefore inserts nothing and changes no count.
 */

import type { PoolClient } from 'pg'

/** Namespaced so nothing here collides with S11's, S12's, part 2's or tenant data. */
export const REST_SCOPE = 's13-rest'

/** Prefix for the relations the schema does not scope by instance. */
export const LIBRARY_PREFIX = 'S13R'

export const REST_CAMPAIGN_IDS = [
  `${REST_SCOPE}:1`,
  `${REST_SCOPE}:2`,
] as const

/** Conversations whose inbound reply carries an intent label. Three pages. */
export const LABELLED_CONVERSATIONS = 2_100
/** Conversations with an inbound reply and no intent label at all. */
export const UNLABELLED_CONVERSATIONS = 40
export const REST_LEAD_COUNT = LABELLED_CONVERSATIONS + UNLABELLED_CONVERSATIONS

/** `i % 3` over the labelled conversations, so each level gets exactly a third. */
export const P1_CONVERSATIONS = LABELLED_CONVERSATIONS / 3 // 700
export const P2_CONVERSATIONS = LABELLED_CONVERSATIONS / 3 // 700
export const P3_CONVERSATIONS = LABELLED_CONVERSATIONS / 3 // 700

/** Only the P3 conversations get an outbound follow-up, and it lands after P3. */
export const REST_OUTBOUND_COUNT = P3_CONVERSATIONS
export const REST_INBOUND_COUNT = REST_LEAD_COUNT
export const REST_MESSAGE_COUNT = REST_INBOUND_COUNT + REST_OUTBOUND_COUNT

/** One follow-up projection per labelled conversation. Three pages. */
export const FOLLOW_UP_STATE_COUNT = LABELLED_CONVERSATIONS
/** Every tenth carries an owner; the rest are unowned. */
export const OWNED_EVERY = 10
export const OWNED_FOLLOW_UPS = FOLLOW_UP_STATE_COUNT / OWNED_EVERY // 210
/** Every seventh is archived — an archived task is not an open one. */
export const ARCHIVED_EVERY = 7
export const ARCHIVED_FOLLOW_UPS = FOLLOW_UP_STATE_COUNT / ARCHIVED_EVERY // 300

/**
 * `team_members` ids used for `owner_id`, and the reason they are the S06
 * fixtures' is the same reason part 2 used them for `assigned_to`: ids 1 and 2 are
 * immutable and certainly exist, and the point is to prove the integer crosses
 * the boundary unresolved — **not** to name anybody. N-B2's collision is that
 * these integers denote different people on the two providers, so nothing here
 * turns one into a name.
 */
export const OWNER_IDS = [1, 2] as const

/** Follow-up audit events, on one conversation, matching the panel's page size. */
export const FOLLOW_UP_EVENT_COUNT = 120
export const FOLLOW_UP_PAGE = 50

/**
 * The two indices whose `occurred_at` values are swapped.
 *
 * In the descending `(occurred_at, id)` order the panel and the operation both
 * use, index 119 comes first, so the first page of 50 ends at index 70 and the
 * second begins at index 69. Swapping those two instants moves index 69 to the end
 * of page one and leaves index 70 at the start of page two — and since `id` rises
 * with insertion order, page one now ends on the *smaller* of the two ids. A seek
 * of the form `id < lastId` skips index 70 entirely at that point; a
 * `(occurred_at, id) < (…)` comparison does not.
 */
export const INVERTED_INDICES = [
  FOLLOW_UP_EVENT_COUNT - FOLLOW_UP_PAGE - 1, // 69
  FOLLOW_UP_EVENT_COUNT - FOLLOW_UP_PAGE, // 70
] as const

/** Notes on one lead, including one with no `created_at` at all. */
export const NOTE_COUNT = 25
export const NOTES_WITH_NULL_CREATED_AT = 1
export const TOTAL_NOTE_COUNT = NOTE_COUNT + NOTES_WITH_NULL_CREATED_AT

/**
 * Pipeline events. `PIPELINE_GROUP` share each `occurred_at`, and it is coprime
 * with the 1,000-row page cap on purpose: a group straddles a page boundary.
 */
export const PIPELINE_EVENT_COUNT = 2_100
export const PIPELINE_GROUP = 7
export const PIPELINE_INSTANTS = PIPELINE_EVENT_COUNT / PIPELINE_GROUP // 300

/** The library rows, all small: their reads prove shape, not pagination. */
export const SAVED_SEARCH_COUNT = 3
export const ICP_COUNT = 1
export const ICP_PERSONA_COUNT = 2
export const ICP_INDUSTRY_COUNT = 3
export const HYPOTHESIS_COUNT = 2
export const HYPOTHESIS_CAMPAIGN_COUNT = 2

/** Calendar anchors. Nothing here depends on the wall clock. */
const LEAD_FIRST_DAY = '2025-09-01'
const INBOUND_FIRST_DAY = '2025-10-01'
const PIPELINE_FIRST_DAY = '2025-11-01'
const FOLLOW_UP_FIRST_DAY = '2026-01-01'
const NOTE_FIRST_DAY = '2026-02-01'

const INTENT_LEVELS = ['p1', 'p2', 'p3'] as const

function dayFrom(anchor: string, offset: number): string {
  const date = new Date(`${anchor}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function instantFrom(anchor: string, offset: number, time: string): string {
  return `${dayFrom(anchor, offset)}T${time}Z`
}

/** Deterministic, sortable lead id. All-hex, namespaced, index-ordered. */
export function restLeadId(index: number): string {
  return `13e00000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

/** Deterministic mutation id for a follow-up event, so re-runs collide. */
export function followUpMutationId(index: number): string {
  return `13f00000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

/**
 * Profile URLs are zero-padded, so their **text** order matches their numeric
 * order. That matters here and nowhere else in these fixtures: the conversation
 * reads seek on `(instance_id, profile_url)` as text, and an unpadded
 * `.../lead/10` sorts before `.../lead/9`. Padding makes the expected sequence
 * writable without reimplementing the collation.
 */
export function restProfileUrl(index: number): string {
  return `${REST_SCOPE}/lead/${String(index).padStart(6, '0')}`
}

/** The conversation whose follow-up audit trail is seeded in depth. */
export const HISTORY_CONVERSATION_INDEX = 0
/** The lead whose notes are seeded. */
export const NOTES_LEAD_INDEX = 1

export function restIntentLevel(index: number): string | null {
  return index < LABELLED_CONVERSATIONS
    ? INTENT_LEVELS[index % INTENT_LEVELS.length]
    : null
}

export function restInboundSentAt(index: number): string {
  return instantFrom(INBOUND_FIRST_DAY, index % 300, '09:00:00.000')
}

/** One day after the inbound, so it is unambiguously "after P3". */
export function restOutboundSentAt(index: number): string {
  return instantFrom(INBOUND_FIRST_DAY, (index % 300) + 1, '15:00:00.000')
}

export function pipelineOccurredAt(index: number): string {
  return instantFrom(
    PIPELINE_FIRST_DAY,
    Math.floor(index / PIPELINE_GROUP),
    '11:00:00.000',
  )
}

/**
 * The follow-up event's `occurred_at`, **with the planted inversion**. Ascending
 * in the index except for the one swapped pair — see `INVERTED_INDICES`.
 *
 * A pure function rather than a post-insert `UPDATE`, so the seed is idempotent:
 * a swap applied twice would undo itself.
 */
export function followUpOccurredAt(index: number): string {
  const [low, high] = INVERTED_INDICES
  const effective = index === low ? high : index === high ? low : index
  return instantFrom(FOLLOW_UP_FIRST_DAY, effective, '08:00:00.000')
}

export function noteCreatedAt(index: number): string {
  return instantFrom(NOTE_FIRST_DAY, index, '13:00:00.000')
}

export interface SeededRest {
  readonly leads: number
  readonly inbound: number
  readonly outbound: number
  readonly followUpStates: number
  readonly followUpEvents: number
  readonly pipelineEvents: number
  readonly notes: number
  readonly replyIntentRows: number
  readonly latestMessageRows: number
}

/**
 * Idempotent seed. Runs as an active member, so every row is written through the
 * same policies the reads come back through.
 *
 * Batched through `unnest` rather than row by row: ~9,000 individual round trips
 * to a remote region would dominate the suite's runtime.
 */
export async function seedRestFixture(client: PoolClient): Promise<SeededRest> {
  await client.query(
    `INSERT INTO public.instances (id, label)
     VALUES ($1, 'S13 part 3 fixture')
     ON CONFLICT (id) DO NOTHING`,
    [REST_SCOPE],
  )

  await client.query(
    `INSERT INTO public.campaigns (id, instance_id, lh_campaign_id, name, status)
     SELECT c.id, $1, c.lh_id, c.name, 'active'
       FROM unnest($2::text[], $3::text[], $4::text[]) AS c(id, lh_id, name)
     ON CONFLICT (id) DO NOTHING`,
    [
      REST_SCOPE,
      [...REST_CAMPAIGN_IDS],
      ['1', '2'],
      ['S13R Delta', 'S13R Epsilon'],
    ],
  )

  await seedLeads(client)
  await seedMessages(client)
  await seedFollowUpState(client)
  await seedFollowUpEvents(client)
  await seedPipelineEvents(client)
  await seedLeadNotes(client)
  await seedLibrary(client)

  const counts = await client.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM public.leads WHERE instance_id = $1) AS leads,
            (SELECT count(*) FROM public.messages
              WHERE instance_id = $1 AND direction = 'in') AS inbound,
            (SELECT count(*) FROM public.messages
              WHERE instance_id = $1 AND direction = 'out') AS outbound,
            (SELECT count(*) FROM public.conversation_follow_up_state
              WHERE instance_id = $1) AS follow_up_states,
            (SELECT count(*) FROM public.follow_up_events
              WHERE instance_id = $1) AS follow_up_events,
            (SELECT count(*) FROM public.pipeline_events
              WHERE actor = $1) AS pipeline_events,
            (SELECT count(*) FROM public.lead_notes
              WHERE lead_id = $2::uuid) AS notes,
            (SELECT count(*) FROM public.conversation_reply_intent
              WHERE instance_id = $1) AS reply_intent_rows,
            (SELECT count(*) FROM public.conversation_latest_message
              WHERE instance_id = $1) AS latest_message_rows`,
    [REST_SCOPE, restLeadId(NOTES_LEAD_INDEX)],
  )
  const row = counts.rows[0] ?? {}
  const at = (key: string) => Number(row[key] ?? 0)

  return {
    leads: at('leads'),
    inbound: at('inbound'),
    outbound: at('outbound'),
    followUpStates: at('follow_up_states'),
    followUpEvents: at('follow_up_events'),
    pipelineEvents: at('pipeline_events'),
    notes: at('notes'),
    replyIntentRows: at('reply_intent_rows'),
    latestMessageRows: at('latest_message_rows'),
  }
}

async function seedLeads(client: PoolClient): Promise<void> {
  const ids: string[] = []
  const campaignIds: string[] = []
  const profileUrls: string[] = []
  const fullNames: string[] = []
  const invitedAt: string[] = []
  const repliedAt: string[] = []

  for (let index = 0; index < REST_LEAD_COUNT; index++) {
    ids.push(restLeadId(index))
    campaignIds.push(REST_CAMPAIGN_IDS[index % REST_CAMPAIGN_IDS.length])
    profileUrls.push(restProfileUrl(index))
    fullNames.push(`S13R Lead ${index}`)
    // Every one of these leads replied — they all have an inbound message — so
    // the milestone ladder is complete rather than partial. The funnel shape is
    // part 2's fixture's job; this one exists for the conversation relations.
    invitedAt.push(instantFrom(LEAD_FIRST_DAY, index % 300, '10:00:00.000'))
    repliedAt.push(restInboundSentAt(index))
  }

  await client.query(
    `INSERT INTO public.leads (
        id, instance_id, campaign_id, profile_url, full_name,
        invited_at, connected_at, first_message_at, replied_at, updated_at)
     SELECT f.id::uuid, $1, f.campaign_id, f.profile_url, f.full_name,
            f.invited_at::timestamptz, f.invited_at::timestamptz,
            f.invited_at::timestamptz, f.replied_at::timestamptz,
            f.replied_at::timestamptz
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[])
            AS f(id, campaign_id, profile_url, full_name, invited_at, replied_at)
     ON CONFLICT (campaign_id, profile_url) DO NOTHING`,
    [REST_SCOPE, ids, campaignIds, profileUrls, fullNames, invitedAt, repliedAt],
  )
}

async function seedMessages(client: PoolClient): Promise<void> {
  const inbound = {
    profileUrls: [] as string[],
    campaignIds: [] as string[],
    bodies: [] as string[],
    sentAt: [] as string[],
    intents: [] as (string | null)[],
    hashes: [] as string[],
  }
  const outbound = {
    profileUrls: [] as string[],
    campaignIds: [] as string[],
    bodies: [] as string[],
    sentAt: [] as string[],
    hashes: [] as string[],
  }

  for (let index = 0; index < REST_LEAD_COUNT; index++) {
    const profileUrl = restProfileUrl(index)
    const campaignId = REST_CAMPAIGN_IDS[index % REST_CAMPAIGN_IDS.length]
    inbound.profileUrls.push(profileUrl)
    inbound.campaignIds.push(campaignId)
    inbound.bodies.push(`S13R inbound ${index}`)
    inbound.sentAt.push(restInboundSentAt(index))
    inbound.intents.push(restIntentLevel(index))
    inbound.hashes.push(`${REST_SCOPE}/in/${index}`)

    // Only the P3 conversations receive an outbound reply, and it lands after the
    // P3 message — which is what makes `last_out_after_p3_at` non-null for exactly
    // those, and makes the latest message outbound for exactly those.
    if (restIntentLevel(index) === 'p3') {
      outbound.profileUrls.push(profileUrl)
      outbound.campaignIds.push(campaignId)
      outbound.bodies.push(`S13R outbound ${index}`)
      outbound.sentAt.push(restOutboundSentAt(index))
      outbound.hashes.push(`${REST_SCOPE}/out/${index}`)
    }
  }

  await client.query(
    `INSERT INTO public.messages (
        instance_id, campaign_id, profile_url, direction, body, sent_at,
        intent_level, intent_reason, intent_classified_at,
        intent_classified_model, intent_taxonomy_version, content_hash, source)
     SELECT $1, f.campaign_id, f.profile_url, 'in', f.body, f.sent_at::timestamptz,
            f.intent_level,
            CASE WHEN f.intent_level IS NULL THEN NULL ELSE 'fixture intent' END,
            CASE WHEN f.intent_level IS NULL THEN NULL
                 ELSE f.sent_at::timestamptz END,
            CASE WHEN f.intent_level IS NULL THEN NULL ELSE 'claude-haiku-4-5' END,
            CASE WHEN f.intent_level IS NULL THEN NULL ELSE 'p123-v1' END,
            f.content_hash, 'sync'
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[])
            AS f(campaign_id, profile_url, body, sent_at, intent_level,
                 content_hash)
     ON CONFLICT (instance_id, profile_url, direction, sent_at, content_hash)
       DO NOTHING`,
    [
      REST_SCOPE,
      inbound.campaignIds,
      inbound.profileUrls,
      inbound.bodies,
      inbound.sentAt,
      inbound.intents,
      inbound.hashes,
    ],
  )

  await client.query(
    `INSERT INTO public.messages (
        instance_id, campaign_id, profile_url, direction, body, sent_at,
        content_hash, source)
     SELECT $1, f.campaign_id, f.profile_url, 'out', f.body,
            f.sent_at::timestamptz, f.content_hash, 'sync'
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
            AS f(campaign_id, profile_url, body, sent_at, content_hash)
     ON CONFLICT (instance_id, profile_url, direction, sent_at, content_hash)
       DO NOTHING`,
    [
      REST_SCOPE,
      outbound.campaignIds,
      outbound.profileUrls,
      outbound.bodies,
      outbound.sentAt,
      outbound.hashes,
    ],
  )
}

async function seedFollowUpState(client: PoolClient): Promise<void> {
  const profileUrls: string[] = []
  const dueDates: (string | null)[] = []
  const ownerIds: (number | null)[] = []
  const archivedAt: (string | null)[] = []

  for (let index = 0; index < FOLLOW_UP_STATE_COUNT; index++) {
    profileUrls.push(restProfileUrl(index))
    dueDates.push(dayFrom(FOLLOW_UP_FIRST_DAY, index % 90))
    ownerIds.push(
      index % OWNED_EVERY === 0
        ? OWNER_IDS[(index / OWNED_EVERY) % OWNER_IDS.length]
        : null,
    )
    archivedAt.push(
      index % ARCHIVED_EVERY === 0
        ? instantFrom(FOLLOW_UP_FIRST_DAY, 200, '12:00:00.000')
        : null,
    )
  }

  await client.query(
    `INSERT INTO public.conversation_follow_up_state (
        instance_id, profile_url, next_follow_up_date, owner_id, revision,
        updated_by, archived_at)
     SELECT $1, f.profile_url, f.next_follow_up_date::date, f.owner_id, 1,
            's13-rest-fixture', f.archived_at::timestamptz
       FROM unnest($2::text[], $3::text[], $4::bigint[], $5::text[])
            AS f(profile_url, next_follow_up_date, owner_id, archived_at)
     ON CONFLICT (instance_id, profile_url) DO NOTHING`,
    [REST_SCOPE, profileUrls, dueDates, ownerIds, archivedAt],
  )
}

/**
 * The audit trail for one conversation. `event_kind` alternates between
 * `scheduled` and `completed` because those are the two kinds whose column
 * combinations satisfy `follow_up_events_values_check` with no extra fields:
 * `scheduled` needs a new due date and a new owner name and no previous date,
 * `completed` needs a previous date and no new one.
 *
 * `new_owner_name` is a text snapshot, which is the point of it existing —
 * the history stays readable with no roster and no join.
 */
async function seedFollowUpEvents(client: PoolClient): Promise<void> {
  const mutationIds: string[] = []
  const kinds: string[] = []
  const previousDue: (string | null)[] = []
  const newDue: (string | null)[] = []
  const newOwnerNames: (string | null)[] = []
  const occurredAt: string[] = []

  for (let index = 0; index < FOLLOW_UP_EVENT_COUNT; index++) {
    const scheduled = index % 2 === 0
    mutationIds.push(followUpMutationId(index))
    kinds.push(scheduled ? 'scheduled' : 'completed')
    previousDue.push(scheduled ? null : dayFrom(FOLLOW_UP_FIRST_DAY, index % 90))
    newDue.push(scheduled ? dayFrom(FOLLOW_UP_FIRST_DAY, index % 90) : null)
    newOwnerNames.push(scheduled ? `S13R Owner ${index % 3}` : null)
    occurredAt.push(followUpOccurredAt(index))
  }

  await client.query(
    `INSERT INTO public.follow_up_events (
        instance_id, profile_url, mutation_id, event_ordinal,
        request_fingerprint, event_kind, previous_due_date, new_due_date,
        new_owner_name, state_revision, actor, occurred_at)
     SELECT $1, $2, f.mutation_id::uuid, 1, 's13-rest-fingerprint', f.event_kind,
            f.previous_due_date::date, f.new_due_date::date, f.new_owner_name,
            1, 's13-rest-fixture', f.occurred_at::timestamptz
       FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                   $8::text[])
            AS f(mutation_id, event_kind, previous_due_date, new_due_date,
                 new_owner_name, occurred_at)
     ON CONFLICT (mutation_id, event_ordinal) DO NOTHING`,
    [
      REST_SCOPE,
      restProfileUrl(HISTORY_CONVERSATION_INDEX),
      mutationIds,
      kinds,
      previousDue,
      newDue,
      newOwnerNames,
      occurredAt,
    ],
  )
}

/**
 * `pipeline_events` has no natural unique key, so the whole batch is guarded by a
 * `NOT EXISTS` on the scope marker this fixture writes into `actor`. That column
 * is free text naming who performed the action, and a fixture is as legitimate an
 * actor as an SDR.
 */
async function seedPipelineEvents(client: PoolClient): Promise<void> {
  const leadIds: string[] = []
  const kinds: string[] = []
  const fromStages: (string | null)[] = []
  const toStages: (string | null)[] = []
  const assignees: (string | null)[] = []
  const occurredAt: string[] = []

  for (let index = 0; index < PIPELINE_EVENT_COUNT; index++) {
    const stageEvent = index % 2 === 0
    leadIds.push(restLeadId(index % REST_LEAD_COUNT))
    kinds.push(stageEvent ? 'stage' : 'assignment')
    fromStages.push(stageEvent ? 'first_contact' : null)
    toStages.push(stageEvent ? 'interested' : null)
    // A member *name*, not an id — the one reference to a team member in this
    // schema that needs no roster to read. See `operations/pipeline.ts`.
    assignees.push(stageEvent ? null : `S13R Owner ${index % 3}`)
    occurredAt.push(pipelineOccurredAt(index))
  }

  await client.query(
    `INSERT INTO public.pipeline_events (
        lead_id, kind, actor, from_stage, to_stage, to_assignee, occurred_at)
     SELECT f.lead_id::uuid, f.kind, $1, f.from_stage, f.to_stage,
            f.to_assignee, f.occurred_at::timestamptz
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[])
            AS f(lead_id, kind, from_stage, to_stage, to_assignee, occurred_at)
      WHERE NOT EXISTS (
              SELECT 1 FROM public.pipeline_events WHERE actor = $1)`,
    [
      REST_SCOPE,
      leadIds,
      kinds,
      fromStages,
      toStages,
      assignees,
      occurredAt,
    ],
  )
}

/**
 * One lead's notes, including one with **no `created_at`** — the column is
 * nullable in the baseline (`DEFAULT now()` with no NOT NULL), and an explicit
 * NULL is the only way to reach that state. NULL placement under a bare `DESC` is
 * PostgreSQL's NULLS FIRST, which is also what PostgREST emits, so the note with
 * no timestamp sorts first on both providers rather than first on one.
 */
async function seedLeadNotes(client: PoolClient): Promise<void> {
  const bodies: string[] = []
  const createdAt: (string | null)[] = []

  for (let index = 0; index < NOTE_COUNT; index++) {
    bodies.push(`S13R note ${index}`)
    createdAt.push(noteCreatedAt(index))
  }
  bodies.push('S13R note with no timestamp')
  createdAt.push(null)

  await client.query(
    `INSERT INTO public.lead_notes (lead_id, author, body, created_at)
     SELECT $1::uuid, 's13-rest-fixture', f.body, f.created_at::timestamptz
       FROM unnest($2::text[], $3::text[]) AS f(body, created_at)
      WHERE NOT EXISTS (
              SELECT 1 FROM public.lead_notes
               WHERE lead_id = $1::uuid AND body = f.body)`,
    [restLeadId(NOTES_LEAD_INDEX), bodies, createdAt],
  )
}

/**
 * The sourcing library. None of these relations is scoped by instance and none
 * has a unique key, so every insert is guarded by a `NOT EXISTS` on the
 * `LIBRARY_PREFIX`-prefixed name this fixture owns, and every assertion filters
 * on the same prefix. The rows carry populated `text[]` and `jsonb` columns
 * because those are the shapes worth proving cross the boundary as themselves.
 */
async function seedLibrary(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO public.icps (
        name, main_product, purchase_triggers, features, company_countries,
        apollo_industries, exclude_keywords)
     SELECT $1, 'S13R product',
            ARRAY['trigger one', 'trigger two'],
            ARRAY['feature one'],
            ARRAY['DE', 'PL', 'UA'],
            ARRAY['software'],
            ARRAY['recruiting', 'agency']
      WHERE NOT EXISTS (SELECT 1 FROM public.icps WHERE name = $1)`,
    [`${LIBRARY_PREFIX} ICP`],
  )

  await client.query(
    `INSERT INTO public.icp_personas (icp_id, kind, job_titles, sort)
     SELECT i.id, f.kind, f.job_titles::text[], f.sort
       FROM public.icps i,
            unnest($2::text[], $3::text[], $4::int[]) AS f(kind, job_titles, sort)
      WHERE i.name = $1
        AND NOT EXISTS (
              SELECT 1 FROM public.icp_personas p
               WHERE p.icp_id = i.id AND p.kind = f.kind)`,
    [
      `${LIBRARY_PREFIX} ICP`,
      [`${LIBRARY_PREFIX} technical`, `${LIBRARY_PREFIX} management`],
      ['{CTO,"VP Engineering"}', '{CEO,Founder}'],
      [1, 0],
    ],
  )

  await client.query(
    `INSERT INTO public.icp_industries (icp_id, name, include_keywords)
     SELECT i.id, f.name, f.include_keywords::text[]
       FROM public.icps i,
            unnest($2::text[], $3::text[]) AS f(name, include_keywords)
      WHERE i.name = $1
        AND NOT EXISTS (
              SELECT 1 FROM public.icp_industries n
               WHERE n.icp_id = i.id AND n.name = f.name)`,
    [
      `${LIBRARY_PREFIX} ICP`,
      [
        `${LIBRARY_PREFIX} fintech`,
        `${LIBRARY_PREFIX} healthtech`,
        `${LIBRARY_PREFIX} logistics`,
      ],
      ['{payments,ledger}', '{ehr,telemedicine}', '{freight}'],
    ],
  )

  await client.query(
    `INSERT INTO public.hypotheses (name, icp_id, description)
     SELECT f.name, (SELECT id FROM public.icps WHERE name = $1), f.description
       FROM unnest($2::text[], $3::text[]) AS f(name, description)
      WHERE NOT EXISTS (
              SELECT 1 FROM public.hypotheses h WHERE h.name = f.name)`,
    [
      `${LIBRARY_PREFIX} ICP`,
      [`${LIBRARY_PREFIX} Hypothesis A`, `${LIBRARY_PREFIX} Hypothesis B`],
      ['first hypothesis', 'second hypothesis'],
    ],
  )

  // `hypothesis_campaigns` is unique on `campaign_id` alone: a campaign belongs
  // to at most one hypothesis.
  await client.query(
    `INSERT INTO public.hypothesis_campaigns (hypothesis_id, campaign_id)
     SELECT h.id, f.campaign_id
       FROM unnest($1::text[], $2::text[]) AS f(hypothesis_name, campaign_id)
       JOIN public.hypotheses h ON h.name = f.hypothesis_name
     ON CONFLICT (campaign_id) DO NOTHING`,
    [
      [`${LIBRARY_PREFIX} Hypothesis A`, `${LIBRARY_PREFIX} Hypothesis B`],
      [...REST_CAMPAIGN_IDS],
    ],
  )

  await client.query(
    `INSERT INTO public.saved_searches (
        name, platform, include_keywords, exclude_keywords, filters,
        hypothesis_id)
     SELECT f.name, f.platform, f.include_keywords::text[],
            f.exclude_keywords::text[], f.filters::jsonb,
            (SELECT id FROM public.hypotheses WHERE name = $1)
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
            AS f(name, platform, include_keywords, exclude_keywords, filters)
      WHERE NOT EXISTS (
              SELECT 1 FROM public.saved_searches s WHERE s.name = f.name)`,
    [
      `${LIBRARY_PREFIX} Hypothesis A`,
      [
        `${LIBRARY_PREFIX} Apollo sweep`,
        `${LIBRARY_PREFIX} Navigator sweep`,
        `${LIBRARY_PREFIX} esun sweep`,
      ],
      ['apollo', 'sales-navigator', 'esun'],
      ['{cto,founder}', '{vp}', '{head}'],
      ['{recruiter}', '{agency}', '{}'],
      [
        '{"headcount":"11-50","country":"DE","verified":true}',
        '{"seniority":["owner","cxo"]}',
        '{}',
      ],
    ],
  )
}
