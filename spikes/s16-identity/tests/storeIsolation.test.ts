/**
 * Where the identity store lives, proven rather than asserted.
 *
 * The candidate keeps its own user store — `user`, `session`, `account`,
 * `verification`. The spike's position is that this store may share the
 * *database* with the canonical tables (so invite and disable can be one
 * transaction) but must not share the *schema*, the *owner* or the *grants*.
 *
 * These tests measure both halves of that boundary. If either direction ever
 * opens up, one of them goes red.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import pgDefault from 'pg'
import type { Pool as PgPool } from 'pg'
import { inject } from 'vitest'

import { createWorld, type World } from './support/world.js'

const { Pool } = pgDefault
const PASSPHRASE = 'correct-horse-battery-staple-16'

describe('two-way isolation between the two stores', () => {
  let world: World
  let storePool: PgPool

  beforeAll(async () => {
    world = await createWorld()
    storePool = new Pool({ connectionString: inject('identityStoreUrl'), max: 2 })
  })
  afterAll(async () => {
    await storePool?.end()
    await world?.close()
  })

  it('the identity store’s role cannot read any business table', async () => {
    for (const relation of ['public.leads', 'public.messages', 'public.instances']) {
      await expect(
        storePool.query(`SELECT 1 FROM ${relation} LIMIT 1`),
        `${relation} should be unreachable from the identity store role`,
      ).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('the identity store’s role cannot read the canonical identity tables either', async () => {
    for (const relation of ['public.users', 'public.user_identities', 'public.team_members']) {
      await expect(
        storePool.query(`SELECT 1 FROM ${relation} LIMIT 1`),
        `${relation} should be unreachable from the identity store role`,
      ).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('the request-path role cannot read the candidate’s tables', async () => {
    // Password hashes and live session tokens sit in these tables. The role
    // that serves every dashboard read must not be able to reach them, so a
    // SQL-injection or a policy mistake in the product cannot become a
    // credential dump.
    for (const relation of ['identity_spike."user"', 'identity_spike."session"', 'identity_spike."account"']) {
      await expect(
        world.runtimePool.query(`SELECT 1 FROM ${relation} LIMIT 1`),
        `${relation} should be unreachable from the runtime role`,
      ).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('only the admin path reaches both, and only under an explicit SET ROLE', async () => {
    // `app_migration` is NOINHERIT: owner capability exists only inside an
    // explicit `SET ROLE app_owner`, on one connection, for one transaction.
    const withoutRole = await world.ownerPool.connect()
    try {
      await expect(withoutRole.query('SELECT 1 FROM public.users LIMIT 1')).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      withoutRole.release()
    }

    const bothStores = await world.asOwner(async (client) => {
      const canonical = await client.query('SELECT count(*)::int AS n FROM public.users')
      const store = await client.query('SELECT count(*)::int AS n FROM identity_spike."user"')
      return [canonical.rows[0].n, store.rows[0].n]
    })
    expect(bothStores[0]).toBeGreaterThan(0)
    expect(bothStores[1]).toBeGreaterThanOrEqual(0)
  })

  it('stores a scrypt hash, never the password', async () => {
    const email = `hash-${Date.now()}@example.test`
    const invited = await world.invite({ email, password: PASSPHRASE })

    const row = await storePool.query(
      `SELECT password FROM identity_spike."account" WHERE "userId" = $1`, [
        invited.subject,
      ],
    )
    const stored = String(row.rows[0].password)

    expect(stored).not.toContain(PASSPHRASE)
    // The candidate's default hash is scrypt, stored as `<salt>:<derived key>`
    // in hex. Recorded as a shape assertion so a silent switch to something
    // weaker would fail here.
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/)
  })
})
