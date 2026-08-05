/**
 * Fixture for the S14 write slice.
 *
 * **This is the first session whose fixture is not rolled back for it.** Every
 * earlier Neon session was read-only or ran inside a transaction that ended in
 * `ROLLBACK`; these tests commit. So the rules here are stricter than the read
 * fixtures' were:
 *
 * - Everything is scoped by `instance_id = 's14-writes'`, and `resetWriteFixture`
 *   is called from `beforeEach`, not just `afterAll` — a test that fails halfway
 *   must not leave rows that make the next one pass for the wrong reason.
 * - `pipeline_events`, `lead_notes` and `lead_gender_reviews` are cleaned by
 *   their `lead_id` / `instance_id`, because the first two carry no
 *   `instance_id` of their own. The lead ids are deterministic (see `LEAD_IDS`)
 *   precisely so this deletion can name them without a subquery that might
 *   match a neighbouring session's rows.
 * - The seed is idempotent, so a re-run after a crash is a no-op rather than a
 *   conflict.
 *
 * The shared Neon project also carries `s11-contract`, `s12-activity`,
 * `s13-dashboard` and `s13-rest`. Nothing here touches them.
 */

import type { PoolClient } from 'pg'

export const WRITE_SCOPE = 's14-writes'
export const WRITE_CAMPAIGN_ID = `${WRITE_SCOPE}:1`
/**
 * A second campaign, needed rather than decorative: `leads` is unique on
 * `(campaign_id, profile_url)`, so the two rows of one human — which is what
 * `set_gender`'s `(instance_id, profile_url)` key exists to update together —
 * cannot both live in one campaign. That is also the real shape: the same person
 * reached from two campaigns is two lead rows.
 */
export const WRITE_CAMPAIGN_ID_2 = `${WRITE_SCOPE}:2`

/**
 * Deterministic lead uuids, so cleanup can name them and so a test can assert
 * against a specific lead without first reading one back.
 */
export const LEAD_IDS = {
  /** The stage/assignment subject. */
  stage: '5a140000-0000-4000-8000-000000000001',
  /** The note subject. */
  notes: '5a140000-0000-4000-8000-000000000002',
  /** The demographics subject, and the second row of the same person. */
  genderPrimary: '5a140000-0000-4000-8000-000000000003',
  genderSibling: '5a140000-0000-4000-8000-000000000004',
  /** The conversation-import subject: no milestones at all to start with. */
  import: '5a140000-0000-4000-8000-000000000005',
} as const

export const PROFILE_URLS = {
  stage: `https://www.linkedin.com/in/${WRITE_SCOPE}-stage/`,
  notes: `https://www.linkedin.com/in/${WRITE_SCOPE}-notes/`,
  /** Shared by both gender rows — one human, two campaigns' worth of rows. */
  gender: `https://www.linkedin.com/in/${WRITE_SCOPE}-gender/`,
  import: `https://www.linkedin.com/in/${WRITE_SCOPE}-import/`,
} as const

const ALL_LEAD_IDS = Object.values(LEAD_IDS)

/**
 * Delete everything the fixture and the tests can have written, in
 * foreign-key-safe order.
 *
 * `messages` before `leads` because of the `messages → campaigns` anchor and
 * because `archive_follow_up_after_last_lead` fires on a `leads` delete;
 * clearing the conversation rows first keeps that trigger's work empty and makes
 * the deletion order the reason rather than luck.
 */
export async function resetWriteFixture(client: PoolClient): Promise<void> {
  await client.query(
    `DELETE FROM public.pipeline_events WHERE lead_id = ANY($1::uuid[])`,
    [ALL_LEAD_IDS],
  )
  await client.query(
    `DELETE FROM public.lead_notes WHERE lead_id = ANY($1::uuid[])`,
    [ALL_LEAD_IDS],
  )
  await client.query(
    `DELETE FROM public.lead_gender_reviews WHERE instance_id = $1`,
    [WRITE_SCOPE],
  )
  await client.query(
    `DELETE FROM public.follow_up_events WHERE instance_id = $1`,
    [WRITE_SCOPE],
  )
  await client.query(
    `DELETE FROM public.conversation_follow_up_state WHERE instance_id = $1`,
    [WRITE_SCOPE],
  )
  await client.query(`DELETE FROM public.messages WHERE instance_id = $1`, [
    WRITE_SCOPE,
  ])
  await client.query(`DELETE FROM public.leads WHERE instance_id = $1`, [
    WRITE_SCOPE,
  ])
}

