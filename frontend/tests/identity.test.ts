/**
 * S17's contract suite: the identity endpoint, the provider contract and every
 * G3 condition that lives in configuration.
 *
 * Runs in the default `npm test` against the fake provider and the fake data
 * store, with no container and no credential. The division of labour is
 * deliberate:
 *
 * - **here**: the product's own logic — the operation allowlist, the origin
 *   check, the 401/403/200 split, resolving the actor once, revocation on
 *   disable, pruning, and the admin denials. Exhaustive, because it is cheap.
 * - **`identityStore.neon.test.ts`**: the adapter against the real candidate and
 *   the real identity store, proving the same contract holds where it counts.
 *
 * The one thing this file must not do is assert the *candidate's* security
 * behaviour against the fake — cookie attributes, its CSRF middleware, its
 * hashing. A fake that asserted those would be testing itself, which is exactly
 * the failure mode F3 caught in the spike.
 */

import { describe, expect, it, beforeEach } from 'vitest'

import { CANDIDATE_ROUTES, createIdentityHandler } from '../api/identity.js'
import { FakeDataStore } from '../api/_lib/data/fake.js'
import {
  APPLICATION_ACTORLESS_OPERATIONS,
  IDENTITY_ADMIN_COMMANDS,
  IDENTITY_OPERATIONS,
  buildApplicationRegistry,
  resolveSelfOperation,
} from '../api/_lib/data/operations/index.js'
import { FakeIdentityProvider, FAKE_SESSION_COOKIE } from '../api/_lib/identity/fakeProvider.js'
import { ResetMailDeliveryError } from '../api/_lib/identity/resetMail.js'
import {
  IdentityPostureError,
  assertCandidateSecurityPosture,
} from '../api/_lib/identity/provider.js'
import { checkRequestOrigin } from '../api/_lib/identity/origin.js'
import {
  pruneSessionsIfDue,
  resetPruneClock,
} from '../api/_lib/identity/runtime.js'
import { IDENTITY_BASE_PATH, SESSION_EXPIRES_IN_SECONDS } from '../api/_lib/identity/config.js'
import { buildCandidateOptions } from '../api/_lib/identity/betterAuthProvider.js'

const ORIGIN = 'https://dashboard.test'
const MEMBER = {
  subject: 'subject-member',
  actorId: '00000000-0000-0000-0000-000000000001',
  email: 'member@example.test',
}
const ADMIN = {
  subject: 'subject-admin',
  actorId: '00000000-0000-0000-0000-000000000002',
  email: 'admin@example.test',
}

interface Harness {
  readonly identity: FakeIdentityProvider
  readonly store: FakeDataStore
  readonly handler: (request: Request) => Promise<Response>
  /** Every admin command the store actually received, in order. */
  readonly executed: { operation: string; params: unknown }[]
}

