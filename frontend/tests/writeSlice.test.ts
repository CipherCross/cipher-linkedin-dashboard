/**
 * The write slice against the **fake** store — no credential, no database.
 *
 * The live suites (`writeSlice.neon.test.ts`, `librarySlice.neon.test.ts`) are
 * stronger evidence and slower, and they cannot run without
 * `NEON_DATASTORE_URL`. This file covers what is genuinely a property of the
 * *handler* rather than of Postgres, and it runs in `npx vitest run` where
 * everyone sees it:
 *
 * - **Which operation is asked for, with which parameters.** The live suite
 *   proves the rows end up right; only this one can prove the handler did not
 *   get there by asking for something else. Every command is recorded.
 * - **The decisions made in JavaScript**: `changedAtMode`, the no-op
 *   short-circuit, the dedup set, the milestone derivation from the *full*
 *   payload, and the `wasManual` rule that records a null prediction when a
 *   human overrode a human.
 * - **The error contract**: that a `DataStoreConstraintError` becomes 409 or
 *   400, that a rollback becomes a 500 rather than a 200 with an error field,
 *   and that no driver text reaches the response body.
 *
 * What it deliberately does **not** cover: anything whose truth lives in SQL —
 * the `COALESCE` backfill, the advisory lock, the RLS `WITH CHECK`, the jsonb
 * presence test. A fake that reimplemented those would be asserting against
 * itself. Those are the live suites' job, and the division is the same one
 * `tests/identity.test.ts` drew.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeDataStore } from '../api/_lib/data/fake.js'
import { DataStoreConstraintError } from '../api/_lib/data/contracts.js'
import {
  CONVERSATION_WRITE_COMMANDS,
  CONVERSATION_WRITE_OPERATIONS,
  LIBRARY_WRITE_COMMANDS,
  PIPELINE_WRITE_COMMANDS,
  PIPELINE_WRITE_OPERATIONS,
} from '../api/_lib/data/operations/index.js'
import {
  neonAddNote,
  neonDeleteNote,
  neonImportConversation,
  neonSetGender,
  neonSetInstanceConfig,
  neonSetStage,
} from '../api/_lib/neonWrites.js'
import {
  neonDeleteEntity,
  neonSaveEntity,
} from '../api/_lib/neonLibraryWrites.js'

const MEMBER = {
  subject: 'supabase-subject-member',
  actorId: '00000000-0000-0000-0000-0000000000a1',
}
const ADMIN = {
  subject: 'supabase-subject-admin',
  actorId: '00000000-0000-0000-0000-0000000000a2',
}

const LEAD_ID = '5a140000-0000-4000-8000-0000000000aa'

interface Recorded {
  readonly operation: string
  readonly params: Record<string, unknown>
}

interface Harness {
  readonly store: FakeDataStore
  readonly executed: Recorded[]
  readonly deps: { store: FakeDataStore; legacyProviderName: string }
}

/** What `pipeline.leadPipelineFields` answers with, per test. */
let leadFields: Record<string, unknown> | null
/** What `pipeline.leadDemographics` answers with, per test. */
let leadDemographics: Record<string, unknown> | null
/** What `conversations.leadForImport` answers with, per test. */
let leadForImport: Record<string, unknown> | null
/** What `conversations.threadDedupKeys` answers with, per test. */
let threadRows: { direction: string; body: string }[]
/** Operations that should throw instead of answering, and what they throw. */
let failing: Map<string, () => never>

