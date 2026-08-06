/**
 * The AI layer, unit side: the flag semantics, the AI operation allowlist, the
 * system vocabulary ledger step 007 made possible, and the system actor's
 * contract properties. No credential is needed — everything here is about what
 * the adapter STATES, not what a database answers. The live counterpart (the
 * guard actually refusing, actually serving) is `aiStore.neon.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
  SYSTEM_GUARD_OPERATIONS,
  SYSTEM_GUARD_SQL,
  SYSTEM_OPERATIONS,
  SYSTEM_QUERY_OPERATIONS,
} from '../api/_lib/data/operations/aiSystem.js'
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
