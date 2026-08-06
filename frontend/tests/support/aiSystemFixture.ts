/**
 * Fixture for the S15 system write path (`aiSystemWrites.neon.test.ts`).
 *
 * Two constraints shape everything here, and both are stricter than S14's.
 *
 * **The suite commits, and the project holds real tenant data.** So every row
 * this file creates is namespaced — `instance_id = 's15-ai-system'` for the
 * business rows, `platform = 's15-ai-system'` for the library rows — and every
 * deletion names that namespace. Nothing selects by a predicate that could
 * match a neighbouring session's rows, and nothing selects by a predicate that
 * could match a real one. The notifier's own candidate read is deliberately
 * **unscoped** (it drains the whole backlog, which is the endpoint's job), so
 * the tests never claim what that read returns — they claim ids this file
 * created and nothing else.
 *
 * **`app_system` cannot clean up after itself.** Step 007 granted it
 * `SELECT, INSERT, UPDATE` and no `DELETE`, which is exactly the property the
 * suite proves — so seeding and teardown run on the *runtime* credential
 * through `NeonFixtureClient`, as an active member, precisely as S14's fixture
 * does. A fixture that needed DELETE from the principal under test would have
 * to weaken the thing being tested.
 *
 * The seed is idempotent: it resets first, so a re-run after a crash is a
 * no-op rather than a conflict.
 */

import type { PoolClient } from 'pg'

export const SYSTEM_SCOPE = 's15-ai-system'
export const SYSTEM_CAMPAIGN_ID = `${SYSTEM_SCOPE}:1`

/** Deterministic, so cleanup can name it without first reading it back. */
export const SYSTEM_LEAD_ID = '5a150000-0000-4000-8000-000000000001'
export const SYSTEM_PROFILE_URL = `https://www.linkedin.com/in/${SYSTEM_SCOPE}-reply/`
export const SYSTEM_LEAD_NAME = 'S15 System Reply Subject'

/**
 * The library rows are namespaced by **platform**, not by name: the baseline's
 * uniqueness is `(platform, lower(name))`, so a namespaced platform both keeps
 * the suite's rows from colliding with a real search and makes the teardown
 * predicate exact.
 */
export const SYSTEM_SEARCH_PLATFORM = SYSTEM_SCOPE

/**
 * `briefing_jobs` and `briefings` are keyed on `(briefing_date, briefing_kind)`
 * and carry no scope column at all, so the namespace has to be the date itself.
 * A date this far out cannot collide with a briefing the tenant will ever have,
 * and the teardown names it exactly.
 *
 * The PRIOR date is the day before, and it exists so `briefing.prior` — which
 * reads `briefing_date < $1` fleet-wide and would otherwise answer with the
 * tenant's real briefings — has a deterministic newest row to find.
 */
export const SYSTEM_BRIEFING_DATE = '2099-12-31'
export const SYSTEM_PRIOR_BRIEFING_DATE = '2099-12-30'
const SYSTEM_BRIEFING_DATES = [
  SYSTEM_BRIEFING_DATE,
  SYSTEM_PRIOR_BRIEFING_DATE,
] as const

/**
 * The team-context rows the briefing cron reads through the guard.
 *
 * `hypotheses` is unique on `name` and `annotations` has no natural key, so both
 * are namespaced by a literal this file owns and both teardowns name it exactly.
 * The annotation is dated TODAY because the guard query's window is
 * `noted_at >= now() - interval '30 days'` — a fixture outside the window would
 * make the read look empty for the wrong reason.
 */
export const SYSTEM_HYPOTHESIS_NAME = 'S15 AI system hypothesis'
export const SYSTEM_ANNOTATION_NOTE =
  'S15 system path — team context annotation.'
/** Namespaced by platform like every other library row this fixture writes. */
export const SYSTEM_SEARCH_NAME = 'S15 system assigned search'

/**
 * Three unannounced inbound replies. Three rather than one because the
 * concurrency proof needs a set that two overlapping claims could plausibly
 * split, and because a claim that returned "some rows" without returning *all*
 * of them would pass a one-row test.
 */
export const SYSTEM_REPLY_BODIES = [
  'S15 system path — first unannounced reply.',
  'S15 system path — second unannounced reply.',
  'S15 system path — third unannounced reply.',
] as const

const SYSTEM_REPLY_SENT_AT = [
  '2026-01-02T09:00:00.000Z',
  '2026-01-02T10:00:00.000Z',
  '2026-01-02T11:00:00.000Z',
] as const

/**
 * Every row this fixture and its tests can have written, namespace by namespace.
 *
 * The order is a dependency order, not a preference: `saved_searches` points at
 * `hypotheses`, `hypothesis_campaigns` points at both `hypotheses` and the
 * fixture campaign, and `dropAiSystemFixture` removes that campaign afterwards.
 */
