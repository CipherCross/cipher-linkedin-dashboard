/**
 * The provider-neutral identity contract, and the assertions that keep the
 * candidate's security posture from silently reverting to its defaults.
 *
 * **Why this interface is small.** F12's strongest argument for accepting
 * self-hosted Better Auth was that the spike depended on exactly two members of
 * it, so replacing it later is a bounded change rather than a rewrite. That
 * property is only real if the product also depends on a small surface, so the
 * surface is declared here and the adapter is the only file that imports the
 * candidate. Everything else in S17 talks to `IdentityProvider`.
 *
 * **What this interface deliberately cannot do.** It cannot read or write any
 * business table, it cannot grant a role, and it never decides authorization.
 * It answers "which provider subject is presenting this request", and the
 * canonical database answers everything that follows — which is F5, the
 * structural result the whole acceptance rests on. A provider that returned a
 * role would be ignored: see `session.ts`.
 */

export class IdentityProviderError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'IdentityProviderError'
    this.code = code
  }
}

/** A misconfiguration that would weaken a defence G3 made a condition. */
export class IdentityPostureError extends IdentityProviderError {
  constructor(message: string) {
    super('IDENTITY_POSTURE_INVALID', message)
    this.name = 'IdentityPostureError'
  }
}

export interface IdentitySessionUser {
  /**
   * The identity-provider subject. This is `public.user_identities
   * .provider_subject` and **never** a canonical `public.users.id`: the store's
   * `user.id` is `text` precisely so the two cannot be confused (F8).
   */
  readonly subject: string
  readonly email: string
}

export interface IdentitySession {
  readonly user: IdentitySessionUser
}

/**
 * The material needed to create one person's store-side account, computed
 * without writing anything.
 *
 * It is split out from the write because the write is a single SQL transaction
 * spanning both stores (ledger step 005), so the hash and the subject have to
 * exist as *values* before the transaction opens. Hashing is the candidate's,
 * not ours — we never invent password handling.
 */
export interface PreparedAccount {
  readonly subject: string
  /** The candidate's own hash format. The passphrase never appears in it. */
  readonly passwordHash: string
}

export interface IdentityProvider {
  /** Recorded in `user_identities.provider`. */
  readonly name: string

  /**
   * The candidate's own HTTP routes — sign-in, sign-out, password reset.
   *
   * The request reaches this unmodified apart from its path, so the candidate's
   * own origin and CSRF middleware sees the real `Origin` and `Cookie` headers
   * and the seven refusals F3 measured still apply.
   */
  handle(request: Request): Promise<Response>

  /**
   * Read the session the request presents. `null` for absent, malformed,
   * expired or revoked — the caller must not be able to tell which.
   */
  getSession(headers: Headers): Promise<IdentitySession | null>

  /** Hash a passphrase and mint a subject, writing nothing. */
  prepareAccount(input: { readonly password: string }): Promise<PreparedAccount>

  /**
   * End every session belonging to a subject, and report how many were ended.
   *
   * This is the second half of C2. `identity_admin_set_member_active(id, false)`
   * stops the next request at 403 through the canonical tables, but it does not
   * touch session state, because the store is not its to write. Disabling a
   * member and ending their live session are two things and this is the second.
   */
  revokeSessions(subject: string): Promise<number>

  /**
   * Delete already-expired session rows and report how many (C4).
   *
   * F9 measured that an expired session which is *presented* is deleted, while
   * one that is merely abandoned stays in the table forever, so `session` grows
   * with every abandoned login. Not a security hole — an expired row is never
   * honoured — but not self-limiting either.
   */
  pruneExpiredSessions(): Promise<number>

  close(): Promise<void>
}

/**
 * The candidate options this file is willing to vouch for.
 *
 * Structural rather than the candidate's own type, so the assertion below can
 * run against a plain object in a test without constructing a real provider.
 */