function harness(options: { now?: () => number } = {}): Harness {
  const identity = new FakeIdentityProvider({
    basePath: '/api/identity',
    ...(options.now ? { now: options.now } : {}),
  })
  const store = new FakeDataStore()
  const executed: { operation: string; params: unknown }[] = []

  identity.seedAccount({ email: MEMBER.email, password: 'pw', subject: MEMBER.subject })
  identity.seedAccount({ email: ADMIN.email, password: 'pw', subject: ADMIN.subject })

  store.seedActor('fake', MEMBER.subject, { actorId: MEMBER.actorId, role: 'member' })
  store.seedActor('fake', ADMIN.subject, { actorId: ADMIN.actorId, role: 'admin' })

  store.registerQuery(IDENTITY_OPERATIONS.teamRoster, () => [
    {
      id: 1,
      userId: MEMBER.actorId,
      name: 'Member',
      email: MEMBER.email,
      role: 'member',
      active: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ])

  // The fake store's commands stand in for the SQL functions. They record what
  // they were asked to do and, crucially, they do NOT re-check the actor's role:
  // that keeps the endpoint's own denial honest, because if the endpoint stopped
  // refusing a member, these would happily run and the test would fail.
  for (const operation of Object.values(IDENTITY_ADMIN_COMMANDS)) {
    store.registerCommand(operation, ({ params }) => {
      executed.push({ operation, params })
      return {
        user_id: '00000000-0000-0000-0000-000000000009',
        member_id: 9,
        provider_subject: 'subject-invited',
        email: 'invited@example.test',
        role: 'member',
        active: true,
      }
    })
  }

  return {
    identity,
    store,
    executed,
    handler: createIdentityHandler({
      identity,
      store,
      trustedOrigin: ORIGIN,
      providerName: 'fake',
    }),
  }
}

function post(op: string, body?: unknown, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}/api/identity?op=${encodeURIComponent(op)}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function get(op: string, cookie?: string): Request {
  return new Request(`${ORIGIN}/api/identity?op=${encodeURIComponent(op)}`, {
    method: 'GET',
    headers: cookie ? { cookie: `${FAKE_SESSION_COOKIE}=${cookie}` } : {},
  })
}

function withCookie(request: Request, token: string): Request {
  const headers = new Headers(request.headers)
  headers.set('cookie', `${FAKE_SESSION_COOKIE}=${token}`)
  return new Request(request, { headers })
}

// ---------------------------------------------------------------------------
// C1, C2, C4, C6 — the conditions that live in configuration.
// ---------------------------------------------------------------------------

describe('the candidate security posture (C1, C2, C4, C6)', () => {
  /** A posture that satisfies every condition, as the adapter builds it. */
  const sound = () => ({
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    emailAndPassword: { revokeSessionsOnPasswordReset: true, disableSignUp: true },
    session: { expiresIn: SESSION_EXPIRES_IN_SECONDS },
  })

  it('accepts the posture the adapter actually builds', () => {
    // Built from the real function rather than restated, so this cannot drift
    // from what is handed to betterAuth().
    const options = buildCandidateOptions(
      {
        config: {
          connectionString: 'postgresql://user:pw@localhost:5432/db',
          sessionSecret: 'x'.repeat(64),
          baseUrl: ORIGIN,
          basePath: '/api/identity',
          useSecureCookies: true,
        },
      },
      null as never,
    )
    expect(() => assertCandidateSecurityPosture(options as never)).not.toThrow()
  })

  it('C1: refuses a build where the origin check is left to default', () => {
    // The whole point of the condition. Under NODE_ENV=test — which this very
    // run sets — an unset disableOriginCheck resolves to `true`, and skipping
    // the origin check also skips the CSRF check. So `undefined` must fail.
    expect(process.env.NODE_ENV).toBe('test')
    const options = sound()
    delete (options.advanced as Record<string, unknown>).disableOriginCheck
    expect(() => assertCandidateSecurityPosture(options)).toThrow(IdentityPostureError)
    expect(() => assertCandidateSecurityPosture(options)).toThrow(/C1/)
  })

  it('C1: refuses a build where the CSRF check is disabled or left to default', () => {
    for (const value of [undefined, true]) {
      const options = sound()
      ;(options.advanced as Record<string, unknown>).disableCSRFCheck = value
      expect(() => assertCandidateSecurityPosture(options)).toThrow(/C1/)
    }
  })

  it('C2: refuses a build that leaves sessions alive after a password reset', () => {
    for (const value of [undefined, false]) {
      const options = sound()
      ;(options.emailAndPassword as Record<string, unknown>)
        .revokeSessionsOnPasswordReset = value
      expect(() => assertCandidateSecurityPosture(options)).toThrow(/C2/)
    }
  })

  it('C4: refuses a build that inherits the default session lifetime', () => {
    const options = sound()
    delete (options.session as Record<string, unknown>).expiresIn
    expect(() => assertCandidateSecurityPosture(options)).toThrow(/C4/)
  })

  it('C4: the chosen lifetime is deliberate and shorter than the 7-day default', () => {
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(12 * 60 * 60)
    expect(SESSION_EXPIRES_IN_SECONDS).toBeLessThan(7 * 24 * 60 * 60)
  })

  it('C6: refuses a build that enables the session cookie cache', () => {
    const options = sound() as Record<string, unknown>
    options.session = { expiresIn: 60, cookieCache: { enabled: true } }
    expect(() => assertCandidateSecurityPosture(options)).toThrow(/C6/)
  })

  it('C6: the adapter does not enable the cookie cache', () => {
    const options = buildCandidateOptions(
      {
        config: {
          connectionString: 'postgresql://user:pw@localhost:5432/db',
          sessionSecret: 'x'.repeat(64),
          baseUrl: ORIGIN,
          basePath: '/api/identity',
          useSecureCookies: true,
        },
      },
      null as never,
    )
    const session = options.session as { cookieCache?: unknown }
    expect(session.cookieCache).toBeUndefined()
  })

  it('refuses a build that allows public sign-up', () => {
    const options = sound()
    ;(options.emailAndPassword as Record<string, unknown>).disableSignUp = false
    expect(() => assertCandidateSecurityPosture(options)).toThrow(/disableSignUp/)
  })
})

// ---------------------------------------------------------------------------
// C1's third clause — the product's own origin check.
// ---------------------------------------------------------------------------

describe('the product origin check (C1)', () => {
  const req = (method: string, origin?: string) =>
    new Request(`${ORIGIN}/api/identity?op=admin.setRole`, {
      method,
      headers: origin === undefined ? {} : { origin },
    })

  it('refuses a state-changing request from a hostile origin', () => {
    expect(checkRequestOrigin(req('POST', 'https://evil.test'), ORIGIN)).toEqual({
      ok: false,
      reason: 'INVALID_ORIGIN',
    })
  })

  it('refuses a state-changing request with no Origin header at all', () => {
    // The half that is easy to get wrong: omitting the header is trivial, so a
    // missing origin must be a refusal rather than a pass.
    expect(checkRequestOrigin(req('POST'), ORIGIN)).toEqual({
      ok: false,
      reason: 'MISSING_ORIGIN',
    })
  })

  it('refuses the literal string "null", which is a real opaque origin', () => {
    expect(checkRequestOrigin(req('POST', 'null'), ORIGIN)).toEqual({
      ok: false,
      reason: 'MISSING_ORIGIN',
    })
  })

  it('accepts the same request from its own origin — the control', () => {
    expect(checkRequestOrigin(req('POST', ORIGIN), ORIGIN)).toEqual({ ok: true })
  })

  it('is not fooled by an origin that merely starts with the trusted one', () => {
    expect(
      checkRequestOrigin(req('POST', 'https://dashboard.test.evil.test'), ORIGIN),
    ).toEqual({ ok: false, reason: 'INVALID_ORIGIN' })
  })

  it('exempts GET, which is why no operation may change state on a GET', () => {
    expect(checkRequestOrigin(req('GET'), ORIGIN)).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// The endpoint: allowlist, methods, and the 401/403/200 split.
// ---------------------------------------------------------------------------

describe('the identity endpoint', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
    resetPruneClock()
  })

  it('requires an operation', async () => {
    const response = await h.handler(
      new Request(`${ORIGIN}/api/identity`, { method: 'GET' }),
    )
    expect(response.status).toBe(400)
  })

  it('refuses an operation that is not allowlisted', async () => {
    for (const op of [
      'admin/create-user',
      'admin/ban-user',
      'admin/list-users',
      'sign-up/email',
      'session.current.evil',
      '../pipeline',
    ]) {
      const response = await h.handler(post(op))
      expect(response.status, op).toBe(400)
    }
  })

  it('does not expose the candidate admin plugin routes', async () => {
    // The plugin is loaded, because step 004's DDL is its output. Its routes are
    // not on the allowlist, so the product's admin path is the self-authorizing
    // SQL functions and nothing else.
    const response = await h.handler(post('admin/create-user', { email: 'x@y.test' }))
    expect(response.status).toBe(400)
    expect(h.executed).toHaveLength(0)
  })

  it('refuses a state-changing operation on GET rather than exempting it', async () => {
    // C1: GET is exempt from the origin check by design, so a state-changing GET
    // would be CSRF-reachable. It must be a 405 before the origin check is
    // consulted at all.
    for (const op of ['session.signIn', 'admin.invite', 'maintenance.pruneSessions']) {
      const response = await h.handler(get(op))
      expect(response.status, op).toBe(405)
    }
    expect(h.executed).toHaveLength(0)
  })

  it('refuses a read operation on POST', async () => {
    const response = await h.handler(post('session.current'))
    expect(response.status).toBe(405)
  })

  it('applies the origin check to every state-changing operation', async () => {
    for (const op of [
      'session.signIn',
      'session.signOut',
      'password.requestReset',
      'admin.invite',
      'admin.setActive',
      'admin.setRole',
    ]) {
      const hostile = new Request(`${ORIGIN}/api/identity?op=${op}`, {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
        body: '{}',
      })
      const response = await h.handler(hostile)
      expect(response.status, op).toBe(403)
      expect(await response.json(), op).toMatchObject({ code: 'INVALID_ORIGIN' })
    }
    expect(h.executed).toHaveLength(0)
  })

  it('session.current returns 401 when no credential is presented', async () => {
    const response = await h.handler(get('session.current'))
    expect(response.status).toBe(401)
  })

  it('session.current returns 401 for a session token that is not valid', async () => {
    const response = await h.handler(get('session.current', 'not-a-real-token'))
    expect(response.status).toBe(401)
  })

  it('session.current returns 200 with the canonical actor for a member', async () => {
    const token = h.identity.seedSession(MEMBER.subject)
    const response = await h.handler(get('session.current', token))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      subject: MEMBER.subject,
      provider: 'fake',
      actor: { actorId: MEMBER.actorId, role: 'member' },
    })
  })

  it('session.current returns 403 — not 401 — for a valid session that is no longer a member', async () => {
    // F5's reachable state, and S18 has to render it distinctly: deactivating
    // someone leaves their session valid, so they are authenticated and no longer
    // a member. Collapsing this into 401 would bounce them to a sign-in that
    // succeeds and changes nothing.
    const token = h.identity.seedSession(MEMBER.subject)
    h.store.seedActor('fake', MEMBER.subject, null)
    const response = await h.handler(get('session.current', token))
    expect(response.status).toBe(403)
  })

  it('exposes no email, roster or provider record on session.current', async () => {
    const token = h.identity.seedSession(ADMIN.subject)
    const body = (await (await h.handler(get('session.current', token))).json()) as
      Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['actor', 'provider', 'subject'])
    expect(JSON.stringify(body)).not.toContain(ADMIN.email)
  })

  it('role comes from the database, never from the session', async () => {
    // An account the provider believes is an admin, which the database says is a
    // member, resolves as member. This is F5, and it is the reason the provider is
    // a replaceable component rather than an authority.
    const token = h.identity.seedSession(MEMBER.subject)
    const body = (await (await h.handler(get('session.current', token))).json()) as {
      actor: { role: string }
    }
    expect(body.actor.role).toBe('member')
  })

  it('team.roster is readable by an ordinary member', async () => {
    const token = h.identity.seedSession(MEMBER.subject)
    const response = await h.handler(get('team.roster', token))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { members: unknown[] }
    expect(body.members).toHaveLength(1)
  })

  it('team.roster refuses an unauthenticated caller', async () => {
    expect((await h.handler(get('team.roster'))).status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Admin denial — the one that has to actually bite.
// ---------------------------------------------------------------------------

describe('admin denial', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
    resetPruneClock()
  })

  const adminCalls: [string, unknown][] = [
    ['admin.invite', { email: 'new@example.test', name: 'New', role: 'member' }],
    ['admin.setActive', { userId: MEMBER.actorId, active: false }],
    ['admin.setRole', { userId: MEMBER.actorId, role: 'admin' }],
  ]

  it('refuses an ordinary member every admin operation', async () => {
    const token = h.identity.seedSession(MEMBER.subject)
    for (const [op, body] of adminCalls) {
      const response = await h.handler(withCookie(post(op, body), token))
      expect(response.status, op).toBe(403)
    }
  })

  it('the refusal reaches the database with nothing — no command is issued', async () => {
    // The denial that matters. If the endpoint's check were removed, these would
    // reach the fake commands, which deliberately do NOT re-check the role, and
    // this assertion is what fails. In the real system the database refuses
    // independently with SQLSTATE 42501 — proved by
    // postgres/tests/portable_identity_atomic_invite_assertions.sql from a real
    // app_runtime session, because a check that exists only in TypeScript is one
    // that disappears the first time someone adds a second call site.
    const token = h.identity.seedSession(MEMBER.subject)
    for (const [op, body] of adminCalls) {
      await h.handler(withCookie(post(op, body), token))
    }
    expect(h.executed).toEqual([])
  })

  it('refuses an unauthenticated caller every admin operation with 401', async () => {
    for (const [op, body] of adminCalls) {
      const response = await h.handler(post(op, body))
      expect(response.status, op).toBe(401)
    }
    expect(h.executed).toEqual([])
  })

  it('refuses a deactivated caller with 403 even though their session is valid', async () => {
    const token = h.identity.seedSession(ADMIN.subject)
    h.store.seedActor('fake', ADMIN.subject, null)
    for (const [op, body] of adminCalls) {
      const response = await h.handler(withCookie(post(op, body), token))
      expect(response.status, op).toBe(403)
    }
    expect(h.executed).toEqual([])
  })

  it('allows an admin, and passes the validated arguments through', async () => {
    const token = h.identity.seedSession(ADMIN.subject)
    const response = await h.handler(
      withCookie(
        post('admin.invite', { email: 'New@Example.test', name: '  New Person  ', role: 'admin' }),
        token,
      ),
    )
    expect(response.status).toBe(200)
    expect(h.executed).toHaveLength(1)
    expect(h.executed[0].operation).toBe(IDENTITY_ADMIN_COMMANDS.invite)
    const params = h.executed[0].params as Record<string, string>
    expect(params.email).toBe('New@Example.test')
    expect(params.name).toBe('New Person')
    expect(params.role).toBe('admin')
    // The provider hashed a passphrase the endpoint invented and never returns.
    expect(params.passwordHash).toMatch(/^fake-scrypt\$/)
    expect(params.providerSubject).toBeTruthy()
  })

  it('emails the invited person a link, marked as an invitation and not a reset', async () => {
    const token = h.identity.seedSession(ADMIN.subject)
    const response = await h.handler(
      withCookie(
        post('admin.invite', { email: 'New@Example.test', name: 'New', role: 'member' }),
        token,
      ),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      invitation: { delivered: boolean }
      warning?: string
    }
    expect(body.invitation.delivered).toBe(true)
    // A clean invite carries no warning: the account exists and its owner can
    // reach it, which is the whole of what was asked for.
    expect(body.warning).toBeUndefined()
    // The account was created with a passphrase nobody knows, so this letter is
    // the only route in. Without it the invite creates an unreachable account —
    // which is what it did, in production, for a real tenant.
    expect(h.identity.resetRequests).toEqual([
      { email: 'new@example.test', purpose: 'invitation' },
    ])
  })

  it('creates the member anyway when the invitation email cannot be sent, and says so', async () => {
    h.identity.failResetDelivery = new ResetMailDeliveryError(422)
    h.identity.failResetDeliveryStatus = 422
    const token = h.identity.seedSession(ADMIN.subject)
    const response = await h.handler(
      withCookie(
        post('admin.invite', { email: 'new@example.test', name: 'New', role: 'member' }),
        token,
      ),
    )
    // 200, because the membership committed and rolling it back over a mail
    // provider's bad minute would be worse. But not a silent 200: the admin is
    // the only person who can tell this teammate the email is not coming.
    expect(response.status).toBe(200)
    expect(h.executed).toHaveLength(1)
    expect(h.executed[0].operation).toBe(IDENTITY_ADMIN_COMMANDS.invite)
    const body = (await response.json()) as {
      ok: boolean
      warning?: string
      invitation: { delivered: boolean; subsystem?: string; providerStatus?: number }
    }
    expect(body.ok).toBe(true)
    expect(body.invitation).toMatchObject({
      delivered: false,
      subsystem: 'reset_delivery',
      providerStatus: 422,
    })
    expect(body.warning).toContain('could not be')
  })

  it('does not call a 200 with no send a delivered invitation', async () => {
    // The candidate answers 200 whatever the sink did: it awaits the send and
    // then swallows what it throws (better-auth 1.6.25). An endpoint that read
    // delivery off that status would tell the admin an email was on its way to
    // somebody who is never going to get one — which is the failure this whole
    // change exists to end, reintroduced one layer up.
    h.identity.silentResetDelivery = true
    const token = h.identity.seedSession(ADMIN.subject)
    const response = await h.handler(
      withCookie(
        post('admin.invite', { email: 'new@example.test', name: 'New', role: 'member' }),
        token,
      ),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { warning?: string; invitation: { delivered: boolean } }
    expect(body.invitation.delivered).toBe(false)
    expect(body.warning).toBeTruthy()
  })

  it('sends the invitation without the admin\'s session, and with the deployment\'s own origin', async () => {
    const seen: Request[] = []
    const handle = h.identity.handle.bind(h.identity)
    h.identity.handle = async (request: Request) => {
      seen.push(request.clone())
      return handle(request)
    }
    const token = h.identity.seedSession(ADMIN.subject)
    await h.handler(
      withCookie(
        post('admin.invite', { email: 'new@example.test', name: 'New', role: 'member' }),
        token,
      ),
    )
    expect(seen).toHaveLength(1)
    // The admin's cookie is not this person's to carry into a flow that mints a
    // credential for somebody else.
    expect(seen[0].headers.get('cookie')).toBeNull()
    // C1 is the candidate's too: a POST it does not recognise the origin of is
    // refused, so the request carries the origin the deployment is.
    expect(seen[0].headers.get('origin')).toBe(ORIGIN)
    expect(new URL(seen[0].url).pathname).toBe(
      `${IDENTITY_BASE_PATH}${CANDIDATE_ROUTES['password.requestReset']}`,
    )
  })

  it('refuses to report a reset link the mail provider would not take', async () => {
    h.identity.failResetDelivery = new ResetMailDeliveryError(422)
    h.identity.failResetDeliveryStatus = 422
    const response = await h.handler(
      post('password.requestReset', { email: MEMBER.email, redirectTo: `${ORIGIN}/` }),
    )
    // Not the candidate's 200. Somebody waiting on a link that is not coming
    // should be told to try again, not left refreshing an inbox.
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      subsystem: 'reset_delivery',
      providerStatus: 422,
    })
  })

  it('still answers an unknown address exactly as the candidate does', async () => {
    // No send attempted is not a failure: it is what an address with no account
    // produces. Turning it into a 503 would make this endpoint an oracle for
    // which addresses are registered.
    h.identity.silentResetDelivery = true
    const response = await h.handler(
      post('password.requestReset', { email: 'nobody@example.test', redirectTo: `${ORIGIN}/` }),
    )
    expect(response.status).toBe(200)
  })

  it('leaves an ordinary reset an ordinary reset', async () => {
    // The forwarded operation shares the candidate route with the invite, so
    // the purpose has to come from the caller and not from the route. A person
    // who forgot their password must not be told an account was just made for
    // them.
    const response = await h.handler(
      post('password.requestReset', { email: MEMBER.email, redirectTo: `${ORIGIN}/` }),
    )
    expect(response.status).toBe(200)
    expect(h.identity.resetRequests).toEqual([
      { email: MEMBER.email, purpose: 'reset' },
    ])
  })

  it('never returns the invented passphrase or the hash', async () => {
    const token = h.identity.seedSession(ADMIN.subject)
    const response = await h.handler(
      withCookie(
        post('admin.invite', { email: 'new@example.test', name: 'New', role: 'member' }),
        token,
      ),
    )
    const text = await response.text()
    expect(text).not.toContain('fake-scrypt')
    expect(text).not.toContain('passwordHash')
  })

  it('validates admin arguments before reaching the database', async () => {
    const token = h.identity.seedSession(ADMIN.subject)
    const bad: [string, unknown][] = [
      ['admin.invite', { email: 'not-an-address', name: 'X', role: 'member' }],
      ['admin.invite', { email: 'a@b.test', name: '', role: 'member' }],
      ['admin.invite', { email: 'a@b.test', name: 'X', role: 'superuser' }],
      ['admin.setActive', { userId: MEMBER.actorId }],
      ['admin.setActive', { userId: '', active: false }],
      ['admin.setRole', { userId: MEMBER.actorId, role: 'root' }],
    ]
    for (const [op, body] of bad) {
      const response = await h.handler(withCookie(post(op, body), token))
      expect(response.status, `${op} ${JSON.stringify(body)}`).toBe(400)
    }
    expect(h.executed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C2's second half: disabling someone must also end their session.
// ---------------------------------------------------------------------------

describe('disabling a member revokes their sessions (C2)', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
    resetPruneClock()
  })

  it('revokes the disabled person’s sessions and reports how many', async () => {
    const adminToken = h.identity.seedSession(ADMIN.subject)
    // Two live sessions for the person about to be disabled.
    h.identity.seedAccount({
      email: 'invited@example.test',
      password: 'pw',
      subject: 'subject-invited',
    })
    h.identity.seedSession('subject-invited')
    h.identity.seedSession('subject-invited')
    const before = h.identity.sessionCount()

    const response = await h.handler(
      withCookie(post('admin.setActive', { userId: MEMBER.actorId, active: false }), adminToken),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, sessionsRevoked: 2 })
    expect(h.identity.sessionCount()).toBe(before - 2)
  })

  it('does not revoke anything when re-enabling someone', async () => {
    const adminToken = h.identity.seedSession(ADMIN.subject)
    h.identity.seedAccount({
      email: 'invited@example.test',
      password: 'pw',
      subject: 'subject-invited',
    })
    h.identity.seedSession('subject-invited')
    const before = h.identity.sessionCount()

    const response = await h.handler(
      withCookie(post('admin.setActive', { userId: MEMBER.actorId, active: true }), adminToken),
    )
    expect(await response.json()).toMatchObject({ sessionsRevoked: null })
    expect(h.identity.sessionCount()).toBe(before)
  })

  it('takes the subject from the database, not from the request', async () => {
    // An admin must not be able to aim a revocation at a subject unrelated to the
    // member they disabled, so the subject comes from the function's return value.
    const adminToken = h.identity.seedSession(ADMIN.subject)
    h.identity.seedAccount({
      email: 'invited@example.test',
      password: 'pw',
      subject: 'subject-invited',
    })
    h.identity.seedSession('subject-invited')
    const adminSessionsBefore = h.identity.sessionCount()

    await h.handler(
      withCookie(
        post('admin.setActive', {
          userId: MEMBER.actorId,
          active: false,
          // Ignored: not a parameter this endpoint reads.
          providerSubject: ADMIN.subject,
        }),
        adminToken,
      ),
    )

    // The admin's own session survives; only the disabled person's went.
    expect(adminSessionsBefore - h.identity.sessionCount()).toBe(1)
    const stillValid = await h.handler(get('session.current', adminToken))
    expect(stillValid.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Session lifecycle through the fake: expiry, revocation, pruning (C4).
// ---------------------------------------------------------------------------

describe('session expiry, revocation and pruning (C4)', () => {
  it('an expired session is refused and is not distinguishable from an absent one', async () => {
    let now = 1_000_000
    const h = harness({ now: () => now })
    const token = h.identity.seedSession(MEMBER.subject, 60)

    expect((await h.handler(get('session.current', token))).status).toBe(200)
    now += 61_000
    expect((await h.handler(get('session.current', token))).status).toBe(401)
    expect((await h.handler(get('session.current'))).status).toBe(401)
  })

  it('revocation is immediate', async () => {
    const h = harness()
    const token = h.identity.seedSession(MEMBER.subject)
    expect((await h.handler(get('session.current', token))).status).toBe(200)
    await h.identity.revokeSessions(MEMBER.subject)
    expect((await h.handler(get('session.current', token))).status).toBe(401)
  })

  it('pruning removes expired sessions and leaves live ones alone', async () => {
    let now = 1_000_000
    const h = harness({ now: () => now })
    h.identity.seedSession(MEMBER.subject, 60)
    h.identity.seedSession(ADMIN.subject, 3600)
    expect(h.identity.sessionCount()).toBe(2)

    now += 61_000
    const pruned = await h.identity.pruneExpiredSessions()
    expect(pruned).toBe(1)
    expect(h.identity.sessionCount()).toBe(1)
  })

  it('the scheduled sweep runs once per interval, not per request', async () => {
    const h = harness()
    resetPruneClock()
    let sweeps = 0
    const counting = {
      ...h.identity,
      pruneExpiredSessions: async () => {
        sweeps += 1
        return 0
      },
    } as unknown as FakeIdentityProvider

    await pruneSessionsIfDue(counting, 10_000_000)
    await pruneSessionsIfDue(counting, 10_000_001)
    await pruneSessionsIfDue(counting, 10_000_002)
    expect(sweeps).toBe(1)

    // Past the interval, it runs again.
    await pruneSessionsIfDue(counting, 10_000_000 + 6 * 60 * 60 * 1000 + 1)
    expect(sweeps).toBe(2)
  })

  it('a failing sweep never breaks the request that triggered it', async () => {
    resetPruneClock()
    const exploding = {
      pruneExpiredSessions: async () => {
        throw new Error('database is on fire')
      },
    } as unknown as FakeIdentityProvider
    await expect(pruneSessionsIfDue(exploding, 20_000_000)).resolves.toBeUndefined()
  })

  it('the explicit pruning operation refuses an ordinary member', async () => {
    const h = harness()
    const token = h.identity.seedSession(MEMBER.subject)
    const response = await h.handler(
      withCookie(post('maintenance.pruneSessions'), token),
    )
    expect(response.status).toBe(403)
  })

  it('the explicit pruning operation allows an admin', async () => {
    const h = harness()
    const token = h.identity.seedSession(ADMIN.subject)
    const response = await h.handler(
      withCookie(post('maintenance.pruneSessions'), token),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// The candidate's own routes, and what the dispatcher does with them.
// ---------------------------------------------------------------------------

describe('candidate route forwarding', () => {
  it('forwards a sign-in to the candidate and returns its Set-Cookie', async () => {
    const h = harness()
    const response = await h.handler(
      post('session.signIn', { email: MEMBER.email, password: 'pw' }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain(FAKE_SESSION_COOKIE)
    // HttpOnly, so an XSS payload reading document.cookie gets nothing.
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
  })

  it('a wrong passphrase is refused, and says nothing about whether the account exists', async () => {
    const h = harness()
    const wrongPassword = await h.handler(
      post('session.signIn', { email: MEMBER.email, password: 'nope' }),
    )
    const noSuchAccount = await h.handler(
      post('session.signIn', { email: 'nobody@example.test', password: 'nope' }),
    )
    expect(wrongPassword.status).toBe(401)
    expect(noSuchAccount.status).toBe(401)
    expect(await wrongPassword.text()).toEqual(await noSuchAccount.text())
  })

  it('the body reaches the candidate unmodified and `op` does not', async () => {
    const h = harness()
    let seen: { url: string; body: string } | null = null
    const spy = {
      ...h.identity,
      name: 'fake',
      handle: async (request: Request) => {
        seen = { url: request.url, body: await request.text() }
        return new Response('{}', { status: 200 })
      },
      getSession: (headers: Headers) => h.identity.getSession(headers),
      pruneExpiredSessions: async () => 0,
    } as unknown as FakeIdentityProvider

    const handler = createIdentityHandler({
      identity: spy,
      store: h.store,
      trustedOrigin: ORIGIN,
      providerName: 'fake',
    })
    await handler(post('session.signIn', { email: MEMBER.email, password: 'pw' }))

    expect(seen).not.toBeNull()
    expect(seen!.url).toContain('/api/identity/sign-in/email')
    expect(seen!.url).not.toContain('op=')
    expect(JSON.parse(seen!.body)).toEqual({ email: MEMBER.email, password: 'pw' })
  })

  it('password.change is allowlisted, POST-only and origin-checked', async () => {
    // It exists because password.requestReset needs email this deployment does
    // not have, so without it nobody could ever change a password. The candidate
    // requires the current password and a valid session, so the product adds no
    // authorization of its own — but it must still be a POST and must still be
    // origin-checked, or it would be CSRF-reachable.
    const h = harness()

    expect((await h.handler(get('password.change'))).status).toBe(405)

    const hostile = new Request(`${ORIGIN}/api/identity?op=password.change`, {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'pw', newPassword: 'new' }),
    })
    const refused = await h.handler(hostile)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: 'INVALID_ORIGIN' })
  })

  it('password.change forwards to the candidate route, body intact', async () => {
    const h = harness()
    let seenUrl = ''
    let seenBody = ''
    const spy = {
      ...h.identity,
      name: 'fake',
      handle: async (request: Request) => {
        seenUrl = request.url
        seenBody = await request.text()
        return new Response('{}', { status: 200 })
      },
      pruneExpiredSessions: async () => 0,
    } as unknown as FakeIdentityProvider

    const handler = createIdentityHandler({
      identity: spy,
      store: h.store,
      trustedOrigin: ORIGIN,
      providerName: 'fake',
    })
    const token = h.identity.seedSession(MEMBER.subject)
    await handler(
      withCookie(
        post('password.change', { currentPassword: 'pw', newPassword: 'a-new-one' }),
        token,
      ),
    )

    expect(seenUrl).toContain('/api/identity/change-password')
    // Both values reach the candidate and neither is touched on the way.
    expect(JSON.parse(seenBody)).toEqual({
      currentPassword: 'pw',
      newPassword: 'a-new-one',
    })
  })

  it('signs out, and the session stops working', async () => {
    const h = harness()
    const token = h.identity.seedSession(MEMBER.subject)
    expect((await h.handler(get('session.current', token))).status).toBe(200)
    await h.handler(withCookie(post('session.signOut'), token))
    expect((await h.handler(get('session.current', token))).status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// The registry: what the request path may ask the database for.
// ---------------------------------------------------------------------------

describe('the operation registry', () => {
  it('has exactly one actorless operation, and it is the actor resolver', () => {
    // A read that runs with no actor published is the sharpest tool in the
    // driver. It exists for one reason and the count is pinned so a second one
    // cannot be added quietly.
    const registry = buildApplicationRegistry()
    expect(registry.actorlessOperationNames()).toEqual(['identity.resolveActor'])
    expect(APPLICATION_ACTORLESS_OPERATIONS).toEqual(['identity.resolveActor'])
  })

  it('the resolver is neither a query nor a command', () => {
    const registry = buildApplicationRegistry()
    expect(() => registry.lookupQuery(IDENTITY_OPERATIONS.resolveActor)).toThrow(
      /not allowlisted/,
    )
    expect(() => registry.lookupCommand(IDENTITY_OPERATIONS.resolveActor)).toThrow(
      /not allowlisted/,
    )
  })

  it('registers exactly the three identity admin commands and no table write', () => {
    const registry = buildApplicationRegistry()
    for (const operation of Object.values(IDENTITY_ADMIN_COMMANDS)) {
      expect(() => registry.lookupCommand(operation)).not.toThrow()
    }
    for (const forbidden of [
      'leads.update',
      'team_members.update',
      'users.insert',
      'user_identities.insert',
      'admin_update_team_member',
    ]) {
      expect(() => registry.lookupCommand(forbidden)).toThrow(/not allowlisted/)
    }
  })

  it('the roster read is a query and not a command', () => {
    const registry = buildApplicationRegistry()
    expect(() => registry.lookupQuery(IDENTITY_OPERATIONS.teamRoster)).not.toThrow()
    expect(() => registry.lookupCommand(IDENTITY_OPERATIONS.teamRoster)).toThrow(
      /not allowlisted/,
    )
  })

  it("S12's resolveSelf is exported for S16's evidence but is NOT reachable", () => {
    // The fence, pinned. `spikes/s16-identity/tests/mapping.neon.test.ts` is G3's
    // live evidence and exercises the mapping through this operation against the
    // product's own driver, building its own registry — so it needs the symbol,
    // not the registration. Deleting the symbol would invalidate that evidence to
    // save a few lines; registering it would give the request path a second,
    // weaker way to resolve an actor. Exported and unregistered is the answer, and
    // this test is what stops either half from drifting.
    expect(resolveSelfOperation).toBeTypeOf('object')
    expect(IDENTITY_OPERATIONS.resolveSelf).toBe('identity.resolveSelf')

    const registry = buildApplicationRegistry()
    expect(() => registry.lookupQuery(IDENTITY_OPERATIONS.resolveSelf)).toThrow(
      /not allowlisted/,
    )
    expect(() => registry.lookupCommand(IDENTITY_OPERATIONS.resolveSelf)).toThrow(
      /not allowlisted/,
    )
    expect(registry.actorlessOperationNames()).not.toContain(
      IDENTITY_OPERATIONS.resolveSelf,
    )
  })
})

// ---------------------------------------------------------------------------
// The fake store's own resolveActor contract, which the Neon adapter must match.
// ---------------------------------------------------------------------------

describe('resolveActor contract (fake side)', () => {
  it('resolves an exact pair and nothing else', async () => {
    const store = new FakeDataStore()
    store.seedActor('better-auth', 'subject-x', {
      actorId: MEMBER.actorId,
      role: 'member',
    })
    await expect(
      store.resolveActor({ provider: 'better-auth', subject: 'subject-x' }),
    ).resolves.toEqual({ actorId: MEMBER.actorId, role: 'member' })
  })

  it('is not an enumeration primitive', async () => {
    const store = new FakeDataStore()
    store.seedActor('better-auth', 'subject-x', {
      actorId: MEMBER.actorId,
      role: 'member',
    })
    for (const [provider, subject] of [
      ['better-auth', '%'],
      ['%', '%'],
      ['better-auth', ''],
      ['', 'subject-x'],
      ['better-auth', 'subject-'],
    ]) {
      await expect(store.resolveActor({ provider, subject })).resolves.toBeNull()
    }
  })
})

describe('the routes forwarded to the candidate exist in the candidate', () => {
  /**
   * Every mapped route, checked against the candidate's own endpoint table.
   *
   * `password.requestReset` pointed at `/forget-password` — a name this version
   * does not serve — so the operation answered 404 from the day it shipped. It
   * survived because the other half of the flow was broken too: the reset link
   * was discarded before delivery, so nobody ever got far enough to see the 404.
   * A mapping to a name the dependency does not have is exactly what an upgrade
   * breaks silently, which is why this asserts against the table and not a list.
   */
  it('maps every operation to a path the installed candidate serves', async () => {
    const { betterAuth } = await import('better-auth')
    const options = buildCandidateOptions(
      {
        config: {
          connectionString: 'postgres://user@host/db',
          sessionSecret: 'x'.repeat(32),
          baseUrl: 'https://tenant.example.test',
          basePath: IDENTITY_BASE_PATH,
          useSecureCookies: true,
        },
      },
      // A pool shape that answers, so the candidate's adapter initialises and
      // registers its routes instead of rejecting in the background. Nothing
      // here executes a query: only the route table is read.
      {
        query: async () => ({ rows: [], rowCount: 0 }),
        connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
        on: () => {},
        end: async () => {},
      } as never,
    )
    const candidate = betterAuth(options as never) as unknown as {
      api: Record<string, { path?: string }>
    }
    const served = new Set(
      Object.values(candidate.api)
        .map((endpoint) => endpoint?.path)
        .filter((path): path is string => typeof path === 'string'),
    )
    expect(served.size).toBeGreaterThan(0)
    for (const [operation, route] of Object.entries(CANDIDATE_ROUTES)) {
      expect(served.has(route), `${operation} -> ${route}`).toBe(true)
    }
  })
})
