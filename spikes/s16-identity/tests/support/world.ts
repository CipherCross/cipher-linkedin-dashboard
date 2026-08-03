/**
 * One assembled spike: clean-room tenant database, the candidate over its own
 * isolated store, the serverless-shaped handler, and an HTTP harness in front
 * of it. Every test in the clean-room suite builds one of these.
 *
 * The invite helper writes **both** stores in a single transaction. That is not
 * incidental convenience — it is the spike's answer to "how are two user stores
 * reconciled without a second source of truth", and it is only possible because
 * the candidate's tables sit in the same database as the canonical ones. See
 * `tests/inviteResetDisable.test.ts`.
 */

import { hashPassword } from 'better-auth/crypto'
import { randomUUID } from 'node:crypto'
import pgDefault from 'pg'
import type { Pool as PgPool, PoolClient } from 'pg'
import { inject } from 'vitest'

import {
  createProposeThenConfirmResolver,
  createDefinerResolver,
  type ActorResolver,
} from '../../src/canonicalActor.js'
import { CookieJar, jarFetch, type JarFetchResult, type SendContext } from '../../src/cookieJar.js'
import { createSpikeHandler, WHOAMI_PATH } from '../../src/handler.js'
import { startHarness, type Harness } from '../../src/harness.js'
import { AUTH_BASE_PATH, createSpikeAuth, IDENTITY_SCHEMA, type SpikeAuth } from '../../src/spikeAuth.js'

const { Pool } = pgDefault

/** The provider label the clean-room leg writes into `user_identities`. */
export const SPIKE_PROVIDER = 'better-auth'

export interface InviteInput {
  readonly email: string
  readonly password: string
  /** Omit to invite an account with no canonical mapping at all. */
  readonly canonicalUserId?: string | null
  readonly canonicalRole?: 'member' | 'admin'
  readonly canonicalActive?: boolean
  /** The candidate's *own* role column, which is not the authoritative one. */
  readonly storeRole?: 'user' | 'admin'
  readonly subject?: string
}

export interface Invited {
  readonly subject: string
  readonly email: string
  readonly password: string
  readonly canonicalUserId: string | null
}

export interface World {
  readonly auth: SpikeAuth
  readonly harness: Harness
  readonly origin: string
  readonly runtimePool: PgPool
  readonly ownerPool: PgPool
  /**
   * Run as `app_owner`. `app_migration` is NOINHERIT, so owner capability only
   * exists inside an explicit `SET ROLE` on one connection — a pooled
   * `pool.query` would land on some other connection and be denied.
   */
  asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>
  readonly resolver: ActorResolver
  /** Swap in the `SECURITY DEFINER` resolver candidate. */
  useDefinerResolver(): void
  invite(input: InviteInput): Promise<Invited>
  signIn(jar: CookieJar, email: string, password: string, init?: RequestInit & { context?: SendContext }): Promise<JarFetchResult>
  whoAmI(jar: CookieJar): Promise<JarFetchResult>
  post(path: string, init?: RequestInit & { context?: SendContext }, jar?: CookieJar): Promise<JarFetchResult>
  close(): Promise<void>
}

export interface WorldOptions {
  readonly useSecureCookies?: boolean
  /** See `SpikeAuthConfig.enforceOriginChecks`. Defaults to enforced. */
  readonly enforceOriginChecks?: boolean
  /** See `SpikeAuthConfig.revokeSessionsOnPasswordReset`. */
  readonly revokeSessionsOnPasswordReset?: boolean
  readonly sessionExpiresInSeconds?: number
  readonly sessionUpdateAgeSeconds?: number
  readonly sessionFreshAgeSeconds?: number
  readonly userIds?: readonly string[]
}

