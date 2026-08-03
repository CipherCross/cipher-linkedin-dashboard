/**
 * The membership lifecycle: invite, reset, disable — and specifically whether a
 * disabled person's **existing session** stops working, not merely whether
 * their next sign-in fails.
 *
 * The important structural result here is that there are *two* independent kill
 * switches, in two different stores, and they behave differently:
 *
 * - Revoking in the **canonical** tables (`team_members.active = false`) leaves
 *   the candidate's session perfectly valid and stops the request at
 *   authorization — 403, on the very next request, with no session bookkeeping
 *   at all. It works because the actor is re-resolved from the database on
 *   every request.
 * - Revoking in the **candidate's** store (`admin/ban-user`) destroys the
 *   session itself — 401, and no new sign-in either.
 *
 * S17 needs both, and needs them in one transaction; the last test here shows
 * that being possible only because the two stores share a database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'

import { CookieJar } from '../src/cookieJar.js'
import { AUTH_BASE_PATH, IDENTITY_SCHEMA } from '../src/spikeAuth.js'
import { createWorld, SPIKE_PROVIDER, type World } from './support/world.js'

const PASSPHRASE = 'correct-horse-battery-staple-16'
const NEW_PASSPHRASE = 'a-completely-different-passphrase-17'

describe('invite is the only way in', () => {
  let world: World

  beforeAll(async () => {
    world = await createWorld()
  })
  afterAll(async () => {
    await world?.close()
  })

  it('public sign-up is refused', async () => {
    const result = await world.post(`${AUTH_BASE_PATH}/sign-up/email`, {
      body: JSON.stringify({
        email: `walkin-${Date.now()}@example.test`,
        password: PASSPHRASE,
        name: 'Walk In',
      }),
    })
    expect(result.response.status).toBe(400)
    expect(JSON.parse(result.body)).toMatchObject({ code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' })
  })

  it('the admin create-user route refuses an anonymous caller', async () => {
    const result = await world.post(`${AUTH_BASE_PATH}/admin/create-user`, {
      body: JSON.stringify({
        email: `anon-invite-${Date.now()}@example.test`,
        password: PASSPHRASE,
        name: 'Anon Invite',
      }),
    })
    expect(result.response.status).toBe(401)
  })

  it('the admin create-user route refuses an ordinary member', async () => {
    const email = `member-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE, storeRole: 'user' })
    const jar = new CookieJar()
    await world.signIn(jar, email, PASSPHRASE)

    const result = await world.post(
      `${AUTH_BASE_PATH}/admin/create-user`,
      {
        body: JSON.stringify({
          email: `member-invite-${Date.now()}@example.test`,
          password: PASSPHRASE,
          name: 'Member Invite',
        }),
      },
      jar,
    )
    expect(result.response.status).toBe(403)
  })
})

describe('password reset', () => {
  let world: World
  let email: string

  beforeAll(async () => {
    world = await createWorld()
    email = `reset-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE })
  })
  afterAll(async () => {
    await world?.close()
  })

  it('issues a token to the configured sink and never anywhere else', async () => {
    const before = world.auth.resetTokens.length
    const result = await world.post(`${AUTH_BASE_PATH}/request-password-reset`, {
      body: JSON.stringify({ email, redirectTo: `${world.origin}/reset` }),
    })

    expect(result.response.status).toBe(200)
    expect(world.auth.resetTokens.length).toBe(before + 1)

    // The response body is deliberately identical whether or not the address
    // exists, so it is not an account-enumeration oracle.
    const unknown = await world.post(`${AUTH_BASE_PATH}/request-password-reset`, {
      body: JSON.stringify({ email: `nobody-${Date.now()}@example.test`, redirectTo: `${world.origin}/reset` }),
    })
    expect(unknown.response.status).toBe(200)
    expect(JSON.parse(unknown.body)).toEqual(JSON.parse(result.body))
    // …and no token was minted for the address that does not exist.
    expect(world.auth.resetTokens.length).toBe(before + 1)
  })

  it('completes the reset, invalidates the old password and burns the token', async () => {
    await world.post(`${AUTH_BASE_PATH}/request-password-reset`, {
      body: JSON.stringify({ email, redirectTo: `${world.origin}/reset` }),
    })
    const token = world.auth.resetTokens.at(-1)!.token

    const reset = await world.post(`${AUTH_BASE_PATH}/reset-password`, {
      body: JSON.stringify({ newPassword: NEW_PASSPHRASE, token }),
    })
    expect(reset.response.status).toBe(200)

    const withOld = await world.signIn(new CookieJar(), email, PASSPHRASE)
    expect(withOld.response.status).toBe(401)

    const withNew = await world.signIn(new CookieJar(), email, NEW_PASSPHRASE)
    expect(withNew.response.status).toBe(200)

    // Single use: the same token cannot be replayed to set the password again.
    const replay = await world.post(`${AUTH_BASE_PATH}/reset-password`, {
      body: JSON.stringify({ newPassword: 'yet-another-passphrase-18', token }),
    })
    expect(replay.response.status).toBeGreaterThanOrEqual(400)
  })

  /**
   * A password reset is the flow used *after* a suspected compromise, so
   * whether it kills the attacker's existing session is the whole question.
   * The two tests below are the same scenario under the candidate's default
   * and under the one-line fix.
   */
  async function resetAndProbeExistingSession(target: World): Promise<number> {
    const subject = `reset-sessions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`
    await target.invite({ email: subject, password: PASSPHRASE })

    const jar = new CookieJar()
    await target.signIn(jar, subject, PASSPHRASE)
    expect((await target.whoAmI(jar)).response.status).toBe(200)

    await target.post(`${AUTH_BASE_PATH}/request-password-reset`, {
      body: JSON.stringify({ email: subject, redirectTo: `${target.origin}/reset` }),
    })
    const token = target.auth.resetTokens.at(-1)!.token
    const reset = await target.post(`${AUTH_BASE_PATH}/reset-password`, {
      body: JSON.stringify({ newPassword: NEW_PASSPHRASE, token }),
    })
    expect(reset.response.status).toBe(200)

    return (await target.whoAmI(jar)).response.status
  }

  it('FINDING: by default the reset leaves every existing session alive', async () => {
    // 200, not 401. The password is changed, the old one no longer signs in —
    // and whoever already holds a session cookie keeps full access until it
    // expires. `revokeSessionsOnPasswordReset` is only consulted when set, so
    // the default is not to revoke.
    expect(await resetAndProbeExistingSession(world)).toBe(200)
  })

  it('…and the one-line fix closes it', async () => {
    const revoking = await createWorld({ revokeSessionsOnPasswordReset: true })
    try {
      expect(await resetAndProbeExistingSession(revoking)).toBe(401)
    } finally {
      await revoking.close()
    }
  })
})

