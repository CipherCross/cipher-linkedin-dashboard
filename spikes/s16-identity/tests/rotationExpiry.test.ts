/**
 * What happens to a session at expiry, and what "rotation" actually means for
 * this candidate.
 *
 * The short version, measured below: the session **expiry** slides forward
 * while the session is in use, but the session **token** does not change. There
 * is no rolling token. That is a deliberate design in the candidate and it has
 * consequences S17 has to accept knowingly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CookieJar } from '../src/cookieJar.js'
import { AUTH_BASE_PATH } from '../src/spikeAuth.js'
import { createWorld, type World } from './support/world.js'

const PASSPHRASE = 'correct-horse-battery-staple-16'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('expiry', () => {
  let world: World

  beforeAll(async () => {
    // Three seconds, so the test measures a real expiry rather than a clock
    // that was moved. `updateAge` above `expiresIn` disables the refresh, so
    // the session cannot slide out from under the assertion.
    world = await createWorld({ sessionExpiresInSeconds: 3, sessionUpdateAgeSeconds: 3600 })
  })
  afterAll(async () => {
    await world?.close()
  })

  it('stops authenticating once the expiry passes, without any server action', async () => {
    const email = `expiry-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE })

    const jar = new CookieJar()
    await world.signIn(jar, email, PASSPHRASE)

    const cookie = jar.get('s16.session_token')
    expect(cookie?.maxAge).toBe(3)
    expect((await world.whoAmI(jar)).response.status).toBe(200)

    await wait(3_500)

    // Two independent things have happened, and both matter:
    // 1. the browser has dropped the cookie, because Max-Age elapsed;
    expect(jar.header(`${world.origin}/`)).toBeNull()
    // 2. and even replaying the raw value, the server refuses it.
    const replayed = await fetch(`${world.origin}/api/s16-whoami`, {
      headers: { cookie: `${cookie!.name}=${cookie!.value}` },
    })
    expect(replayed.status).toBe(401)
  })

  it('prunes an expired session when it is presented, but not otherwise', async () => {
    const presented = `expiry-presented-${Date.now()}@example.test`
    const abandoned = `expiry-abandoned-${Date.now()}@example.test`
    const a = await world.invite({ email: presented, password: PASSPHRASE })
    const b = await world.invite({ email: abandoned, password: PASSPHRASE })

    const usedJar = new CookieJar()
    const abandonedJar = new CookieJar()
    await world.signIn(usedJar, presented, PASSPHRASE)
    await world.signIn(abandonedJar, abandoned, PASSPHRASE)
    const used = usedJar.get('s16.session_token')!
    const stale = abandonedJar.get('s16.session_token')!

    await wait(3_500)

    // Presented raw, because a browser would already have dropped the cookie
    // at Max-Age and sent nothing at all — which is itself worth stating: the
    // server-side expiry check only ever runs against a client that ignores
    // the cookie's own lifetime, i.e. an attacker replaying a captured value.
    const replayed = await fetch(`${world.origin}/api/s16-whoami`, {
      headers: { cookie: `${used.name}=${used.value}` },
    })
    expect(replayed.status).toBe(401)

    // The refused request cleaned up after itself…
    const afterPresenting = await world.auth.pool.query(
      `SELECT count(*)::int AS n FROM "session" WHERE "userId" = $1`,
      [a.subject],
    )
    expect(afterPresenting.rows[0].n).toBe(0)

    // …but the session nobody ever comes back to is still in the table.
    // FINDING: pruning is lazy and access-driven, so `session` accumulates one
    // row per abandoned login for the life of the product. A housekeeping job
    // S17 has to own — not a security hole, since an expired row is never
    // honoured, but not self-limiting either.
    const abandonedRows = await world.auth.pool.query(
      `SELECT count(*)::int AS n FROM "session" WHERE "userId" = $1 AND "expiresAt" < now()`,
      [b.subject],
    )
    expect(abandonedRows.rows[0].n).toBe(1)
    expect(stale.expiresAt).toBeLessThan(Date.now())
  })
})

describe('rotation', () => {
  let world: World

  beforeAll(async () => {
    // A one-second refresh window, so an ordinary request crosses it.
    world = await createWorld({ sessionExpiresInSeconds: 120, sessionUpdateAgeSeconds: 1 })
  })
  afterAll(async () => {
    await world?.close()
  })

  it('slides the expiry forward on use, and keeps the same token', async () => {
    const email = `rotate-${Date.now()}@example.test`
    const invited = await world.invite({ email, password: PASSPHRASE })

    const jar = new CookieJar()
    await world.signIn(jar, email, PASSPHRASE)
    const tokenBefore = jar.get('s16.session_token')!.value

    const rowBefore = await world.auth.pool.query(
      `SELECT token, "expiresAt" FROM "session" WHERE "userId" = $1`,
      [invited.subject],
    )
    expect(rowBefore.rowCount).toBe(1)

    await wait(1_500)
    expect((await world.whoAmI(jar)).response.status).toBe(200)

    const rowAfter = await world.auth.pool.query(
      `SELECT token, "expiresAt" FROM "session" WHERE "userId" = $1`,
      [invited.subject],
    )
    expect(rowAfter.rowCount).toBe(1)

    // The expiry moved…
    expect(new Date(rowAfter.rows[0].expiresAt).getTime()).toBeGreaterThan(
      new Date(rowBefore.rows[0].expiresAt).getTime(),
    )
    // …and the credential itself did not. A token captured on day one is still
    // the valid token on day thirty, as long as the session keeps being used.
    expect(rowAfter.rows[0].token).toBe(rowBefore.rows[0].token)
    expect(jar.get('s16.session_token')!.value).toBe(tokenBefore)
  })

  it('issues a distinct session per sign-in, and leaves the earlier ones live', async () => {
    const email = `multi-${Date.now()}@example.test`
    const invited = await world.invite({ email, password: PASSPHRASE })

    const first = new CookieJar()
    const second = new CookieJar()
    await world.signIn(first, email, PASSPHRASE)
    await world.signIn(second, email, PASSPHRASE)

    expect(first.get('s16.session_token')!.value).not.toBe(second.get('s16.session_token')!.value)
    expect((await world.whoAmI(first)).response.status).toBe(200)
    expect((await world.whoAmI(second)).response.status).toBe(200)

    const rows = await world.auth.pool.query(
      `SELECT count(*)::int AS n FROM "session" WHERE "userId" = $1`,
      [invited.subject],
    )
    expect(rows.rows[0].n).toBe(2)
  })

  it('sign-out ends one session; revoke-sessions ends them all', async () => {
    const email = `revoke-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE })

    const first = new CookieJar()
    const second = new CookieJar()
    await world.signIn(first, email, PASSPHRASE)
    await world.signIn(second, email, PASSPHRASE)

    const signedOut = await world.post(`${AUTH_BASE_PATH}/sign-out`, { body: '{}' }, first)
    expect(signedOut.response.status).toBe(200)
    expect((await world.whoAmI(first)).response.status).toBe(401)
    // The other device is untouched — which is correct, and is also why a
    // compromise response needs `revoke-sessions` rather than a sign-out.
    expect((await world.whoAmI(second)).response.status).toBe(200)

    const revoked = await world.post(`${AUTH_BASE_PATH}/revoke-sessions`, { body: '{}' }, second)
    expect(revoked.response.status).toBe(200)
    expect((await world.whoAmI(second)).response.status).toBe(401)
  })

  it('a session issued before sign-in cannot be adopted by it', async () => {
    // Session fixation: plant a cookie, then sign in carrying it, and check the
    // browser ends up with a different session than the planted one.
    const email = `fixation-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE })

    const victim = new CookieJar()
    // Plant an arbitrary value under the session cookie's name.
    victim.applyResponse(
      new Response(null, { headers: { 'set-cookie': 's16.session_token=planted-value; Path=/' } }),
      `${world.origin}/`,
    )
    expect(victim.get('s16.session_token')!.value).toBe('planted-value')

    await world.signIn(victim, email, PASSPHRASE)
    expect(victim.get('s16.session_token')!.value).not.toBe('planted-value')
    expect((await world.whoAmI(victim)).response.status).toBe(200)
  })
})
