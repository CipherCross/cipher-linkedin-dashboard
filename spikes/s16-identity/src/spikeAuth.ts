/**
 * The Auth candidate under test: **self-hosted Better Auth**, the initial
 * `IdentityProvider` adapter G0 accepted on 2026-07-31.
 *
 * This module is the candidate's configuration and nothing else. It is
 * deliberately not wired to any page, handler, route or context in the running
 * dashboard — S16 is an isolated spike, and G3 is meant to be decidable about
 * the mechanism alone.
 *
 * Two configuration principles, because they are what the tests measure:
 *
 * 1. **Security-relevant defaults are left alone.** Cookie attributes, CSRF
 *    behaviour and token generation are not overridden here, because
 *    overriding them would measure this file rather than the candidate. The one
 *    exception is `useSecureCookies`, which the candidate keys off
 *    `NODE_ENV === 'production'`; the spike sets it explicitly so both settings
 *    can be measured.
 * 2. **Nothing leaves the process.** `sendResetPassword` captures the reset
 *    token in memory instead of sending mail. No SMTP provider, no external
 *    service, no account anywhere.
 */

import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { admin } from 'better-auth/plugins/admin'
import { randomBytes, randomUUID } from 'node:crypto'
import pgDefault from 'pg'
import type { Pool as PgPool } from 'pg'

import type { CandidateAuth } from './handler.js'

const { Pool } = pgDefault

/** Where the candidate's own tables live. Never `public`. */
export const IDENTITY_SCHEMA = 'identity_spike'

/**
 * The candidate's own routes. Namespaced away from the product's `/api/*` so
 * the spike could never be mistaken for, or collide with, a live endpoint.
 */
export const AUTH_BASE_PATH = '/api/s16-auth'

/**
 * The value the candidate writes into `user_identities.provider` in
 * production. The Neon leg overrides it to `fixture`, so the read-only
 * baseline fixtures can drive the mapping without writing a row to Neon.
 */
export const CANDIDATE_PROVIDER = 'better-auth'

export interface CapturedResetToken {
  readonly email: string
  readonly token: string
  readonly url: string
}

export interface SpikeAuthConfig {
  /** Connection string for the role that owns the candidate's own tables. */
  readonly connectionString: string
  readonly baseURL: string
  /** Explicit rather than inherited from NODE_ENV, so both can be measured. */
  readonly useSecureCookies: boolean
  /**
   * Whether the candidate's origin/CSRF checks are enforced.
   *
   * Defaults to `true`, and this is **not** a gratuitous override of a default.
   * The candidate resolves `skipOriginCheck` as
   * `disableOriginCheck ?? (isTest() ? true : false)` where `isTest()` is
   * `NODE_ENV === 'test' || TEST` — and skipping the origin check also skips the
   * CSRF check, through its own backward-compatibility branch. Vitest sets
   * `NODE_ENV=test`. So a test suite that does not set this explicitly measures
   * a build with **no CSRF defence at all** and passes while proving nothing.
   * Setting it true restores the production behaviour; setting it false is how
   * `tests/csrf.test.ts` demonstrates the hazard.
   */
  readonly enforceOriginChecks?: boolean
  /**
   * Whether completing a password reset revokes that user's existing sessions.
   *
   * The candidate's default is **false** — `revokeSessionsOnPasswordReset` is
   * only consulted if set, so a reset leaves every session open. Left
   * defaulting to the candidate's own value so the default can be measured;
   * `tests/inviteResetDisable.test.ts` measures both settings.
   */
  readonly revokeSessionsOnPasswordReset?: boolean
  readonly sessionExpiresInSeconds?: number
  readonly sessionUpdateAgeSeconds?: number
  readonly sessionFreshAgeSeconds?: number
  /**
   * Ids to hand out for the next `user` rows, in order. Spike-only test
   * control: it lets a Better Auth account carry the same subject as a
   * `user_identities` fixture row, so the mapping can be proven against the
   * live Neon project **without writing anything to it**.
   */
  readonly userIds?: readonly string[]
}