export async function resetAiSystemFixture(client: PoolClient): Promise<void> {
  await client.query(`DELETE FROM public.messages WHERE instance_id = $1`, [
    SYSTEM_SCOPE,
  ])
  await client.query(`DELETE FROM public.leads WHERE instance_id = $1`, [
    SYSTEM_SCOPE,
  ])
  await client.query(`DELETE FROM public.saved_searches WHERE platform = $1`, [
    SYSTEM_SEARCH_PLATFORM,
  ])
  await client.query(
    `DELETE FROM public.hypothesis_campaigns
      WHERE hypothesis_id IN (SELECT id FROM public.hypotheses WHERE name = $1)`,
    [SYSTEM_HYPOTHESIS_NAME],
  )
  await client.query(`DELETE FROM public.hypotheses WHERE name = $1`, [
    SYSTEM_HYPOTHESIS_NAME,
  ])
  await client.query(`DELETE FROM public.annotations WHERE instance_id = $1`, [
    SYSTEM_SCOPE,
  ])
  await client.query(
    `DELETE FROM public.briefing_jobs WHERE briefing_date = ANY($1::date[])`,
    [[...SYSTEM_BRIEFING_DATES]],
  )
  await client.query(
    `DELETE FROM public.briefings WHERE briefing_date = ANY($1::date[])`,
    [[...SYSTEM_BRIEFING_DATES]],
  )
}

/** Drop the fixture's own campaign and instance too. For `afterAll`. */
export async function dropAiSystemFixture(client: PoolClient): Promise<void> {
  await resetAiSystemFixture(client)
  await client.query(`DELETE FROM public.campaigns WHERE instance_id = $1`, [
    SYSTEM_SCOPE,
  ])
  await client.query(`DELETE FROM public.instances WHERE id = $1`, [SYSTEM_SCOPE])
}

export interface SeededAiSystemFixture {
  /** The three reply ids, oldest first — the order the notifier drains in. */
  readonly messageIds: readonly number[]
  /** The fixture hypothesis, whose id the assignment and search rows carry. */
  readonly hypothesisId: number
}

export async function seedAiSystemFixture(
  client: PoolClient,
): Promise<SeededAiSystemFixture> {
  await resetAiSystemFixture(client)

  await client.query(
    `INSERT INTO public.instances (id, label, account_name)
     VALUES ($1, 'S15 AI system fixture', 'S15 System Account')
     ON CONFLICT (id) DO UPDATE
       SET label = EXCLUDED.label, account_name = EXCLUDED.account_name`,
    [SYSTEM_SCOPE],
  )
  await client.query(
    `INSERT INTO public.campaigns (id, instance_id, lh_campaign_id, name, status)
     VALUES ($1, $2, '1', 'S15 AI system campaign', 'active')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [SYSTEM_CAMPAIGN_ID, SYSTEM_SCOPE],
  )

  await client.query(
    `INSERT INTO public.leads
            (id, instance_id, campaign_id, profile_url, full_name, headline, company)
     VALUES ($1::uuid, $2, $3, $4, $5, 'Head of Nothing In Particular', 'S15 Test Co')`,
    [
      SYSTEM_LEAD_ID,
      SYSTEM_SCOPE,
      SYSTEM_CAMPAIGN_ID,
      SYSTEM_PROFILE_URL,
      SYSTEM_LEAD_NAME,
    ],
  )

  // `notified_at` is left NULL by omission — being an unannounced candidate is
  // the whole reason these rows exist.
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO public.messages
            (instance_id, campaign_id, profile_url, direction, body,
             sent_at, content_hash, source)
     SELECT $1, $2, $3, 'in', m.body, m.sent_at::timestamptz, md5(m.body), 'sync'
       FROM unnest($4::text[], $5::text[]) AS m(body, sent_at)
     RETURNING id::text AS id`,
    [
      SYSTEM_SCOPE,
      SYSTEM_CAMPAIGN_ID,
      SYSTEM_PROFILE_URL,
      [...SYSTEM_REPLY_BODIES],
      [...SYSTEM_REPLY_SENT_AT],
    ],
  )

  // The team-context rows the briefing cron reads. `annotations.noted_at` is a
  // calendar date and is set to today so it falls inside the guard query's
  // 30-day window; the saved search carries `hypothesis_id` because
  // `briefing.assignedSearches` selects only assigned, non-archived rows.
  const hypothesis = await client.query<{ id: string }>(
    `INSERT INTO public.hypotheses (name, description)
     VALUES ($1, 'S15 AI system fixture hypothesis')
     RETURNING id::text AS id`,
    [SYSTEM_HYPOTHESIS_NAME],
  )
  const hypothesisId = Number(hypothesis.rows[0]?.id ?? 0)
  await client.query(
    `INSERT INTO public.hypothesis_campaigns (hypothesis_id, campaign_id)
     VALUES ($1::bigint, $2)`,
    [hypothesisId, SYSTEM_CAMPAIGN_ID],
  )
  await client.query(
    `INSERT INTO public.annotations (instance_id, campaign_id, note, noted_at)
     VALUES ($1, $2, $3, current_date)`,
    [SYSTEM_SCOPE, SYSTEM_CAMPAIGN_ID, SYSTEM_ANNOTATION_NOTE],
  )
  await client.query(
    `INSERT INTO public.saved_searches (name, platform, hypothesis_id, notes)
     VALUES ($1, $2, $3::bigint, 'S15 system assigned-search context')`,
    [SYSTEM_SEARCH_NAME, SYSTEM_SEARCH_PLATFORM, hypothesisId],
  )

  return {
    messageIds: inserted.rows.map((row) => Number(row.id)),
    hypothesisId,
  }
}

/** Read the claim state of the fixture's replies, out of band. */
export async function readNotifiedAt(
  client: PoolClient,
  ids: readonly number[],
): Promise<ReadonlyMap<number, Date | null>> {
  const result = await client.query<{ id: string; notified_at: Date | null }>(
    `SELECT id::text AS id, notified_at FROM public.messages
      WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [[...ids]],
  )
  return new Map(
    result.rows.map((row) => [Number(row.id), row.notified_at] as const),
  )
}