export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const harness = await startHarness()

  const auth = await createSpikeAuth({
    connectionString: inject('identityStoreUrl'),
    baseURL: harness.origin,
    useSecureCookies: options.useSecureCookies ?? false,
    enforceOriginChecks: options.enforceOriginChecks ?? true,
    revokeSessionsOnPasswordReset: options.revokeSessionsOnPasswordReset,
    sessionExpiresInSeconds: options.sessionExpiresInSeconds,
    sessionUpdateAgeSeconds: options.sessionUpdateAgeSeconds,
    sessionFreshAgeSeconds: options.sessionFreshAgeSeconds,
    userIds: options.userIds,
  })

  const runtimePool = new Pool({ connectionString: inject('runtimeUrl'), max: 4 })
  const ownerPool = new Pool({ connectionString: inject('ownerUrl'), max: 4 })

  let resolver: ActorResolver = createProposeThenConfirmResolver(runtimePool)

  harness.mount(
    createSpikeHandler({
      auth: auth.auth,
      resolveActor: (input) => resolver(input),
      provider: SPIKE_PROVIDER,
    }),
  )

  const asOwner = async <T,>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await ownerPool.connect()
    try {
      await client.query('SET ROLE app_owner')
      return await fn(client)
    } finally {
      client.release()
    }
  }

  const invite = async (input: InviteInput): Promise<Invited> => {
    const subject = input.subject ?? randomUUID()
    const canonicalUserId =
      input.canonicalUserId === undefined ? randomUUID() : input.canonicalUserId
    const passwordHash = await hashPassword(input.password)

    const client = await ownerPool.connect()
    try {
      // One transaction across both stores. Either the person exists in both,
      // or in neither. This is the reconciliation answer.
      await client.query('BEGIN')
      await client.query('SET ROLE app_owner')

      if (canonicalUserId !== null) {
        await client.query(
          'INSERT INTO public.users (id, active) VALUES ($1, $2)',
          [canonicalUserId, input.canonicalActive ?? true],
        )
        await client.query(
          `INSERT INTO public.team_members (name, active, email, role, user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.email, input.canonicalActive ?? true, input.email, input.canonicalRole ?? 'member', canonicalUserId],
        )
        await client.query(
          `INSERT INTO public.user_identities (user_id, provider, provider_subject)
           VALUES ($1, $2, $3)`,
          [canonicalUserId, SPIKE_PROVIDER, subject],
        )
      }

      await client.query(
        `INSERT INTO ${IDENTITY_SCHEMA}."user"
           (id, name, email, "emailVerified", "createdAt", "updatedAt", role, "canonicalUserId")
         VALUES ($1, $2, $3, true, now(), now(), $4, $5)`,
        [subject, input.email, input.email, input.storeRole ?? 'user', canonicalUserId],
      )
      await client.query(
        `INSERT INTO ${IDENTITY_SCHEMA}."account"
           (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
         VALUES ($1, $2, 'credential', $3, $4, now(), now())`,
        [randomUUID(), subject, subject, passwordHash],
      )

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    return { subject, email: input.email, password: input.password, canonicalUserId }
  }

  const signIn: World['signIn'] = (jar, email, password, init = {}) =>
    jarFetch(jar, `${harness.origin}${AUTH_BASE_PATH}/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: harness.origin,
        ...(init.headers as Record<string, string> | undefined),
      },
      body: JSON.stringify({ email, password }),
      ...(init.context ? { context: init.context } : {}),
    })

  return {
    auth,
    harness,
    origin: harness.origin,
    runtimePool,
    ownerPool,
    asOwner,
    get resolver() {
      return resolver
    },
    useDefinerResolver: () => {
      resolver = createDefinerResolver(runtimePool)
    },
    invite,
    signIn,
    whoAmI: (jar) => jarFetch(jar, `${harness.origin}${WHOAMI_PATH}`),
    post: (path, init = {}, jar = new CookieJar()) =>
      jarFetch(jar, `${harness.origin}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: harness.origin,
          ...(init.headers as Record<string, string> | undefined),
        },
        ...init,
      }),
    close: async () => {
      await harness.close()
      await auth.close()
      await runtimePool.end()
      await ownerPool.end()
    },
  }
}