export interface CandidateSecurityPosture {
  readonly advanced?: {
    readonly disableOriginCheck?: unknown
    readonly disableCSRFCheck?: unknown
    readonly useSecureCookies?: unknown
  }
  readonly emailAndPassword?: {
    readonly revokeSessionsOnPasswordReset?: unknown
    readonly disableSignUp?: unknown
  }
  readonly session?: {
    readonly expiresIn?: unknown
    readonly cookieCache?: { readonly enabled?: unknown }
  }
}

/**
 * Fail construction unless every G3 condition that lives in configuration is
 * explicitly set the right way.
 *
 * **Why an assertion and not a comment.** Each of these has a default that is
 * wrong for this product, and two of them are wrong in a way that a passing
 * test suite would hide:
 *
 * - **C1.** `skipOriginCheck` resolves to
 *   `disableOriginCheck ?? (isTest() ? true : false)`, and skipping the origin
 *   check also skips the CSRF check through a backward-compatibility branch.
 *   `isTest()` is `NODE_ENV === 'test' || TEST`, and **vitest sets
 *   `NODE_ENV=test`**. So a CSRF suite that does not set these explicitly runs
 *   against a build with no CSRF defence at all and reports green. Requiring
 *   the literal `false` — not `undefined`, not falsy — is what makes the
 *   defence present in the environment the tests run in.
 * - **C2.** `revokeSessionsOnPasswordReset` is only consulted when set, so the
 *   default leaves every session alive after a reset. A reset is the flow used
 *   *after* a suspected compromise, so the default is the wrong way round here.
 * - **C6.** `session.cookieCache` validates the session from a signed cookie
 *   instead of the database, reintroducing exactly the revocation delay a JWT
 *   would have. F5 — the result the acceptance rests on — depends on
 *   server-side state being consulted per request, so this stays disabled.
 *
 * Also checked, because they are cheap and they are the product's actual
 * membership model: sign-up is disabled (invite-only), and `expiresIn` is set
 * to something rather than inherited (C4).
 */
export function assertCandidateSecurityPosture(
  options: CandidateSecurityPosture,
): void {
  const advanced = options.advanced ?? {}
  const emailAndPassword = options.emailAndPassword ?? {}
  const session = options.session ?? {}

  // C1. Explicitly false in every environment, including NODE_ENV=test.
  if (advanced.disableOriginCheck !== false) {
    throw new IdentityPostureError(
      'C1: advanced.disableOriginCheck must be explicitly false. Left unset it ' +
        'defaults to true under NODE_ENV=test, which every vitest run sets, and ' +
        'skipping the origin check also skips the CSRF check.',
    )
  }
  if (advanced.disableCSRFCheck !== false) {
    throw new IdentityPostureError(
      'C1: advanced.disableCSRFCheck must be explicitly false in every environment.',
    )
  }

  // C2. A reset must not leave a possibly-compromised session alive.
  if (emailAndPassword.revokeSessionsOnPasswordReset !== true) {
    throw new IdentityPostureError(
      'C2: emailAndPassword.revokeSessionsOnPasswordReset must be explicitly ' +
        'true. The default leaves every existing session alive after a reset.',
    )
  }

  // C6. Server-side session state is consulted per request, or F5 stops holding.
  if (session.cookieCache !== undefined && session.cookieCache.enabled === true) {
    throw new IdentityPostureError(
      'C6: session.cookieCache must stay disabled. Enabling it validates the ' +
        'session from a signed cookie instead of the database, reintroducing ' +
        'the revocation delay F5 depends on not having.',
    )
  }

  // C4. A deliberate lifetime, not the inherited 7 days.
  if (typeof session.expiresIn !== 'number' || session.expiresIn <= 0) {
    throw new IdentityPostureError(
      'C4: session.expiresIn must be set deliberately rather than inheriting ' +
        'the 7-day default.',
    )
  }

  // Invite-only is the product's membership model, not a preference.
  if (emailAndPassword.disableSignUp !== true) {
    throw new IdentityPostureError(
      'emailAndPassword.disableSignUp must be true: membership is invite-only ' +
        'and an account exists because an admin created it.',
    )
  }
}