describe('disable, with a live session already open', () => {
  let world: World

  beforeAll(async () => {
    world = await createWorld()
  })
  afterAll(async () => {
    await world?.close()
  })

  it('canonical deactivation stops the very next request, at 403', async () => {
    const email = `disable-canonical-${Date.now()}@example.test`
    const invited = await world.invite({ email, password: PASSPHRASE })

    const jar = new CookieJar()
    await world.signIn(jar, email, PASSPHRASE)
    const before = await world.whoAmI(jar)
    expect(before.response.status).toBe(200)
    expect(JSON.parse(before.body)).toMatchObject({ actor: { role: 'member' } })

    await world.asOwner((client) =>
      client.query('UPDATE public.team_members SET active = false WHERE user_id = $1', [
        invited.canonicalUserId,
      ]),
    )

    // No session bookkeeping was involved. The cookie is still valid and the
    // candidate still recognises it; the tenant database refuses to produce an
    // actor for it, and the request dies at authorization.
    const after = await world.whoAmI(jar)
    expect(after.response.status).toBe(403)

    // And the candidate genuinely still authenticates them — which is the
    // distinction S18 has to render: signed in, but no longer a member.
    const stillSignsIn = await world.signIn(new CookieJar(), email, PASSPHRASE)
    expect(stillSignsIn.response.status).toBe(200)
  })

  it('a ban in the candidate destroys the session outright, at 401', async () => {
    const adminEmail = `admin-${Date.now()}@example.test`
    const victimEmail = `disable-ban-${Date.now()}@example.test`
    await world.invite({
      email: adminEmail,
      password: PASSPHRASE,
      canonicalRole: 'admin',
      storeRole: 'admin',
    })
    const victim = await world.invite({ email: victimEmail, password: PASSPHRASE })

    const victimJar = new CookieJar()
    await world.signIn(victimJar, victimEmail, PASSPHRASE)
    expect((await world.whoAmI(victimJar)).response.status).toBe(200)

    const adminJar = new CookieJar()
    await world.signIn(adminJar, adminEmail, PASSPHRASE)

    const banned = await world.post(
      `${AUTH_BASE_PATH}/admin/ban-user`,
      { body: JSON.stringify({ userId: victim.subject }) },
      adminJar,
    )
    expect(banned.response.status).toBe(200)

    // The session row is gone, so there is nothing left to authenticate.
    expect((await world.whoAmI(victimJar)).response.status).toBe(401)
    // …and they cannot sign in again either.
    const retry = await world.signIn(new CookieJar(), victimEmail, PASSPHRASE)
    expect(retry.response.status).toBeGreaterThanOrEqual(400)
  })

  it('the authoritative role is the canonical one, not the candidate’s', async () => {
    // An account whose *store* role says admin but whose membership says
    // member. If the handler trusted the candidate's claim, this would come
    // back as an admin.
    const email = `role-conflict-${Date.now()}@example.test`
    await world.invite({
      email,
      password: PASSPHRASE,
      storeRole: 'admin',
      canonicalRole: 'member',
    })

    const jar = new CookieJar()
    await world.signIn(jar, email, PASSPHRASE)
    const result = await world.whoAmI(jar)

    expect(result.response.status).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({ actor: { role: 'member' } })
  })
})