export interface SpikeAuth {
  readonly auth: CandidateAuth
  readonly pool: PgPool
  /** Reset tokens the candidate would have emailed. Never sent anywhere. */
  readonly resetTokens: CapturedResetToken[]
  readonly baseURL: string
  close(): Promise<void>
}

/**
 * Build the candidate, applying its own schema first.
 *
 * The migration is run through the candidate's own `getMigrations`, so the DDL
 * the spike records is the DDL the candidate actually requires — not a
 * transcription of it. `sql/better_auth_generated_schema.sql` is that output,
 * committed so S17 can hand it to the migration ledger.
 */
export async function createSpikeAuth(config: SpikeAuthConfig): Promise<SpikeAuth> {
  const pool = new Pool({
    connectionString: config.connectionString,
    options: `-c search_path=${IDENTITY_SCHEMA}`,
    max: 4,
  })

  const remainingIds = [...(config.userIds ?? [])]
  const resetTokens: CapturedResetToken[] = []

  const options = {
    database: pool,
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    // Per-run and random. No secret is committed, and no run reuses another's.
    secret: randomBytes(32).toString('base64url'),
    emailAndPassword: {
      enabled: true,
      // Invite-only: there is no public sign-up. An account exists because an
      // admin created it, which is the product's actual membership model.
      disableSignUp: true,
      revokeSessionsOnPasswordReset: config.revokeSessionsOnPasswordReset ?? false,
      requireEmailVerification: false,
      sendResetPassword: async ({
        user,
        url,
        token,
      }: {
        user: { email: string }
        url: string
        token: string
      }) => {
        resetTokens.push({ email: user.email, token, url })
      },
    },
    session: {
      ...(config.sessionExpiresInSeconds !== undefined
        ? { expiresIn: config.sessionExpiresInSeconds }
        : {}),
      ...(config.sessionUpdateAgeSeconds !== undefined
        ? { updateAge: config.sessionUpdateAgeSeconds }
        : {}),
      ...(config.sessionFreshAgeSeconds !== undefined
        ? { freshAge: config.sessionFreshAgeSeconds }
        : {}),
    },
    user: {
      additionalFields: {
        /**
         * The canonical `public.users.id` this account belongs to.
         *
         * It is a **proposal**, not an authority: the tenant database confirms
         * it under RLS before it becomes an actor (see `canonicalActor.ts`).
         * `input: false` keeps it out of any client-writable payload.
         */
        canonicalUserId: { type: 'string', required: false, input: false },
      },
    },
    advanced: {
      useSecureCookies: config.useSecureCookies,
      cookiePrefix: 's16',
      // Explicit in both directions, because the candidate's own default here
      // is environment-dependent. See `enforceOriginChecks`.
      disableOriginCheck: config.enforceOriginChecks === false,
      disableCSRFCheck: config.enforceOriginChecks === false,
      database: {
        generateId: ({ model }: { model: string }) =>
          model === 'user' && remainingIds.length > 0
            ? (remainingIds.shift() as string)
            : randomUUID(),
      },
    },
    plugins: [admin()],
  }

  const migrations = await getMigrations(options as never)
  await migrations.runMigrations()

  return {
    auth: betterAuth(options as never) as unknown as CandidateAuth,
    pool,
    resetTokens,
    baseURL: config.baseURL,
    close: async () => {
      await pool.end()
    },
  }
}

/** The DDL the candidate requires, as the candidate itself emits it. */
export async function compileCandidateSchema(
  connectionString: string,
): Promise<string> {
  const pool = new Pool({
    connectionString,
    options: `-c search_path=${IDENTITY_SCHEMA}`,
    max: 1,
  })
  try {
    const migrations = await getMigrations({
      database: pool,
      baseURL: 'https://schema-only.invalid',
      secret: randomBytes(32).toString('base64url'),
      emailAndPassword: { enabled: true, disableSignUp: true },
      user: {
        additionalFields: {
          canonicalUserId: { type: 'string', required: false, input: false },
        },
      },
      plugins: [admin()],
    } as never)
    return await migrations.compileMigrations()
  } finally {
    await pool.end()
  }
}
