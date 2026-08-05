/**
 * The S15 AI layer, unit side: the flag semantics, the AI operation allowlist,
 * and the system actor's contract properties. No credential is needed —
 * everything here is about what the adapter STATES, not what a database
 * answers. The live counterpart (the guard actually refusing, actually
 * serving) is `aiStore.neon.test.ts`.
 */
import { describe, expect, it } from 'vitest'

import { deploymentAiPath, NEON_AI_PATH_ENV } from '../api/_lib/data/aiPath.js'
import {
  AI_LOCAL_ROLE,
  buildAiStoreConfig,
  SYSTEM_ACTOR,
} from '../api/_lib/data/aiStore.js'
import {
  assertActorContext,
  DataStoreAuthorizationError,
} from '../api/_lib/data/contracts.js'
import {
  AI_NAMED_SQL,
  AI_OPERATIONS,
  buildAiRegistry,
  type AiNamedQuery,
} from '../api/_lib/data/operations/ai.js'

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

  it('registers no commands: the AI path has no write vocabulary', () => {
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
