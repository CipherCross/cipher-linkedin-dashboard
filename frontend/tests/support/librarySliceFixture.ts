/**
 * Fixture for S14's second write slice — the sourcing library.
 *
 * Separate from `writeSliceFixture.ts` on purpose. That one is scoped by
 * `instance_id`, and **nothing in this slice has an `instance_id`**: `icps`,
 * `hypotheses` and `saved_searches` are global rows keyed only by a name. So the
 * scope has to be something else, and it is a **name prefix** — every row this
 * fixture or a test creates is named `s14-lib …`, and cleanup deletes by that
 * prefix.
 *
 * That is a weaker fence than an `instance_id`, and it is stated rather than
 * glossed: a human row on the shared project called `s14-lib something` would be
 * deleted by a test run. The prefix is deliberately ugly for that reason.
 *
 * `campaigns` is the one exception — `save_campaign_context` writes a campaign
 * row, which does carry `instance_id`, so it reuses the `s14-writes` scope's own
 * campaign rather than creating a second instance.
 */

import type { PoolClient } from 'pg'

/** The name prefix that *is* the scope. Every row created here starts with it. */
export const LIBRARY_SCOPE = 's14-lib'

export const LIBRARY_NAMES = {
  /** The ICP a persona, an industry and a hypothesis all hang off. */
  icp: `${LIBRARY_SCOPE} anchor icp`,
  /** A second ICP, so a rename can collide with something. */
  icpRival: `${LIBRARY_SCOPE} rival icp`,
  hypothesis: `${LIBRARY_SCOPE} anchor hypothesis`,
  hypothesisRival: `${LIBRARY_SCOPE} rival hypothesis`,
  search: `${LIBRARY_SCOPE} anchor search`,
  searchRival: `${LIBRARY_SCOPE} rival search`,
  industry: `${LIBRARY_SCOPE} anchor industry`,
  persona: `${LIBRARY_SCOPE} anchor persona`,
} as const

export const LIBRARY_PLATFORM = `${LIBRARY_SCOPE}-linkedin`

/**
 * Delete every row the fixture or a test can have created, children first.
 *
 * `hypothesis_campaigns` is cleaned explicitly rather than left to the cascade,
 * because `set_hypothesis_campaigns` can attach a campaign to a hypothesis a
 * previous run created and the cascade only fires if that hypothesis is deleted
 * in the same statement order.
 */
export async function resetLibraryFixture(client: PoolClient): Promise<void> {
  const like = `${LIBRARY_SCOPE}%`
  await client.query(
    `DELETE FROM public.hypothesis_campaigns
      WHERE hypothesis_id IN (SELECT id FROM public.hypotheses WHERE name LIKE $1)`,
    [like],
  )
  await client.query(
    `DELETE FROM public.icp_personas
      WHERE kind LIKE $1
         OR icp_id IN (SELECT id FROM public.icps WHERE name LIKE $1)`,
    [like],
  )
  await client.query(
    `DELETE FROM public.icp_industries
      WHERE name LIKE $1
         OR icp_id IN (SELECT id FROM public.icps WHERE name LIKE $1)`,
    [like],
  )
  await client.query(`DELETE FROM public.saved_searches WHERE name LIKE $1`, [like])
  await client.query(`DELETE FROM public.hypotheses WHERE name LIKE $1`, [like])
  await client.query(`DELETE FROM public.icps WHERE name LIKE $1`, [like])
}

export interface SeededLibraryFixture {
  readonly icpId: number
  readonly icpRivalId: number
  readonly hypothesisId: number
  readonly hypothesisRivalId: number
  readonly searchId: number
  readonly searchRivalId: number
  readonly industryId: number
  readonly personaId: number
}

/**
 * Seed one of everything, plus a "rival" row per uniquely-named relation.
 *
 * The rivals exist so a **rename into an existing name** is testable — that is
 * the one conflict an `ON CONFLICT` clause could not have expressed and the
 * reason `DataStoreConstraintError` exists rather than a zero row count.
 *
 * Arrays and `filters` are seeded non-empty so a partial patch that touches
 * neither can be shown to have left them alone. A patch that blanked every
 * unmentioned column would pass against empty defaults.
 */
export async function seedLibraryFixture(
  client: PoolClient,
): Promise<SeededLibraryFixture> {
  await resetLibraryFixture(client)

  const icps = await client.query<{ id: string; name: string }>(
    `INSERT INTO public.icps
            (name, main_product, purchase_triggers, company_countries, archived)
     SELECT n.name, 'seeded product', ARRAY['seeded trigger'], ARRAY['PL'], false
       FROM unnest($1::text[]) AS n(name)
  RETURNING id::text AS id, name`,
    [[LIBRARY_NAMES.icp, LIBRARY_NAMES.icpRival]],
  )
  const icpId = Number(icps.rows.find((row) => row.name === LIBRARY_NAMES.icp)?.id)
  const icpRivalId = Number(
    icps.rows.find((row) => row.name === LIBRARY_NAMES.icpRival)?.id,
  )

  const hypotheses = await client.query<{ id: string; name: string }>(
    `INSERT INTO public.hypotheses (name, icp_id, description)
     SELECT n.name, $2::bigint, 'seeded description'
       FROM unnest($1::text[]) AS n(name)
  RETURNING id::text AS id, name`,
    [[LIBRARY_NAMES.hypothesis, LIBRARY_NAMES.hypothesisRival], icpId],
  )
  const hypothesisId = Number(
    hypotheses.rows.find((row) => row.name === LIBRARY_NAMES.hypothesis)?.id,
  )
  const hypothesisRivalId = Number(
    hypotheses.rows.find((row) => row.name === LIBRARY_NAMES.hypothesisRival)?.id,
  )

  const searches = await client.query<{ id: string; name: string }>(
    `INSERT INTO public.saved_searches
            (name, platform, include_keywords, exclude_keywords, filters, notes)
     SELECT n.name, $2, ARRAY['seeded include'], ARRAY['seeded exclude'],
            '{"seeded": true}'::jsonb, 'seeded notes'
       FROM unnest($1::text[]) AS n(name)
  RETURNING id::text AS id, name`,
    [[LIBRARY_NAMES.search, LIBRARY_NAMES.searchRival], LIBRARY_PLATFORM],
  )
  const searchId = Number(
    searches.rows.find((row) => row.name === LIBRARY_NAMES.search)?.id,
  )
  const searchRivalId = Number(
    searches.rows.find((row) => row.name === LIBRARY_NAMES.searchRival)?.id,
  )

  const industries = await client.query<{ id: string }>(
    `INSERT INTO public.icp_industries (icp_id, name, include_keywords)
     VALUES ($1::bigint, $2, ARRAY['seeded keyword'])
  RETURNING id::text AS id`,
    [icpId, LIBRARY_NAMES.industry],
  )

  const personas = await client.query<{ id: string }>(
    `INSERT INTO public.icp_personas (icp_id, kind, job_titles, location, sort)
     VALUES ($1::bigint, $2, ARRAY['seeded title'], 'Warsaw', 3)
  RETURNING id::text AS id`,
    [icpId, LIBRARY_NAMES.persona],
  )

  return {
    icpId,
    icpRivalId,
    hypothesisId,
    hypothesisRivalId,
    searchId,
    searchRivalId,
    industryId: Number(industries.rows[0]?.id),
    personaId: Number(personas.rows[0]?.id),
  }
}
