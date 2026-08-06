/**
 * The live proofs of ledger step 007 — the `app_system` write path.
 *
 * `aiStore.neon.test.ts` proved the AI store's *principal* contract: who may
 * reach the guard, and that the guard is SELECT-only. This file proves the
 * thing step 007 added and nothing before it could: that `app_system` may now
 * change rows in exactly five relations, that the actor gate in front of them
 * is load-bearing rather than ceremonial, and that everything the step did NOT
 * open is still shut. Until this file ran, all of that existed only as SQL in a
 * ledger artifact and as unit tests against fakes.
 *
 * ## What runs as what
 *
 * - The **subject** is the production AI store — `getAiDataStore()`, built from
 *   `buildAiStoreConfig()`, connected with `NEON_AI_DATABASE_URL` and entering
 *   `app_system` on every transaction. Probe stores below are built from the
 *   *same* config with a widened registry, so the principal under test is never
 *   a different principal wearing its name.
 * - The **fixture** runs on the runtime credential as an active member, through
 *   `NeonFixtureClient`, for a reason the fixture module states: `app_system`
 *   holds no `DELETE` anywhere, so it cannot clean up after itself, and giving
 *   it that grant to make the suite convenient would delete the property the
 *   suite exists to measure.
 *
 * ## Two things this file deliberately does not do
 *
 * It never invokes a cron handler end to end — not `notify-replies.ts`, not
 * `classify.ts`'s GET, not `briefing.ts`'s GET. Every one of them acts on what
 * an *unscoped* backlog read returns: the notifier would claim and announce
 * real replies to Slack, the classifier would send real conversations to
 * Anthropic and stamp real rows, and the briefing would generate and post a
 * real briefing. On a project holding real tenant data none of that is a test.
 * So the endpoints' operations are driven through the store with explicit
 * fixture ids and fixture keys, and the handlers' own composition — which
 * provider is chosen, what the response body says — stays covered by the unit
 * tests in `aiSlice.test.ts`. That is a real gap and it is named here rather
 * than papered over.
 *
 * And it asserts refusals **by class**, never by message: `42501` arrives as
 * `DataStoreAuthorizationError` and that is what is checked, because driver text
 * is not stable and must not appear in a test expectation any more than in a
 * log.
 *
 * ## RLS refuses reads and writes in two different shapes
 *
 * Worth stating once, because half the assertions below depend on it. A policy
 * that does not match makes rows *invisible*: a SELECT returns zero rows and an
 * UPDATE reports zero rows changed — neither raises. Only a `WITH CHECK`
 * violation (an INSERT, or an UPDATE whose new row leaves the policy) raises
 * `42501`. So "the gate refused it" is measured as *the row did not change*
 * where the statement is a read or an update, and as an authorization error
 * where it is an insert. Both are failures closed; they simply are not the same
 * failure, and a test that expected a throw from a denied UPDATE would be
 * testing PostgreSQL wrongly and passing for the wrong reason.
 */

import type { PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  buildAiStoreConfig,
  getAiDataStore,
  resetAiDataStore,
  SYSTEM_ACTOR,
} from '../api/_lib/data/aiStore.js'
import {
  DataStoreAuthorizationError,
  MAX_PAGE_SIZE,
  type ActorContext,
  type Page,
} from '../api/_lib/data/contracts.js'
import {
  NeonDataStore,
  type NeonOperationRegistry,
} from '../api/_lib/data/neon.js'
import { readNeonAiConnectionString } from '../api/_lib/data/neonConfig.js'
import {
  AI_OPERATIONS,
  buildAiRegistry,
} from '../api/_lib/data/operations/ai.js'
import {
  firstGuardResult,
  SYSTEM_OPERATIONS,
  type ClaimedMessageRow,
  type NotifyCandidateRow,
  type NotifyLeadRow,
} from '../api/_lib/data/operations/aiSystem.js'
import {
  AI_WRITE_OPERATIONS,
  type BriefingJobRowShape,
  type EntityWriteResult,
  type GenderBatchRow,
  type PendingReplyRow,
  type PriorBriefingRow,
  type SavedSearchRow,
  type ThreadContextRow,
} from '../api/_lib/data/operations/index.js'
import { CONTRACT_ACTORS } from './support/dataStoreContract.js'
import {
  dropAiSystemFixture,
  readNotifiedAt,
  seedAiSystemFixture,
  SYSTEM_ANNOTATION_NOTE,
  SYSTEM_BRIEFING_DATE,
  SYSTEM_CAMPAIGN_ID,
  SYSTEM_HYPOTHESIS_NAME,
  SYSTEM_LEAD_NAME,
  SYSTEM_PRIOR_BRIEFING_DATE,
  SYSTEM_PROFILE_URL,
  SYSTEM_REPLY_BODIES,
  SYSTEM_SCOPE,
  SYSTEM_SEARCH_NAME,
  SYSTEM_SEARCH_PLATFORM,
} from './support/aiSystemFixture.js'
import {
  NeonFixtureClient,
  requireNeonTestConnection,
} from './support/neonContractHarness.js'

/**
 * Both credentials are required, and both fail the file at import if absent.
 *
 * The AI one is no longer conditional. `aiStore.neon.test.ts` skips without it
 * because when that file was written the owner action was pending; step 007 is
 * applied, so an absent `NEON_AI_DATABASE_URL` here is a missing source, and a
 * green suite that touched no database is worse than a red one.
 */
const connection = requireNeonTestConnection()
readNeonAiConnectionString()

const fixtures = new NeonFixtureClient(connection.direct)

/** Out-of-band, on the runtime credential as an active member. */
function outOfBand<TResult>(
  work: (client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
  return fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, work)
}

/** The production AI store, narrowed to the driver type the probes reuse. */
const ai = () => getAiDataStore() as NeonDataStore

/**
 * A store that is the AI store in every respect that matters — same credential,
 * same unconditional `SET LOCAL ROLE app_system`, same transaction timeout —
 * with extra operations registered, so a statement the application would never
 * issue can still be put to the database. That is the only honest way to ask
 * "what happens if `app_system` tries X" for an X the registry deliberately has
 * no entry for. Note what is NOT overridden: the connection string. A probe
 * that reached for a different credential would be measuring a different
 * principal and saying nothing about this one.
 */
function probeStore(
  register: (registry: NeonOperationRegistry) => void,
  applicationName: string,
): NeonDataStore {
  const registry = buildAiRegistry()
  register(registry)
  return new NeonDataStore({
    ...buildAiStoreConfig(),
    operations: registry,
    applicationName,
  })
}

/** One guard call, returning the aggregate's rows. */
async function guard(
  store: NeonDataStore,
  query: string,
): Promise<readonly Record<string, unknown>[]> {
  const page = await store.query<unknown[]>(SYSTEM_ACTOR, {
    operation: AI_OPERATIONS.executeSql,
    params: { query },
  })
  return firstGuardResult(page) as readonly Record<string, unknown>[]
}

let messageIds: readonly number[] = []
let hypothesisId = 0