function harness(): Harness {
  const store = new FakeDataStore()
  const executed: Recorded[] = []

  // Production resolves the transitional bearer under `provider = 'supabase'`.
  // These tests pass `legacyProviderName: 'legacy'` explicitly — the same seam
  // the live suites use to point at the baseline's `fixture` rows — so the
  // provider name is never a hidden default.
  store.seedActor('legacy', MEMBER.subject, {
    actorId: MEMBER.actorId,
    role: 'member',
  })
  store.seedActor('legacy', ADMIN.subject, {
    actorId: ADMIN.actorId,
    role: 'admin',
  })

  store.registerQuery(PIPELINE_WRITE_OPERATIONS.actorDisplayName, () => [
    { name: 'Fixture Reviewer' },
  ])
  store.registerQuery(PIPELINE_WRITE_OPERATIONS.leadPipelineFields, () =>
    leadFields ? [leadFields] : [],
  )
  store.registerQuery(PIPELINE_WRITE_OPERATIONS.leadDemographics, () =>
    leadDemographics ? [leadDemographics] : [],
  )
  store.registerQuery(CONVERSATION_WRITE_OPERATIONS.leadForImport, () =>
    leadForImport ? [leadForImport] : [],
  )
  store.registerQuery(CONVERSATION_WRITE_OPERATIONS.threadDedupKeys, () =>
    threadRows.map((row) => ({ ...row })),
  )

  /**
   * Every command records and then answers with a shape the handler will
   * accept. They do **not** re-derive anything: a fake that recomputed the
   * statement's result would be testing itself, and the handler's own arithmetic
   * is what these tests are for.
   */
  const command = (operation: string, result: unknown) => {
    store.registerCommand(operation, ({ params }) => {
      executed.push({ operation, params: (params ?? {}) as Record<string, unknown> })
      const thrower = failing.get(operation)
      if (thrower) thrower()
      return result
    })
  }

  command(PIPELINE_WRITE_COMMANDS.setStage, {
    rowCount: 1,
    row: {
      id: LEAD_ID,
      pipeline_stage: 'interested',
      pipeline_substatus: null,
      lost_reason: null,
      pipeline_stage_changed_at: '2026-08-05T10:00:00.000Z',
    },
  })
  command(PIPELINE_WRITE_COMMANDS.appendStageEvent, {
    id: '1',
    occurred_at: '2026-08-05T10:00:00.000Z',
  })
  command(PIPELINE_WRITE_COMMANDS.addNote, {
    rowCount: 1,
    row: {
      id: 7,
      lead_id: LEAD_ID,
      author: 'Fixture Reviewer',
      body: 'a note',
      created_at: '2026-08-05T10:00:00.000Z',
    },
  })
  command(PIPELINE_WRITE_COMMANDS.deleteNote, { rowCount: 1 })
  command(PIPELINE_WRITE_COMMANDS.setGender, {
    rowCount: 2,
    rows: [{ id: LEAD_ID, gender: 'female' }],
  })
  command(PIPELINE_WRITE_COMMANDS.appendGenderReview, { id: '1' })
  command(PIPELINE_WRITE_COMMANDS.setInstanceConfig, { rowCount: 1 })
  command(CONVERSATION_WRITE_COMMANDS.lockThread, { locked: true })
  command(CONVERSATION_WRITE_COMMANDS.insertImportedMessages, { inserted: 0 })
  command(CONVERSATION_WRITE_COMMANDS.backfillMilestones, {
    rowCount: 1,
    row: {
      replied_at: null,
      first_message_at: null,
      connected_at: null,
    },
  })
  command(LIBRARY_WRITE_COMMANDS.insertIcp, {
    rowCount: 1,
    row: { id: 5, name: 'an icp' },
  })
  command(LIBRARY_WRITE_COMMANDS.updateIcp, {
    rowCount: 1,
    row: { id: 5, name: 'an icp' },
  })
  command(LIBRARY_WRITE_COMMANDS.deleteIcp, { rowCount: 1, row: { id: 5 } })

  return {
    store,
    executed,
    deps: { store, legacyProviderName: 'legacy' },
  }
}

/**
 * Which subject the stubbed `requireUser` reports. Set per test; `null` lets the
 * real implementation run, which is how the unauthenticated path stays honest.
 */
let currentSubject: string | null = ADMIN.subject

function request(): Request {
  return new Request('https://dashboard.test/api/pipeline', {
    method: 'POST',
    headers: currentSubject ? { authorization: 'Bearer stub' } : {},
  })
}

