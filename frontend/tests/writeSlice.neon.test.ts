/**
 * S14 — the non-AI write slice, end to end against the live Neon project.
 *
 * **This is the first suite in the migration that commits.** Everything before it
 * was read-only or ended in `ROLLBACK`, so the shape here is different: the
 * fixture is reset in `beforeEach`, every assertion reads the row back through a
 * separate connection, and `afterAll` drops the scope.
 *
 * What is real: the real operation registry, the real driver, the real baseline
 * RLS policies, the real step-`003` functions. The only stub is the JWT
 * verification, exactly as `dashboardSliceRest.neon.test.ts` stubs it — the
 * denial tests run it for real.
 *
 * The four things the spec names for this session each have a section below:
 * authorization, atomicity, dedup, and the locks.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LEAD_IDS,
  PRE_EXISTING_INBOUND_BODY,
  PROFILE_URLS,
  WRITE_CAMPAIGN_ID,
  WRITE_SCOPE,
  dropWriteFixture,
  seedWriteFixture,
} from './support/writeSliceFixture'
import {
  NeonFixtureClient,
  requireNeonTestConnection,
} from './support/neonContractHarness'
import { CONTRACT_ACTORS } from './support/dataStoreContract'

/** Fails the file at import if the credential is absent. */
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

/** The baseline's own identity fixtures, `provider = 'fixture'`. */
const SUBJECTS = {
  activeMember: 'subject-one',
  activeAdmin: 'subject-two',
  inactive: 'subject-three',
} as const

const {
  neonAddNote,
  neonDeleteMessage,
  neonDeleteNote,
  neonEditMessage,
  neonImportConversation,
  neonSetGender,
  neonSetInstanceConfig,
  neonSetStage,
} = await import('../api/_lib/neonWrites.js')
const { NeonDataStore } = await import('../api/_lib/data/neon.js')
const {
  buildApplicationRegistry,
  CONVERSATION_WRITE_COMMANDS,
  PIPELINE_WRITE_COMMANDS,
  PIPELINE_WRITE_OPERATIONS,
} = await import('../api/_lib/data/operations/index.js')
const { resetDataStore } = await import('../api/_lib/data/store.js')
const { deploymentWritePath, NEON_WRITES_ENV } = await import(
  '../api/_lib/data/writePath.js'
)
const { NEON_DATABASE_URL_ENV } = await import('../api/_lib/data/neonConfig.js')
const { ProviderPathError } = await import('../api/_lib/data/providerPath.js')

const fixtures = new NeonFixtureClient(connection.direct)

/**
 * The store the handlers use, built here rather than taken from `getDataStore()`
 * so the suite closes it deterministically. It is the same class, the same
 * registry and the same statement timeout the request path uses.
 */
function realStore() {
  return new NeonDataStore({
    connectionString: connection.pooled,
    operations: buildApplicationRegistry(),
    statementTimeoutMs: 8_000,
    maxConnections: 2,
    applicationName: 's14-write-slice',
  })
}

/**
 * The same store with **one** operation replaced by one that raises.
 *
 * The registry is the real `buildApplicationRegistry()`, so every other
 * operation is byte-identical to production. `RAISE` is issued by the database,
 * inside the transaction, after the paired mutation has already been sent — which
 * is precisely the failure the pairing exists to survive.
 */
function storeWithFailingCommand(operation: string) {
  const registry = buildApplicationRegistry()
  registry.registerCommand(operation, {
    build: () => ({
      text: `DO $$ BEGIN RAISE EXCEPTION 'injected failure in ${operation}'; END $$`,
      values: [],
    }),
  })
  return new NeonDataStore({
    connectionString: connection.pooled,
    operations: registry,
    statementTimeoutMs: 8_000,
    maxConnections: 2,
    applicationName: 's14-write-slice-injected',
  })
}

let store: ReturnType<typeof realStore>

function request(subject: keyof typeof SUBJECTS | 'anonymous'): Request {
  stubbedSubject = subject === 'anonymous' ? null : SUBJECTS[subject]
  return new Request('https://dashboard.test/api/pipeline', {
    method: 'POST',
    headers: subject === 'anonymous' ? {} : { authorization: 'Bearer stub-token' },
  })
}

/** Read rows back on a separate connection, as an active member. */
async function read<TRow = Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<TRow[]> {
  return fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, async (client) => {
    const result = await client.query(sql, values)
    return result.rows as TRow[]
  })
}

/** The dedup normalization, copied from `_lib/conversationImport.ts`. */
const normalize = (body: string) =>
  body.replace(/\r/g, '').trim().replace(/\s+/g, ' ').toLowerCase()

const md5 = async (text: string): Promise<string> => {
  const { createHash } = await import('node:crypto')
  return createHash('md5').update(text, 'utf8').digest('hex')
}

interface ImportBlock {
  direction: 'in' | 'out'
  body: string
  sent_at: string
  force?: boolean
}

async function importBlocks(blocks: ImportBlock[]) {
  return Promise.all(
    blocks.map(async (block) => ({
      direction: block.direction,
      body: block.body,
      sent_at: block.sent_at,
      force: block.force === true,
      contentHash: await md5(block.body),
    })),
  )
}

beforeAll(async () => {
  store = realStore()
})

beforeEach(async () => {
  stubbedSubject = null
  await fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, (client) =>
    seedWriteFixture(client),
  )
})

afterAll(async () => {
  await fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, (client) =>
    dropWriteFixture(client),
  )
  await store.close()
  await resetDataStore()
  await fixtures.end()
})

// ---------------------------------------------------------------------------

