/**
 * An in-memory `IdentityProvider` for the contract suite.
 *
 * **What this is for, and what it is emphatically not for.** The product's own
 * logic — the operation allowlist, the origin check, resolving the actor once
 * per request, and every admin denial — is worth testing exhaustively and
 * cheaply, without a container or a credential. This fake exists so those tests
 * can run in the default `npm test`.
 *
 * It is **not** a re-implementation of the candidate's security. Anything that
 * depends on the candidate's own behaviour — cookie attributes, its origin and
 * CSRF middleware, scrypt parameters, the exact shape of a signed token — is
 * proved against the real adapter and a real database, because a fake that
 * asserted those would only be testing itself. The two suites are deliberately
 * different in kind: this one proves the product honours the contract, the
 * adapter suite proves the candidate does.
 *
 * The fake is faithful on exactly the properties the product depends on:
 * a session is a bearer token the client cannot forge, an expired session is
 * indistinguishable from an absent one, revocation is immediate, and pruning
 * removes only what has already expired.
 */

import { randomUUID } from 'node:crypto'

import {
  IdentityProviderError,
  type IdentityProvider,
  type IdentitySession,
  type PreparedAccount,
} from './provider.js'

/** Matches the real adapter's `advanced.cookiePrefix`. */
export const FAKE_SESSION_COOKIE = 'lh2.session_token'

interface FakeAccount {
  readonly subject: string
  readonly email: string
  readonly passwordHash: string
}

interface FakeSession {
  readonly subject: string
  expiresAt: number
}

export interface FakeIdentityProviderOptions {
  readonly basePath?: string
  readonly expiresInSeconds?: number
  /** Injectable so a test can advance time without sleeping. */
  readonly now?: () => number
}

/**
 * Hashing stand-in. Deliberately *not* a real KDF and deliberately obvious
 * about it: a fake that looked like it hashed would invite someone to trust it.
 * The property the product depends on is only that the passphrase does not
 * survive into the stored value, which this does honour.
 */
function fakeHash(password: string): string {
  return `fake-scrypt$${Buffer.from(password).toString('base64url')}`
}

export class FakeIdentityProvider implements IdentityProvider {
  readonly name = 'fake'

  private readonly accounts = new Map<string, FakeAccount>()
  private readonly byEmail = new Map<string, string>()
  private readonly sessions = new Map<string, FakeSession>()
  private readonly basePath: string
  private readonly expiresInSeconds: number
  private readonly now: () => number
  private closed = false

  constructor(options: FakeIdentityProviderOptions = {}) {
    this.basePath = options.basePath ?? '/api/identity'
    this.expiresInSeconds = options.expiresInSeconds ?? 12 * 60 * 60
    this.now = options.now ?? (() => Date.now())
  }

  /** Seed an account directly. Test setup, not a provider contract member. */
  seedAccount(input: {
    readonly email: string
    readonly password: string
    readonly subject?: string
  }): FakeAccount {
    const subject = input.subject ?? randomUUID()
    const account: FakeAccount = {
      subject,
      email: input.email.toLowerCase(),
      passwordHash: fakeHash(input.password),
    }
    this.accounts.set(subject, account)
    this.byEmail.set(account.email, subject)
    return account
  }

  /** Issue a session directly, bypassing sign-in. Test setup. */
  seedSession(subject: string, ttlSeconds = this.expiresInSeconds): string {
    const token = randomUUID()
    this.sessions.set(token, {
      subject,
      expiresAt: this.now() + ttlSeconds * 1000,
    })
    return token
  }

  /** How many session rows exist, expired included. For pruning assertions. */
  sessionCount(): number {
    return this.sessions.size
  }

  async handle(request: Request): Promise<Response> {
    this.assertOpen()
    const url = new URL(request.url)
    const route = url.pathname.slice(this.basePath.length)

    if (route === '/sign-in/email' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        email?: unknown
        password?: unknown
      }
      const email = typeof body.email === 'string' ? body.email.toLowerCase() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      const subject = this.byEmail.get(email)
      const account = subject ? this.accounts.get(subject) : undefined

      // One refusal for a wrong address and a wrong passphrase alike, so the
      // endpoint is not an account-existence oracle.
      if (!account || account.passwordHash !== fakeHash(password)) {
        return json(401, { error: 'Invalid email or password' })
      }

      const token = this.seedSession(account.subject)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie':
            `${FAKE_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; ` +
            `Max-Age=${this.expiresInSeconds}`,
        },
      })
    }

    if (route === '/sign-out' && request.method === 'POST') {
      const token = readCookie(request.headers, FAKE_SESSION_COOKIE)
      if (token) this.sessions.delete(token)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': `${FAKE_SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
        },
      })
    }

    return json(404, { error: 'Not found' })
  }

  async getSession(headers: Headers): Promise<IdentitySession | null> {
    this.assertOpen()
    const token = readCookie(headers, FAKE_SESSION_COOKIE)
    if (!token) return null

    const session = this.sessions.get(token)
    if (!session) return null

    // An expired session that is *presented* is deleted, which is the
    // behaviour F9 measured on the candidate — and the reason abandoned ones
    // need a sweep.
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token)
      return null
    }

    const account = this.accounts.get(session.subject)
    if (!account) return null
    return { user: { subject: account.subject, email: account.email } }
  }

  async prepareAccount(input: {
    readonly password: string
  }): Promise<PreparedAccount> {
    this.assertOpen()
    return { subject: randomUUID(), passwordHash: fakeHash(input.password) }
  }

  async revokeSessions(subject: string): Promise<number> {
    this.assertOpen()
    if (typeof subject !== 'string' || subject.trim() === '') {
      throw new IdentityProviderError(
        'IDENTITY_SUBJECT_INVALID',
        'A subject is required to revoke sessions',
      )
    }
    let revoked = 0
    for (const [token, session] of this.sessions) {
      if (session.subject === subject) {
        this.sessions.delete(token)
        revoked += 1
      }
    }
    return revoked
  }

  async pruneExpiredSessions(): Promise<number> {
    this.assertOpen()
    const now = this.now()
    let pruned = 0
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token)
        pruned += 1
      }
    }
    return pruned
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new IdentityProviderError(
        'IDENTITY_PROVIDER_CLOSED',
        'The identity provider is closed',
      )
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Read one cookie value out of a request's `Cookie` header. */
export function readCookie(headers: Headers, name: string): string | null {
  const header = headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || null
    }
  }
  return null
}
