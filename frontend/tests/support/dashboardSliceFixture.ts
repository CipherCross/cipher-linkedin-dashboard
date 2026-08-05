/**
 * Fixture for S13's `leads` and `messages` reads.
 *
 * Real rows in `public.leads` and `public.messages`, written and read back through
 * the baseline's own RLS policies. Nothing is stubbed.
 *
 * **Seeded here rather than reused from B2.** The B2 bounded tenant-slice copy was
 * deleted the day it ran and its deletion has been proved twice; re-copying is a
 * fresh owner decision each time, not a standing permission
 * (`docs/implementation-handoffs/N-B2.md`). So this suite owns its own data and
 * assumes none.
 *
 * ## What the shape is for
 *
 * Every number below earns its place — a fixture that is merely large proves less
 * than one built against the specific ways these reads can break.
 *
 * - **Three pages, twice-chained cursors.** `LEAD_COUNT` and `INBOUND_COUNT` both
 *   exceed 2,000, so a walk at the 1,000-row cap needs three pages and the cursor
 *   has to chain twice. One page over the cap would not prove chaining.
 * - **Duplicate `sent_at`, in groups that straddle page boundaries.**
 *   `SENT_AT_GROUP` messages share each instant, which is what a bulk sync
 *   actually produces. 1,000 is not a multiple of 7, so a page boundary falls
 *   *inside* a group — and that is the case that fails if `id` is dropped from the
 *   sort key or from the keyset predicate. This is the single most important
 *   property of this fixture.
 * - **A real funnel, not uniform rows.** Leads are staged `i % 5` across the
 *   milestone ladder, so `invited_at → connected_at → first_message_at →
 *   replied_at` have genuinely different populations and a NULL milestone means
 *   "never happened" as it does in production. That is what makes the
 *   `frontend/src/lib/leads.ts` recompute check meaningful rather than tautological.
 * - **Two `updated_at` cohorts.** One in ten rows is stamped recent, so a delta
 *   refresh has an exact expected answer instead of "some rows".
 * - **Fixed calendar anchors.** No `Date.now()` anywhere: the outbound window is
 *   supplied by the caller as an explicit range, exactly as `DataContext` computes
 *   its own 90-day `since`. A fixture that drifted with the wall clock would make
 *   the window assertions unreproducible.
 *
 * ## Idempotency
 *
 * The suite mutates the shared Neon project (a known limit since S11), so every
 * insert targets a unique key with `ON CONFLICT DO NOTHING`:
 * `leads_campaign_id_profile_url_key` and `messages_identity_key`. Lead ids are
 * **deterministic** rather than generated, so a re-run addresses the same rows and
 * the fixture's own rows stay identifiable inside an unscoped read.
 */

import type { PoolClient } from 'pg'

/** Namespaced so nothing here can collide with S11's, S12's or tenant data. */
export const DASHBOARD_SCOPE = 's13-dashboard'

export const CAMPAIGN_IDS = [
  `${DASHBOARD_SCOPE}:1`,
  `${DASHBOARD_SCOPE}:2`,
  `${DASHBOARD_SCOPE}:3`,
] as const

/** 2,300 leads → three pages at the 1,000-row cap. */
export const LEAD_COUNT = 2_300
/** 2,100 inbound → three pages. */
export const INBOUND_COUNT = 2_100
/** 1,400 outbound → two pages, and half of them outside the sample window. */
export const OUTBOUND_COUNT = 1_400

/**
 * Messages sharing one `sent_at`. Coprime with 1,000 on purpose, so a page
 * boundary lands inside a group and the `id` tiebreaker is load-bearing.
 */
export const SENT_AT_GROUP = 7

export const INBOUND_INSTANTS = INBOUND_COUNT / SENT_AT_GROUP // 300
export const OUTBOUND_INSTANTS = OUTBOUND_COUNT / SENT_AT_GROUP // 200

/** Milestone ladder anchor. Leads spread over 300 consecutive days from here. */
export const LEAD_FIRST_DAY = '2025-06-01'
export const LEAD_DAY_SPREAD = 300

/** Message anchors. Inbound spans 300 days, outbound 200, both from here. */
export const MESSAGE_FIRST_DAY = '2025-03-01'

/**
 * The delta-refresh watermark the tests query with, and the two cohorts either
 * side of it. `RECENT_UPDATED_AT` is after it; `OLD_UPDATED_AT` is well before.
 */
export const DELTA_SINCE = '2026-07-01T00:00:00.000Z'
export const RECENT_UPDATED_AT = '2026-07-15T12:00:00.000Z'
export const OLD_UPDATED_AT = '2026-01-15T12:00:00.000Z'