describe('the write-path flag', () => {
  it('takes an explicit value, and derives the unset one from the credential', () => {
    // **S27 inverted the default.** `providerPath.test.ts` covers the resolver
    // row by row; what this asserts is that the write flag is wired to it and to
    // the runtime credential — the one this suite is actually running against.
    expect(deploymentWritePath({ [NEON_WRITES_ENV]: 'neon' })).toBe('neon')
    expect(deploymentWritePath({ [NEON_WRITES_ENV]: ' neon ' })).toBe('neon')
    expect(deploymentWritePath({ [NEON_WRITES_ENV]: 'supabase' })).toBe('supabase')
    expect(deploymentWritePath({})).toBe('supabase')
    expect(deploymentWritePath({ [NEON_WRITES_ENV]: '' })).toBe('supabase')
    expect(
      deploymentWritePath({ [NEON_DATABASE_URL_ENV]: 'postgres://runtime@example/db' }),
    ).toBe('neon')
    // This process holds the real credential, so the deployment default here is
    // `neon` with nothing set at all — the state every tenant is in.
    expect(deploymentWritePath()).toBe('neon')
    for (const value of ['true', '1', 'NEON', 'supabse']) {
      expect(() => deploymentWritePath({ [NEON_WRITES_ENV]: value })).toThrow(
        ProviderPathError,
      )
    }
  })
})

describe('authorization', () => {
  it('refuses an unauthenticated caller and writes nothing', async () => {
    const response = await neonSetStage(
      request('anonymous'),
      { leadId: LEAD_IDS.stage, stage: 'interested', substatus: null, lostReason: null },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(401)

    const rows = await read(`SELECT pipeline_stage FROM public.leads WHERE id = $1`, [
      LEAD_IDS.stage,
    ])
    expect(rows[0]?.pipeline_stage).toBe('first_contact')
    expect(
      await read(`SELECT id FROM public.pipeline_events WHERE lead_id = $1`, [
        LEAD_IDS.stage,
      ]),
    ).toHaveLength(0)
  })

  it('refuses an inactive team member, and the refusal is indistinguishable from unknown', async () => {
    const response = await neonSetStage(
      request('inactive'),
      { leadId: LEAD_IDS.stage, stage: 'interested', substatus: null, lostReason: null },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(403)

    const rows = await read(`SELECT pipeline_stage FROM public.leads WHERE id = $1`, [
      LEAD_IDS.stage,
    ])
    expect(rows[0]?.pipeline_stage).toBe('first_contact')
  })

  it('an ordinary member may move a stage', async () => {
    const response = await neonSetStage(
      request('activeMember'),
      { leadId: LEAD_IDS.stage, stage: 'interested', substatus: null, lostReason: null },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, changed: true })
  })
})

describe('set_stage: the mutation and its audit row are one commit', () => {
  it('writes both, and the event carries the previous stage', async () => {
    const response = await neonSetStage(
      request('activeMember'),
      { leadId: LEAD_IDS.stage, stage: 'call_booked', substatus: null, lostReason: null },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, changed: true, pipeline_stage: 'call_booked' })
    expect(typeof body.pipeline_stage_changed_at).toBe('string')

    const lead = await read(
      `SELECT pipeline_stage, pipeline_stage_changed_at FROM public.leads WHERE id = $1`,
      [LEAD_IDS.stage],
    )
    expect(lead[0]?.pipeline_stage).toBe('call_booked')
    expect(lead[0]?.pipeline_stage_changed_at).not.toBeNull()

    const events = await read(
      `SELECT kind, actor, from_stage, to_stage FROM public.pipeline_events
        WHERE lead_id = $1`,
      [LEAD_IDS.stage],
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'stage',
      from_stage: 'first_contact',
      to_stage: 'call_booked',
    })
    // The actor is a name read from Neon's own roster, keyed on the canonical
    // uuid — never the colliding `team_members.id`.
    expect(typeof events[0]?.actor).toBe('string')
    expect(String(events[0]?.actor).length).toBeGreaterThan(0)
  })

  it('ROLLS THE STAGE BACK when the audit insert fails mid-transaction', async () => {
    const injected = storeWithFailingCommand(
      PIPELINE_WRITE_COMMANDS.appendStageEvent,
    )
    try {
      const response = await neonSetStage(
        request('activeMember'),
        {
          leadId: LEAD_IDS.stage,
          stage: 'proposal_presented',
          substatus: null,
          lostReason: null,
        },
        { store: injected, legacyProviderName: 'fixture' },
      )
      // Not a 200 with an `event_error` field, which is what the Supabase path
      // returns. The caller is told the action failed.
      expect(response.status).toBe(500)
      expect(await response.json()).not.toMatchObject({ ok: true })
    } finally {
      await injected.close()
    }

    // The whole point: the stage did not move.
    const lead = await read(
      `SELECT pipeline_stage, pipeline_stage_changed_at FROM public.leads WHERE id = $1`,
      [LEAD_IDS.stage],
    )
    expect(lead[0]?.pipeline_stage).toBe('first_contact')
    expect(lead[0]?.pipeline_stage_changed_at).toBeNull()
    expect(
      await read(`SELECT id FROM public.pipeline_events WHERE lead_id = $1`, [
        LEAD_IDS.stage,
      ]),
    ).toHaveLength(0)
  })

  it('short-circuits a no-op without appending an audit row', async () => {
    const response = await neonSetStage(
      request('activeMember'),
      {
        leadId: LEAD_IDS.stage,
        stage: 'first_contact',
        substatus: null,
        lostReason: null,
      },
      { store, legacyProviderName: 'fixture' },
    )
    expect(await response.json()).toEqual({ ok: true, changed: false })
    expect(
      await read(`SELECT id FROM public.pipeline_events WHERE lead_id = $1`, [
        LEAD_IDS.stage,
      ]),
    ).toHaveLength(0)
  })

  it('holds pipeline_stage_changed_at still for a substatus-only edit', async () => {
    await neonSetStage(
      request('activeMember'),
      { leadId: LEAD_IDS.stage, stage: 'lost', substatus: null, lostReason: null },
      { store, legacyProviderName: 'fixture' },
    )
    const first = await read(
      `SELECT pipeline_stage_changed_at FROM public.leads WHERE id = $1`,
      [LEAD_IDS.stage],
    )
    const stamped = first[0]?.pipeline_stage_changed_at

    await neonSetStage(
      request('activeMember'),
      {
        leadId: LEAD_IDS.stage,
        stage: 'lost',
        substatus: 'hard_no',
        lostReason: 'budget',
      },
      { store, legacyProviderName: 'fixture' },
    )
    const second = await read(
      `SELECT pipeline_stage, pipeline_substatus, lost_reason, pipeline_stage_changed_at
         FROM public.leads WHERE id = $1`,
      [LEAD_IDS.stage],
    )
    expect(second[0]?.pipeline_substatus).toBe('hard_no')
    expect(second[0]?.lost_reason).toBe('budget')
    // Time-in-stage must not reset because a label changed.
    expect(second[0]?.pipeline_stage_changed_at).toEqual(stamped)
  })

  it('clears the timestamp when the lead leaves the pipeline', async () => {
    await neonSetStage(
      request('activeMember'),
      { leadId: LEAD_IDS.stage, stage: 'interested', substatus: null, lostReason: null },
      { store, legacyProviderName: 'fixture' },
    )
    const response = await neonSetStage(
      request('activeMember'),
      { leadId: LEAD_IDS.stage, stage: null, substatus: null, lostReason: null },
      { store, legacyProviderName: 'fixture' },
    )
    expect(await response.json()).toMatchObject({
      ok: true,
      changed: true,
      pipeline_stage: null,
      pipeline_stage_changed_at: null,
    })
    const lead = await read(
      `SELECT pipeline_stage, pipeline_stage_changed_at FROM public.leads WHERE id = $1`,
      [LEAD_IDS.stage],
    )
    expect(lead[0]?.pipeline_stage).toBeNull()
    expect(lead[0]?.pipeline_stage_changed_at).toBeNull()
  })

  it('answers 404 for an unknown lead', async () => {
    const response = await neonSetStage(
      request('activeMember'),
      {
        leadId: '5a140000-0000-4000-8000-0000000000ff',
        stage: 'interested',
        substatus: null,
        lostReason: null,
      },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(404)
  })
})

