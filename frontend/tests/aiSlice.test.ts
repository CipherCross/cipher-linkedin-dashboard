/**
 * The AI layer, unit side: the flag semantics, the AI operation allowlist, the
 * system vocabulary ledger step 007 made possible, and the system actor's
 * contract properties. No credential is needed — everything here is about what
 * the adapter STATES, not what a database answers. The live counterpart (the
 * guard actually refusing, actually serving) is `aiStore.neon.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deploymentAiPath, NEON_AI_PATH_ENV } from '../api/_lib/data/aiPath.js'
import {
  AI_LOCAL_ROLE,
  buildAiStoreConfig,
  SYSTEM_ACTOR,
} from '../api/_lib/data/aiStore.js'
import {
  assertActorContext,
  DataStoreAuthorizationError,
  type DataStoreParams,
} from '../api/_lib/data/contracts.js'
import {
  AI_NAMED_SQL,
  AI_OPERATIONS,
  buildAiRegistry,
  type AiNamedQuery,
} from '../api/_lib/data/operations/ai.js'
import {
  SYSTEM_COMMAND_OPERATIONS,
  SYSTEM_CRON_COMMAND_OPERATIONS,
  SYSTEM_CRON_QUERY_OPERATIONS,
  SYSTEM_GUARD_OPERATIONS,
  SYSTEM_GUARD_SQL,
  SYSTEM_OPERATIONS,
  SYSTEM_QUERY_OPERATIONS,
} from '../api/_lib/data/operations/aiSystem.js'
import { AI_WRITE_OPERATIONS } from '../api/_lib/data/operations/aiWrites.js'
import {
  BRIEFING_CONTEXT_GUARD_SQL,
  briefingAssignmentsOperation,
  briefingCampaignsContextOperation,
  briefingHypothesesListOperation,
  briefingRecentAnnotationsOperation,
} from '../api/_lib/data/operations/briefingWrites.js'
import { GET as classifyCron } from '../api/classify.js'
import { GET as briefingCron } from '../api/briefing.js'
import { POST as notifyReplies } from '../api/notify-replies.js'

describe('deploymentAiPath', () => {
  it('enables the Neon path only for exactly "neon"', () => {
    for (const value of ['', '  ', 'true', '1', 'yes', 'supabase', 'Neon', 'NEON', ' neon2']) {
      expect(deploymentAiPath({ [NEON_AI_PATH_ENV]: value })).toBe('supabase')
    }
    expect(deploymentAiPath({})).toBe('supabase')
    expect(deploymentAiPath({ [NEON_AI_PATH_ENV]: 'neon' })).toBe('neon')
    // Whitespace is trimmed, matching deploymentWritePath's shape exactly.
    expect(deploymentAiPath({ [NEON_AI_PATH_ENV]: ' neon ' })).toBe('neon')
  })
})

describe('the AI operation allowlist', () => {
  const registry = buildAiRegistry()

  it('registers the generic guard operation and every fixed query', () => {
    for (const operation of Object.values(AI_OPERATIONS)) {
      expect(() => registry.lookupQuery(operation)).not.toThrow()
    }
  })

  it('refuses an operation nobody registered', () => {
    expect(() => registry.lookupQuery('ai.nonexistent')).toThrow(DataStoreAuthorizationError)
  })

  it('registers no guard operation as a command: the guard never writes', () => {
    // Step 007 gave `app_system` a write vocabulary, but not here — every entry
    // in this file is a call to a SELECT-only function, and a mutation routed
    // through it would be a write path the guard's whole contract denies.
    for (const operation of Object.values(AI_OPERATIONS)) {
      expect(() => registry.lookupCommand(operation)).toThrow(DataStoreAuthorizationError)
    }
  })

  it('refuses an empty query before any connection is acquired', () => {
    const operation = registry.lookupQuery(AI_OPERATIONS.executeSql)
    const context = (query?: string) => ({
      actor: SYSTEM_ACTOR,
      params: query === undefined ? undefined : { query },
      page: { limit: 1, cursor: null },
      range: undefined,
      after: undefined,
    })
    expect(() => operation.build(context(''))).toThrow()
    expect(() => operation.build(context('   '))).toThrow()
    expect(() => operation.build(context())).toThrow()
  })

  it('owns one SQL statement per fixed query, SELECT/WITH only', () => {
    const names = Object.keys(AI_NAMED_SQL) as AiNamedQuery[]
    // One entry per fixed query, and nothing else.
    expect(new Set(names)).toEqual(
      new Set(Object.keys(AI_OPERATIONS).filter((key) => key !== 'executeSql')),
    )
    for (const name of names) {
      const sql = AI_NAMED_SQL[name]
      expect(sql).toMatch(/^\s*(select|with)\b/i)
      expect(sql).not.toContain(';')
    }
  })
})

describe('the system actor', () => {
  it('is a valid contract actor: well-formed, and belonging to nobody', () => {
    // Throws if the kind/role pairing or the uuid shape is wrong — the same
    // assertion every resolved user actor passes through.
    expect(assertActorContext(SYSTEM_ACTOR)).toBe(SYSTEM_ACTOR)
    expect(SYSTEM_ACTOR.actorId).toBe('00000000-0000-0000-0000-000000000000')
    expect(SYSTEM_ACTOR.kind).toBe('system')
    expect(SYSTEM_ACTOR.tenantId).toBe('primary')
  })

  it('enters app_system, named once', () => {
    expect(AI_LOCAL_ROLE).toBe('app_system')
  })
})

describe('the AI store configuration', () => {
  // The two properties whose silent loss would run the AI path as app_runtime:
  // the credential env name and the unconditional SET LOCAL ROLE. Each has a
  // dedicated assertion so a mutation of either turns this suite red.
  const AI_URL = 'postgres://ai-principal@example.test/neon'

  it('resolves NEON_AI_DATABASE_URL and enters app_system on every transaction', () => {
    const config = buildAiStoreConfig({ NEON_AI_DATABASE_URL: AI_URL })
    expect(config.connectionString).toBe(AI_URL)
    expect(config.localRole).toBe('app_system')
  })

  it('never falls back to NEON_DATABASE_URL', () => {
    const config = buildAiStoreConfig({
      NEON_AI_DATABASE_URL: AI_URL,
      NEON_DATABASE_URL: 'postgres://runtime-principal@example.test/neon',
    })
    expect(config.connectionString).toBe(AI_URL)
    // And with only the runtime credential present, construction refuses
    // loudly rather than connecting the AI path as app_runtime.
    expect(() =>
      buildAiStoreConfig({ NEON_DATABASE_URL: 'postgres://runtime@example.test/neon' }),
    ).toThrow()
  })

  it('arms a transaction timeout beyond the guard’s own 10 s cap', () => {
    const config = buildAiStoreConfig({ NEON_AI_DATABASE_URL: AI_URL })
    expect(config.statementTimeoutMs).toBeGreaterThan(10_000)
  })
})

// ---------------------------------------------------------------------------
// The system vocabulary — what ledger step 007 made possible.
// ---------------------------------------------------------------------------

describe('the system operation allowlist', () => {
  const registry = buildAiRegistry()

  const queryContext = (params?: DataStoreParams) => ({
    actor: SYSTEM_ACTOR,
    params,
    page: { limit: 20, cursor: null },
    range: undefined,
    after: undefined,
  })
  const commandContext = (params?: DataStoreParams) => ({
    actor: SYSTEM_ACTOR,
    params,
  })

  /** Every system statement, built through the registry so registration and
   *  shape are asserted by the same call. */
  const systemStatements = () => [
    registry.lookupQuery(SYSTEM_OPERATIONS.notifyCandidates).build(queryContext()),
    registry.lookupQuery(SYSTEM_OPERATIONS.notifyRemaining).build(queryContext()),
    registry
      .lookupQuery(SYSTEM_OPERATIONS.notifyLeadContext)
      .build(queryContext({ instances: ['notebook-1'], profiles: ['/in/someone'] })),
    registry
      .lookupCommand(SYSTEM_OPERATIONS.notifyClaim)
      .build(commandContext({ notifiedAt: '2026-08-06T00:00:00.000Z', ids: [1, 2] })),
    registry
      .lookupCommand(SYSTEM_OPERATIONS.notifyUnclaim)
      .build(commandContext({ ids: [1, 2] })),
    registry
      .lookupCommand(SYSTEM_OPERATIONS.insertSavedSearch)
      .build(commandContext({ patchJson: '{}' })),
    registry
      .lookupCommand(SYSTEM_OPERATIONS.updateSavedSearch)
      .build(commandContext({ id: 1, patchJson: '{}' })),
  ]

  it('serves the system vocabulary from the same registry as the guard', () => {
    // One store, one principal: `getAiDataStore()` must answer for both halves,
    // so composing `aiSystem.ts` into `buildAiRegistry` is the load-bearing
    // wiring and not a convenience.
    for (const operation of SYSTEM_QUERY_OPERATIONS) {
      expect(() => registry.lookupQuery(operation)).not.toThrow()
    }
    for (const operation of SYSTEM_COMMAND_OPERATIONS) {
      expect(() => registry.lookupCommand(operation)).not.toThrow()
    }
    // The two lists together are the whole surface — an operation named but
    // classified as neither would be registered nowhere and never noticed.
    expect(new Set([...SYSTEM_QUERY_OPERATIONS, ...SYSTEM_COMMAND_OPERATIONS])).toEqual(
      new Set(Object.values(SYSTEM_OPERATIONS)),
    )
  })

  it('registers the notifier’s claim, un-claim, stale sweep and backlog count', () => {
    expect(() => registry.lookupQuery(SYSTEM_OPERATIONS.notifyCandidates)).not.toThrow()
    expect(() => registry.lookupCommand(SYSTEM_OPERATIONS.notifyClaim)).not.toThrow()
    expect(() => registry.lookupCommand(SYSTEM_OPERATIONS.notifyUnclaim)).not.toThrow()
    expect(() => registry.lookupQuery(SYSTEM_OPERATIONS.notifyRemaining)).not.toThrow()
    expect(() => registry.lookupQuery(SYSTEM_OPERATIONS.notifyLeadContext)).not.toThrow()
  })

  it('registers the MCP save_search write, as an insert and an update', () => {
    expect(() => registry.lookupCommand(SYSTEM_OPERATIONS.insertSavedSearch)).not.toThrow()
    expect(() => registry.lookupCommand(SYSTEM_OPERATIONS.updateSavedSearch)).not.toThrow()
    const insert = registry
      .lookupCommand(SYSTEM_OPERATIONS.insertSavedSearch)
      .build(commandContext({ patchJson: '{}' }))
    const update = registry
      .lookupCommand(SYSTEM_OPERATIONS.updateSavedSearch)
      .build(commandContext({ id: 7, patchJson: '{}' }))
    expect(insert.text).toMatch(/^INSERT INTO public\.saved_searches\b/)
    expect(update.text).toMatch(/^UPDATE public\.saved_searches\b/)
    // The row is the one the human path writes: same statements, and both
    // return the full row so the tool answers as the Supabase path does.
    expect(insert.text).toContain('RETURNING')
    expect(update.text).toContain('RETURNING')
  })

  it('claims in ONE atomic UPDATE that re-checks the predicate and returns the rows', () => {
    // The single thing preventing a double post when two pings align. A claim
    // split into a confirming read and an update would pass every other
    // assertion in this file and still announce a reply twice.
    const claim = registry
      .lookupCommand(SYSTEM_OPERATIONS.notifyClaim)
      .build(commandContext({ notifiedAt: '2026-08-06T00:00:00.000Z', ids: [1, 2] }))
    expect(claim.text).toMatch(/^UPDATE public\.messages\b/)
    expect(claim.text).toContain('notified_at IS NULL')
    expect(claim.text).toContain('RETURNING')
    expect(claim.text).not.toContain(';')
    // Both the stamp and the id list are bound, never spliced into the text.
    expect(claim.values).toEqual(['2026-08-06T00:00:00.000Z', [1, 2]])
    // It refuses without parameters rather than claiming an unbounded set.
    expect(() =>
      registry.lookupCommand(SYSTEM_OPERATIONS.notifyClaim).build(commandContext()),
    ).toThrow()
  })

  it('reads out-of-grant context through the guard, not as a direct table read', () => {
    // `campaigns` and `instances` are outside step 007's five relations, so a
    // direct statement would be refused by the database. These must be guard
    // calls — the query as a BOUND parameter of `ai_execute_sql`, never a
    // SELECT this store sends against the table itself.
    for (const operation of SYSTEM_GUARD_OPERATIONS) {
      const statement = registry.lookupQuery(operation).build(queryContext())
      expect(statement.text).toBe('SELECT public.ai_execute_sql($1) AS result')
      expect(statement.values).toEqual([SYSTEM_GUARD_SQL[operation]])
      expect(statement.text).not.toMatch(/\bFROM\s+public\./i)
    }
    expect(new Set(SYSTEM_GUARD_OPERATIONS)).toEqual(new Set(Object.keys(SYSTEM_GUARD_SQL)))
  })

  it('sends only SELECT/WITH through the guard, one statement each', () => {
    for (const sql of Object.values(SYSTEM_GUARD_SQL)) {
      expect(sql).toMatch(/^\s*(select|with)\b/i)
      expect(sql).not.toContain(';')
    }
  })

  it('routes no direct statement through the guard, and no mutation either way', () => {
    const guardSql = new Set(Object.values(SYSTEM_GUARD_SQL))
    for (const statement of systemStatements()) {
      const isGuardCall = statement.text.includes('ai_execute_sql')
      if (isGuardCall) {
        // Only the two context reads are guard calls, and only with the SQL
        // this module owns.
        expect(guardSql.has(String(statement.values?.[0]))).toBe(true)
      } else {
        expect(statement.text).not.toContain('ai_execute_sql')
      }
    }
    // The direct writes are direct: a mutation must never reach the guard,
    // whose SELECT-only rule is the reason it can take arbitrary text at all.
    for (const operation of SYSTEM_COMMAND_OPERATIONS) {
      const statement = registry
        .lookupCommand(operation)
        .build(
          commandContext({
            notifiedAt: '2026-08-06T00:00:00.000Z',
            ids: [1],
            id: 1,
            patchJson: '{}',
          }),
        )
      expect(statement.text).not.toContain('ai_execute_sql')
    }
  })

  it('calls pipeline_auto_advance from nowhere in the AI store', () => {
    // Ledger step 008 (the EXECUTE grant) is written and NOT applied, and even
    // once it is, the call belongs on a direct connection: it has side effects
    // and the guard is SELECT-only. Neither the fixed guard queries nor the
    // system statements may name it.
    const everySql = [
      ...Object.values(AI_NAMED_SQL),
      ...Object.values(SYSTEM_GUARD_SQL),
      ...systemStatements().map((statement) => statement.text),
    ]
    for (const sql of everySql) {
      expect(sql).not.toContain('pipeline_auto_advance')
    }
  })

  it('refuses a system operation nobody registered', () => {
    expect(() => registry.lookupQuery('system.nonexistent')).toThrow(
      DataStoreAuthorizationError,
    )
    expect(() => registry.lookupCommand('system.nonexistent')).toThrow(
      DataStoreAuthorizationError,
    )
  })
})