/** One row in ten is stamped recent. */
export const DELTA_EVERY = 10
export const RECENT_LEADS = LEAD_COUNT / DELTA_EVERY // 230
export const RECENT_INBOUND = INBOUND_COUNT / DELTA_EVERY // 210

/**
 * `team_members` ids used for `assigned_to`.
 *
 * Ids 1 and 2 are two of the three immutable S06 identity fixtures, which the live
 * contract suites assert by id and role and which therefore certainly exist. The
 * point of assigning any at all is to prove the column crosses the boundary as the
 * integer it is — **not** to name anybody. N-B2's collision is exactly that these
 * integers denote different people on the two sides, so nothing in this suite
 * resolves one to a name.
 */
export const ASSIGNEE_IDS = [1, 2] as const

/** Every tenth lead carries an assignee, alternating between the two ids. */
export const ASSIGNED_EVERY = 10
export const ASSIGNED_LEADS = LEAD_COUNT / ASSIGNED_EVERY // 230

const PIPELINE_STAGES = [
  'first_contact',
  'interested',
  'following_up',
  'call_booked',
  'client',
] as const

const SENTIMENTS = ['positive', 'neutral', 'negative', 'objection', null] as const
const INTENTS = ['p1', 'p2', 'p3', null, null] as const

/** Deterministic, sortable lead id. All-hex, namespaced, index-ordered. */
export function leadId(index: number): string {
  return `13d00000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

export function leadProfileUrl(index: number): string {
  return `${DASHBOARD_SCOPE}/lead/${index}`
}

function dayFrom(anchor: string, offset: number): string {
  const date = new Date(`${anchor}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function instantFrom(anchor: string, offset: number, time: string): string {
  return `${dayFrom(anchor, offset)}T${time}Z`
}

/** How many milestones lead `index` has reached: 0 (none) through 4 (replied). */
export function milestoneDepth(index: number): number {
  return index % 5
}

/** The day a lead was added, and the base for its milestone ladder. */
export function leadAddedDay(index: number): string {
  return dayFrom(LEAD_FIRST_DAY, index % LEAD_DAY_SPREAD)
}

export interface ExpectedFunnel {
  readonly leads: number
  readonly invited: number
  readonly connected: number
  readonly firstMessaged: number
  readonly replied: number
}

/**
 * The funnel the fixture encodes, computed from the same rule the seed uses.
 *
 * Derived rather than hardcoded so the two cannot drift, but derived
 * *independently* of the SQL — this is the expectation the database's answer is
 * checked against.
 */
export const EXPECTED_FUNNEL: ExpectedFunnel = (() => {
  let invited = 0
  let connected = 0
  let firstMessaged = 0
  let replied = 0
  for (let index = 0; index < LEAD_COUNT; index++) {
    const depth = milestoneDepth(index)
    if (depth >= 1) invited++
    if (depth >= 2) connected++
    if (depth >= 3) firstMessaged++
    if (depth >= 4) replied++
  }
  return { leads: LEAD_COUNT, invited, connected, firstMessaged, replied }
})()

/** The instant the n-th inbound message was sent. Groups of `SENT_AT_GROUP`. */
export function inboundSentAt(index: number): string {
  return instantFrom(
    MESSAGE_FIRST_DAY,
    Math.floor(index / SENT_AT_GROUP),
    '09:00:00.000',
  )
}

export function outboundSentAt(index: number): string {
  return instantFrom(
    MESSAGE_FIRST_DAY,
    Math.floor(index / SENT_AT_GROUP),
    '15:00:00.000',
  )
}

/**
 * A window over the outbound messages, expressed as inclusive UTC days the way
 * `presetRanges` does. Everything from group `fromGroup` onward.
 */
export function outboundWindowFrom(fromGroup: number): string {
  return dayFrom(MESSAGE_FIRST_DAY, fromGroup)
}

export interface SeededDashboard {
  readonly leads: number
  readonly inbound: number
  readonly outbound: number
}

/**
 * Idempotent seed. Runs as an active member, so every row is written through the
 * same policies the reads come back through.
 *
 * Batched through `unnest` rather than row-by-row: 5,800 individual round trips to
 * a remote region would dominate the suite's runtime.
 */
export async function seedDashboardFixture(
  client: PoolClient,
): Promise<SeededDashboard> {
  await client.query(
    `INSERT INTO public.instances (id, label)
     VALUES ($1, 'S13 dashboard slice fixture')
     ON CONFLICT (id) DO NOTHING`,
    [DASHBOARD_SCOPE],
  )

  await client.query(
    `INSERT INTO public.campaigns (id, instance_id, lh_campaign_id, name, status)
     SELECT c.id, $1, c.lh_id, c.name, 'active'
       FROM unnest($2::text[], $3::text[], $4::text[]) AS c(id, lh_id, name)
     ON CONFLICT (id) DO NOTHING`,
    [
      DASHBOARD_SCOPE,
      [...CAMPAIGN_IDS],
      ['1', '2', '3'],
      ['S13 Alpha', 'S13 Beta', 'S13 Gamma'],
    ],
  )

  // --- leads ---------------------------------------------------------------
  const ids: string[] = []
  const campaignIds: string[] = []
  const profileUrls: string[] = []
  const fullNames: string[] = []
  const headlines: string[] = []
  const companies: string[] = []
  const addedAt: string[] = []
  const invitedAt: (string | null)[] = []
  const connectedAt: (string | null)[] = []
  const firstMessageAt: (string | null)[] = []
  const repliedAt: (string | null)[] = []
  const lastActionAt: (string | null)[] = []
  const stages: (string | null)[] = []
  const assignees: (number | null)[] = []
  const educationYears: (number | null)[] = []
  const genders: (string | null)[] = []
  const leadUpdatedAt: string[] = []

  for (let index = 0; index < LEAD_COUNT; index++) {
    const depth = milestoneDepth(index)
    const day = leadAddedDay(index)
    const at = (offset: number) =>
      instantFrom(day, offset, '12:00:00.000')

    ids.push(leadId(index))
    campaignIds.push(CAMPAIGN_IDS[index % CAMPAIGN_IDS.length])
    profileUrls.push(leadProfileUrl(index))
    fullNames.push(`S13 Lead ${index}`)
    headlines.push(index % 3 === 0 ? 'Head of Engineering' : 'Product Manager')
    companies.push(`Company ${index % 40}`)
    addedAt.push(at(0))
    invitedAt.push(depth >= 1 ? at(1) : null)
    connectedAt.push(depth >= 2 ? at(3) : null)
    firstMessageAt.push(depth >= 3 ? at(4) : null)
    repliedAt.push(depth >= 4 ? at(7) : null)
    lastActionAt.push(at(depth))
    // Only leads that actually replied carry a manual pipeline stage, which is
    // how the real overlay behaves: an SDR stages a conversation, not a silence.
    stages.push(depth >= 4 ? PIPELINE_STAGES[index % PIPELINE_STAGES.length] : null)
    assignees.push(
      index % ASSIGNED_EVERY === 0
        ? ASSIGNEE_IDS[(index / ASSIGNED_EVERY) % ASSIGNEE_IDS.length]
        : null,
    )
    // `refresh_lead_age_estimate` fires BEFORE INSERT on this column and derives
    // the birth-year bounds, `age_source` and `age_inferred_at` itself — so those
    // arrive as genuinely trigger-computed values rather than as fixture literals.
    educationYears.push(index % 7 === 0 ? 2004 + (index % 12) : null)
    genders.push(index % 4 === 0 ? 'female' : index % 4 === 1 ? 'male' : null)
    leadUpdatedAt.push(
      index % DELTA_EVERY === 0 ? RECENT_UPDATED_AT : OLD_UPDATED_AT,
    )
  }

  await client.query(
    `INSERT INTO public.leads (
        id, instance_id, campaign_id, profile_url, full_name, headline, company,
        added_at, invited_at, connected_at, first_message_at, replied_at,
        last_action_at, pipeline_stage, assigned_to, education_start_year,
        gender, gender_confidence, updated_at)
     SELECT f.id::uuid, $1, f.campaign_id, f.profile_url, f.full_name, f.headline,
            f.company, f.added_at::timestamptz, f.invited_at::timestamptz,
            f.connected_at::timestamptz, f.first_message_at::timestamptz,
            f.replied_at::timestamptz, f.last_action_at::timestamptz,
            f.pipeline_stage, f.assigned_to, f.education_start_year,
            f.gender,
            CASE WHEN f.gender IS NULL THEN NULL ELSE 0.87::real END,
            f.updated_at::timestamptz
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::text[], $10::text[], $11::text[],
                   $12::text[], $13::text[], $14::text[], $15::bigint[],
                   $16::int[], $17::text[], $18::text[])
            AS f(id, campaign_id, profile_url, full_name, headline, company,
                 added_at, invited_at, connected_at, first_message_at, replied_at,
                 last_action_at, pipeline_stage, assigned_to,
                 education_start_year, gender, updated_at)
     ON CONFLICT (campaign_id, profile_url) DO NOTHING`,
    [
      DASHBOARD_SCOPE,
      ids,
      campaignIds,
      profileUrls,
      fullNames,
      headlines,
      companies,
      addedAt,
      invitedAt,
      connectedAt,
      firstMessageAt,
      repliedAt,
      lastActionAt,
      stages,
      assignees,
      educationYears,
      genders,
      leadUpdatedAt,
    ],
  )

  // --- messages ------------------------------------------------------------
  await seedMessages(client, 'in', INBOUND_COUNT, inboundSentAt)
  await seedMessages(client, 'out', OUTBOUND_COUNT, outboundSentAt)

  const counts = await client.query<{
    leads: string
    inbound: string
    outbound: string
  }>(
    `SELECT (SELECT count(*) FROM public.leads WHERE instance_id = $1) AS leads,
            (SELECT count(*) FROM public.messages
              WHERE instance_id = $1 AND direction = 'in') AS inbound,
            (SELECT count(*) FROM public.messages
              WHERE instance_id = $1 AND direction = 'out') AS outbound`,
    [DASHBOARD_SCOPE],
  )
  const row = counts.rows[0]

  return {
    leads: Number(row?.leads ?? 0),
    inbound: Number(row?.inbound ?? 0),
    outbound: Number(row?.outbound ?? 0),
  }
}

async function seedMessages(
  client: PoolClient,
  direction: 'in' | 'out',
  count: number,
  sentAtFor: (index: number) => string,
): Promise<void> {
  const profileUrls: string[] = []
  const campaignIds: string[] = []
  const bodies: string[] = []
  const sentAt: string[] = []
  const sentiments: (string | null)[] = []
  const intents: (string | null)[] = []
  const contentHashes: string[] = []
  const updatedAt: string[] = []

  for (let index = 0; index < count; index++) {
    // Reuse the leads' own profile URLs so the two relations describe the same
    // people — a `leadKey(instance_id, profile_url)` join across them resolves,
    // which is what the client's conversation views actually do.
    profileUrls.push(leadProfileUrl(index % LEAD_COUNT))
    campaignIds.push(CAMPAIGN_IDS[index % CAMPAIGN_IDS.length])
    bodies.push(`S13 ${direction} body ${index}`)
    sentAt.push(sentAtFor(index))
    // Only inbound replies are classified, which is what `classify.ts` does.
    sentiments.push(
      direction === 'in' ? SENTIMENTS[index % SENTIMENTS.length] : null,
    )
    intents.push(direction === 'in' ? INTENTS[index % INTENTS.length] : null)
    // Makes each row unique under `messages_identity_key` even though
    // `SENT_AT_GROUP` rows share an instant and a profile can repeat.
    contentHashes.push(`${DASHBOARD_SCOPE}/${direction}/${index}`)
    updatedAt.push(index % DELTA_EVERY === 0 ? RECENT_UPDATED_AT : OLD_UPDATED_AT)
  }

  await client.query(
    `INSERT INTO public.messages (
        instance_id, campaign_id, profile_url, direction, body, sent_at,
        sentiment, reason, classified_at, classified_model, intent_level,
        intent_reason, intent_classified_at, intent_classified_model,
        intent_taxonomy_version, content_hash, source, updated_at)
     SELECT $1, f.campaign_id, f.profile_url, $2, f.body, f.sent_at::timestamptz,
            f.sentiment,
            CASE WHEN f.sentiment IS NULL THEN NULL ELSE 'fixture rationale' END,
            CASE WHEN f.sentiment IS NULL THEN NULL
                 ELSE f.sent_at::timestamptz END,
            CASE WHEN f.sentiment IS NULL THEN NULL ELSE 'claude-haiku-4-5' END,
            f.intent_level,
            CASE WHEN f.intent_level IS NULL THEN NULL ELSE 'fixture intent' END,
            CASE WHEN f.intent_level IS NULL THEN NULL
                 ELSE f.sent_at::timestamptz END,
            CASE WHEN f.intent_level IS NULL THEN NULL ELSE 'claude-haiku-4-5' END,
            CASE WHEN f.intent_level IS NULL THEN NULL ELSE 'p123-v1' END,
            f.content_hash, 'sync', f.updated_at::timestamptz
       FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                   $8::text[], $9::text[], $10::text[])
            AS f(campaign_id, profile_url, body, sent_at, sentiment,
                 intent_level, content_hash, updated_at)
     ON CONFLICT (instance_id, profile_url, direction, sent_at, content_hash)
       DO NOTHING`,
    [
      DASHBOARD_SCOPE,
      direction,
      campaignIds,
      profileUrls,
      bodies,
      sentAt,
      sentiments,
      intents,
      contentHashes,
      updatedAt,
    ],
  )
}