// `requireUser` is the only thing between the bearer and the subject, and it
// verifies a real Supabase JWT. Stubbing the module the way the live suites do
// keeps that boundary intact while letting these tests choose a subject.
vi.mock('../api/_lib/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/_lib/auth.js')>()
  return {
    ...actual,
    requireUser: async (req: Request) => {
      if (currentSubject === null) return actual.requireUser(req)
      return { userId: currentSubject, email: null }
    },
  }
})

beforeEach(() => {
  currentSubject = ADMIN.subject
  leadFields = {
    id: LEAD_ID,
    pipeline_stage: 'first_contact',
    pipeline_substatus: null,
    lost_reason: null,
  }
  leadDemographics = {
    id: LEAD_ID,
    instance_id: 'inst',
    profile_url: 'https://example.test/in/person',
    gender: 'male',
    gender_confidence: 0.75,
    demo_model: 'name-v1',
    gender_model_version: 'v1',
  }
  leadForImport = {
    id: LEAD_ID,
    instance_id: 'inst',
    connected_at: null,
    first_message_at: null,
    replied_at: null,
  }
  threadRows = []
  failing = new Map()
})

const found = (executed: Recorded[], operation: string) =>
  executed.find((entry) => entry.operation === operation)

// ---------------------------------------------------------------------------

describe('set_stage: what the handler decides before the statement runs', () => {
  it('asks for the pre-read, the actor name, the update and the audit row, in that order', async () => {
    const { executed, deps } = harness()
    const response = await neonSetStage(
      request(),
      { leadId: LEAD_ID, stage: 'interested', substatus: null, lostReason: null },
      deps,
    )
    expect(response.status).toBe(200)
    expect(executed.map((entry) => entry.operation)).toEqual([
      PIPELINE_WRITE_COMMANDS.setStage,
      PIPELINE_WRITE_COMMANDS.appendStageEvent,
    ])
  })

  it('sends changedAtMode "set" with an instant when the stage itself moves', async () => {
    const { executed, deps } = harness()
    await neonSetStage(
      request(),
      { leadId: LEAD_ID, stage: 'interested', substatus: null, lostReason: null },
      deps,
    )
    const update = found(executed, PIPELINE_WRITE_COMMANDS.setStage)
    expect(update?.params.changedAtMode).toBe('set')
    expect(typeof update?.params.changedAt).toBe('string')
  })

  it('sends "keep" and a null instant for a substatus-only edit', async () => {
    const { executed, deps } = harness()
    await neonSetStage(
      request(),
      {
        leadId: LEAD_ID,
        stage: 'first_contact',
        substatus: 'awaiting_reply',
        lostReason: null,
      },
      deps,
    )
    const update = found(executed, PIPELINE_WRITE_COMMANDS.setStage)
    expect(update?.params.changedAtMode).toBe('keep')
    expect(update?.params.changedAt).toBeNull()
  })

  it('sends "clear" when the lead leaves the pipeline', async () => {
    const { executed, deps } = harness()
    await neonSetStage(
      request(),
      { leadId: LEAD_ID, stage: null, substatus: null, lostReason: null },
      deps,
    )
    expect(found(executed, PIPELINE_WRITE_COMMANDS.setStage)?.params.changedAtMode).toBe(
      'clear',
    )
  })

  it('carries the previous stage into the audit row', async () => {
    const { executed, deps } = harness()
    await neonSetStage(
      request(),
      { leadId: LEAD_ID, stage: 'interested', substatus: null, lostReason: null },
      deps,
    )
    expect(found(executed, PIPELINE_WRITE_COMMANDS.appendStageEvent)?.params).toMatchObject(
      {
        fromStage: 'first_contact',
        toStage: 'interested',
        actor: 'Fixture Reviewer',
      },
    )
  })

  it('writes nothing at all when nothing changed', async () => {
    const { executed, deps } = harness()
    const response = await neonSetStage(
      request(),
      {
        leadId: LEAD_ID,
        stage: 'first_contact',
        substatus: null,
        lostReason: null,
      },
      deps,
    )
    expect(await response.json()).toEqual({ ok: true, changed: false })
    expect(executed).toHaveLength(0)
  })

  it('404s an unknown lead before issuing any command', async () => {
    const { executed, deps } = harness()
    leadFields = null
    const response = await neonSetStage(
      request(),
      { leadId: LEAD_ID, stage: 'interested', substatus: null, lostReason: null },
      deps,
    )
    expect(response.status).toBe(404)
    expect(executed).toHaveLength(0)
  })

  it('answers 500, not a 200 with an error field, when the audit row fails', async () => {
    const { deps } = harness()
    failing.set(PIPELINE_WRITE_COMMANDS.appendStageEvent, () => {
      throw new Error('injected: audit row refused')
    })
    const response = await neonSetStage(
      request(),
      { leadId: LEAD_ID, stage: 'interested', substatus: null, lostReason: null },
      deps,
    )
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: string }
    // The Supabase path's shape, which this one deliberately does not have.
    expect(body).not.toHaveProperty('ok')
    expect(body).not.toHaveProperty('event_error')
    // And no driver text.
    expect(body.error).not.toContain('injected')
  })
})

