/**
 * The one file that imports the Auth candidate.
 *
 * Everything else in S17 depends on `IdentityProvider` instead, which is what
 * keeps F12's "the porting surface is two function members" true of the product
 * and not only of the spike.
 *
 * Three things this adapter does that the S16 spike did not, each forced by
 * something the identity ledger measured:
 *
 * 1. **It connects as `identity_store`, never as `app_runtime`.** Two pools,
 *    two roles, two blast radiuses. `identity_store` holds no `USAGE` on
 *    `public` and `SELECT` on no relation there, so a compromise of this pool
 *    is not a read of the workspace. The role's own `search_path` is
 *    `identity, pg_temp`, set at the role level by the control-plane bootstrap,
 *    so the candidate's unqualified `"user"` resolves to `identity."user"`.
 * 2. **`canonicalUserId` is absent.** The spike carried it as a proposal the
 *    database confirmed. Step 004 chose the `SECURITY DEFINER` resolver instead
 *    (F7 option B) and deliberately omitted the column — a catalog assertion
 *    fails if it is ever added. So there is no proposal to keep correct and no
 *    class of bug where a cached proposal drifts.
 * 3. **Revocation and pruning are direct SQL on the store's own tables**, not
 *    the admin plugin's HTTP routes. Those routes require an admin *session* to
 *    call, which a server-side maintenance task does not have and should not
 *    have to fabricate. The store is ours to write; its column names are pinned
 *    by step 004's DDL, which is the candidate's own `compileMigrations()`
 *    output.
 */

import { betterAuth } from 'better-auth'
import { hashPassword } from 'better-auth/crypto'
import { admin } from 'better-auth/plugins/admin'
import { randomUUID } from 'node:crypto'
import pgDefault from 'pg'
import type { Pool as PgPool } from 'pg'

import {
  IDENTITY_PROVIDER_NAME,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_FRESH_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  type IdentityRuntimeConfig,
} from './config.js'
import {
  IdentityProviderError,
  assertCandidateSecurityPosture,
  type IdentityProvider,
  type IdentitySession,
  type PreparedAccount,
} from './provider.js'

const { Pool } = pgDefault

/**
 * Small for the same reason `data/store.ts` keeps its ceiling at 2: many warm
 * function instances each hold their own pool and Neon's connection budget is
 * shared across all of them. A session read is one query.
 */
const MAX_CONNECTIONS = 2

/** Aborts a hung identity query well inside the endpoint's own `maxDuration`. */
const STATEMENT_TIMEOUT_MS = 8_000

/**
 * Where a password-reset link is delivered.
 *
 * A deployment that binds a sender gets the real sink from `resetMail.ts`;
 * `runtime.ts` decides. The default here *drops* the link and logs only that a
 * reset was requested, with **no token and no address**: a reset link is a
 * single-use credential and an email address is personal data, so neither
 * belongs in a log line.
 *
 * Dropping rather than throwing is deliberate — mail is a capability a
 * deployment may genuinely not have — but it is why a caller must never read
 * "delivered" off a successful response. Nothing downstream can tell this sink
 * from a real one, which is what `recordMailAttempt` is for.
 */
export type ResetLinkSink = (link: {
  readonly email: string
  readonly token: string
  readonly url: string
}) => Promise<void> | void

const dropResetLink: ResetLinkSink = () => {
  console.warn(
    'identity: a password reset was requested but no delivery sink is ' +
      'configured, so the link was discarded (no SMTP provider — external gate)',
  )
}

export interface BetterAuthProviderOptions {
  readonly config: IdentityRuntimeConfig
  readonly sendResetLink?: ResetLinkSink
  /**
   * Subjects to hand out for the next `user` rows, in order. Test-only control,
   * and the reason it exists is worth stating: it lets a suite create an account
   * whose subject is a `user_identities` fixture the baseline already ships, so
   * the mapping can be exercised without writing a fixture row.
   */
  readonly subjects?: readonly string[]
}

/**
 * The candidate's option object, built in one place so the posture assertion
 * runs against exactly what is handed to `betterAuth()` — not a restatement of
 * it. A test builds this and mutates it to prove each assertion bites.
 */