describe('notes', () => {
  it('inserts a note whose author is the resolved member', async () => {
    const response = await neonAddNote(
      request('activeMember'),
      { leadId: LEAD_IDS.notes, body: 'Called, will follow up Tuesday.' },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { note?: Record<string, unknown> }
    expect(body.note?.body).toBe('Called, will follow up Tuesday.')
    expect(typeof body.note?.author).toBe('string')

    const rows = await read(
      `SELECT body, author FROM public.lead_notes WHERE lead_id = $1`,
      [LEAD_IDS.notes],
    )
    expect(rows).toHaveLength(1)
  })

  it('answers 404 for an unknown lead without inserting', async () => {
    const response = await neonAddNote(
      request('activeMember'),
      { leadId: '5a140000-0000-4000-8000-0000000000ff', body: 'orphan' },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(404)
    expect(
      await read(`SELECT id FROM public.lead_notes WHERE body = 'orphan'`),
    ).toHaveLength(0)
  })

  it('deletes a note, and 404s the second time', async () => {
    const created = await neonAddNote(
      request('activeMember'),
      { leadId: LEAD_IDS.notes, body: 'to be deleted' },
      { store, legacyProviderName: 'fixture' },
    )
    const noteId = ((await created.json()) as { note: { id: number } }).note.id

    const first = await neonDeleteNote(request('activeMember'), { noteId }, { store, legacyProviderName: 'fixture' })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, deleted: noteId })

    const second = await neonDeleteNote(request('activeMember'), { noteId }, { store, legacyProviderName: 'fixture' })
    expect(second.status).toBe(404)
  })
})