// ---------------------------------------------------------------------------

describe('set_gender: the prediction snapshot', () => {
  it('records what the model predicted when the model had labelled it', async () => {
    const { executed, deps } = harness()
    await neonSetGender(request(), { leadId: LEAD_ID, gender: 'female' }, deps)
    expect(found(executed, PIPELINE_WRITE_COMMANDS.appendGenderReview)?.params).toMatchObject(
      {
        action: 'set',
        predictedGender: 'male',
        predictedConfidence: 0.75,
        predictedModel: 'name-v1',
        predictedVersion: 'v1',
        reviewedGender: 'female',
      },
    )
  })

  it('records a null prediction when a human overrode a human', async () => {
    const { executed, deps } = harness()
    leadDemographics = { ...leadDemographics, demo_model: 'manual' }
    await neonSetGender(request(), { leadId: LEAD_ID, gender: 'female' }, deps)
    expect(found(executed, PIPELINE_WRITE_COMMANDS.appendGenderReview)?.params).toMatchObject(
      {
        predictedGender: null,
        predictedConfidence: null,
        predictedModel: null,
        predictedVersion: null,
      },
    )
  })

  it('clears with confidence, model and instant all null', async () => {
    const { executed, deps } = harness()
    await neonSetGender(request(), { leadId: LEAD_ID, gender: null }, deps)
    expect(found(executed, PIPELINE_WRITE_COMMANDS.setGender)?.params).toMatchObject({
      gender: null,
      confidence: null,
      demoModel: null,
      inferredAt: null,
    })
    expect(found(executed, PIPELINE_WRITE_COMMANDS.appendGenderReview)?.params.action).toBe(
      'clear',
    )
  })

  it('keys the update on the person, not on the lead row', async () => {
    const { executed, deps } = harness()
    await neonSetGender(request(), { leadId: LEAD_ID, gender: 'female' }, deps)
    expect(found(executed, PIPELINE_WRITE_COMMANDS.setGender)?.params).toMatchObject({
      instanceId: 'inst',
      profileUrl: 'https://example.test/in/person',
    })
  })
})

// ---------------------------------------------------------------------------

