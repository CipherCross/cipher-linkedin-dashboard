/**
 * S14's second write slice — `/api/playbook`'s thirteen actions, live.
 *
 * Same shape as `writeSlice.neon.test.ts`: the real registry, the real driver,
 * the real baseline policies, the real step-`003` function, and only the JWT
 * verification stubbed. It commits, so the fixture resets in `beforeEach` and
 * every assertion reads back on a separate connection.
 *
 * Three things this file is really for, and each has a section:
 *
 * 1. **The partial patch.** That an absent key leaves a column alone while an
 *    explicit `null` clears it is the single claim the jsonb-presence design
 *    rests on, and a `COALESCE` implementation would pass half of it.
 * 2. **The two constraint kinds.** A duplicate name is a 409 and a dangling
 *    parent is a 400, which is what `DataStoreConstraintError` was added for.
 * 3. **The admin gate reading Neon's roster**, not Supabase's.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LIBRARY_NAMES,
  LIBRARY_PLATFORM,
  LIBRARY_SCOPE,
  resetLibraryFixture,
  seedLibraryFixture,
  type SeededLibraryFixture,
} from './support/librarySliceFixture'
import {
  WRITE_CAMPAIGN_ID,
  dropWriteFixture,
  seedWriteFixture,
} from './support/writeSliceFixture'
import {
  NeonFixtureClient,
  requireNeonTestConnection,
} from './support/neonContractHarness'
import { CONTRACT_ACTORS } from './support/dataStoreContract'

const connection = requireNeonTestConnection()

let stubbedSubject: string | null = null

vi.mock('../api/_lib/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/_lib/auth.js')>()
  return {
    ...actual,
    requireUser: async (req: Request) => {
      if (stubbedSubject === null) return actual.requireUser(req)
      return { userId: stubbedSubject, email: null }
    },
  }
})

const SUBJECTS = {
  activeMember: 'subject-one',
  activeAdmin: 'subject-two',
  inactive: 'subject-three',
} as const

const {
  neonAssignSearch,
  neonDeleteEntity,
  neonSaveCampaignContext,
  neonSaveEntity,
  neonSavePlaybook,
  neonSetHypothesisCampaigns,
} = await import('../api/_lib/neonLibraryWrites.js')
const { NeonDataStore } = await import('../api/_lib/data/neon.js')
const { buildApplicationRegistry } = await import(
  '../api/_lib/data/operations/index.js'
)
const { resetDataStore } = await import('../api/_lib/data/store.js')

const fixtures = new NeonFixtureClient(connection.direct)

let store: InstanceType<typeof NeonDataStore>
let seeded: SeededLibraryFixture

function request(subject: keyof typeof SUBJECTS | 'anonymous'): Request {
  stubbedSubject = subject === 'anonymous' ? null : SUBJECTS[subject]
  return new Request('https://dashboard.test/api/playbook', {
    method: 'POST',
    headers: subject === 'anonymous' ? {} : { authorization: 'Bearer stub-token' },
  })
}

const deps = () => ({ store, legacyProviderName: 'fixture' })

async function read<TRow = Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<TRow[]> {
  return fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, async (client) => {
    const result = await client.query(sql, values)
    return result.rows as TRow[]
  })
}

beforeAll(async () => {
  store = new NeonDataStore({
    connectionString: connection.pooled,
    operations: buildApplicationRegistry(),
    statementTimeoutMs: 8_000,
    maxConnections: 2,
    applicationName: 's14-library-slice',
  })
  // `save_campaign_context` needs a campaign, and the write fixture already owns
  // one. Seeded once rather than per test: nothing here mutates its leads.
  await fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, (client) =>
    seedWriteFixture(client),
  )
})

beforeEach(async () => {
  stubbedSubject = null
  seeded = await fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, (client) =>
    seedLibraryFixture(client),
  )
})

afterAll(async () => {
  await fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, async (client) => {
    await resetLibraryFixture(client)
    await dropWriteFixture(client)
  })
  await store.close()
  await resetDataStore()
  await fixtures.end()
})

// ---------------------------------------------------------------------------

describe('authorization: admin, decided by the database being written', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await neonSaveEntity(
      request('anonymous'),
      {
        entity: 'icp',
        patch: { name: `${LIBRARY_NAMES.icp} anon` },
        bodyKey: 'icp',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(response.status).toBe(401)
    expect(
      await read(`SELECT id FROM public.icps WHERE name = $1`, [
        `${LIBRARY_NAMES.icp} anon`,
      ]),
    ).toHaveLength(0)
  })

  it('refuses an active member who is not an admin, and writes nothing', async () => {
    const response = await neonSaveEntity(
      request('activeMember'),
      {
        entity: 'icp',
        patch: { name: `${LIBRARY_NAMES.icp} member` },
        bodyKey: 'icp',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Admin access required' })
    expect(
      await read(`SELECT id FROM public.icps WHERE name = $1`, [
        `${LIBRARY_NAMES.icp} member`,
      ]),
    ).toHaveLength(0)
  })

  it('lets an admin through', async () => {
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'icp',
        patch: { name: `${LIBRARY_NAMES.icp} admin` },
        bodyKey: 'icp',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(response.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------

describe('insert: absent keys take the table default, not NULL', () => {
  it('creates an ICP whose five array columns are empty rather than null', async () => {
    const name = `${LIBRARY_SCOPE} created icp`
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'icp',
        patch: { name, main_product: 'a product' },
        bodyKey: 'icp',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { icp: Record<string, unknown> }
    expect(body.icp).toMatchObject({
      name,
      main_product: 'a product',
      purchase_triggers: [],
      features: [],
      company_countries: [],
      apollo_industries: [],
      exclude_keywords: [],
      archived: false,
    })
    // And the same thing is true of the row, not just of the response.
    const rows = await read<Record<string, unknown>>(
      `SELECT purchase_triggers, features, company_countries, apollo_industries,
              exclude_keywords, archived, airtable_url
         FROM public.icps WHERE name = $1`,
      [name],
    )
    expect(rows[0]).toMatchObject({
      purchase_triggers: [],
      features: [],
      company_countries: [],
      apollo_industries: [],
      exclude_keywords: [],
      archived: false,
      airtable_url: null,
    })
  })

  it('creates a saved search whose filters default to {}', async () => {
    const name = `${LIBRARY_SCOPE} created search`
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'search',
        patch: { name, platform: LIBRARY_PLATFORM },
        bodyKey: 'search',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { search: Record<string, unknown> }
    expect(body.search).toMatchObject({
      name,
      platform: LIBRARY_PLATFORM,
      filters: {},
      include_keywords: [],
      exclude_keywords: [],
      archived: false,
      hypothesis_id: null,
    })
  })

  it('creates a persona whose sort defaults to 0', async () => {
    const kind = `${LIBRARY_SCOPE} created persona`
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'persona',
        patch: { icp_id: seeded.icpId, kind },
        bodyKey: 'persona',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { persona: Record<string, unknown> }
    expect(body.persona).toMatchObject({
      icp_id: seeded.icpId,
      kind,
      sort: 0,
      job_titles: [],
      location: null,
    })
  })
})

// ---------------------------------------------------------------------------

describe('update: the partial patch, which is the whole design', () => {
  it('leaves every unmentioned column exactly as it was', async () => {
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'icp',
        id: seeded.icpId,
        patch: { main_product: 'edited product' },
        bodyKey: 'icp',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(response.status).toBe(200)

    const rows = await read<Record<string, unknown>>(
      `SELECT name, main_product, purchase_triggers, company_countries, archived
         FROM public.icps WHERE id = $1`,
      [seeded.icpId],
    )
    expect(rows[0]).toEqual({
      name: LIBRARY_NAMES.icp,
      main_product: 'edited product',
      // These are the assertion. A `COALESCE(new, old)` implementation passes
      // this test too; the next one is where the two designs part.
      purchase_triggers: ['seeded trigger'],
      company_countries: ['PL'],
      archived: false,
    })
  })

  it('clears a column when the key is present and null', async () => {
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'icp',
        id: seeded.icpId,
        patch: { main_product: null },
        bodyKey: 'icp',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(response.status).toBe(200)
    expect(
      (await response.json()) as { icp: { main_product: unknown } },
    ).toMatchObject({ icp: { main_product: null } })

    const rows = await read<{ main_product: string | null }>(
      `SELECT main_product FROM public.icps WHERE id = $1`,
      [seeded.icpId],
    )
    // `COALESCE(new, old)` would have left 'seeded product' here. This is the
    // one assertion that separates the two implementations.
    expect(rows[0]?.main_product).toBeNull()
  })

  it('replaces an array wholesale, and empties it when given []', async () => {
    await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'icp',
        id: seeded.icpId,
        patch: { purchase_triggers: ['first', 'second'] },
        bodyKey: 'icp',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    let rows = await read<{ purchase_triggers: string[] }>(
      `SELECT purchase_triggers FROM public.icps WHERE id = $1`,
      [seeded.icpId],
    )
    expect(rows[0]?.purchase_triggers).toEqual(['first', 'second'])

    await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'icp',
        id: seeded.icpId,
        patch: { purchase_triggers: [] },
        bodyKey: 'icp',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    rows = await read<{ purchase_triggers: string[] }>(
      `SELECT purchase_triggers FROM public.icps WHERE id = $1`,
      [seeded.icpId],
    )
    expect(rows[0]?.purchase_triggers).toEqual([])
  })

  it('replaces a jsonb column and leaves the rest of the search alone', async () => {
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'search',
        id: seeded.searchId,
        patch: { filters: { seniority: ['head', 'lead'], remote: true } },
        bodyKey: 'search',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(response.status).toBe(200)
    const rows = await read<Record<string, unknown>>(
      `SELECT filters, notes, include_keywords FROM public.saved_searches WHERE id = $1`,
      [seeded.searchId],
    )
    expect(rows[0]).toEqual({
      filters: { seniority: ['head', 'lead'], remote: true },
      notes: 'seeded notes',
      include_keywords: ['seeded include'],
    })
  })

  it('flips a boolean and moves an integer', async () => {
    await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'hypothesis',
        id: seeded.hypothesisId,
        patch: { archived: true },
        bodyKey: 'hypothesis',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'persona',
        id: seeded.personaId,
        patch: { sort: 9 },
        bodyKey: 'persona',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(
      (
        await read<{ archived: boolean; description: string | null }>(
          `SELECT archived, description FROM public.hypotheses WHERE id = $1`,
          [seeded.hypothesisId],
        )
      )[0],
    ).toEqual({ archived: true, description: 'seeded description' })
    expect(
      (
        await read<{ sort: number; location: string | null }>(
          `SELECT sort, location FROM public.icp_personas WHERE id = $1`,
          [seeded.personaId],
        )
      )[0],
    ).toEqual({ sort: 9, location: 'Warsaw' })
  })

  it('nulls a nullable foreign key when told to, and sets it back', async () => {
    await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'hypothesis',
        id: seeded.hypothesisId,
        patch: { icp_id: null },
        bodyKey: 'hypothesis',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(
      (
        await read<{ icp_id: string | null }>(
          `SELECT icp_id::text AS icp_id FROM public.hypotheses WHERE id = $1`,
          [seeded.hypothesisId],
        )
      )[0]?.icp_id,
    ).toBeNull()

    await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'hypothesis',
        id: seeded.hypothesisId,
        patch: { icp_id: seeded.icpRivalId },
        bodyKey: 'hypothesis',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(
      Number(
        (
          await read<{ icp_id: string | null }>(
            `SELECT icp_id::text AS icp_id FROM public.hypotheses WHERE id = $1`,
            [seeded.hypothesisId],
          )
        )[0]?.icp_id,
      ),
    ).toBe(seeded.icpRivalId)
  })

  it('bumps updated_at through the trigger, not through the statement', async () => {
    const before = await read<{ updated_at: string }>(
      `SELECT updated_at FROM public.icps WHERE id = $1`,
      [seeded.icpId],
    )
    await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'icp',
        id: seeded.icpId,
        patch: { main_product: 'moved' },
        bodyKey: 'icp',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    const after = await read<{ updated_at: string }>(
      `SELECT updated_at FROM public.icps WHERE id = $1`,
      [seeded.icpId],
    )
    expect(
      new Date(String(after[0]?.updated_at)).getTime(),
    ).toBeGreaterThanOrEqual(new Date(String(before[0]?.updated_at)).getTime())
  })

  it('404s an unknown id without touching anything', async () => {
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'icp',
        id: 2_147_483_600,
        patch: { name: 'nowhere' },
        bodyKey: 'icp',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown icp id' })
  })
})

// ---------------------------------------------------------------------------

describe('the two constraint kinds are answers, not 500s', () => {
  it('409s an insert that duplicates a name', async () => {
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'icp',
        patch: { name: LIBRARY_NAMES.icp },
        bodyKey: 'icp',
        conflictMessage: 'an ICP with that name already exists',
      },
      deps(),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'an ICP with that name already exists',
    })
  })

  it('409s a rename onto an existing name — the case ON CONFLICT could not express', async () => {
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'icp',
        id: seeded.icpId,
        patch: { name: LIBRARY_NAMES.icpRival },
        bodyKey: 'icp',
        conflictMessage: 'an ICP with that name already exists',
      },
      deps(),
    )
    expect(response.status).toBe(409)
    // And the rename did not happen.
    expect(
      (
        await read<{ name: string }>(`SELECT name FROM public.icps WHERE id = $1`, [
          seeded.icpId,
        ])
      )[0]?.name,
    ).toBe(LIBRARY_NAMES.icp)
  })

  it('409s a saved search that repeats a name on the same platform', async () => {
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'search',
        patch: { name: LIBRARY_NAMES.search, platform: LIBRARY_PLATFORM },
        bodyKey: 'search',
        conflictMessage: 'a search with that name already exists for this platform',
      },
      deps(),
    )
    expect(response.status).toBe(409)
  })

  it('400s a persona whose ICP does not exist', async () => {
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'persona',
        patch: { icp_id: 2_147_483_600, kind: `${LIBRARY_SCOPE} orphan` },
        bodyKey: 'persona',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'a referenced row does not exist',
    })
  })

  it('does not classify a CHECK violation as a constraint answer', async () => {
    // 161 characters, one past `hypotheses_name_check`. The validator would have
    // refused this; reaching the database with it is a defect, and a defect is a
    // 500 rather than a tidy 400 someone could leave in place.
    const response = await neonSaveEntity(
      request('activeAdmin'),
      {
        entity: 'hypothesis',
        patch: { name: 's14-lib '.padEnd(161, 'x') },
        bodyKey: 'hypothesis',
        conflictMessage: 'conflict',
      },
      deps(),
    )
    expect(response.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------

describe('delete', () => {
  it('removes the row and cascades its children', async () => {
    const response = await neonDeleteEntity(
      request('activeAdmin'),
      { entity: 'icp', id: seeded.icpId },
      deps(),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    expect(
      await read(`SELECT id FROM public.icps WHERE id = $1`, [seeded.icpId]),
    ).toHaveLength(0)
    expect(
      await read(`SELECT id FROM public.icp_personas WHERE id = $1`, [
        seeded.personaId,
      ]),
    ).toHaveLength(0)
    expect(
      await read(`SELECT id FROM public.icp_industries WHERE id = $1`, [
        seeded.industryId,
      ]),
    ).toHaveLength(0)
  })

  it('404s a second delete of the same id, with the relation-named message', async () => {
    await neonDeleteEntity(
      request('activeAdmin'),
      { entity: 'industry', id: seeded.industryId },
      deps(),
    )
    const again = await neonDeleteEntity(
      request('activeAdmin'),
      { entity: 'industry', id: seeded.industryId },
      deps(),
    )
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({ error: 'unknown icp_industries id' })
  })

  it('404s a saved search with its own phrasing', async () => {
    await neonDeleteEntity(
      request('activeAdmin'),
      { entity: 'search', id: seeded.searchId },
      deps(),
    )
    const again = await neonDeleteEntity(
      request('activeAdmin'),
      { entity: 'search', id: seeded.searchId },
      deps(),
    )
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({ error: 'unknown search id' })
  })
})

// ---------------------------------------------------------------------------

describe('set_hypothesis_campaigns', () => {
  it('attaches a campaign and then replaces the set wholesale', async () => {
    const first = await neonSetHypothesisCampaigns(
      request('activeAdmin'),
      { hypothesisId: seeded.hypothesisId, campaignIds: [WRITE_CAMPAIGN_ID] },
      deps(),
    )
    expect(first.status).toBe(200)
    expect(
      await read(`SELECT campaign_id FROM public.hypothesis_campaigns WHERE hypothesis_id = $1`, [
        seeded.hypothesisId,
      ]),
    ).toEqual([{ campaign_id: WRITE_CAMPAIGN_ID }])

    const second = await neonSetHypothesisCampaigns(
      request('activeAdmin'),
      { hypothesisId: seeded.hypothesisId, campaignIds: [] },
      deps(),
    )
    expect(second.status).toBe(200)
    expect(
      await read(`SELECT campaign_id FROM public.hypothesis_campaigns WHERE hypothesis_id = $1`, [
        seeded.hypothesisId,
      ]),
    ).toHaveLength(0)
  })

  it('404s an unknown hypothesis, from the function’s own exception', async () => {
    const response = await neonSetHypothesisCampaigns(
      request('activeAdmin'),
      { hypothesisId: 2_147_483_600, campaignIds: [WRITE_CAMPAIGN_ID] },
      deps(),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown hypothesis id' })
  })

  it('400s a campaign id that does not exist, and attaches nothing', async () => {
    const response = await neonSetHypothesisCampaigns(
      request('activeAdmin'),
      {
        hypothesisId: seeded.hypothesisId,
        campaignIds: [WRITE_CAMPAIGN_ID, 's14-lib:nonexistent'],
      },
      deps(),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'one or more campaign_ids do not exist',
    })
    // The whole call rolled back — the valid campaign is not attached either.
    expect(
      await read(`SELECT campaign_id FROM public.hypothesis_campaigns WHERE hypothesis_id = $1`, [
        seeded.hypothesisId,
      ]),
    ).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('assign_search', () => {
  it('assigns, then unassigns with an explicit null', async () => {
    const assigned = await neonAssignSearch(
      request('activeAdmin'),
      { searchId: seeded.searchId, hypothesisId: seeded.hypothesisId },
      deps(),
    )
    expect(assigned.status).toBe(200)
    expect(
      (await assigned.json()) as { search: { hypothesis_id: number } },
    ).toMatchObject({ search: { hypothesis_id: seeded.hypothesisId } })

    const cleared = await neonAssignSearch(
      request('activeAdmin'),
      { searchId: seeded.searchId, hypothesisId: null },
      deps(),
    )
    expect(cleared.status).toBe(200)
    expect(
      (
        await read<{ hypothesis_id: string | null }>(
          `SELECT hypothesis_id::text AS hypothesis_id FROM public.saved_searches WHERE id = $1`,
          [seeded.searchId],
        )
      )[0]?.hypothesis_id,
    ).toBeNull()
  })

  it('400s a hypothesis that does not exist, naming it', async () => {
    const response = await neonAssignSearch(
      request('activeAdmin'),
      { searchId: seeded.searchId, hypothesisId: 2_147_483_600 },
      deps(),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'unknown hypothesis id' })
  })

  it('404s an unknown search', async () => {
    const response = await neonAssignSearch(
      request('activeAdmin'),
      { searchId: 2_147_483_600, hypothesisId: null },
      deps(),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown search id' })
  })
})

// ---------------------------------------------------------------------------

describe('save_campaign_context and the playbook singleton', () => {
  it('writes the context and stamps its own column', async () => {
    const response = await neonSaveCampaignContext(
      request('activeAdmin'),
      { campaignId: WRITE_CAMPAIGN_ID, context: 'the team sells developer tooling' },
      deps(),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      campaign_id: WRITE_CAMPAIGN_ID,
      briefing_context: 'the team sells developer tooling',
    })
    expect(typeof body.briefing_context_updated_at).toBe('string')
  })

  it('clears the context when given an empty string', async () => {
    await neonSaveCampaignContext(
      request('activeAdmin'),
      { campaignId: WRITE_CAMPAIGN_ID, context: 'something' },
      deps(),
    )
    const response = await neonSaveCampaignContext(
      request('activeAdmin'),
      { campaignId: WRITE_CAMPAIGN_ID, context: '' },
      deps(),
    )
    expect(response.status).toBe(200)
    expect(
      (await response.json()) as { briefing_context: unknown },
    ).toMatchObject({ briefing_context: null })
  })

  it('404s an unknown campaign', async () => {
    const response = await neonSaveCampaignContext(
      request('activeAdmin'),
      { campaignId: 's14-lib:nonexistent', context: 'x' },
      deps(),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown campaign_id' })
  })

  it('upserts the singleton playbook and moves its updated_at', async () => {
    const before = await read<{ content: string; updated_at: string }>(
      `SELECT content, updated_at FROM public.playbook WHERE id`,
    )
    const marker = `${LIBRARY_SCOPE} playbook ${before.length}`

    const response = await neonSavePlaybook(
      request('activeAdmin'),
      { content: marker },
      deps(),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    const rows = await read<{ content: string }>(
      `SELECT content FROM public.playbook WHERE id`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe(marker)

    // Restore whatever the project had, so this suite leaves the singleton as it
    // found it — it is the one row here with no name to scope by.
    await neonSavePlaybook(
      request('activeAdmin'),
      { content: before[0]?.content ?? '' },
      deps(),
    )
  })
})