describe('set_gender: the override and its review row are one commit', () => {
  it('updates every row of the person and snapshots the prediction', async () => {
    const response = await neonSetGender(
      request('activeAdmin'),
      { leadId: LEAD_IDS.genderPrimary, gender: 'female' },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, gender: 'female', gender_confidence: 1 })

    // Keyed on (instance_id, profile_url), so the sibling row moves too.
    const leads = await read(
      `SELECT id, gender, gender_confidence, demo_model, gender_model_version
         FROM public.leads
        WHERE instance_id = $1 AND profile_url = $2
        ORDER BY id`,
      [WRITE_SCOPE, PROFILE_URLS.gender],
    )
    expect(leads).toHaveLength(2)
    for (const lead of leads) {
      expect(lead.gender).toBe('female')
      expect(lead.demo_model).toBe('manual')
      expect(lead.gender_model_version).toBeNull()
    }

    const reviews = await read(
      `SELECT action, predicted_gender, predicted_model, reviewed_gender, reviewer
         FROM public.lead_gender_reviews WHERE instance_id = $1`,
      [WRITE_SCOPE],
    )
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      action: 'set',
      predicted_gender: 'male',
      predicted_model: 'name-v1',
      reviewed_gender: 'female',
    })
  })

  it('records a null prediction when the previous value was already a human override', async () => {
    await neonSetGender(
      request('activeAdmin'),
      { leadId: LEAD_IDS.genderPrimary, gender: 'female' },
      { store, legacyProviderName: 'fixture' },
    )
    await neonSetGender(
      request('activeAdmin'),
      { leadId: LEAD_IDS.genderPrimary, gender: 'male' },
      { store, legacyProviderName: 'fixture' },
    )
    const reviews = await read(
      `SELECT predicted_gender, predicted_model FROM public.lead_gender_reviews
        WHERE instance_id = $1 ORDER BY id`,
      [WRITE_SCOPE],
    )
    expect(reviews).toHaveLength(2)
    expect(reviews[0]?.predicted_gender).toBe('male')
    // The second override had nothing to predict against: the value it replaced
    // was a human's. That is what keeps model precision measurable.
    expect(reviews[1]?.predicted_gender).toBeNull()
    expect(reviews[1]?.predicted_model).toBeNull()
  })

  it('clears the override without disturbing the age estimate', async () => {
    const response = await neonSetGender(
      request('activeAdmin'),
      { leadId: LEAD_IDS.genderPrimary, gender: null },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(200)
    const leads = await read(
      `SELECT gender, gender_confidence, demo_model, demo_inferred_at
         FROM public.leads WHERE id = $1`,
      [LEAD_IDS.genderPrimary],
    )
    expect(leads[0]?.gender).toBeNull()
    expect(leads[0]?.demo_model).toBeNull()
    const reviews = await read(
      `SELECT action FROM public.lead_gender_reviews WHERE instance_id = $1`,
      [WRITE_SCOPE],
    )
    expect(reviews[0]?.action).toBe('clear')
  })

  it('ROLLS THE OVERRIDE BACK when the review insert fails mid-transaction', async () => {
    const injected = storeWithFailingCommand(
      PIPELINE_WRITE_COMMANDS.appendGenderReview,
    )
    try {
      const response = await neonSetGender(
        request('activeAdmin'),
        { leadId: LEAD_IDS.genderPrimary, gender: 'female' },
        { store: injected, legacyProviderName: 'fixture' },
      )
      expect(response.status).toBe(500)
    } finally {
      await injected.close()
    }

    const leads = await read(
      `SELECT gender, demo_model FROM public.leads WHERE id = $1`,
      [LEAD_IDS.genderPrimary],
    )
    // Still the machine's answer. On the Supabase path this would be 'female'
    // with a 200 carrying `review_error`, and the audit row would be gone.
    expect(leads[0]?.gender).toBe('male')
    expect(leads[0]?.demo_model).toBe('name-v1')
    expect(
      await read(
        `SELECT id FROM public.lead_gender_reviews WHERE instance_id = $1`,
        [WRITE_SCOPE],
      ),
    ).toHaveLength(0)
  })
})

describe('set_instance_config', () => {
  it('writes the blob and stamps config_updated_at', async () => {
    const response = await neonSetInstanceConfig(
      request('activeAdmin'),
      { instanceId: WRITE_SCOPE, config: { sync_photos: true, batch: 25 } },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, instance_id: WRITE_SCOPE })

    const rows = await read(
      `SELECT config, config_updated_at FROM public.instances WHERE id = $1`,
      [WRITE_SCOPE],
    )
    expect(rows[0]?.config).toEqual({ sync_photos: true, batch: 25 })
    expect(rows[0]?.config_updated_at).not.toBeNull()
  })

  it('answers 404 for an unknown instance', async () => {
    const response = await neonSetInstanceConfig(
      request('activeAdmin'),
      { instanceId: 'no-such-notebook', config: {} },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(404)
  })
})