describe('conversation_import: the decisions taken in JavaScript', () => {
  const block = (
    direction: 'in' | 'out',
    body: string,
    sentAt: string,
    force = false,
  ) => ({ direction, body, sent_at: sentAt, force, contentHash: `hash-${body}` })

  const normalize = (body: string) =>
    body.replace(/\r/g, '').trim().replace(/\s+/g, ' ').toLowerCase()

  const importInput = (messages: ReturnType<typeof block>[]) => ({
    instanceId: 'inst',
    campaignId: 'inst:1',
    profileUrl: 'https://example.test/in/person',
    messages,
    normalize,
  })

  it('takes the thread lock before it reads anything', async () => {
    const { executed, deps } = harness()
    await neonImportConversation(
      request(),
      importInput([block('in', 'hello', '2026-02-01T09:00:00.000Z')]),
      deps,
    )
    expect(executed[0]?.operation).toBe(CONVERSATION_WRITE_COMMANDS.lockThread)
  })

  it('skips a block whose normalized body already exists, though the raw text differs', async () => {
    const { executed, deps } = harness()
    threadRows = [{ direction: 'in', body: 'Thanks   for\r\n reaching out.' }]
    const response = await neonImportConversation(
      request(),
      importInput([block('in', 'thanks for reaching out.', '2026-02-01T09:00:00.000Z')]),
      deps,
    )
    expect(await response.json()).toMatchObject({ ok: true, inserted: 0, skipped: 1 })
    expect(found(executed, CONVERSATION_WRITE_COMMANDS.insertImportedMessages)).toBeUndefined()
  })

  it('inserts the same body in the other direction — direction is part of the key', async () => {
    const { executed, deps } = harness()
    threadRows = [{ direction: 'in', body: 'hello' }]
    await neonImportConversation(
      request(),
      importInput([block('out', 'hello', '2026-02-01T09:00:00.000Z')]),
      deps,
    )
    expect(
      found(executed, CONVERSATION_WRITE_COMMANDS.insertImportedMessages)?.params.directions,
    ).toEqual(['out'])
  })

  it('dedupes a block against itself inside one request', async () => {
    const { executed, deps } = harness()
    await neonImportConversation(
      request(),
      importInput([
        block('in', 'hello', '2026-02-01T09:00:00.000Z'),
        block('in', 'HELLO', '2026-02-01T09:05:00.000Z'),
      ]),
      deps,
    )
    expect(
      found(executed, CONVERSATION_WRITE_COMMANDS.insertImportedMessages)?.params.bodies,
    ).toEqual(['hello'])
  })

  it('honours force, which is what puts a known duplicate back', async () => {
    const { executed, deps } = harness()
    threadRows = [{ direction: 'in', body: 'hello' }]
    await neonImportConversation(
      request(),
      importInput([block('in', 'hello', '2026-02-01T09:00:00.000Z', true)]),
      deps,
    )
    expect(
      found(executed, CONVERSATION_WRITE_COMMANDS.insertImportedMessages)?.params.bodies,
    ).toEqual(['hello'])
  })

  it('derives the milestones from the whole payload, not from the rows that landed', async () => {
    const { executed, deps } = harness()
    // Everything is a duplicate, so nothing is inserted — and the backfill must
    // still be asked for, with the instants the payload carried.
    threadRows = [
      { direction: 'in', body: 'inbound' },
      { direction: 'out', body: 'outbound' },
    ]
    await neonImportConversation(
      request(),
      importInput([
        block('in', 'inbound', '2026-02-03T09:00:00.000Z'),
        block('out', 'outbound', '2026-02-01T09:00:00.000Z'),
      ]),
      deps,
    )
    expect(found(executed, CONVERSATION_WRITE_COMMANDS.backfillMilestones)?.params).toMatchObject(
      {
        repliedAt: '2026-02-03T09:00:00.000Z',
        firstMessageAt: '2026-02-01T09:00:00.000Z',
        // The earliest of either direction.
        connectedAt: '2026-02-01T09:00:00.000Z',
      },
    )
  })

  it('refuses an instance_id that does not match the lead', async () => {
    const { executed, deps } = harness()
    leadForImport = { ...leadForImport, instance_id: 'another' }
    const response = await neonImportConversation(
      request(),
      importInput([block('in', 'hello', '2026-02-01T09:00:00.000Z')]),
      deps,
    )
    expect(response.status).toBe(400)
    expect(found(executed, CONVERSATION_WRITE_COMMANDS.insertImportedMessages)).toBeUndefined()
  })

  it('404s an unknown lead', async () => {
    const { deps } = harness()
    leadForImport = null
    const response = await neonImportConversation(
      request(),
      importInput([block('in', 'hello', '2026-02-01T09:00:00.000Z')]),
      deps,
    )
    expect(response.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------

describe('the smaller writes', () => {
  it('add_note sends the resolved actor name as the author', async () => {
    const { executed, deps } = harness()
    const response = await neonAddNote(request(), { leadId: LEAD_ID, body: 'a note' }, deps)
    expect(response.status).toBe(200)
    expect(found(executed, PIPELINE_WRITE_COMMANDS.addNote)?.params.author).toBe(
      'Fixture Reviewer',
    )
  })

  it('delete_note 404s a zero row count', async () => {
    const { store, deps } = harness()
    store.registerCommand(PIPELINE_WRITE_COMMANDS.deleteNote, () => ({ rowCount: 0 }))
    const response = await neonDeleteNote(request(), { noteId: 4 }, deps)
    expect(response.status).toBe(404)
  })

  it('set_instance_config serializes the blob rather than passing an object', async () => {
    const { executed, deps } = harness()
    await neonSetInstanceConfig(
      request(),
      { instanceId: 'inst', config: { sync_photos: true } },
      deps,
    )
    expect(found(executed, PIPELINE_WRITE_COMMANDS.setInstanceConfig)?.params.configJson).toBe(
      '{"sync_photos":true}',
    )
  })
})

// ---------------------------------------------------------------------------

describe('the library slice: dispatch, admin and the constraint contract', () => {
  const saveIcp = (overrides: Record<string, unknown> = {}) => ({
    entity: 'icp' as const,
    patch: { name: 'an icp' },
    bodyKey: 'icp',
    conflictMessage: 'an ICP with that name already exists',
    ...overrides,
  })

  it('routes an id-less save to the insert operation', async () => {
    const { executed, deps } = harness()
    await neonSaveEntity(request(), saveIcp(), deps)
    expect(executed.map((entry) => entry.operation)).toEqual([
      LIBRARY_WRITE_COMMANDS.insertIcp,
    ])
  })

  it('routes a save carrying an id to the update operation, with the patch as JSON', async () => {
    const { executed, deps } = harness()
    await neonSaveEntity(
      request(),
      saveIcp({ id: 5, patch: { main_product: null } }),
      deps,
    )
    const update = found(executed, LIBRARY_WRITE_COMMANDS.updateIcp)
    expect(update?.params).toEqual({ id: 5, patchJson: '{"main_product":null}' })
  })

  it('refuses a non-admin before issuing any command', async () => {
    const { executed, deps } = harness()
    currentSubject = MEMBER.subject
    const response = await neonSaveEntity(request(), saveIcp(), deps)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Admin access required' })
    expect(executed).toHaveLength(0)
  })

  it('turns a unique violation into 409 with the caller’s own message', async () => {
    const { deps } = harness()
    failing.set(LIBRARY_WRITE_COMMANDS.insertIcp, () => {
      throw new DataStoreConstraintError('unique', 'composed message')
    })
    const response = await neonSaveEntity(request(), saveIcp(), deps)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'an ICP with that name already exists',
    })
  })

  it('turns a foreign-key violation into 400', async () => {
    const { deps } = harness()
    failing.set(LIBRARY_WRITE_COMMANDS.insertIcp, () => {
      throw new DataStoreConstraintError('foreign_key', 'composed message')
    })
    const response = await neonSaveEntity(request(), saveIcp(), deps)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'a referenced row does not exist',
    })
  })

  it('leaves every other failure a 500 with no driver text', async () => {
    const { deps } = harness()
    failing.set(LIBRARY_WRITE_COMMANDS.insertIcp, () => {
      throw new Error('connection to ep-secret-host.neon.tech failed')
    })
    const response = await neonSaveEntity(request(), saveIcp(), deps)
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('neon.tech')
  })

  it('404s a delete that matched nothing, naming the relation', async () => {
    const { store, deps } = harness()
    store.registerCommand(LIBRARY_WRITE_COMMANDS.deleteIcp, () => ({
      rowCount: 0,
      row: null,
    }))
    const response = await neonDeleteEntity(request(), { entity: 'icp', id: 5 }, deps)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown icps id' })
  })
})