export function buildCandidateOptions(
  options: BetterAuthProviderOptions,
  database: PgPool,
): Record<string, unknown> {
  const { config } = options
  const remaining = [...(options.subjects ?? [])]
  const sink = options.sendResetLink ?? dropResetLink

  return {
    database,
    baseURL: config.baseUrl,
    basePath: config.basePath,
    secret: config.sessionSecret,
    emailAndPassword: {
      enabled: true,
      // Invite-only. An account exists because an admin created it.
      disableSignUp: true,
      // C2. The default leaves every session alive after a reset, and a reset
      // is the flow used after a suspected compromise.
      revokeSessionsOnPasswordReset: true,
      requireEmailVerification: false,
      sendResetPassword: async (input: {
        user: { email: string }
        url: string
        token: string
      }) => {
        await sink({ email: input.user.email, token: input.token, url: input.url })
      },
    },
    session: {
      // C4. Deliberate, not the inherited 7 days. See config.ts for the reasoning.
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      freshAge: SESSION_FRESH_AGE_SECONDS,
      // C6. Absent rather than set to false, so there is no object to flip:
      // enabling the cookie cache would validate the session from a signed
      // cookie instead of the database and reintroduce a revocation delay.
    },
    advanced: {
      // From the origin's scheme, not NODE_ENV. F2 measured both halves of the
      // trap: Secure over plain HTTP makes the browser drop the cookie.
      useSecureCookies: config.useSecureCookies,
      cookiePrefix: 'lh2',
      // C1. Explicitly false in every environment. Left unset these default to
      // true under NODE_ENV=test — which every vitest run sets — and skipping
      // the origin check also skips the CSRF check.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      database: {
        generateId: ({ model }: { model: string }) =>
          model === 'user' && remaining.length > 0
            ? (remaining.shift() as string)
            : randomUUID(),
      },
    },
    // Kept because step 004's DDL is this plugin's output: the store's `user`
    // table carries `role`, `banned`, `banReason` and `banExpires` because the
    // schema was generated with it. Dropping it here would make the candidate's
    // own migration output disagree with the applied baseline.
    //
    // Its routes are *not* reachable: the dispatching endpoint forwards only
    // allowlisted operations, and no admin-plugin route is on that list. The
    // product's admin path is the three SECURITY DEFINER functions, which
    // authorize themselves against the canonical tables.
    plugins: [admin()],
  }
}

interface CandidateAuth {
  handler(request: Request): Promise<Response>
  api: {
    getSession(input: { headers: Headers }): Promise<{
      user: { id: string; email: string }
    } | null>
  }
}

export class BetterAuthIdentityProvider implements IdentityProvider {
  readonly name = IDENTITY_PROVIDER_NAME

  private readonly pool: PgPool
  private readonly auth: CandidateAuth
  private principalChecked = false
  private closed = false

  constructor(options: BetterAuthProviderOptions) {
    this.pool = new Pool({
      connectionString: options.config.connectionString,
      max: MAX_CONNECTIONS,
      // Deliberately no `options: '-c search_path=...'`. The role-level
      // search_path the control-plane bootstrap set is what resolves the
      // candidate's unqualified table names, and a startup `options` parameter
      // is rejected outright by a transaction pooler — so relying on the role
      // keeps this working on either endpoint. `assertStoreReachable` fails
      // loudly if that role setting ever disappears.
    })

    const candidateOptions = buildCandidateOptions(options, this.pool)
    // Before construction, so a build with a weakened posture never exists.
    assertCandidateSecurityPosture(candidateOptions as never)
    this.auth = betterAuth(candidateOptions as never) as unknown as CandidateAuth
  }

  async handle(request: Request): Promise<Response> {
    await this.assertStoreReachable()
    return this.auth.handler(request)
  }

  async getSession(headers: Headers): Promise<IdentitySession | null> {
    await this.assertStoreReachable()
    let session: Awaited<ReturnType<CandidateAuth['api']['getSession']>>
    try {
      session = await this.auth.api.getSession({ headers })
    } catch {
      // An unreadable or tampered cookie is indistinguishable from no cookie.
      // The caller must not be able to tell which, so both are null.
      return null
    }
    if (!session?.user?.id) return null
    return { user: { subject: session.user.id, email: session.user.email } }
  }

  async prepareAccount(input: {
    readonly password: string
  }): Promise<PreparedAccount> {
    // The candidate's own hashing, never ours. `account.password` holds
    // `<salt>:<key>` scrypt output and the passphrase does not appear in it.
    const passwordHash = await hashPassword(input.password)
    return { subject: randomUUID(), passwordHash }
  }