describe('conversation import: dedup by normalized body, never by the unique key', () => {
  it('skips a re-paste that differs only in whitespace and casing', async () => {
    // The synced row's `sent_at` is an LH2 action-run time; the paste carries the
    // real message time. So these are NOT the same row under
    // `messages_identity_key`, and only the normalized-body rule catches it.
    const response = await neonImportConversation(
      request('activeAdmin'),
      {
        instanceId: WRITE_SCOPE,
        campaignId: WRITE_CAMPAIGN_ID,
        profileUrl: PROFILE_URLS.import,
        messages: await importBlocks([
          {
            direction: 'in',
            body: `  ${PRE_EXISTING_INBOUND_BODY.toUpperCase()}\r\n  `,
            sent_at: '2026-01-09T17:22:00.000Z',
          },
        ]),
        normalize,
      },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, inserted: 0, skipped: 1 })

    const rows = await read(
      `SELECT id FROM public.messages WHERE instance_id = $1 AND profile_url = $2`,
      [WRITE_SCOPE, PROFILE_URLS.import],
    )
    // Still one. A run that deduped on the unique key would have two.
    expect(rows).toHaveLength(1)
  })

  it('inserts new blocks and backfills only the NULL milestones', async () => {
    const response = await neonImportConversation(
      request('activeAdmin'),
      {
        instanceId: WRITE_SCOPE,
        campaignId: WRITE_CAMPAIGN_ID,
        profileUrl: PROFILE_URLS.import,
        messages: await importBlocks([
          { direction: 'out', body: 'Opening note', sent_at: '2026-01-05T10:00:00.000Z' },
          { direction: 'in', body: 'Sounds good', sent_at: '2026-01-06T11:00:00.000Z' },
          { direction: 'out', body: 'Great, booking now', sent_at: '2026-01-07T12:00:00.000Z' },
        ]),
        normalize,
      },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, inserted: 3, skipped: 0 })
    expect(body.milestones).toEqual({
      replied_at: '2026-01-06T11:00:00.000Z',
      first_message_at: '2026-01-05T10:00:00.000Z',
      connected_at: '2026-01-05T10:00:00.000Z',
    })

    const lead = await read(
      `SELECT connected_at, first_message_at, replied_at, source_count
         FROM (SELECT l.connected_at, l.first_message_at, l.replied_at,
                      (SELECT count(*) FROM public.messages m
                        WHERE m.instance_id = l.instance_id
                          AND m.profile_url = l.profile_url) AS source_count
                 FROM public.leads l WHERE l.id = $1) s`,
      [LEAD_IDS.import],
    )
    expect(Number(lead[0]?.source_count)).toBe(4)
    expect(lead[0]?.replied_at).not.toBeNull()
  })

  it('never moves a milestone LH2 already recorded, even to an earlier instant', async () => {
    // The one property `COALESCE(column, $n)` exists for, and the one the
    // argument order decides. LH2 is ground truth for anything it captured: a
    // paste may FILL a NULL milestone and may never CHANGE a filled one, in
    // either direction. `leads_keep_milestones` only blocks non-NULL -> NULL, so
    // nothing but this statement's argument order stops an overwrite.
    const recorded = '2026-03-01T08:00:00.000Z'
    await fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, (client) =>
      client.query(
        `UPDATE public.leads
            SET replied_at = $2::timestamptz, first_message_at = $2::timestamptz,
                connected_at = $2::timestamptz
          WHERE id = $1`,
        [LEAD_IDS.import, recorded],
      ),
    )

    const response = await neonImportConversation(
      request('activeAdmin'),
      {
        instanceId: WRITE_SCOPE,
        campaignId: WRITE_CAMPAIGN_ID,
        profileUrl: PROFILE_URLS.import,
        messages: await importBlocks([
          // Both earlier than what is recorded, which is the direction a
          // "fill the earliest" rule would happily take.
          { direction: 'out', body: 'Much earlier note', sent_at: '2026-02-01T07:00:00.000Z' },
          { direction: 'in', body: 'Much earlier reply', sent_at: '2026-02-02T07:00:00.000Z' },
        ]),
        normalize,
      },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ inserted: 2 })
    // Nothing is reported as newly filled, because nothing was.
    expect(body.milestones).toBeUndefined()

    // `read` goes through the raw fixture client, which has no type parsers, so
    // these arrive as `Date` rather than as the driver's ISO strings.
    const lead = await read<Record<string, Date>>(
      `SELECT connected_at, first_message_at, replied_at FROM public.leads WHERE id = $1`,
      [LEAD_IDS.import],
    )
    expect({
      connected_at: lead[0]?.connected_at?.toISOString(),
      first_message_at: lead[0]?.first_message_at?.toISOString(),
      replied_at: lead[0]?.replied_at?.toISOString(),
    }).toEqual({
      connected_at: recorded,
      first_message_at: recorded,
      replied_at: recorded,
    })
  })

  it('is idempotent: the same paste twice inserts nothing the second time', async () => {
    const blocks = await importBlocks([
      { direction: 'out', body: 'Hello there', sent_at: '2026-02-01T10:00:00.000Z' },
      { direction: 'in', body: 'Hi back', sent_at: '2026-02-02T10:00:00.000Z' },
    ])
    const payload = {
      instanceId: WRITE_SCOPE,
      campaignId: WRITE_CAMPAIGN_ID,
      profileUrl: PROFILE_URLS.import,
      messages: blocks,
      normalize,
    }

    const first = await neonImportConversation(request('activeAdmin'), payload, {
      store,
      legacyProviderName: 'fixture',
    })
    expect(await first.json()).toMatchObject({ inserted: 2, skipped: 0 })

    const second = await neonImportConversation(request('activeAdmin'), payload, {
      store,
      legacyProviderName: 'fixture',
    })
    const body = (await second.json()) as Record<string, unknown>
    expect(body).toMatchObject({ inserted: 0, skipped: 2 })
    // The milestones were already filled, so nothing is reported as new — which
    // is what `COALESCE` buys over a JavaScript-built patch.
    expect(body.milestones).toBeUndefined()

    const rows = await read(
      `SELECT id FROM public.messages WHERE instance_id = $1 AND profile_url = $2`,
      [WRITE_SCOPE, PROFILE_URLS.import],
    )
    expect(rows).toHaveLength(3)
  })

  it('honours force for a legitimately repeated block', async () => {
    const response = await neonImportConversation(
      request('activeAdmin'),
      {
        instanceId: WRITE_SCOPE,
        campaignId: WRITE_CAMPAIGN_ID,
        profileUrl: PROFILE_URLS.import,
        messages: await importBlocks([
          {
            direction: 'in',
            body: PRE_EXISTING_INBOUND_BODY,
            sent_at: '2026-03-01T10:00:00.000Z',
            force: true,
          },
        ]),
        normalize,
      },
      { store, legacyProviderName: 'fixture' },
    )
    expect(await response.json()).toMatchObject({ inserted: 1, skipped: 0 })
  })

  it('refuses a lead whose instance does not match, before writing anything', async () => {
    const response = await neonImportConversation(
      request('activeAdmin'),
      {
        instanceId: 'some-other-notebook',
        campaignId: WRITE_CAMPAIGN_ID,
        profileUrl: PROFILE_URLS.import,
        messages: await importBlocks([
          { direction: 'in', body: 'nope', sent_at: '2026-04-01T10:00:00.000Z' },
        ]),
        normalize,
      },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(400)
    expect(
      await read(`SELECT id FROM public.messages WHERE body = 'nope'`),
    ).toHaveLength(0)
  })

  it('ROLLS THE MESSAGES BACK when the milestone backfill fails mid-transaction', async () => {
    const injected = storeWithFailingCommand(
      CONVERSATION_WRITE_COMMANDS.backfillMilestones,
    )
    try {
      const response = await neonImportConversation(
        request('activeAdmin'),
        {
          instanceId: WRITE_SCOPE,
          campaignId: WRITE_CAMPAIGN_ID,
          profileUrl: PROFILE_URLS.import,
          messages: await importBlocks([
            { direction: 'in', body: 'rolled back', sent_at: '2026-05-01T10:00:00.000Z' },
            { direction: 'out', body: 'also rolled back', sent_at: '2026-05-02T10:00:00.000Z' },
          ]),
          normalize,
        },
        { store: injected, legacyProviderName: 'fixture' },
      )
      // The Supabase path returns 200 with `milestone_error` here, having already
      // committed the messages — a replied lead with a NULL `replied_at`.
      expect(response.status).toBe(500)
    } finally {
      await injected.close()
    }

    const rows = await read(
      `SELECT id FROM public.messages WHERE instance_id = $1 AND profile_url = $2`,
      [WRITE_SCOPE, PROFILE_URLS.import],
    )
    expect(rows).toHaveLength(1)
    const lead = await read(
      `SELECT replied_at, first_message_at, connected_at FROM public.leads WHERE id = $1`,
      [LEAD_IDS.import],
    )
    expect(lead[0]?.replied_at).toBeNull()
    expect(lead[0]?.first_message_at).toBeNull()
    expect(lead[0]?.connected_at).toBeNull()
  })
})