// ---------------------------------------------------------------------------
// The cron vocabulary — the classify and briefing operations the AI store
// admits now that step 007 is applied, and the one it must never admit.
// ---------------------------------------------------------------------------

describe('the cron half of classify and briefing', () => {
  const registry = buildAiRegistry()

  const queryContext = (params?: DataStoreParams) => ({
    actor: SYSTEM_ACTOR,
    params,
    page: { limit: 20, cursor: null },
    range: undefined,
    after: undefined,
  })
  const commandContext = (params?: DataStoreParams) => ({
    actor: SYSTEM_ACTOR,
    params,
  })

  /** Enough parameters to build any cron statement, so one loop covers them all. */
  const EVERY_PARAM: DataStoreParams = {
    taxonomyVersion: 'p123-v1',
    genderVersion: 'name-headline-v1',
    bucketLimit: 100,
    batchLimit: 100,
    instances: ['notebook-1'],
    profiles: ['/in/someone'],
    messageId: 1,
    applySentiment: true,
    sentiment: 'positive',
    reason: 'r',
    intentLevel: 'p3',
    intentReason: 'r',
    now: '2026-08-06T00:00:00.000Z',
    model: 'claude-haiku-4-5',
    instanceId: 'notebook-1',
    profileUrl: '/in/someone',
    gender: 'unknown',
    confidence: 0,
    briefingDate: '2026-08-06',
    briefingKind: 'daily',
    expectedStatus: 'pending',
    expectedVersion: 0,
    nextStatus: 'investigating',
    patch: '{}',
    message: 'm',
    periodStart: '2026-08-06',
    periodEnd: '2026-08-06',
    headline: 'h',
    summary: 's',
    changes: '[]',
    sections: '[]',
    actions: '[]',
    risks: '[]',
    metrics: '[]',
    createdAt: '2026-08-06T00:00:00.000Z',
  }

  it('serves every cron read and write from the AI store’s registry', () => {
    for (const operation of SYSTEM_CRON_QUERY_OPERATIONS) {
      expect(() => registry.lookupQuery(operation)).not.toThrow()
    }
    for (const operation of SYSTEM_CRON_COMMAND_OPERATIONS) {
      expect(() => registry.lookupCommand(operation)).not.toThrow()
    }
  })

  it('does NOT admit classify.autoAdvance, by either kind', () => {
    // The whole reason ledger step 008 exists as an unapplied artifact. If this
    // ever passes, the cron will call `pipeline_auto_advance()` as `app_system`
    // and either be refused at run time or — worse — succeed because someone
    // widened the grant without widening the review.
    expect(() =>
      registry.lookupCommand(AI_WRITE_OPERATIONS.classifyAutoAdvance),
    ).toThrow(DataStoreAuthorizationError)
    expect(() =>
      registry.lookupQuery(AI_WRITE_OPERATIONS.classifyAutoAdvance),
    ).toThrow(DataStoreAuthorizationError)
  })

  it('keeps every cron statement direct: no guard call, no auto-advance', () => {
    // These relations are all inside step 007's grant, so routing any of them
    // through the guard would be both unnecessary and — for the writes —
    // impossible, since the guard is SELECT-only.
    const statements = [
      ...SYSTEM_CRON_QUERY_OPERATIONS.map((operation) =>
        registry.lookupQuery(operation).build(queryContext(EVERY_PARAM)),
      ),
      ...SYSTEM_CRON_COMMAND_OPERATIONS.map((operation) =>
        registry.lookupCommand(operation).build(commandContext(EVERY_PARAM)),
      ),
    ]
    for (const statement of statements) {
      expect(statement.text).not.toContain('ai_execute_sql')
      expect(statement.text).not.toContain('pipeline_auto_advance')
      expect(statement.text).not.toContain(';')
    }
  })

  it('carries the optimistic version predicate in every job-machine write', () => {
    // The claim, the two stage transitions, the reset and the stale sweep all
    // key on the version the caller READ. A statement that lost its predicate
    // would let two workers progress the same briefing in parallel, and nothing
    // else in the machine would notice.
    for (const operation of [
      AI_WRITE_OPERATIONS.briefingClaimJob,
      AI_WRITE_OPERATIONS.briefingFinishStage,
      AI_WRITE_OPERATIONS.briefingFailStage,
      AI_WRITE_OPERATIONS.briefingResetJob,
      AI_WRITE_OPERATIONS.briefingStaleError,
    ]) {
      const statement = registry
        .lookupCommand(operation)
        .build(commandContext(EVERY_PARAM))
      expect(statement.text).toMatch(/AND version = \$\d+::bigint/)
      // And it bumps the version itself rather than taking a caller's guess at
      // what the next one is.
      expect(statement.text).toContain('version = version + 1')
      expect(statement.values).toContain(EVERY_PARAM.expectedVersion)
    }
  })

  it('reads the four out-of-grant briefing relations through the guard', () => {
    for (const [key, sql] of Object.entries(BRIEFING_CONTEXT_GUARD_SQL)) {
      expect(sql).toMatch(/^\s*select\b/i)
      expect(sql).not.toContain(';')
      // Registered, and registered with exactly this text.
      const operation = ({
        campaignsContext: SYSTEM_OPERATIONS.briefingCampaignsContext,
        hypothesesList: SYSTEM_OPERATIONS.briefingHypothesesList,
        assignments: SYSTEM_OPERATIONS.briefingAssignments,
        recentAnnotations: SYSTEM_OPERATIONS.briefingRecentAnnotations,
      } as Record<string, string>)[key]
      const statement = registry.lookupQuery(operation).build(queryContext())
      expect(statement.text).toBe('SELECT public.ai_execute_sql($1) AS result')
      expect(statement.values).toEqual([sql])
    }
    // The one that could grow without bound bounds itself, well under the
    // guard's 1000-row cap.
    expect(BRIEFING_CONTEXT_GUARD_SQL.recentAnnotations).toContain('limit 100')
  })

  it('selects the same columns through the guard as the direct statement does', () => {
    /** The base column names of a SELECT list, minus casts and aliases. */
    const selectedColumns = (sql: string): string[] => {
      const list = /select\s+([\s\S]+?)\s+from\s/i.exec(sql)?.[1] ?? ''
      return list
        .split(',')
        .map((part) => part.trim().split(/::|\s+as\s+/i)[0].trim())
        .filter(Boolean)
    }
    const build = (operation: { build: (context: never) => { text: string } }) =>
      operation.build({ params: { since: 'x' } } as never).text

    const pairs: [string, string][] = [
      [build(briefingCampaignsContextOperation), BRIEFING_CONTEXT_GUARD_SQL.campaignsContext],
      [build(briefingHypothesesListOperation), BRIEFING_CONTEXT_GUARD_SQL.hypothesesList],
      [build(briefingAssignmentsOperation), BRIEFING_CONTEXT_GUARD_SQL.assignments],
      [build(briefingRecentAnnotationsOperation), BRIEFING_CONTEXT_GUARD_SQL.recentAnnotations],
    ]
    for (const [direct, guarded] of pairs) {
      const wanted = selectedColumns(direct)
      expect(wanted.length).toBeGreaterThan(0)
      // The anti-drift assertion the two texts exist for: a column added to one
      // provider's read and forgotten in the other's would hand the two
      // principals different team context for the same briefing.
      expect(selectedColumns(guarded)).toEqual(wanted)
    }
  })
})