describe('invite writes both stores atomically', () => {
  let world: World

  beforeAll(async () => {
    world = await createWorld()
  })
  afterAll(async () => {
    await world?.close()
  })

  it('rolls both stores back when either half fails', async () => {
    const email = `atomic-${Date.now()}@example.test`
    const subject = randomUUID()
    const canonicalUserId = randomUUID()

    await world.asOwner(async (client) => {
      await client.query('BEGIN')
      await client.query('INSERT INTO public.users (id, active) VALUES ($1, true)', [canonicalUserId])
      await client.query(
        `INSERT INTO public.team_members (name, active, email, role, user_id)
         VALUES ($1, true, $2, 'member', $3)`,
        [email, email, canonicalUserId],
      )
      await client.query(
        `INSERT INTO public.user_identities (user_id, provider, provider_subject)
         VALUES ($1, $2, $3)`,
        [canonicalUserId, SPIKE_PROVIDER, subject],
      )
      // The candidate's half fails — a duplicate id, a constraint, a crash.
      await expect(
        client.query(
          `INSERT INTO ${IDENTITY_SCHEMA}."user"
             (id, name, email, "emailVerified", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, true, now(), now())`,
          [subject, email, null],
        ),
      ).rejects.toThrow()
      await client.query('ROLLBACK')
    })

    // Neither store kept a half-person. Without a shared database this would
    // need a compensating write and a reconciliation job.
    const canonical = await world.asOwner((client) =>
      client.query('SELECT 1 FROM public.users WHERE id = $1', [canonicalUserId]),
    )
    const store = await world.auth.pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [subject])
    expect(canonical.rowCount).toBe(0)
    expect(store.rowCount).toBe(0)
  })
})