  async revokeSessions(subject: string): Promise<number> {
    if (typeof subject !== 'string' || subject.trim() === '') {
      throw new IdentityProviderError(
        'IDENTITY_SUBJECT_INVALID',
        'A subject is required to revoke sessions',
      )
    }
    const result = await this.query(
      'DELETE FROM identity."session" WHERE "userId" = $1',
      [subject],
    )
    return result
  }

  async pruneExpiredSessions(): Promise<number> {
    // Expired rows only, so this can never end a live session. `session` is
    // indexed on the column it deletes by. `verification` is swept in the same
    // pass: an unused reset token is the same unbounded growth for the same
    // reason, and an expired one is already worthless.
    const sessions = await this.query(
      'DELETE FROM identity."session" WHERE "expiresAt" < now()',
    )
    await this.query('DELETE FROM identity."verification" WHERE "expiresAt" < now()')
    return sessions
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.end()
  }

  /**
   * Row counts for the four store tables.
   *
   * Exists so the live adapter test can assert it wrote nothing. Deliberately
   * named for its purpose: it is a read of counts only, it exposes no column of
   * any row, and in particular it cannot return `account.password`.
   */
  async storeRowCountsForTests(): Promise<Record<string, number>> {
    const client = await this.pool.connect()
    try {
      const { rows } = await client.query<{
        user: string
        session: string
        account: string
        verification: string
      }>(
        `SELECT (SELECT count(*) FROM identity."user") AS "user",
                (SELECT count(*) FROM identity."session") AS "session",
                (SELECT count(*) FROM identity."account") AS "account",
                (SELECT count(*) FROM identity."verification") AS "verification"`,
      )
      const observed = rows[0]
      return {
        user: Number(observed?.user ?? -1),
        session: Number(observed?.session ?? -1),
        account: Number(observed?.account ?? -1),
        verification: Number(observed?.verification ?? -1),
      }
    } finally {
      client.release()
    }
  }

  private async query(text: string, values: readonly unknown[] = []): Promise<number> {
    const client = await this.pool.connect()
    try {
      await client.query('SELECT set_config($1, $2, true)', [
        'statement_timeout',
        String(STATEMENT_TIMEOUT_MS),
      ])
      const result = await client.query(text, values as unknown[])
      return result.rowCount ?? 0
    } finally {
      client.release()
    }
  }

  /**
   * Fail closed, once per instance, if the store is not what we think it is.
   *
   * Same shape as the data store's `ensureRuntimePrincipal`: one round trip on
   * a cold start, never again. It checks the two things that would otherwise
   * fail later and confusingly — the wrong login, or a role that lost its
   * `search_path` so every unqualified table name resolves somewhere else.
   */
  private async assertStoreReachable(): Promise<void> {
    if (this.principalChecked) return
    if (this.closed) {
      throw new IdentityProviderError(
        'IDENTITY_PROVIDER_CLOSED',
        'The identity provider is closed',
      )
    }

    const client = await this.pool.connect()
    try {
      const { rows } = await client.query<{
        principal: string
        resolves: boolean
      }>(
        // The name is deliberately *unqualified*. A schema-qualified
        // `to_regclass` would resolve regardless of search_path and prove
        // nothing about the setting this depends on; an unqualified one
        // resolves through search_path, which is the thing being asserted.
        // A literal `::regclass` cast would raise if the table were missing,
        // turning a clear refusal into a driver error, so the comparison goes
        // through the catalog and yields NULL — not true — when it is absent.
        `SELECT current_user AS principal,
                to_regclass('"user"') = (
                  SELECT c.oid FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'identity' AND c.relname = 'user'
                ) AS resolves`,
      )
      const observed = rows[0]
      if (observed?.principal !== 'identity_store') {
        throw new IdentityProviderError(
          'IDENTITY_PRINCIPAL_UNEXPECTED',
          'The identity store must be reached as identity_store; refusing to ' +
            'run the candidate on another principal.',
        )
      }
      if (observed.resolves !== true) {
        throw new IdentityProviderError(
          'IDENTITY_SEARCH_PATH_UNEXPECTED',
          'identity."user" does not resolve on this connection: the ' +
            "identity_store role's search_path is not identity, pg_temp.",
        )
      }
      this.principalChecked = true
    } finally {
      client.release()
    }
  }
}
