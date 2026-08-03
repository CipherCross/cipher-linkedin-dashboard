/**
 * CSRF. Every case below is a **refusal observed over HTTP**, with the status
 * and error code the candidate actually returned — not an assertion that a
 * defence exists.
 *
 * How the candidate's defence is built, as measured rather than as documented:
 *
 * - There is **no synchroniser token**. Nothing in a session-cookie flow issues
 *   a per-form nonce that must be echoed back. Asking "is a state-changing
 *   request without the token refused" therefore has to be re-posed as "is a
 *   state-changing request without a *trusted origin* refused", which is the
 *   defence the candidate actually implements.
 * - Origin validation fires only when the request carries a `Cookie` header
 *   (`validateOrigin`: `const useCookies = headers.has("cookie")`). That is
 *   coherent — an unauthenticated request has no authority to abuse — but it
 *   means login CSRF is handled by a separate fetch-metadata path.
 * - `SameSite=Lax` on the session cookie is the first line: a browser will not
 *   attach it to a cross-site POST at all, so the origin check is the second
 *   line, for the cases where it would.
 * - **GET is exempt.** `originCheckMiddleware` returns immediately for GET,
 *   HEAD and OPTIONS. Any state-changing GET is therefore unprotected — a
 *   constraint on S17's own endpoints, not on the candidate.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CookieJar } from '../src/cookieJar.js'
import { AUTH_BASE_PATH } from '../src/spikeAuth.js'
import { createWorld, type World } from './support/world.js'

const PASSPHRASE = 'correct-horse-battery-staple-16'
const HOSTILE_ORIGIN = 'https://evil.invalid'

interface Attempt {
  readonly status: number
  readonly code: string | null
}

async function attempt(
  origin: string,
  path: string,
  init: RequestInit & { readonly headers: Record<string, string> },
): Promise<Attempt> {
  const response = await fetch(`${origin}${path}`, { ...init, redirect: 'manual' })
  const text = await response.text()
  let code: string | null = null
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? null
  } catch {
    code = null
  }
  return { status: response.status, code }
}

describe('CSRF on state-changing requests', () => {
  let world: World
  let cookie: string
  let email: string

  beforeAll(async () => {
    world = await createWorld()
    email = `csrf-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE })

    const jar = new CookieJar()
    const signedIn = await world.signIn(jar, email, PASSPHRASE)
    expect(signedIn.response.status).toBe(200)
    cookie = jar.header(`${world.origin}/`) as string
    expect(cookie).toContain('session_token')
  })

  afterAll(async () => {
    await world?.close()
  })

  it('accepts the same request from its own origin — the control', async () => {
    expect(
      await attempt(world.origin, `${AUTH_BASE_PATH}/update-user`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: world.origin, cookie },
        body: JSON.stringify({ name: 'legitimate rename' }),
      }),
    ).toEqual({ status: 200, code: null })
  })

  it('refuses a state change carrying a valid session from a hostile origin', async () => {
    expect(
      await attempt(world.origin, `${AUTH_BASE_PATH}/update-user`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: HOSTILE_ORIGIN, cookie },
        body: JSON.stringify({ name: 'attacker rename' }),
      }),
    ).toEqual({ status: 403, code: 'INVALID_ORIGIN' })
  })

  it('refuses a state change with no Origin header at all', async () => {
    // The interesting one: a request that simply omits the header must not be
    // treated as same-origin by default.
    expect(
      await attempt(world.origin, `${AUTH_BASE_PATH}/update-user`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'attacker rename' }),
      }),
    ).toEqual({ status: 403, code: 'MISSING_OR_NULL_ORIGIN' })
  })

  it('refuses a cross-origin password change', async () => {
    expect(
      await attempt(world.origin, `${AUTH_BASE_PATH}/change-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: HOSTILE_ORIGIN, cookie },
        body: JSON.stringify({ currentPassword: PASSPHRASE, newPassword: 'attacker-password-999' }),
      }),
    ).toEqual({ status: 403, code: 'INVALID_ORIGIN' })
  })

  it('refuses a cross-origin sign-out', async () => {
    expect(
      await attempt(world.origin, `${AUTH_BASE_PATH}/sign-out`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: HOSTILE_ORIGIN, cookie },
        body: '{}',
      }),
    ).toEqual({ status: 403, code: 'INVALID_ORIGIN' })
  })

  it('refuses a cross-site navigation sign-in', async () => {
    // Login CSRF: a form on an attacker's page posting credentials so the
    // victim ends up signed in as the attacker. No cookie is involved, so the
    // fetch-metadata path is what has to catch it.
    expect(
      await attempt(world.origin, `${AUTH_BASE_PATH}/sign-in/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
        },
        body: new URLSearchParams({ email, password: PASSPHRASE }).toString(),
      }),
    ).toEqual({ status: 403, code: 'MISSING_OR_NULL_ORIGIN' })
  })

  it('refuses an off-origin callbackURL — the open-redirect half', async () => {
    expect(
      await attempt(world.origin, `${AUTH_BASE_PATH}/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: world.origin },
        body: JSON.stringify({ email, password: PASSPHRASE, callbackURL: `${HOSTILE_ORIGIN}/steal` }),
      }),
    ).toEqual({ status: 403, code: 'INVALID_CALLBACK_URL' })
  })

  it('a browser would not send the session cross-site in the first place', async () => {
    // SameSite=Lax, measured through the jar rather than assumed: the origin
    // check above is the second line of defence, not the only one.
    const jar = new CookieJar()
    await world.signIn(jar, email, PASSPHRASE)

    expect(jar.header(`${world.origin}/api/s16-whoami`, { crossSite: true, method: 'POST' })).toBeNull()
    expect(jar.header(`${world.origin}/api/s16-whoami`, { crossSite: false })).toContain('session_token')
  })
})

describe('the session token cannot be replayed across sessions', () => {
  let world: World

  beforeAll(async () => {
    world = await createWorld()
  })

  afterAll(async () => {
    await world?.close()
  })

  it('rejects a token whose signature does not match its value', async () => {
    const jar = new CookieJar()
    const email = `replay-a-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE })
    await world.signIn(jar, email, PASSPHRASE)

    const cookie = jar.get('s16.session_token')
    expect(cookie).toBeDefined()

    // The cookie is `<token>.<hmac>`. Flip the token and keep the signature.
    const [token, signature] = decodeURIComponent(cookie!.value).split('.')
    const forged = `${cookie!.name}=${encodeURIComponent(`${token.slice(0, -4)}AAAA.${signature}`)}`

    const response = await fetch(`${world.origin}/api/s16-whoami`, { headers: { cookie: forged } })
    expect(response.status).toBe(401)
  })

  it("rejects one user's token re-signed onto another user's cookie name", async () => {
    const jarA = new CookieJar()
    const jarB = new CookieJar()
    const emailA = `replay-b-${Date.now()}@example.test`
    const emailB = `replay-c-${Date.now()}@example.test`
    const a = await world.invite({ email: emailA, password: PASSPHRASE })
    await world.invite({ email: emailB, password: PASSPHRASE })

    await world.signIn(jarA, emailA, PASSPHRASE)
    await world.signIn(jarB, emailB, PASSPHRASE)

    const cookieA = decodeURIComponent(jarA.get('s16.session_token')!.value)
    const cookieB = decodeURIComponent(jarB.get('s16.session_token')!.value)

    // A's token spliced onto B's signature: the pairing is what is signed.
    const spliced = `${cookieA.split('.')[0]}.${cookieB.split('.')[1]}`
    const response = await fetch(`${world.origin}/api/s16-whoami`, {
      headers: { cookie: `s16.session_token=${encodeURIComponent(spliced)}` },
    })
    expect(response.status).toBe(401)

    // And A's own intact cookie still resolves to A, so the splice failed
    // because of the signature rather than because the session died.
    const still = await world.whoAmI(jarA)
    expect(still.response.status).toBe(200)
    expect(JSON.parse(still.body)).toMatchObject({ subject: a.subject })
  })

  it('stops accepting a token once its session is signed out', async () => {
    const jar = new CookieJar()
    const email = `replay-d-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE })
    await world.signIn(jar, email, PASSPHRASE)

    const stolen = jar.header(`${world.origin}/`) as string
    expect((await world.whoAmI(jar)).response.status).toBe(200)

    const signedOut = await fetch(`${world.origin}${AUTH_BASE_PATH}/sign-out`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: world.origin, cookie: stolen },
      body: '{}',
    })
    expect(signedOut.status).toBe(200)

    // The copy an attacker took before sign-out is now worthless: the session
    // row is gone, so the signature verifying is not enough.
    const replayed = await fetch(`${world.origin}/api/s16-whoami`, { headers: { cookie: stolen } })
    expect(replayed.status).toBe(401)
  })

  it('LIMIT: an intact stolen cookie works from anywhere, by design', async () => {
    // Stated as a test so it cannot be quietly forgotten. The session cookie is
    // a bearer credential: it is bound to the server's secret, not to the
    // client. There is no device binding, no IP pinning and no proof of
    // possession. Anyone holding the bytes is the user until it expires or is
    // revoked — which is the reason HttpOnly, Secure and revocation carry as
    // much weight as they do.
    const jar = new CookieJar()
    const email = `replay-e-${Date.now()}@example.test`
    const invited = await world.invite({ email, password: PASSPHRASE })
    await world.signIn(jar, email, PASSPHRASE)

    const stolen = jar.header(`${world.origin}/`) as string
    const elsewhere = await fetch(`${world.origin}/api/s16-whoami`, {
      headers: { cookie: stolen, 'user-agent': 'a different client entirely' },
    })
    expect(elsewhere.status).toBe(200)
    expect(await elsewhere.json()).toMatchObject({ subject: invited.subject })
  })
})

describe('the candidate disables its own CSRF defence under test detection', () => {
  let unsafe: World

  beforeAll(async () => {
    // `enforceOriginChecks: false` reproduces what the candidate does *by
    // default* when NODE_ENV is `test`, which is what every vitest run sets.
    unsafe = await createWorld({ enforceOriginChecks: false })
  })

  afterAll(async () => {
    await unsafe?.close()
  })

  it('the same hostile-origin request succeeds when the check is skipped', async () => {
    const email = `csrf-off-${Date.now()}@example.test`
    await unsafe.invite({ email, password: PASSPHRASE })
    const jar = new CookieJar()
    await unsafe.signIn(jar, email, PASSPHRASE)
    const cookie = jar.header(`${unsafe.origin}/`) as string

    // The identical request that returns 403 above returns 200 here. This is
    // the finding, not a curiosity: a CSRF suite written without setting
    // `advanced.disableOriginCheck: false` runs against a build with the
    // defence switched off and reports green.
    expect(
      await attempt(unsafe.origin, `${AUTH_BASE_PATH}/update-user`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: HOSTILE_ORIGIN, cookie },
        body: JSON.stringify({ name: 'attacker rename' }),
      }),
    ).toEqual({ status: 200, code: null })
  })
})