// ---------------------------------------------------------------------------
// notify-replies: which provider answers, and what decides it.
// ---------------------------------------------------------------------------

describe('notify-replies picks its provider from the AI path flag', () => {
  const SECRET = 'notify-secret-for-this-unit-test'
  const TOUCHED = [
    NEON_AI_PATH_ENV,
    'NOTIFY_SECRET',
    'NEON_AI_DATABASE_URL',
    'NEON_DATABASE_URL',
    'SUPABASE_URL',
    'VITE_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ] as const
  const saved = new Map<string, string | undefined>()

  const ping = (bearer = SECRET) =>
    new Request('https://example.test/api/notify-replies', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
    })

  beforeEach(() => {
    for (const name of TOUCHED) {
      saved.set(name, process.env[name])
      delete process.env[name]
    }
    process.env.NOTIFY_SECRET = SECRET
  })

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    saved.clear()
  })

  it('stays on Supabase when the flag is unset', async () => {
    // No provider is configured, so whichever branch was taken says so by
    // name. This one names the Supabase server variables, which the Neon
    // branch never reads.
    await expect(notifyReplies(ping())).rejects.toThrow(/SUPABASE_URL/)
  })

  it('refuses to run on Neon without the app_system credential', async () => {
    process.env[NEON_AI_PATH_ENV] = 'neon'
    // And the RUNTIME credential is present, so a branch that silently fell
    // back to `app_runtime` would succeed here instead of refusing.
    process.env.NEON_DATABASE_URL = 'postgres://runtime-principal@example.test/neon'
    await expect(notifyReplies(ping())).rejects.toThrow(/NEON_AI_DATABASE_URL/)
  })

  it('checks the machine secret before choosing a provider at all', async () => {
    process.env[NEON_AI_PATH_ENV] = 'neon'
    const denied = await notifyReplies(ping('wrong'))
    expect(denied.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// The two cron GETs: which provider answers them, now that they are no longer
// declared blocked. Same technique as the notify block above — no provider is
// configured, so the branch that ran names its own missing variable.
// ---------------------------------------------------------------------------

describe('the classify and briefing crons pick their provider from the flag', () => {
  const SECRET = 'cron-secret-for-this-unit-test'
  const TOUCHED = [
    NEON_AI_PATH_ENV,
    'CRON_SECRET',
    'NEON_AI_DATABASE_URL',
    'NEON_DATABASE_URL',
    'SUPABASE_URL',
    'VITE_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ] as const
  const saved = new Map<string, string | undefined>()

  const cron = (path: string, bearer = SECRET) =>
    new Request(`https://example.test${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    })

  beforeEach(() => {
    for (const name of TOUCHED) {
      saved.set(name, process.env[name])
      delete process.env[name]
    }
    process.env.CRON_SECRET = SECRET
    // The RUNTIME credential is present throughout, so a branch that quietly
    // fell back to `app_runtime` would succeed instead of refusing by name.
    process.env.NEON_DATABASE_URL = 'postgres://runtime-principal@example.test/neon'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    saved.clear()
  })

  it('runs classify’s cron on Supabase when the flag is unset', async () => {
    await expect(classifyCron(cron('/api/classify'))).rejects.toThrow(/SUPABASE_URL/)
  })

  it('runs classify’s cron on the app_system store when the flag is on', async () => {
    process.env[NEON_AI_PATH_ENV] = 'neon'
    await expect(classifyCron(cron('/api/classify'))).rejects.toThrow(
      /NEON_AI_DATABASE_URL/,
    )
  })

  it('checks CRON_SECRET before choosing a provider at all', async () => {
    process.env[NEON_AI_PATH_ENV] = 'neon'
    expect((await classifyCron(cron('/api/classify', 'wrong'))).status).toBe(401)
    expect((await briefingCron(cron('/api/briefing', 'wrong'))).status).toBe(401)
  })

  /**
   * The briefing handler swallows every failure into one generic 500 — it must,
   * because the caller is not entitled to the text — so the provider it chose is
   * read off the log line it writes on the way out. That text is the endpoint's
   * own plus `neonConfig.ts`'s own; no driver message and therefore no hostname
   * can reach it, which is why asserting on it here is safe where asserting on a
   * driver message would not be.
   *
   * The clock is pinned to a Wednesday because the daily cron declines to run
   * outside Monday-Friday, and a test whose meaning depends on the day it is
   * run on is not a test.
   */
  async function briefingProviderLog(): Promise<string> {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T07:00:00.000Z'))
    const logged: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      logged.push(parts.map(String).join(' '))
    })
    const response = await briefingCron(cron('/api/briefing?kind=daily'))
    expect(response.status).toBe(500)
    return logged.join('\n')
  }

  it('runs briefing’s cron on Supabase when the flag is unset', async () => {
    expect(await briefingProviderLog()).toMatch(/SUPABASE_URL/)
  })

  it('runs briefing’s cron on the app_system store when the flag is on', async () => {
    process.env[NEON_AI_PATH_ENV] = 'neon'
    expect(await briefingProviderLog()).toMatch(/NEON_AI_DATABASE_URL/)
  })
})