/** Claim the given ids as the given actor, through the registered operation. */
function claimAs(
  actor: ActorContext,
  ids: readonly number[],
  notifiedAt = new Date().toISOString(),
): Promise<readonly ClaimedMessageRow[]> {
  return ai().transaction(actor, (transaction) =>
    transaction.execute<readonly ClaimedMessageRow[]>({
      operation: SYSTEM_OPERATIONS.notifyClaim,
      params: { notifiedAt, ids },
    }),
  )
}

const notifiedState = () => outOfBand((client) => readNotifiedAt(client, messageIds))

/** How many candidates the notifier would see fleet-wide. Real rows are in it. */
async function remainingBacklog(): Promise<number> {
  const page = await ai().query<{ remaining: number }>(SYSTEM_ACTOR, {
    operation: SYSTEM_OPERATIONS.notifyRemaining,
    page: { limit: 1 },
  })
  return page.items[0]?.remaining ?? -1
}

beforeAll(async () => {
  // Force the store's one-time principal verification before any test times a
  // round trip, so a cold TLS handshake is never inside a measurement.
  await guard(ai(), 'select 1 as one')
})

beforeEach(async () => {
  const seeded = await outOfBand(seedAiSystemFixture)
  messageIds = seeded.messageIds
  hypothesisId = seeded.hypothesisId
  expect(messageIds).toHaveLength(SYSTEM_REPLY_BODIES.length)
  expect(hypothesisId).toBeGreaterThan(0)
})

/** The briefing job machine's key, as both operations spell it. */
const jobKey = (briefingKind: 'daily' | 'weekly' = 'daily') => ({
  briefingDate: SYSTEM_BRIEFING_DATE,
  briefingKind,
})

/** One command on the AI store, as the given actor. */
function systemCommand<TResult>(
  operation: string,
  params?: Record<string, string | number | boolean | null>,
  actor: ActorContext = SYSTEM_ACTOR,
): Promise<TResult> {
  return ai().transaction(actor, (transaction) =>
    transaction.execute<TResult>({ operation, params }),
  )
}

/** The job row as the machine reads it, out of the registry rather than by hand. */
async function readJob(
  briefingKind: 'daily' | 'weekly' = 'daily',
): Promise<BriefingJobRowShape | null> {
  const page = await ai().query<BriefingJobRowShape>(SYSTEM_ACTOR, {
    operation: AI_WRITE_OPERATIONS.briefingJobRow,
    params: jobKey(briefingKind),
    page: { limit: 1 },
  })
  return page.items[0] ?? null
}

afterAll(async () => {
  await outOfBand(dropAiSystemFixture)
  await resetAiDataStore()
  await fixtures.end()
})

// ---------------------------------------------------------------------------
// 1. The five granted relations really admit the new statements.
// ---------------------------------------------------------------------------

describe('step 007 admits the system statements, and the rows really change', () => {
  it('runs as app_system, under row-level security', async () => {
    // Everything else in this file is a claim about `app_system`; this is the
    // one measurement that the principal being exercised is that role and not
    // whatever the credential happens to log in as. `current_user` is read on a
    // DIRECT statement — inside the guard it would read `app_ai_runner`, the
    // SECURITY DEFINER owner, and say nothing about the caller.
    const probe = probeStore((registry) => {
      registry.registerQuery('probe.principal', {
        build: () => ({
          text: `SELECT current_user::text AS role,
                        current_setting('row_security') AS row_security,
                        current_setting('app.actor_id', true) AS actor_id`,
          values: [],
        }),
        mapRow: (row) => ({
          role: String(row.role),
          rowSecurity: String(row.row_security),
          actorId: String(row.actor_id),
        }),
      })
    }, 's15-principal-probe')
    try {
      const page = await probe.query<{
        role: string
        rowSecurity: string
        actorId: string
      }>(SYSTEM_ACTOR, { operation: 'probe.principal', page: { limit: 1 } })
      expect(page.items[0]).toEqual({
        role: 'app_system',
        rowSecurity: 'on',
        actorId: SYSTEM_ACTOR.actorId,
      })
    } finally {
      await probe.close()
    }
  })

  it('reads the unannounced backlog directly from public.messages', async () => {
    // The operation is deliberately unscoped — the notifier drains the whole
    // fleet — so this walks every page rather than assuming the fixture's
    // replies land on the first one. It only READS; nothing here claims a row
    // it did not create.
    const seen = new Set<number>()
    let cursor: string | null = null
    for (let page = 0; page < 50; page += 1) {
      const result: Page<NotifyCandidateRow> = await ai().query<NotifyCandidateRow>(
        SYSTEM_ACTOR,
        {
          operation: SYSTEM_OPERATIONS.notifyCandidates,
          page: { limit: MAX_PAGE_SIZE, cursor },
        },
      )
      for (const item of result.items) seen.add(item.id)
      if (!result.hasMore || result.nextCursor === null) break
      cursor = result.nextCursor
    }

    for (const id of messageIds) expect(seen.has(id)).toBe(true)
  })

  it('claims the batch, then gives it back — the round trip on notified_at', async () => {
    const before = await notifiedState()
    expect([...before.values()].every((value) => value === null)).toBe(true)

    const stamp = new Date().toISOString()
    const claimed = await claimAs(SYSTEM_ACTOR, messageIds, stamp)

    // Every row came back, and each carries the columns the notifier renders —
    // the claim is a single statement, so a partial RETURNING would mean a
    // partial claim.
    expect([...claimed].map((row) => row.id).sort()).toEqual(
      [...messageIds].sort(),
    )
    for (const row of claimed) {
      expect(row.instance_id).toBe(SYSTEM_SCOPE)
      expect(row.campaign_id).toBe(SYSTEM_CAMPAIGN_ID)
      expect(row.profile_url).toBe(SYSTEM_PROFILE_URL)
      expect(typeof row.body).toBe('string')
    }

    // Measured on a different connection, as a different principal: the write
    // committed, it is not an artefact of the writer's own snapshot.
    const after = await notifiedState()
    expect([...after.values()].every((value) => value !== null)).toBe(true)

    // The predicate is re-checked under the row lock, so a second claim of the
    // same ids takes nothing. This is the sequential shadow of the concurrency
    // proof at the bottom of the file.
    expect(await claimAs(SYSTEM_ACTOR, messageIds)).toHaveLength(0)

    const undone = await ai().transaction(SYSTEM_ACTOR, (transaction) =>
      transaction.execute<{ rowCount: number }>({
        operation: SYSTEM_OPERATIONS.notifyUnclaim,
        params: { ids: messageIds },
      }),
    )
    expect(undone.rowCount).toBe(messageIds.length)

    const restored = await notifiedState()
    expect([...restored.values()].every((value) => value === null)).toBe(true)
  })

  it('counts the remaining backlog, and the count moves by exactly the batch', async () => {
    // Absolute numbers belong to the tenant's real data and are none of this
    // suite's business; the DELTA is entirely this suite's doing.
    const before = await remainingBacklog()
    expect(before).toBeGreaterThanOrEqual(messageIds.length)

    await claimAs(SYSTEM_ACTOR, messageIds)
    expect(before - (await remainingBacklog())).toBe(messageIds.length)
  })

  it('reads lead display names — public.leads is in the grant too', async () => {
    const page = await ai().query<NotifyLeadRow>(SYSTEM_ACTOR, {
      operation: SYSTEM_OPERATIONS.notifyLeadContext,
      params: { instances: [SYSTEM_SCOPE], profiles: [SYSTEM_PROFILE_URL] },
      page: { limit: MAX_PAGE_SIZE },
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      instance_id: SYSTEM_SCOPE,
      campaign_id: SYSTEM_CAMPAIGN_ID,
      profile_url: SYSTEM_PROFILE_URL,
      full_name: SYSTEM_LEAD_NAME,
    })
  })

  it('inserts and partially patches a saved search as app_system', async () => {
    const insert = await ai().transaction(SYSTEM_ACTOR, (transaction) =>
      transaction.execute<EntityWriteResult<SavedSearchRow>>({
        operation: SYSTEM_OPERATIONS.insertSavedSearch,
        params: {
          patchJson: JSON.stringify({
            name: 'S15 system search',
            platform: SYSTEM_SEARCH_PLATFORM,
            include_keywords: ['alpha', 'beta'],
            notes: 'written by app_system',
          }),
        },
      }),
    )
    expect(insert.rowCount).toBe(1)
    const id = insert.row?.id ?? 0
    expect(id).toBeGreaterThan(0)

    const written = await outOfBand((client) =>
      client.query(
        `SELECT name, platform, include_keywords, notes, archived
           FROM public.saved_searches WHERE id = $1`,
        [id],
      ),
    )
    expect(written.rows[0]).toMatchObject({
      name: 'S15 system search',
      platform: SYSTEM_SEARCH_PLATFORM,
      include_keywords: ['alpha', 'beta'],
      notes: 'written by app_system',
      archived: false,
    })

    const update = await ai().transaction(SYSTEM_ACTOR, (transaction) =>
      transaction.execute<EntityWriteResult<SavedSearchRow>>({
        operation: SYSTEM_OPERATIONS.updateSavedSearch,
        params: { id, patchJson: JSON.stringify({ notes: 'edited by app_system' }) },
      }),
    )
    expect(update.rowCount).toBe(1)
    // A patch, not a replacement: the keys the caller did not send are the
    // values the INSERT wrote, which is the property `?`-presence buys.
    expect(update.row).toMatchObject({
      id,
      name: 'S15 system search',
      include_keywords: ['alpha', 'beta'],
      notes: 'edited by app_system',
    })

    const patched = await outOfBand((client) =>
      client.query(
        `SELECT name, notes FROM public.saved_searches WHERE id = $1`,
        [id],
      ),
    )
    expect(patched.rows[0]).toMatchObject({
      name: 'S15 system search',
      notes: 'edited by app_system',
    })
  })

  it('writes through the MCP save_search surface end to end, on the flagged path', async () => {
    // The flag is overridden inside this process only, for this test only —
    // never in a deployment, and never on disk.
    const { NEON_AI_PATH_ENV } = await import('../api/_lib/data/aiPath.js')
    const { executeSaveSearchAsSystem } = await import('../api/_lib/tools.js')
    const previous = process.env[NEON_AI_PATH_ENV]
    process.env[NEON_AI_PATH_ENV] = 'neon'
    try {
      const result = await executeSaveSearchAsSystem({
        name: 'S15 MCP search',
        platform: SYSTEM_SEARCH_PLATFORM,
        boolean_query: '("head of" OR cto) AND saas',
      })
      // A string here is the tool's refusal text, which the model would read.
      expect(typeof result).toBe('object')
      expect((result as { ok: true }).ok).toBe(true)

      const rows = await outOfBand((client) =>
        client.query(
          `SELECT name, boolean_query FROM public.saved_searches
            WHERE platform = $1 AND name = $2`,
          [SYSTEM_SEARCH_PLATFORM, 'S15 MCP search'],
        ),
      )
      expect(rows.rows).toHaveLength(1)
      expect(rows.rows[0]?.boolean_query).toBe('("head of" OR cto) AND saas')
    } finally {
      if (previous === undefined) delete process.env[NEON_AI_PATH_ENV]
      else process.env[NEON_AI_PATH_ENV] = previous
    }
  })
})