describe('the thread lock', () => {
  it('serializes two concurrent imports of the same thread instead of doubling it', async () => {
    const blocks = await importBlocks([
      { direction: 'in', body: 'Concurrent block', sent_at: '2026-06-01T10:00:00.000Z' },
    ])
    const payload = {
      instanceId: WRITE_SCOPE,
      campaignId: WRITE_CAMPAIGN_ID,
      profileUrl: PROFILE_URLS.import,
      messages: blocks,
      normalize,
    }

    // Two pastes in flight at once. Without the advisory lock both read the same
    // pre-state and both insert, because the two rows differ on nothing the
    // unique key covers only when the instants differ — here they do not, so the
    // key would save us. The lock is what makes it safe when they do differ.
    const [first, second] = await Promise.all([
      neonImportConversation(request('activeAdmin'), payload, { store, legacyProviderName: 'fixture' }),
      neonImportConversation(request('activeAdmin'), payload, { store, legacyProviderName: 'fixture' }),
    ])

    const bodies = await Promise.all([first.json(), second.json()])
    const insertedTotal = bodies.reduce(
      (total, body) => total + Number((body as { inserted?: number }).inserted ?? 0),
      0,
    )
    // Exactly one of the two inserted it.
    expect(insertedTotal).toBe(1)

    const rows = await read(
      `SELECT id FROM public.messages
        WHERE instance_id = $1 AND profile_url = $2 AND body = 'Concurrent block'`,
      [WRITE_SCOPE, PROFILE_URLS.import],
    )
    expect(rows).toHaveLength(1)
  })

  it('serializes two concurrent pastes whose instants differ, which the unique key cannot', async () => {
    const payload = (sentAt: string) => async () => ({
      instanceId: WRITE_SCOPE,
      campaignId: WRITE_CAMPAIGN_ID,
      profileUrl: PROFILE_URLS.import,
      messages: await importBlocks([
        { direction: 'in', body: 'Parsed twice', sent_at: sentAt },
      ]),
      normalize,
    })

    // The same logical message, parsed to two different instants — exactly what
    // happens when the SDR pastes a thread twice and the parser resolves a
    // relative timestamp against two different clocks. `messages_identity_key`
    // does NOT collide on these.
    const [a, b] = await Promise.all([
      payload('2026-07-01T10:00:00.000Z')().then((input) =>
        neonImportConversation(request('activeAdmin'), input, { store, legacyProviderName: 'fixture' }),
      ),
      payload('2026-07-01T10:05:00.000Z')().then((input) =>
        neonImportConversation(request('activeAdmin'), input, { store, legacyProviderName: 'fixture' }),
      ),
    ])

    const bodies = await Promise.all([a.json(), b.json()])
    const insertedTotal = bodies.reduce(
      (total, body) => total + Number((body as { inserted?: number }).inserted ?? 0),
      0,
    )
    expect(insertedTotal).toBe(1)

    const rows = await read(
      `SELECT id FROM public.messages
        WHERE instance_id = $1 AND profile_url = $2 AND body = 'Parsed twice'`,
      [WRITE_SCOPE, PROFILE_URLS.import],
    )
    // One row. Without the lock this is 2, and the thread has a duplicate the
    // SDR has to find by eye.
    expect(rows).toHaveLength(1)
  })
})

