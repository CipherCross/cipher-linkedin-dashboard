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
 * It never invokes `notify-replies.ts`'s handler. That handler claims whatever
 * the *unscoped* backlog read returns and posts it to Slack; on a project
 * holding real tenant data that would announce, and mutate, rows this suite did
 * not create. So the endpoint's operations are driven through the store with
 * explicit fixture ids, and the endpoint's own composition stays covered by the
 * unit tests in `aiSlice.test.ts`. That is a real gap and it is named here
 * rather than papered over.
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
import type {
  EntityWriteResult,
  SavedSearchRow,
} from '../api/_lib/data/operations/index.js'
import { CONTRACT_ACTORS } from './support/dataStoreContract.js'
import {
  dropAiSystemFixture,
  readNotifiedAt,
  seedAiSystemFixture,
  SYSTEM_BRIEFING_DATE,
  SYSTEM_CAMPAIGN_ID,
  SYSTEM_LEAD_NAME,
  SYSTEM_PROFILE_URL,
  SYSTEM_REPLY_BODIES,
  SYSTEM_SCOPE,
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
  expect(messageIds).toHaveLength(SYSTEM_REPLY_BODIES.length)
})

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

  it('writes briefing_jobs and briefings, the two granted relations no operation names yet', async () => {
    // These two are in step 007's grant because the briefing job machine will
    // need them when its cron half moves, but `registerSystemOperations` has no
    // entry for either — the briefing endpoint's POST runs under a human actor
    // on the runtime path today. An untested grant is an unproven grant, so the
    // statements are put through a probe registry rather than left to the
    // privilege matrix alone: `has_table_privilege` reports the GRANT, and only
    // a real statement reports the POLICY.
    const probe = probeStore((registry) => {
      registry.registerCommand<{ rowCount: number }>('probe.insertBriefingJob', {
        build: () => ({
          text: `INSERT INTO public.briefing_jobs (briefing_date, status, seed)
                 VALUES ($1::date, 'pending', 'S15 system write proof')`,
          values: [SYSTEM_BRIEFING_DATE],
        }),
        mapResult: (_rows, rowCount) => ({ rowCount }),
      })
      registry.registerCommand<{ rowCount: number }>('probe.claimBriefingJob', {
        build: () => ({
          // The optimistic predicate the briefing machine's own operations
          // carry, so what is proven is the shape that will actually run.
          text: `UPDATE public.briefing_jobs
                    SET status = 'running', version = version + 1
                  WHERE briefing_date = $1::date AND version = 0`,
          values: [SYSTEM_BRIEFING_DATE],
        }),
        mapResult: (_rows, rowCount) => ({ rowCount }),
      })
      registry.registerCommand<{ rowCount: number }>('probe.insertBriefing', {
        build: () => ({
          text: `INSERT INTO public.briefings (briefing_date, headline, model)
                 VALUES ($1::date, 'S15 system write proof', 'none')`,
          values: [SYSTEM_BRIEFING_DATE],
        }),
        mapResult: (_rows, rowCount) => ({ rowCount }),
      })
    }, 's15-briefing-probe')

    try {
      for (const operation of [
        'probe.insertBriefingJob',
        'probe.claimBriefingJob',
        'probe.insertBriefing',
      ]) {
        const result = await probe.transaction(SYSTEM_ACTOR, (transaction) =>
          transaction.execute<{ rowCount: number }>({ operation }),
        )
        expect(result.rowCount).toBe(1)
      }
    } finally {
      await probe.close()
    }

    const job = await outOfBand((client) =>
      client.query(
        `SELECT status, version FROM public.briefing_jobs WHERE briefing_date = $1::date`,
        [SYSTEM_BRIEFING_DATE],
      ),
    )
    expect(job.rows[0]).toMatchObject({ status: 'running', version: 1 })

    const briefing = await outOfBand((client) =>
      client.query(
        `SELECT headline FROM public.briefings WHERE briefing_date = $1::date`,
        [SYSTEM_BRIEFING_DATE],
      ),
    )
    expect(briefing.rows[0]?.headline).toBe('S15 system write proof')
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
// 2. The actor gate. The single most important section in the file: if these
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
  }

  it('admits the very same statements again once the nil uuid is published', async () => {
    // The control. Without it, every assertion above would also pass against a
    // database where `app_system` had simply lost its grants.
    const claimed = await claimAs(SYSTEM_ACTOR, messageIds)
    expect(claimed).toHaveLength(messageIds.length)
  })
})

// ---------------------------------------------------------------------------
// 3. What step 007 did NOT open. This is what makes the guard-vs-direct split
//    in `aiSystem.ts` a fact rather than a comment.
// ---------------------------------------------------------------------------

describe('the empty grant set still holds outside the five relations', () => {
  const DIRECT_PROBES = {
    campaigns: 'probe.campaignsDirect',
    instances: 'probe.instancesDirect',
    annotations: 'probe.annotationsDirect',
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
})

// ---------------------------------------------------------------------------
// 4. No DELETE. Anywhere.
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
// 5. `pipeline_auto_advance()` is out of reach — which is the entire
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
// 6. The claim under real concurrency.
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
