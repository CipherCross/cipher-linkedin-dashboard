/**
 * The mapping, in the clean room: an identity-provider subject resolving to a
 * canonical `public.users.id` through `public.user_identities`, under the
 * baseline's own RLS.
 *
 * The live-Neon half of the same claim is `tests/mapping.neon.test.ts`, which
 * is read-only. This file is where the negative cases live, because they need
 * writes the Neon project must not receive.
 */

import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CookieJar } from '../src/cookieJar.js'
import { createWorld, SPIKE_PROVIDER, type World } from './support/world.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PASSPHRASE = 'correct-horse-battery-staple-16'

async function whoAmIAfterSignIn(world: World, email: string): Promise<{ status: number; body: unknown }> {
  const jar = new CookieJar()
  const signedIn = await world.signIn(jar, email, PASSPHRASE)
  expect(signedIn.response.status).toBe(200)
  const result = await world.whoAmI(jar)
  return { status: result.response.status, body: JSON.parse(result.body) as unknown }
}

describe('subject → canonical actor, and the ways it fails closed', () => {
  let world: World

  beforeAll(async () => {
    world = await createWorld()
  })
  afterAll(async () => {
    await world?.close()
  })

  it('resolves a mapped, active member to the canonical id the database holds', async () => {
    const email = `map-ok-${Date.now()}@example.test`
    const invited = await world.invite({ email, password: PASSPHRASE, canonicalRole: 'admin' })

    const { status, body } = await whoAmIAfterSignIn(world, email)
    expect(status).toBe(200)
    expect(body).toEqual({
      subject: invited.subject,
      // The role came back from `team_members`, not from the session.
      actor: { actorId: invited.canonicalUserId, role: 'admin' },
    })
  })

  it('fails closed for an account with no canonical mapping at all', async () => {
    const email = `map-none-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE, canonicalUserId: null })

    const { status } = await whoAmIAfterSignIn(world, email)
    expect(status).toBe(403)
  })

  it('fails closed when the account proposes someone else’s canonical id', async () => {
    // The stale-or-hostile proposal. This is precisely the failure mode the
    // environment-held bridge in S12 could produce by being edited wrongly.
    const victim = await world.invite({
      email: `map-victim-${Date.now()}@example.test`,
      password: PASSPHRASE,
    })
    const email = `map-liar-${Date.now()}@example.test`
    const liar = await world.invite({ email, password: PASSPHRASE })

    await world.asOwner((client) =>
      client.query(
        `UPDATE identity_spike."user" SET "canonicalUserId" = $1 WHERE id = $2`,
        [victim.canonicalUserId, liar.subject],
      ),
    )

    // RLS compares `user_identities.user_id` against the published actor *and*
    // the presented subject in one predicate, so the pairing has to hold.
    const { status } = await whoAmIAfterSignIn(world, email)
    expect(status).toBe(403)
  })

  it('fails closed for a deactivated canonical user', async () => {
    const email = `map-inactive-user-${Date.now()}@example.test`
    const invited = await world.invite({ email, password: PASSPHRASE })
    await world.asOwner((client) =>
      client.query('UPDATE public.users SET active = false WHERE id = $1', [invited.canonicalUserId]),
    )

    const { status } = await whoAmIAfterSignIn(world, email)
    expect(status).toBe(403)
  })

  it('fails closed for a subject that exists nowhere', async () => {
    const email = `map-orphan-${Date.now()}@example.test`
    const invited = await world.invite({ email, password: PASSPHRASE })

    // Delete the mapping row but leave the account and the canonical user.
    await world.asOwner((client) =>
      client.query('DELETE FROM public.user_identities WHERE provider_subject = $1', [
        invited.subject,
      ]),
    )

    const { status } = await whoAmIAfterSignIn(world, email)
    expect(status).toBe(403)
  })
})

describe('why the proposal exists at all', () => {
  let world: World

  beforeAll(async () => {
    world = await createWorld()
  })
  afterAll(async () => {
    await world?.close()
  })

  it('the runtime role cannot read the mapping without already knowing the answer', async () => {
    const invited = await world.invite({
      email: `probe-read-${Date.now()}@example.test`,
      password: PASSPHRASE,
    })

    const client = await world.runtimePool.connect()
    try {
      // No actor published: RLS yields nothing, so a subject cannot be looked
      // up. This is the constraint that forces propose-then-confirm.
      await client.query('BEGIN READ ONLY')
      const blind = await client.query(
        'SELECT user_id FROM public.user_identities WHERE provider_subject = $1',
        [invited.subject],
      )
      expect(blind.rowCount).toBe(0)

      // The correct actor published: exactly one row.
      await client.query("SELECT set_config('app.actor_id', $1, true)", [invited.canonicalUserId])
      const sighted = await client.query(
        'SELECT user_id FROM public.user_identities WHERE provider_subject = $1',
        [invited.subject],
      )
      expect(sighted.rowCount).toBe(1)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  it('FINDING: the runtime role has no write path to the identity tables', async () => {
    // Not RLS — table grants. `app_runtime` holds INSERT/UPDATE/DELETE on the
    // business tables and on none of `users`, `user_identities`,
    // `team_members`. So S17's invite, disable and role-change endpoints have
    // no way to write them as the request-path role. That needs an owner
    // decision and a ledger session, exactly like the B4 roster function.
    const attempts: Array<[string, string, unknown[]]> = [
      ['users', 'INSERT INTO public.users (id, active) VALUES ($1, true)', [randomUUID()]],
      [
        'team_members',
        `INSERT INTO public.team_members (name, active, email, role, user_id)
         VALUES ('x', true, $1, 'member', $2)`,
        [`nope-${Date.now()}@example.test`, randomUUID()],
      ],
      [
        'user_identities',
        `INSERT INTO public.user_identities (user_id, provider, provider_subject)
         VALUES ($1, $2, 'nope')`,
        [randomUUID(), SPIKE_PROVIDER],
      ],
      ['team_members update', 'UPDATE public.team_members SET active = false', []],
    ]

    for (const [label, statement, values] of attempts) {
      const client = await world.runtimePool.connect()
      try {
        await expect(
          client.query(statement, values as never[]),
          `${label} should have been denied`,
        ).rejects.toMatchObject({ code: '42501' })
      } finally {
        client.release()
      }
    }
  })
})

describe('the SECURITY DEFINER resolver candidate', () => {
  let world: World

  beforeAll(async () => {
    world = await createWorld()
    // Applied to the ephemeral container only. Not to Neon, not to the
    // baseline. See the banner in the SQL file itself.
    const sql = await readFile(resolve(HERE, '../sql/candidate_identity_resolver.sql'), 'utf8')
    await world.asOwner((client) => client.query(sql))
    world.useDefinerResolver()
  })
  afterAll(async () => {
    await world?.close()
  })

  it('resolves the same actor in one round trip', async () => {
    const email = `definer-ok-${Date.now()}@example.test`
    const invited = await world.invite({ email, password: PASSPHRASE })

    const { status, body } = await whoAmIAfterSignIn(world, email)
    expect(status).toBe(200)
    expect(body).toMatchObject({ actor: { actorId: invited.canonicalUserId, role: 'member' } })
  })

  it('is immune to a wrong proposal, because it does not take one', async () => {
    // The same account that fails closed under propose-then-confirm resolves
    // *correctly* here: a stale cached id cannot mislead a resolver that never
    // reads it. That is the substantive argument for the schema change.
    const victim = await world.invite({
      email: `definer-victim-${Date.now()}@example.test`,
      password: PASSPHRASE,
    })
    const email = `definer-stale-${Date.now()}@example.test`
    const stale = await world.invite({ email, password: PASSPHRASE })

    await world.asOwner((client) =>
      client.query(`UPDATE identity_spike."user" SET "canonicalUserId" = $1 WHERE id = $2`, [
        victim.canonicalUserId,
        stale.subject,
      ]),
    )

    const { status, body } = await whoAmIAfterSignIn(world, email)
    expect(status).toBe(200)
    expect(body).toMatchObject({ actor: { actorId: stale.canonicalUserId } })
  })

  it('still fails closed for an inactive member and an unknown subject', async () => {
    const email = `definer-inactive-${Date.now()}@example.test`
    const invited = await world.invite({ email, password: PASSPHRASE })
    await world.asOwner((client) =>
      client.query('UPDATE public.team_members SET active = false WHERE user_id = $1', [
        invited.canonicalUserId,
      ]),
    )
    expect((await whoAmIAfterSignIn(world, email)).status).toBe(403)

    const orphanEmail = `definer-orphan-${Date.now()}@example.test`
    await world.invite({ email: orphanEmail, password: PASSPHRASE, canonicalUserId: null })
    expect((await whoAmIAfterSignIn(world, orphanEmail)).status).toBe(403)
  })

  it('exposes no more than the one question it answers', async () => {
    const unknown = await world.runtimePool.query(
      'SELECT * FROM public.identity_resolve_actor($1, $2)',
      [SPIKE_PROVIDER, `no-such-subject-${randomUUID()}`],
    )
    expect(unknown.rowCount).toBe(0)

    // No wildcard, no listing: the function is not an enumeration primitive.
    const wildcard = await world.runtimePool.query(
      'SELECT * FROM public.identity_resolve_actor($1, $2)',
      [SPIKE_PROVIDER, '%'],
    )
    expect(wildcard.rowCount).toBe(0)
  })
})