describe('manual edit and delete', () => {
  async function importOne(body: string, sentAt: string): Promise<number> {
    await neonImportConversation(
      request('activeAdmin'),
      {
        instanceId: WRITE_SCOPE,
        campaignId: WRITE_CAMPAIGN_ID,
        profileUrl: PROFILE_URLS.import,
        messages: await importBlocks([{ direction: 'in', body, sent_at: sentAt }]),
        normalize,
      },
      { store, legacyProviderName: 'fixture' },
    )
    const rows = await read<{ id: string }>(
      `SELECT id::text AS id FROM public.messages
        WHERE instance_id = $1 AND profile_url = $2 AND body = $3`,
      [WRITE_SCOPE, PROFILE_URLS.import, body],
    )
    return Number(rows[0]?.id)
  }

  it('edits a manual message and recomputes its content hash', async () => {
    const id = await importOne('Original wording', '2026-08-01T10:00:00.000Z')
    const hash = await md5('Corrected wording')

    const response = await neonEditMessage(
      request('activeAdmin'),
      { messageId: id, body: 'Corrected wording', contentHash: hash },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      edited: id,
      body: 'Corrected wording',
    })

    const rows = await read(
      `SELECT body, content_hash, content_hash = md5(body) AS hash_matches
         FROM public.messages WHERE id = $1`,
      [id],
    )
    expect(rows[0]?.body).toBe('Corrected wording')
    expect(rows[0]?.hash_matches).toBe(true)
  })

  it('refuses to edit a synced row, and leaves it untouched', async () => {
    const synced = await read<{ id: string }>(
      `SELECT id::text AS id FROM public.messages
        WHERE instance_id = $1 AND source = 'sync'`,
      [WRITE_SCOPE],
    )
    const id = Number(synced[0]?.id)

    const response = await neonEditMessage(
      request('activeAdmin'),
      { messageId: id, body: 'tampered', contentHash: await md5('tampered') },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(404)

    const rows = await read(`SELECT body FROM public.messages WHERE id = $1`, [id])
    expect(rows[0]?.body).toBe(PRE_EXISTING_INBOUND_BODY)
  })

  it('deletes a manual message and repairs the milestones its import filled', async () => {
    const id = await importOne('The only inbound', '2026-09-01T10:00:00.000Z')

    const before = await read(
      `SELECT replied_at FROM public.leads WHERE id = $1`,
      [LEAD_IDS.import],
    )
    expect(before[0]?.replied_at).not.toBeNull()

    const response = await neonDeleteMessage(
      request('activeAdmin'),
      { messageId: id },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, deleted: id })
    expect(typeof body.milestones_recomputed).toBe('number')

    expect(await read(`SELECT id FROM public.messages WHERE id = $1`, [id])).toHaveLength(
      0,
    )
  })

  it('refuses to delete a synced row', async () => {
    const synced = await read<{ id: string }>(
      `SELECT id::text AS id FROM public.messages
        WHERE instance_id = $1 AND source = 'sync'`,
      [WRITE_SCOPE],
    )
    const id = Number(synced[0]?.id)

    const response = await neonDeleteMessage(
      request('activeAdmin'),
      { messageId: id },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(404)
    expect(await read(`SELECT id FROM public.messages WHERE id = $1`, [id])).toHaveLength(
      1,
    )
  })

  it('404s an unknown message id', async () => {
    const response = await neonDeleteMessage(
      request('activeAdmin'),
      { messageId: 2_147_483_600 },
      { store, legacyProviderName: 'fixture' },
    )
    expect(response.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------

/**
 * `conversations.applyFollowUpAction` is registered and **not routed** — the
 * roster wall (N-B2) blocks `p_owner_id` while reads stay on Supabase, so no
 * endpoint may reach it yet. That is precisely why it needs its own evidence:
 * an operation with no caller is an operation nothing proves, and the read
 * slice's unwired reads got the same treatment.
 *
 * It is driven through the store directly, because there is no handler to call.
 * The three properties below are the ones the spec's stopping conditions name,
 * and all three are the *function's* — this session ported nothing, it is
 * showing that step `003` still holds under `app_runtime` on Neon.
 */
describe('applyFollowUpAction: registered, unrouted, and proven anyway', () => {
  /** The fixture's own roster id — a bigint from *this* database, never a
   *  Supabase one. That distinction is the whole reason the family is unrouted. */
  async function activeOwnerId(): Promise<number> {
    const rows = await read<{ id: string }>(
      `SELECT id::text AS id FROM public.team_members WHERE active ORDER BY id LIMIT 1`,
    )
    return Number(rows[0]?.id)
  }

  /** Europe/Madrid, because that is the zone the function compares against. */
  async function dueDate(daysAhead: number): Promise<string> {
    const rows = await read<{ day: string }>(
      `SELECT ((now() AT TIME ZONE 'Europe/Madrid')::date + $1::int)::text AS day`,
      [daysAhead],
    )
    return String(rows[0]?.day)
  }

  function apply(params: Record<string, unknown>) {
    return store.transaction(
      { kind: 'user', actorId: CONTRACT_ACTORS.activeMember.actorId, tenantId: 'tenant-a', role: 'member' },
      (transaction) =>
        transaction.execute<Record<string, unknown>>({
          operation: CONVERSATION_WRITE_COMMANDS.applyFollowUpAction,
          params: params as never,
        }),
    )
  }

  const base = async () => ({
    instanceId: WRITE_SCOPE,
    profileUrl: PROFILE_URLS.stage,
    actor: 'S14 live suite',
    ownerId: await activeOwnerId(),
    nextFollowUpDate: await dueDate(3),
    reason: null,
  })

  it('applies a schedule, writing the state row and its event in one commit', async () => {
    const mutationId = '5a140000-0000-4000-8000-00000000f001'
    const result = await apply({
      ...(await base()),
      action: 'schedule',
      expectedRevision: 0,
      mutationId,
    })

    // The function answers `replayed: false` on a first apply rather than
    // omitting the key, so the replay test below compares against `true` and
    // not against presence.
    expect(result.replayed).toBe(false)
    expect(result.state).toMatchObject({ revision: 1 })

    const state = await read<{ revision: string; next_follow_up_date: string }>(
      `SELECT revision::text AS revision, next_follow_up_date::text AS next_follow_up_date
         FROM public.conversation_follow_up_state
        WHERE instance_id = $1 AND profile_url = $2`,
      [WRITE_SCOPE, PROFILE_URLS.stage],
    )
    expect(state).toHaveLength(1)
    expect(Number(state[0]?.revision)).toBe(1)

    const events = await read<{ event_kind: string }>(
      `SELECT event_kind FROM public.follow_up_events
        WHERE instance_id = $1 AND profile_url = $2`,
      [WRITE_SCOPE, PROFILE_URLS.stage],
    )
    expect(events).toEqual([{ event_kind: 'scheduled' }])
  })

  it('replays the same mutation_id instead of writing a second event', async () => {
    const mutationId = '5a140000-0000-4000-8000-00000000f002'
    const input = { ...(await base()), action: 'schedule', expectedRevision: 0, mutationId }

    const first = await apply(input)
    expect(first.replayed).toBe(false)

    // Identical inputs, identical mutation_id: the lost-response case.
    const second = await apply(input)
    expect(second.replayed).toBe(true)
    expect(second.mutation_revision).toBe(1)

    // And exactly one event exists, not two.
    expect(
      await read(`SELECT id FROM public.follow_up_events WHERE mutation_id = $1`, [
        mutationId,
      ]),
    ).toHaveLength(1)
    expect(
      (
        await read<{ revision: string }>(
          `SELECT revision::text AS revision FROM public.conversation_follow_up_state
            WHERE instance_id = $1 AND profile_url = $2`,
          [WRITE_SCOPE, PROFILE_URLS.stage],
        )
      )[0]?.revision,
    ).toBe('1')
  })

  it('refuses a stale expected_revision with 40001, changing nothing', async () => {
    const input = await base()
    await apply({
      ...input,
      action: 'schedule',
      expectedRevision: 0,
      mutationId: '5a140000-0000-4000-8000-00000000f003',
    })

    // Revision is now 1; a second caller still holding 0 must lose.
    await expect(
      apply({
        ...input,
        action: 'reschedule',
        nextFollowUpDate: await dueDate(5),
        expectedRevision: 0,
        mutationId: '5a140000-0000-4000-8000-00000000f004',
      }),
    ).rejects.toThrow(/FOLLOW_UP_CONFLICT/)

    const state = await read<{ revision: string; next_follow_up_date: string }>(
      `SELECT revision::text AS revision, next_follow_up_date::text AS next_follow_up_date
         FROM public.conversation_follow_up_state
        WHERE instance_id = $1 AND profile_url = $2`,
      [WRITE_SCOPE, PROFILE_URLS.stage],
    )
    expect(Number(state[0]?.revision)).toBe(1)
    expect(state[0]?.next_follow_up_date).toBe(await dueDate(3))
    expect(
      await read(`SELECT id FROM public.follow_up_events WHERE mutation_id = $1`, [
        '5a140000-0000-4000-8000-00000000f004',
      ]),
    ).toHaveLength(0)
  })

  it('refuses reusing a mutation_id with different inputs', async () => {
    const input = await base()
    const mutationId = '5a140000-0000-4000-8000-00000000f005'
    await apply({ ...input, action: 'schedule', expectedRevision: 0, mutationId })

    await expect(
      apply({
        ...input,
        action: 'schedule',
        expectedRevision: 0,
        mutationId,
        nextFollowUpDate: await dueDate(9),
      }),
    ).rejects.toThrow(/FOLLOW_UP_CONFLICT/)
  })
})

// ---------------------------------------------------------------------------

/**
 * The concurrency test `FOR UPDATE` was waiting for.
 *
 * Two stage moves of the **same lead**, deliberately overlapped: the first
 * store's `actorDisplayName` query is swapped for one that holds the
 * transaction open in `pg_sleep`, *after* the pre-read has taken its lock. So
 * the second call is guaranteed to arrive while the first is still open, which
 * is the window a wall-clock race would only sometimes hit.
 *
 * The assertion is not "the second one waited" — it is that the two audit rows
 * **chain**: the later event's `from_stage` is the earlier one's `to_stage`.
 * Without `FOR UPDATE` both would read `first_contact` and claim the same
 * origin, and the reconstructed history would fork.
 */
describe('set_stage: two concurrent moves of one lead', () => {
  /** A store whose actor-name read sleeps, holding the transaction open. */
  function slowStore(seconds: number) {
    const registry = buildApplicationRegistry()
    registry.registerQuery(PIPELINE_WRITE_OPERATIONS.actorDisplayName, {
      build: ({ params }) => ({
        text: `SELECT tm.name
                 FROM public.team_members tm, pg_sleep(${seconds})
                WHERE tm.user_id = $1::uuid AND tm.active`,
        values: [(params as { actorId?: string })?.actorId ?? ''],
      }),
      mapRow: (row) => ({ name: String(row.name) }),
    })
    return new NeonDataStore({
      connectionString: connection.pooled,
      operations: registry,
      statementTimeoutMs: 8_000,
      maxConnections: 2,
      applicationName: 's14-write-slice-slow',
    })
  }

  it('chains the audit rows instead of forking them', async () => {
    const slow = slowStore(1)
    try {
      // Warm the new pool first. Without this the race is decided by whose TLS
      // handshake finishes, and the file passes or fails depending on whether
      // the other store's pool is already open -- which is exactly the kind of
      // timing-dependent test this one exists to replace.
      await slow.transaction(
        { kind: 'user', actorId: CONTRACT_ACTORS.activeMember.actorId, tenantId: 'tenant-a', role: 'member' },
        (transaction) =>
          transaction.query({
            operation: PIPELINE_WRITE_OPERATIONS.leadPipelineFields,
            params: { leadId: LEAD_IDS.notes },
            page: { limit: 1 },
          }),
      )

      const first = neonSetStage(
        request('activeMember'),
        { leadId: LEAD_IDS.stage, stage: 'interested', substatus: null, lostReason: null },
        { store: slow, legacyProviderName: 'fixture' },
      )
      // Long enough for `first` to have taken the row lock and entered the
      // sleep, short enough to be inside it.
      await new Promise((resolve) => setTimeout(resolve, 300))
      const second = neonSetStage(
        request('activeMember'),
        { leadId: LEAD_IDS.stage, stage: 'call_booked', substatus: null, lostReason: null },
        { store, legacyProviderName: 'fixture' },
      )

      const [a, b] = await Promise.all([first, second])
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)

      const events = await read<{ from_stage: string | null; to_stage: string | null }>(
        `SELECT from_stage, to_stage FROM public.pipeline_events
          WHERE lead_id = $1 ORDER BY id`,
        [LEAD_IDS.stage],
      )
      // Asserted as a *chain*, not as a fixed order: which of the two wins the
      // lock is legitimately undecided, and pinning it would be testing the
      // scheduler. What must hold is that the second one's origin is the first
      // one's destination -- without FOR UPDATE both read `first_contact` and
      // the reconstructed history forks.
      expect(events).toHaveLength(2)
      expect(events[0]?.from_stage).toBe('first_contact')
      expect(events[1]?.from_stage).toBe(events[0]?.to_stage)
      expect(new Set(events.map((event) => event.to_stage))).toEqual(
        new Set(['interested', 'call_booked']),
      )
      expect(
        (
          await read<{ pipeline_stage: string }>(
            `SELECT pipeline_stage FROM public.leads WHERE id = $1`,
            [LEAD_IDS.stage],
          )
        )[0]?.pipeline_stage,
      ).toBe(events[1]?.to_stage)
    } finally {
      await slow.close()
    }
  }, 30_000)
})