// ---------------------------------------------------------------------------
// 2. The classify cron's vocabulary, under the system principal.
//
//    Every statement here is the one the ADMIN path already runs — the same
//    operation object, registered a second time against the AI store's registry
//    — so what is measured is not "does this SQL work" but "does `app_system`
//    get to run it, and does the row move". The handler itself is never called:
//    its batch would send real conversations to a model. See the file header.
// ---------------------------------------------------------------------------

const TAXONOMY_VERSION = 'p123-v1'
const GENDER_VERSION = 'name-headline-v1'

describe('classify.* runs as app_system, and the labels really land', () => {
  /** The label columns, read out of band as a different principal. */
  async function readLabels(id: number) {
    const result = await outOfBand((client) =>
      client.query(
        `SELECT sentiment, reason, classified_model, intent_level, intent_reason,
                intent_taxonomy_version
           FROM public.messages WHERE id = $1::bigint`,
        [id],
      ),
    )
    return result.rows[0]
  }

  /** The unclassified backlog count, through the registered operation. */
  async function remainingToClassify(): Promise<number> {
    const page = await ai().query<{ remaining: number }>(SYSTEM_ACTOR, {
      operation: AI_WRITE_OPERATIONS.classifyRemainingCount,
      params: { taxonomyVersion: TAXONOMY_VERSION },
      page: { limit: 1 },
    })
    return page.items[0]?.remaining ?? -1
  }

  /** Label one reply exactly as the cron would. */
  function writeLabels(
    id: number,
    options: { applySentiment: boolean; actor?: ActorContext },
  ) {
    return systemCommand<{ updated: number }>(
      AI_WRITE_OPERATIONS.classifyWriteLabels,
      {
        messageId: id,
        applySentiment: options.applySentiment,
        sentiment: 'positive',
        reason: 'S15 system classify proof',
        intentLevel: 'p3',
        intentReason: 'S15 system intent proof',
        now: new Date().toISOString(),
        model: 'claude-haiku-4-5',
        taxonomyVersion: TAXONOMY_VERSION,
      },
      options.actor,
    )
  }

  it('sees the fixture replies in the unclassified backlog', async () => {
    // The operation is fleet-wide and ordered newest-first, and the fixture's
    // replies are dated 2026-01-02, so this walks pages rather than assuming
    // they land on the first one. A read only — nothing here labels a row it
    // did not create.
    const seen = new Set<number>()
    let cursor: string | null = null
    for (let page = 0; page < 50; page += 1) {
      const result: Page<PendingReplyRow> = await ai().query<PendingReplyRow>(
        SYSTEM_ACTOR,
        {
          operation: AI_WRITE_OPERATIONS.classifyPendingReplies,
          params: { taxonomyVersion: TAXONOMY_VERSION },
          page: { limit: MAX_PAGE_SIZE, cursor },
        },
      )
      for (const item of result.items) seen.add(item.id)
      if (!result.hasMore || result.nextCursor === null) break
      cursor = result.nextCursor
    }
    for (const id of messageIds) expect(seen.has(id)).toBe(true)
  })

  it('reads the conversation context the prompt is rendered from', async () => {
    const page = await ai().query<ThreadContextRow>(SYSTEM_ACTOR, {
      operation: AI_WRITE_OPERATIONS.classifyThreadContext,
      params: { instances: [SYSTEM_SCOPE], profiles: [SYSTEM_PROFILE_URL] },
      page: { limit: MAX_PAGE_SIZE },
    })
    expect(page.items).toHaveLength(SYSTEM_REPLY_BODIES.length)
    // Newest first, which is what lets the handler's 5000-row ceiling drop the
    // OLDEST context rather than the messages around the reply being labelled.
    const sentAt = page.items.map((row) => row.sent_at)
    expect([...sentAt].sort().reverse()).toEqual(sentAt)
    for (const row of page.items) {
      expect(row.direction).toBe('in')
      expect(SYSTEM_REPLY_BODIES).toContain(row.body)
    }
  })

  it('writes sentiment and intent, and the backlog moves by exactly the batch', async () => {
    // Absolute numbers belong to the tenant; the DELTA is this suite's doing.
    const before = await remainingToClassify()
    expect(before).toBeGreaterThanOrEqual(messageIds.length)

    for (const id of messageIds) {
      const result = await writeLabels(id, { applySentiment: true })
      expect(result.updated).toBe(1)
    }

    // Committed, and visible to another principal on another connection.
    expect(await readLabels(messageIds[0])).toMatchObject({
      sentiment: 'positive',
      reason: 'S15 system classify proof',
      classified_model: 'claude-haiku-4-5',
      intent_level: 'p3',
      intent_taxonomy_version: TAXONOMY_VERSION,
    })

    expect(before - (await remainingToClassify())).toBe(messageIds.length)
  })

  it('never overwrites a human sentiment, but still stamps the intent', async () => {
    // The one asymmetry in the statement, and the reason it is a CASE rather
    // than two operations: a historical manual row must receive an AI intent
    // level while its human-corrected sentiment stays untouched.
    const victim = messageIds[0]
    await outOfBand((client) =>
      client.query(
        `UPDATE public.messages
            SET sentiment = 'negative', reason = 'human correction',
                classified_model = 'manual'
          WHERE id = $1::bigint`,
        [victim],
      ),
    )

    const result = await writeLabels(victim, { applySentiment: false })
    expect(result.updated).toBe(1)
    expect(await readLabels(victim)).toMatchObject({
      sentiment: 'negative',
      reason: 'human correction',
      classified_model: 'manual',
      intent_level: 'p3',
      intent_taxonomy_version: TAXONOMY_VERSION,
    })
  })

  it('selects the fixture lead into the fair gender batch and writes its inference', async () => {
    // The batch interleaves accounts by within-account position, so a lead that
    // is its account's ONLY candidate sits at rn = 1 and is therefore in the
    // first round-robin round — it can only be missed if the fleet has more
    // than `batchLimit` accounts, which is three orders of magnitude away.
    const batch = await ai().query<GenderBatchRow>(SYSTEM_ACTOR, {
      operation: AI_WRITE_OPERATIONS.classifyGenderBatch,
      params: {
        genderVersion: GENDER_VERSION,
        bucketLimit: 100,
        batchLimit: 100,
      },
      page: { limit: 100 },
    })
    const mine = batch.items.find((row) => row.instance_id === SYSTEM_SCOPE)
    expect(mine).toMatchObject({
      profile_url: SYSTEM_PROFILE_URL,
      full_name: SYSTEM_LEAD_NAME,
    })

    const backlogBefore = await ai().query<{ remaining: number }>(SYSTEM_ACTOR, {
      operation: AI_WRITE_OPERATIONS.classifyGenderBacklog,
      params: { genderVersion: GENDER_VERSION },
      page: { limit: 1 },
    })

    const written = await systemCommand<{ updated: number }>(
      AI_WRITE_OPERATIONS.classifyWriteGender,
      {
        instanceId: SYSTEM_SCOPE,
        profileUrl: SYSTEM_PROFILE_URL,
        gender: 'unknown',
        confidence: 0.25,
        now: new Date().toISOString(),
        model: 'claude-haiku-4-5',
        genderVersion: GENDER_VERSION,
      },
    )
    expect(written.updated).toBe(1)

    const stored = await outOfBand((client) =>
      client.query(
        `SELECT gender, gender_confidence, gender_model_version, demo_model
           FROM public.leads WHERE instance_id = $1 AND profile_url = $2`,
        [SYSTEM_SCOPE, SYSTEM_PROFILE_URL],
      ),
    )
    expect(stored.rows[0]).toMatchObject({
      gender: 'unknown',
      gender_confidence: 0.25,
      gender_model_version: GENDER_VERSION,
      demo_model: 'claude-haiku-4-5',
    })

    const backlogAfter = await ai().query<{ remaining: number }>(SYSTEM_ACTOR, {
      operation: AI_WRITE_OPERATIONS.classifyGenderBacklog,
      params: { genderVersion: GENDER_VERSION },
      page: { limit: 1 },
    })
    expect(
      (backlogBefore.items[0]?.remaining ?? 0) -
        (backlogAfter.items[0]?.remaining ?? 0),
    ).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. The briefing job machine, under the system principal — and the optimistic
//    predicate that is the whole reason a resumed job is safe.
// ---------------------------------------------------------------------------

describe('the briefing job machine runs as app_system', () => {
  /** Put the fixture job into a known state: pending, version 0. */
  async function ensureJob(briefingKind: 'daily' | 'weekly' = 'daily') {
    await systemCommand<void>(AI_WRITE_OPERATIONS.briefingEnsureJob, jobKey(briefingKind))
    const row = await readJob(briefingKind)
    if (!row) throw new Error('briefing.ensureJob did not create the job row')
    return row
  }

  function claim(
    expectedStatus: string,
    expectedVersion: number,
    nextStatus: string,
    actor: ActorContext = SYSTEM_ACTOR,
  ) {
    return systemCommand<BriefingJobRowShape | null>(
      AI_WRITE_OPERATIONS.briefingClaimJob,
      { ...jobKey(), expectedStatus, expectedVersion, nextStatus },
      actor,
    )
  }

  it('creates the job idempotently, pending at version 0', async () => {
    const first = await ensureJob()
    expect(first).toMatchObject({
      briefing_date: SYSTEM_BRIEFING_DATE,
      briefing_kind: 'daily',
      status: 'pending',
      version: 0,
      attempt: 0,
    })
    // `ON CONFLICT DO NOTHING`: a second cron tick on the same day must not
    // reset a job that is already several stages in.
    const again = await ensureJob()
    expect(again.version).toBe(0)
    expect(again.status).toBe('pending')
  })

  it('claims the job — and a claim at a stale version takes ZERO rows', async () => {
    const job = await ensureJob()

    const claimed = await claim('pending', job.version, 'investigating')
    expect(claimed).toMatchObject({
      status: 'investigating',
      version: job.version + 1,
      attempt: job.attempt + 1,
    })

    // The property the whole machine rests on. A second worker that read the
    // row BEFORE the claim above still holds version 0, and its claim must take
    // nothing — otherwise two workers investigate the same day in parallel,
    // each overwriting the other's stage artefacts.
    expect(await claim('pending', job.version, 'investigating')).toBeNull()

    // …and the row is exactly as the winner left it. `null` above is a lost
    // race, not a silent second write.
    expect(await readJob()).toMatchObject({
      status: 'investigating',
      version: job.version + 1,
    })

    // The status half of the predicate is load-bearing too: the right version
    // with the wrong expected status also takes nothing.
    expect(await claim('pending', job.version + 1, 'verifying')).toBeNull()
  })

  it('finishes a stage by key presence, and only at the expected version', async () => {
    const job = await ensureJob()
    const claimed = await claim('pending', job.version, 'investigating')
    expect(claimed).not.toBeNull()
    const version = claimed?.version ?? -1

    const drafts = [{ label: 'operational', text: 'S15 draft' }]
    const finished = await systemCommand<{ updated: number }>(
      AI_WRITE_OPERATIONS.briefingFinishStage,
      {
        ...jobKey(),
        nextStatus: 'investigated',
        expectedVersion: version,
        patch: JSON.stringify({ seed: 'S15 seed', drafts }),
      },
    )
    expect(finished.updated).toBe(1)

    const after = await readJob()
    expect(after).toMatchObject({
      status: 'investigated',
      version: version + 1,
      attempt: 0,
      seed: 'S15 seed',
      drafts,
    })
    // Absent keys mean "leave it alone", which is what lets one statement serve
    // three stages that each store different columns.
    expect(after?.verified_text).toBeNull()
    expect(after?.signals_block).toBeNull()

    // Replaying the same finish — a retry after a lost response — changes
    // nothing, because its version is now stale.
    const replay = await systemCommand<{ updated: number }>(
      AI_WRITE_OPERATIONS.briefingFinishStage,
      {
        ...jobKey(),
        nextStatus: 'investigated',
        expectedVersion: version,
        patch: JSON.stringify({ seed: 'REPLAYED' }),
      },
    )
    expect(replay.updated).toBe(0)
    expect((await readJob())?.seed).toBe('S15 seed')
  })

  it('fails, resets and stale-errors a stage, each bumping the version once', async () => {
    const job = await ensureJob()
    const claimed = await claim('pending', job.version, 'investigating')
    const version = claimed?.version ?? -1

    const failed = await systemCommand<{ updated: number }>(
      AI_WRITE_OPERATIONS.briefingFailStage,
      {
        ...jobKey(),
        nextStatus: 'pending',
        message: 'S15 stage failure',
        expectedVersion: version,
      },
    )
    expect(failed.updated).toBe(1)
    expect(await readJob()).toMatchObject({
      status: 'pending',
      error: 'S15 stage failure',
      version: version + 1,
    })

    const stale = await systemCommand<{ updated: number }>(
      AI_WRITE_OPERATIONS.briefingStaleError,
      {
        ...jobKey(),
        message: 'S15 kept timing out',
        expectedVersion: version + 1,
      },
    )
    expect(stale.updated).toBe(1)
    expect(await readJob()).toMatchObject({
      status: 'error',
      error: 'S15 kept timing out',
      version: version + 2,
    })

    const reset = await systemCommand<BriefingJobRowShape | null>(
      AI_WRITE_OPERATIONS.briefingResetJob,
      { ...jobKey(), expectedVersion: version + 2 },
    )
    expect(reset).toMatchObject({
      status: 'pending',
      attempt: 0,
      version: version + 3,
      seed: null,
      drafts: null,
      error: null,
    })
    // And the reset is optimistic too: replaying it takes nothing.
    expect(
      await systemCommand<BriefingJobRowShape | null>(
        AI_WRITE_OPERATIONS.briefingResetJob,
        { ...jobKey(), expectedVersion: version + 2 },
      ),
    ).toBeNull()
  })

  it('upserts the delivered briefing and reads it back as prior and reference', async () => {
    const upsert = (briefingDate: string, kind: 'daily' | 'weekly', headline: string) =>
      systemCommand<void>(AI_WRITE_OPERATIONS.briefingUpsertBriefing, {
        briefingDate,
        briefingKind: kind,
        periodStart: briefingDate,
        periodEnd: briefingDate,
        headline,
        summary: 'S15 system briefing summary',
        changes: JSON.stringify([{ text: 'S15 change' }]),
        sections: JSON.stringify([]),
        actions: JSON.stringify([]),
        risks: JSON.stringify([]),
        metrics: JSON.stringify([]),
        model: 'none',
        createdAt: new Date().toISOString(),
      })

    await upsert(SYSTEM_PRIOR_BRIEFING_DATE, 'daily', 'S15 prior daily')
    await upsert(SYSTEM_BRIEFING_DATE, 'daily', 'S15 today daily')
    await upsert(SYSTEM_BRIEFING_DATE, 'weekly', 'S15 weekly reference')

    // The conflict target is (briefing_date, briefing_kind): a re-run of the
    // structure stage replaces the row rather than adding a second one.
    await upsert(SYSTEM_BRIEFING_DATE, 'daily', 'S15 today daily, corrected')
    const stored = await outOfBand((client) =>
      client.query(
        `SELECT briefing_kind, headline FROM public.briefings
          WHERE briefing_date = $1::date ORDER BY briefing_kind`,
        [SYSTEM_BRIEFING_DATE],
      ),
    )
    expect(stored.rows).toEqual([
      { briefing_kind: 'daily', headline: 'S15 today daily, corrected' },
      { briefing_kind: 'weekly', headline: 'S15 weekly reference' },
    ])

    // `briefing.prior` is a fleet-wide `briefing_date < $1` read, so the
    // fixture's far-future dates are what make its answer deterministic here.
    const prior = await ai().query<PriorBriefingRow>(SYSTEM_ACTOR, {
      operation: AI_WRITE_OPERATIONS.briefingPrior,
      params: { briefingDate: SYSTEM_BRIEFING_DATE, briefingKind: 'daily' },
      page: { limit: 1 },
    })
    expect(prior.items[0]).toMatchObject({
      briefing_date: SYSTEM_PRIOR_BRIEFING_DATE,
      headline: 'S15 prior daily',
      changes: [{ text: 'S15 change' }],
    })

    const weekly = await ai().query<PriorBriefingRow>(SYSTEM_ACTOR, {
      operation: AI_WRITE_OPERATIONS.briefingWeeklyReference,
      params: { briefingDate: SYSTEM_BRIEFING_DATE, briefingKind: 'weekly' },
      page: { limit: 1 },
    })
    expect(weekly.items[0]?.headline).toBe('S15 weekly reference')
  })
})

// ---------------------------------------------------------------------------
// 4. The actor gate. The single most important section in the file: if these
//    pass with any published actor, step 007's `USING`/`WITH CHECK` does
//    nothing and every grant above is unconditional.
// ---------------------------------------------------------------------------

describe('the nil-uuid actor gate is load-bearing, not ceremony', () => {
  /**
   * An actor that is real, active and human on THIS database — the baseline's
   * own member fixture. Chosen over a made-up uuid deliberately: a refusal of
   * an unknown id could be "no such user", while a refusal of this one can only
   * be "not the system actor", which is the property step 007 claims.
   */
  const HUMAN_ACTOR = CONTRACT_ACTORS.activeMember

  /**
   * The same *kind* the store publishes in production, with a different id. It
   * separates the two candidate explanations for the section above: the driver's
   * `kind: 'system'` is a TypeScript fact the database never sees, so if this
   * were admitted the gate would be in the wrong layer entirely.
   */
  const IMPOSTOR_SYSTEM_ACTOR: ActorContext = {
    kind: 'system',
    actorId: '00000000-0000-0000-0000-0000000000ff',
    tenantId: 'primary',
    role: 'system',
  }

  for (const [label, actor] of [
    ['an active human actor', HUMAN_ACTOR],
    ['a system-kind actor with the wrong id', IMPOSTOR_SYSTEM_ACTOR],
  ] as const) {
    it(`shows no messages at all to ${label}`, async () => {
      const page = await ai().query<NotifyCandidateRow>(actor, {
        operation: SYSTEM_OPERATIONS.notifyCandidates,
        page: { limit: MAX_PAGE_SIZE },
      })
      // Not "the fixture's rows are missing" — NOTHING is visible. The
      // `app_system` policies are the only ones that admit this connection's
      // role, and none of them opened.
      expect(page.items).toHaveLength(0)

      // The control, in the same test rather than a neighbouring one: the very
      // next statement on the very same store, differing only in the published
      // actor, sees rows. So the emptiness above is the actor and nothing else
      // — not a lost credential, not an empty table, not a broken operation.
      const asSystem = await ai().query<NotifyCandidateRow>(SYSTEM_ACTOR, {
        operation: SYSTEM_OPERATIONS.notifyCandidates,
        page: { limit: MAX_PAGE_SIZE },
      })
      expect(asSystem.items.length).toBeGreaterThan(0)
    })

    it(`cannot claim a single row as ${label}, and notified_at stays NULL`, async () => {
      const claimed = await claimAs(actor, messageIds)
      // Zero rows, not a throw: an UPDATE cannot violate a WITH CHECK on rows
      // its USING clause never let it see. See the file header.
      expect(claimed).toHaveLength(0)

      const state = await notifiedState()
      expect(state.size).toBe(messageIds.length)
      expect([...state.values()].every((value) => value === null)).toBe(true)

      // The control, again in-test: the rows were claimable all along, and the
      // only thing standing between the previous statement and them was the
      // published actor.
      expect(await claimAs(SYSTEM_ACTOR, messageIds)).toHaveLength(
        messageIds.length,
      )
    })

    it(`cannot insert a saved search as ${label}`, async () => {
      const before = await outOfBand((client) =>
        client.query(`SELECT count(*)::int AS n FROM public.saved_searches`),
      )

      await expect(
        ai().transaction(actor, (transaction) =>
          transaction.execute({
            operation: SYSTEM_OPERATIONS.insertSavedSearch,
            params: {
              patchJson: JSON.stringify({
                name: `S15 forbidden ${label}`,
                platform: SYSTEM_SEARCH_PLATFORM,
              }),
            },
          }),
        ),
      ).rejects.toBeInstanceOf(DataStoreAuthorizationError)

      // An INSERT has no rows to be denied sight of, so here the WITH CHECK
      // does raise — and the table is unchanged, fleet-wide.
      const after = await outOfBand((client) =>
        client.query(`SELECT count(*)::int AS n FROM public.saved_searches`),
      )
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
    })

    it(`cannot label a reply as ${label}, and the columns stay NULL`, async () => {
      const victim = messageIds[0]
      const denied = await systemCommand<{ updated: number }>(
        AI_WRITE_OPERATIONS.classifyWriteLabels,
        {
          messageId: victim,
          applySentiment: true,
          sentiment: 'positive',
          reason: `S15 forbidden ${label}`,
          intentLevel: 'p3',
          intentReason: `S15 forbidden ${label}`,
          now: new Date().toISOString(),
          model: 'claude-haiku-4-5',
          taxonomyVersion: TAXONOMY_VERSION,
        },
        actor,
      )
      // Zero rows, not a throw — the USING clause hid the row from the UPDATE.
      expect(denied.updated).toBe(0)

      const stored = await outOfBand((client) =>
        client.query(
          `SELECT sentiment, intent_level, intent_taxonomy_version
             FROM public.messages WHERE id = $1::bigint`,
          [victim],
        ),
      )
      expect(stored.rows[0]).toEqual({
        sentiment: null,
        intent_level: null,
        intent_taxonomy_version: null,
      })
    })

    it(`cannot create a briefing job as ${label}`, async () => {
      // An INSERT again, so this one raises. The fixture reset ran in
      // `beforeEach`, so there is no row for `ON CONFLICT DO NOTHING` to hide
      // behind — the WITH CHECK is genuinely evaluated.
      await expect(
        systemCommand<void>(
          AI_WRITE_OPERATIONS.briefingEnsureJob,
          jobKey(),
          actor,
        ),
      ).rejects.toBeInstanceOf(DataStoreAuthorizationError)

      const rows = await outOfBand((client) =>
        client.query(
          `SELECT count(*)::int AS n FROM public.briefing_jobs
            WHERE briefing_date = $1::date`,
          [SYSTEM_BRIEFING_DATE],
        ),
      )
      expect(rows.rows[0]?.n).toBe(0)
    })

    it(`cannot claim a briefing job as ${label}`, async () => {
      await systemCommand<void>(AI_WRITE_OPERATIONS.briefingEnsureJob, jobKey())

      const denied = await systemCommand<BriefingJobRowShape | null>(
        AI_WRITE_OPERATIONS.briefingClaimJob,
        {
          ...jobKey(),
          expectedStatus: 'pending',
          expectedVersion: 0,
          nextStatus: 'investigating',
        },
        actor,
      )
      // A lost race and a denied actor look the same to the caller — both are
      // `null` — which is exactly why the row state is asserted next.
      expect(denied).toBeNull()
      expect(await readJob()).toMatchObject({ status: 'pending', version: 0 })

      // The control: the same statement, the same store, the nil uuid.
      expect(
        await systemCommand<BriefingJobRowShape | null>(
          AI_WRITE_OPERATIONS.briefingClaimJob,
          {
            ...jobKey(),
            expectedStatus: 'pending',
            expectedVersion: 0,
            nextStatus: 'investigating',
          },
        ),
      ).toMatchObject({ status: 'investigating', version: 1 })
    })

    it(`sees no briefing_jobs row at all as ${label}`, async () => {
      await systemCommand<void>(AI_WRITE_OPERATIONS.briefingEnsureJob, jobKey())

      const page = await ai().query<BriefingJobRowShape>(actor, {
        operation: AI_WRITE_OPERATIONS.briefingJobRow,
        params: jobKey(),
        page: { limit: 1 },
      })
      expect(page.items).toHaveLength(0)
      expect(await readJob()).not.toBeNull()
    })
  }

  it('admits the very same statements again once the nil uuid is published', async () => {
    // The control. Without it, every assertion above would also pass against a
    // database where `app_system` had simply lost its grants.
    const claimed = await claimAs(SYSTEM_ACTOR, messageIds)
    expect(claimed).toHaveLength(messageIds.length)
  })
})

// ---------------------------------------------------------------------------
// 5. What step 007 did NOT open. This is what makes the guard-vs-direct split
//    in `aiSystem.ts` a fact rather than a comment.
// ---------------------------------------------------------------------------

describe('the empty grant set still holds outside the five relations', () => {
  // Exactly the five relations the briefing's team-context preload reads and
  // step 007 did not grant. Each has a guard-backed twin asserted below, so the
  // pair is a genuine contrast: same principal, same store, same session — one
  // route refused, the other serving.
  const DIRECT_PROBES = {
    campaigns: 'probe.campaignsDirect',
    instances: 'probe.instancesDirect',
    annotations: 'probe.annotationsDirect',
    hypotheses: 'probe.hypothesesDirect',
    hypothesis_campaigns: 'probe.hypothesisCampaignsDirect',
  } as const

  let probe: NeonDataStore

  beforeAll(() => {
    probe = probeStore((registry) => {
      for (const [relation, operation] of Object.entries(DIRECT_PROBES)) {
        registry.registerQuery(operation, {
          build: () => ({
            text: `SELECT count(*)::int AS n FROM public.${relation}`,
            values: [],
          }),
          mapRow: (row) => ({ n: Number(row.n) }),
        })
      }
    }, 's15-out-of-grant-probe')
  })

  afterAll(async () => {
    await probe?.close()
  })

  for (const [relation, operation] of Object.entries(DIRECT_PROBES)) {
    it(`refuses a direct app_system read of public.${relation}`, async () => {
      // 42501 — insufficient privilege — translated by the driver. Not an empty
      // result: there is no policy to consult, because there is no grant.
      await expect(
        probe.query(SYSTEM_ACTOR, { operation, page: { limit: 1 } }),
      ).rejects.toBeInstanceOf(DataStoreAuthorizationError)
    })
  }

  it('reaches campaigns and instances through the guard-backed named reads', async () => {
    // The same two relations the direct probe above cannot touch. The guard runs
    // as `app_ai_runner`, which reads every business table SELECT-only — so the
    // split is real: same principal, same store, different route, different
    // answer.
    const campaigns = firstGuardResult(
      await ai().query<unknown[]>(SYSTEM_ACTOR, {
        operation: SYSTEM_OPERATIONS.campaignNames,
        page: { limit: 1 },
      }),
    ) as readonly { id: string; name: string | null }[]
    expect(
      campaigns.some((row) => row.id === SYSTEM_CAMPAIGN_ID),
    ).toBe(true)

    const instances = firstGuardResult(
      await ai().query<unknown[]>(SYSTEM_ACTOR, {
        operation: SYSTEM_OPERATIONS.instanceNames,
        page: { limit: 1 },
      }),
    ) as readonly { id: string; account_name: string | null }[]
    expect(instances.some((row) => row.id === SYSTEM_SCOPE)).toBe(true)
  })

  it('reaches the briefing team context through the guard, row shape included', async () => {
    const guardRows = async <TRow>(operation: string): Promise<readonly TRow[]> =>
      firstGuardResult(
        await ai().query<unknown[]>(SYSTEM_ACTOR, { operation, page: { limit: 1 } }),
      ) as readonly TRow[]

    const campaigns = await guardRows<{
      id: string
      name: string
      instance_id: string
      briefing_context: string | null
    }>(SYSTEM_OPERATIONS.briefingCampaignsContext)
    expect(campaigns.find((row) => row.id === SYSTEM_CAMPAIGN_ID)).toMatchObject({
      instance_id: SYSTEM_SCOPE,
      name: 'S15 AI system campaign',
    })

    const hypotheses = await guardRows<{ id: number; name: string }>(
      SYSTEM_OPERATIONS.briefingHypothesesList,
    )
    const mine = hypotheses.find((row) => row.name === SYSTEM_HYPOTHESIS_NAME)
    expect(mine?.id).toBe(hypothesisId)
    // Load-bearing, not incidental: the direct operation maps this column with
    // `Number`, and `composeTeamContext` keys a Map on it. A guard read that
    // handed back the id as a string would silently drop every campaign's
    // hypothesis from the briefing's context block without failing anything.
    expect(typeof mine?.id).toBe('number')

    const assignments = await guardRows<{
      hypothesis_id: number
      campaign_id: string
    }>(SYSTEM_OPERATIONS.briefingAssignments)
    expect(
      assignments.find((row) => row.campaign_id === SYSTEM_CAMPAIGN_ID),
    ).toEqual({ hypothesis_id: hypothesisId, campaign_id: SYSTEM_CAMPAIGN_ID })

    const annotations = await guardRows<{
      instance_id: string | null
      campaign_id: string | null
      note: string
      noted_at: string
    }>(SYSTEM_OPERATIONS.briefingRecentAnnotations)
    // The only one of the five whose relation grows without bound, and the only
    // one carrying its own LIMIT — so the guard's 1000-row cap is unreachable
    // by construction, and this asserts the smaller bound rather than the cap.
    expect(annotations.length).toBeLessThanOrEqual(100)
    expect(
      annotations.find((row) => row.note === SYSTEM_ANNOTATION_NOTE),
    ).toMatchObject({
      instance_id: SYSTEM_SCOPE,
      campaign_id: SYSTEM_CAMPAIGN_ID,
    })
  })

  it('reads the sixth context relation DIRECTLY — saved_searches is in the grant', async () => {
    // The control for the section: `briefing.assignedSearches` has no guard
    // twin because it needs none, and it is the same direct statement the human
    // path runs. If step 007's saved_searches grant ever went away, this fails
    // while every guard read above keeps passing.
    const page = await ai().query<{
      name: string
      hypothesis_id: number | null
      notes: string | null
    }>(SYSTEM_ACTOR, {
      operation: AI_WRITE_OPERATIONS.briefingAssignedSearches,
      page: { limit: MAX_PAGE_SIZE },
    })
    expect(page.items.find((row) => row.name === SYSTEM_SEARCH_NAME)).toMatchObject({
      hypothesis_id: hypothesisId,
      notes: 'S15 system assigned-search context',
    })
  })
})

// ---------------------------------------------------------------------------
// 6. No DELETE. Anywhere.
// ---------------------------------------------------------------------------

describe('app_system holds SELECT, INSERT, UPDATE — and never DELETE', () => {
  const GRANTED = [
    'briefing_jobs',
    'briefings',
    'messages',
    'leads',
    'saved_searches',
  ] as const

  const DELETE_PROBES = {
    messages: 'probe.deleteMessage',
    saved_searches: 'probe.deleteSearch',
  } as const

  let probe: NeonDataStore

  beforeAll(() => {
    probe = probeStore((registry) => {
      registry.registerCommand<{ rowCount: number }, { id: number }>(
        DELETE_PROBES.messages,
        {
          build: ({ params }) => ({
            text: 'DELETE FROM public.messages WHERE id = $1::bigint',
            values: [params?.id ?? 0],
          }),
          mapResult: (_rows, rowCount) => ({ rowCount }),
        },
      )
      registry.registerCommand<{ rowCount: number }>(DELETE_PROBES.saved_searches, {
        build: () => ({
          text: 'DELETE FROM public.saved_searches WHERE platform = $1',
          values: [SYSTEM_SEARCH_PLATFORM],
        }),
        mapResult: (_rows, rowCount) => ({ rowCount }),
      })
    }, 's15-delete-probe')
  })

  afterAll(async () => {
    await probe?.close()
  })

  it('the privilege matrix says so, relation by relation', async () => {
    // Measured through the guard rather than asserted from the artifact's text:
    // what the ledger file says and what the live catalog holds are exactly the
    // two things this session exists to reconcile.
    const rows = (await guard(
      ai(),
      `select r.name,
              has_table_privilege('app_system', 'public.' || r.name, 'SELECT') as can_select,
              has_table_privilege('app_system', 'public.' || r.name, 'INSERT') as can_insert,
              has_table_privilege('app_system', 'public.' || r.name, 'UPDATE') as can_update,
              has_table_privilege('app_system', 'public.' || r.name, 'DELETE') as can_delete
         from unnest(array['briefing_jobs','briefings','messages','leads','saved_searches']) as r(name)
        order by 1`,
    )) as readonly {
      name: string
      can_select: boolean
      can_insert: boolean
      can_update: boolean
      can_delete: boolean
    }[]

    expect(rows.map((row) => row.name).sort()).toEqual([...GRANTED].sort())
    for (const row of rows) {
      expect(row).toEqual({
        name: row.name,
        can_select: true,
        can_insert: true,
        can_update: true,
        can_delete: false,
      })
    }
  })

  it('refuses a DELETE of a granted relation, and the row survives', async () => {
    const victim = messageIds[0]
    await expect(
      probe.transaction(SYSTEM_ACTOR, (transaction) =>
        transaction.execute({
          operation: DELETE_PROBES.messages,
          params: { id: victim },
        }),
      ),
    ).rejects.toBeInstanceOf(DataStoreAuthorizationError)

    const state = await notifiedState()
    expect(state.has(victim)).toBe(true)
  })

  it('refuses a DELETE on saved_searches too — the library write is one-way', async () => {
    await expect(
      probe.transaction(SYSTEM_ACTOR, (transaction) =>
        transaction.execute({ operation: DELETE_PROBES.saved_searches }),
      ),
    ).rejects.toBeInstanceOf(DataStoreAuthorizationError)
  })
})

// ---------------------------------------------------------------------------
// 7. `pipeline_auto_advance()` is out of reach — which is the entire
//    justification for step 008 existing as an unapplied artifact rather than
//    the cron quietly finding a way to call it.
// ---------------------------------------------------------------------------

describe('pipeline_auto_advance is unreachable, by both routes', () => {
  const DIRECT_CALL = 'probe.autoAdvanceDirect'

  let probe: NeonDataStore

  beforeAll(() => {
    probe = probeStore((registry) => {
      registry.registerQuery(DIRECT_CALL, {
        build: () => ({
          text: 'SELECT public.pipeline_auto_advance() AS advanced',
          values: [],
        }),
        mapRow: (row) => ({ advanced: Number(row.advanced) }),
      })
    }, 's15-auto-advance-probe')
  })

  afterAll(async () => {
    await probe?.close()
  })

  it('neither app_system nor the guard owner holds EXECUTE, so neither route works', async () => {
    // The order in this test is load-bearing and not stylistic. The privilege
    // is MEASURED first and the calls are attempted only after; if a future
    // step granted EXECUTE, the assertion below fails and the test stops before
    // running a real auto-advance over the tenant's pipeline. Never reorder
    // these.
    const [privileges] = (await guard(
      ai(),
      `select has_function_privilege('app_system', 'public.pipeline_auto_advance()', 'EXECUTE') as system_advance,
              has_function_privilege('app_ai_runner', 'public.pipeline_auto_advance()', 'EXECUTE') as runner_advance,
              has_function_privilege('app_system', 'public.ai_execute_sql(text)', 'EXECUTE') as system_guard`,
    )) as readonly {
      system_advance: boolean
      runner_advance: boolean
      system_guard: boolean
    }[]

    expect(privileges.system_advance).toBe(false)
    expect(privileges.runner_advance).toBe(false)
    // The contrast that makes the two above mean something: the AI principal
    // does hold EXECUTE on the guard, so "no privilege" is not "no principal".
    expect(privileges.system_guard).toBe(true)

    // Route one: a direct statement as `app_system`. Its positive control is
    // every guard call in this file — `SELECT public.ai_execute_sql($1)` is the
    // same shape of statement, issued the same way by the same principal, and
    // it succeeds. So the refusal below is about this function, not about
    // calling functions.
    await expect(
      probe.query(SYSTEM_ACTOR, { operation: DIRECT_CALL, page: { limit: 1 } }),
    ).rejects.toBeInstanceOf(DataStoreAuthorizationError)

    // Route two: through the guard, where the executing role is `app_ai_runner`.
    // A `SELECT f()` passes the guard's single-statement rule, so what stops it
    // is the grant graph and nothing else.
    await expect(
      guard(ai(), 'select public.pipeline_auto_advance() as advanced'),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 8. The claim under real concurrency.
// ---------------------------------------------------------------------------

/**
 * A rendezvous for `count` participants. Every participant's transaction is
 * already open — connection acquired, `BEGIN` sent, the preamble's role and
 * actor published — before any of them issues its claim, so the two UPDATEs
 * genuinely overlap in the database. Two sequential claims would prove only
 * that the second one re-read the row, which is not the property at risk.
 */
function rendezvous(count: number): () => Promise<void> {
  let arrived = 0
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  return async () => {
    arrived += 1
    if (arrived >= count) open()
    await gate
  }
}

describe('two overlapping claims of one batch, against the live database', () => {
  it('claims every row exactly once between them', async () => {
    const arrive = rendezvous(2)

    /** One invocation: open a transaction, wait for its twin, then claim. */
    const invocation = (stamp: string) =>
      ai().transaction(SYSTEM_ACTOR, async (transaction) => {
        await arrive()
        return transaction.execute<readonly ClaimedMessageRow[]>({
          operation: SYSTEM_OPERATIONS.notifyClaim,
          params: { notifiedAt: stamp, ids: messageIds },
        })
      })

    const [first, second] = await Promise.all([
      invocation('2026-08-06T06:00:00.000Z'),
      invocation('2026-08-06T06:30:00.000Z'),
    ])

    const claimed = [...first, ...second].map((row) => row.id)
    // Exactly once: no id appears twice (which would be a double Slack post),
    // and none is left behind (which would be a reply nobody is told about).
    expect(claimed.sort()).toEqual([...messageIds].sort())

    // Which of the two won is legitimately undecided and pinning it would be
    // testing the scheduler; what must hold is that the split is a partition.
    expect(first.length + second.length).toBe(messageIds.length)

    const state = await notifiedState()
    expect([...state.values()].every((value) => value !== null)).toBe(true)
  }, 60_000)
})
