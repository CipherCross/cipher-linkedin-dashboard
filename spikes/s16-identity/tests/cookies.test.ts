/**
 * Session cookies: what the candidate actually sets, and what a browser does
 * with it — including across a redirect.
 *
 * Everything below is a **measurement**. No test asserts "a cookie exists"; each
 * one reads the attributes off the wire and records them.
 *
 * What these tests do NOT cover, stated once for all of them:
 * - They use the spike's RFC 6265 jar, not a browser engine. Chrome's
 *   two-minute `SameSite=Lax` POST exception, third-party cookie policy,
 *   cookie partitioning (CHIPS) and `__Host-`/`__Secure-` prefix *enforcement*
 *   are not exercised.
 * - The harness speaks plain HTTP on localhost, so TLS itself is not exercised;
 *   the `Secure` behaviour is measured through the jar's storage rule.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CookieJar, jarFetch, parseSetCookie } from '../src/cookieJar.js'
import { AUTH_BASE_PATH } from '../src/spikeAuth.js'
import { createWorld, type World } from './support/world.js'

const PASSPHRASE = 'correct-horse-battery-staple-16'

describe('session cookie attributes', () => {
  let world: World
  let email: string

  beforeAll(async () => {
    world = await createWorld()
    email = `cookies-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE })
  })

  afterAll(async () => {
    await world?.close()
  })

  it('sets exactly one session cookie on sign-in, and records its attributes', async () => {
    const jar = new CookieJar()
    const { response } = await world.signIn(jar, email, PASSPHRASE)
    expect(response.status).toBe(200)

    const headers = response.headers.getSetCookie()
    expect(headers.length).toBeGreaterThan(0)

    const parsed = headers
      .map((header) => parseSetCookie(header, world.origin))
      .filter((cookie): cookie is NonNullable<typeof cookie> => cookie !== null)

    const session = parsed.find((cookie) => cookie.name.includes('session_token'))
    expect(session, `no session cookie among ${parsed.map((c) => c.name).join(', ')}`).toBeDefined()

    // The measured posture, recorded as one object so a change to any single
    // attribute fails here and has to be re-decided rather than absorbed.
    expect({
      httpOnly: session!.httpOnly,
      sameSite: session!.sameSite,
      path: session!.path,
      hasMaxAge: session!.maxAge !== null,
      maxAgeSeconds: session!.maxAge,
    }).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      hasMaxAge: true,
      maxAgeSeconds: 60 * 60 * 24 * 7,
    })
  })

  it('keeps the session cookie out of reach of script', async () => {
    const jar = new CookieJar()
    await world.signIn(jar, email, PASSPHRASE)

    // What `document.cookie` — and therefore an XSS payload — would see.
    expect(jar.scriptVisible()).toEqual([])
    expect(jar.all().every((cookie) => cookie.httpOnly)).toBe(true)
  })

  it('scopes the cookie to the whole origin, not to the auth path', async () => {
    const jar = new CookieJar()
    await world.signIn(jar, email, PASSPHRASE)

    // Path=/ means the session cookie rides along on *every* request to the
    // origin, including the product's own /api routes and static assets. That
    // is what makes the whoami route work without any extra plumbing, and it
    // is also the reason CSRF has to be handled per-request rather than by
    // hoping the cookie is narrowly scoped.
    expect(jar.header(`${world.origin}/api/s16-whoami`)).toContain('session_token')
    expect(jar.header(`${world.origin}/index.html`)).toContain('session_token')
  })

  it('a browser refuses to store a Secure cookie over plain HTTP', async () => {
    // Same candidate, `useSecureCookies` on, still served over http — which is
    // exactly what a local `vercel dev` or the S12 harness looks like.
    const secureWorld = await createWorld({ useSecureCookies: true })
    try {
      const secureEmail = `cookies-secure-${Date.now()}@example.test`
      await secureWorld.invite({ email: secureEmail, password: PASSPHRASE })

      const jar = new CookieJar()
      const { response } = await secureWorld.signIn(jar, secureEmail, PASSPHRASE)
      expect(response.status).toBe(200)

      // The header is sent…
      expect(response.headers.getSetCookie().join(';').toLowerCase()).toContain('secure')
      // …and the browser drops it on the floor, so the next request is anonymous.
      expect(jar.all()).toEqual([])
      expect(jar.rejected.map((entry) => entry.reason)).toContain(
        'Secure cookie over a non-HTTPS connection',
      )

      const { response: who } = await secureWorld.whoAmI(jar)
      expect(who.status).toBe(401)
    } finally {
      await secureWorld.close()
    }
  })
})

describe('cookies across a redirect', () => {
  let world: World
  let email: string

  beforeAll(async () => {
    world = await createWorld()
    email = `redirect-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE })
  })

  afterAll(async () => {
    await world?.close()
  })

  it('an HttpOnly session survives a real 302 to another path', async () => {
    const jar = new CookieJar()
    await world.signIn(jar, email, PASSPHRASE)

    // The password-reset email link is the candidate's one genuine 3xx: a GET
    // that consumes a token and redirects. `sign-in/email` with `callbackURL`
    // does *not* redirect — it answers `{"redirect":true,"url":…}` and leaves
    // the hop to the client, which is worth knowing before designing S18.
    const requested = await world.post(`${AUTH_BASE_PATH}/request-password-reset`, {
      body: JSON.stringify({ email, redirectTo: `${world.origin}/api/s16-whoami` }),
    })
    expect(requested.response.status).toBe(200)

    const captured = world.auth.resetTokens.at(-1)
    expect(captured).toBeDefined()

    const result = await jarFetch(jar, captured!.url, { method: 'GET' })

    // Hop 1 is the 302; hop 2 is the target, reached with the session cookie
    // the jar already held — which is what `Path=/` buys and what makes a
    // post-sign-in landing redirect work without extra plumbing.
    expect(result.chain.length).toBe(2)
    expect(result.chain[0].status).toBe(302)
    expect(new URL(result.chain[1].url).pathname).toBe('/api/s16-whoami')
    expect(result.response.status).toBe(200)

    const body = JSON.parse(result.body) as { subject: string }
    expect(body.subject).toBeTruthy()
  })

  it('refuses to redirect to an untrusted origin', async () => {
    // The same 3xx machinery is an open-redirect surface, so the guard on it is
    // part of the cookie story: a redirect off-origin would carry a signed-in
    // user to an attacker's page with the reset token in the query string.
    const refused = await world.post(`${AUTH_BASE_PATH}/request-password-reset`, {
      body: JSON.stringify({ email, redirectTo: 'https://evil.invalid/steal' }),
    })
    expect(refused.response.status).toBe(403)
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'INVALID_REDIRECT_URL' })
  })
})