/** Drop the fixture's own instance and campaign too. For `afterAll`. */
export async function dropWriteFixture(client: PoolClient): Promise<void> {
  await resetWriteFixture(client)
  await client.query(`DELETE FROM public.campaigns WHERE instance_id = $1`, [
    WRITE_SCOPE,
  ])
  await client.query(`DELETE FROM public.instances WHERE id = $1`, [WRITE_SCOPE])
}

export interface SeededWriteFixture {
  readonly leads: number
}

/**
 * Seed the five leads and one pre-existing inbound message.
 *
 * The pre-existing message is what makes the import's dedup testable: it is a
 * body the test then re-pastes with different whitespace and casing, so a run
 * that deduped on the raw body — or on the `messages` unique key — would insert
 * a second copy and the assertion would catch it.
 */
export async function seedWriteFixture(
  client: PoolClient,
): Promise<SeededWriteFixture> {
  await resetWriteFixture(client)

  await client.query(
    `INSERT INTO public.instances (id, label)
     VALUES ($1, 'S14 write slice fixture')
     ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label`,
    [WRITE_SCOPE],
  )
  await client.query(
    `INSERT INTO public.campaigns (id, instance_id, lh_campaign_id, name, status)
     SELECT c.id, $1, c.lh_id, c.name, 'active'
       FROM unnest($2::text[], $3::text[], $4::text[]) AS c(id, lh_id, name)
     ON CONFLICT (id) DO NOTHING`,
    [
      WRITE_SCOPE,
      [WRITE_CAMPAIGN_ID, WRITE_CAMPAIGN_ID_2],
      ['1', '2'],
      ['S14 writes', 'S14 writes (second campaign)'],
    ],
  )

  await client.query(
    `INSERT INTO public.leads
            (id, instance_id, campaign_id, profile_url, full_name,
             pipeline_stage, gender, gender_confidence, demo_model)
     SELECT l.id::uuid, $1, l.campaign_id, l.profile_url, l.full_name,
            l.stage, l.gender, l.confidence::real, l.model
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[],
                   $6::text[], $7::text[], $8::text[], $9::text[])
              AS l(id, campaign_id, profile_url, full_name, stage, gender,
                   confidence, model)`,
    [
      WRITE_SCOPE,
      ALL_LEAD_IDS,
      [
        WRITE_CAMPAIGN_ID,
        WRITE_CAMPAIGN_ID,
        WRITE_CAMPAIGN_ID,
        WRITE_CAMPAIGN_ID_2,
        WRITE_CAMPAIGN_ID,
      ],
      [
        PROFILE_URLS.stage,
        PROFILE_URLS.notes,
        PROFILE_URLS.gender,
        PROFILE_URLS.gender,
        PROFILE_URLS.import,
      ],
      ['Stage Subject', 'Notes Subject', 'Gender Subject', 'Gender Sibling', 'Import Subject'],
      // The stage lead starts at `first_contact`, so a move to `interested` is a
      // real transition with a non-null `from_stage` in the audit row.
      ['first_contact', null, null, null, null],
      // The gender leads start machine-labelled, so an override has a prediction
      // to snapshot and `predicted_*` is not trivially null.
      [null, null, 'male', 'male', null],
      [null, null, '0.75', '0.75', null],
      [null, null, 'name-v1', 'name-v1', null],
    ],
  )

  await client.query(
    `INSERT INTO public.messages
            (instance_id, campaign_id, profile_url, direction, body,
             sent_at, content_hash, source)
     VALUES ($1, $2, $3, 'in', $4, $5, md5($4), 'sync')
     ON CONFLICT (instance_id, profile_url, direction, sent_at, content_hash)
          DO NOTHING`,
    [
      WRITE_SCOPE,
      WRITE_CAMPAIGN_ID,
      PROFILE_URLS.import,
      PRE_EXISTING_INBOUND_BODY,
      PRE_EXISTING_INBOUND_SENT_AT,
    ],
  )

  return { leads: ALL_LEAD_IDS.length }
}

/**
 * Already in the thread as a synced row. The import test re-pastes it with
 * different whitespace and casing.
 */
export const PRE_EXISTING_INBOUND_BODY =
  'Thanks for reaching out — happy to chat next week.'

/** An LH2 action-run time, not the real message time. That is the whole reason
 *  the `messages` unique key cannot be the dedup key. */
export const PRE_EXISTING_INBOUND_SENT_AT = '2026-01-10T09:00:00.000Z'
