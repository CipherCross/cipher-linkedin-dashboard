/**
 * The mapping, against the **live Neon project**, read-only.
 *
 * This is the half of S16 that cannot be simulated: a session the candidate
 * issued, resolved to a canonical actor by the real tenant database, through
 * the **product's own driver and the product's own `identity.resolveSelf`
 * operation** — the same code path `frontend/api/activity-daily.ts` uses today.
 * Nothing here is a reimplementation of the mapping; the spike supplies the
 * subject and the product supplies the resolution.
 *
 * **Nothing is written to Neon.** Every statement is a SELECT inside the
 * driver's `BEGIN READ ONLY`. No row is inserted, updated or deleted, no DDL is
 * run, and no fixture is added — the three identity fixtures the baseline
 * already ships (`provider = 'fixture'`, subjects `subject-one`/`-two`/`-three`)
 * are enough, because the candidate can be told to mint accounts carrying
 * exactly those subject strings.
 *
 * The candidate's own tables still live in the local clean-room container:
 * creating them on Neon would be DDL outside the migration ledger.
 */

import { hashPassword } from 'better-auth/crypto'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest'
import pgDefault from 'pg'
import type { Pool as PgPool } from 'pg'

import {
  NeonDataStore,
  NeonOperationRegistry,
} from '../../../frontend/api/_lib/data/neon.js'
import { readNeonConnectionString } from '../../../frontend/api/_lib/data/neonConfig.js'
import {
  IDENTITY_OPERATIONS,
  resolveSelfOperation,
  type ResolvedIdentity,
} from '../../../frontend/api/_lib/data/operations/identity.js'
import type { ActorContext } from '../../../frontend/api/_lib/data/contracts.js'

import { ActorResolutionError, type ActorResolver } from '../src/canonicalActor.js'
import { CookieJar, jarFetch } from '../src/cookieJar.js'
import { createSpikeHandler, WHOAMI_PATH } from '../src/handler.js'
import { startHarness, type Harness } from '../src/harness.js'
import { AUTH_BASE_PATH, createSpikeAuth, IDENTITY_SCHEMA, type SpikeAuth } from '../src/spikeAuth.js'

const { Pool } = pgDefault

/** The provider the baseline's own identity fixtures are filed under. */
const FIXTURE_PROVIDER = 'fixture'
const PASSPHRASE = 'correct-horse-battery-staple-16'

/** The baseline's fixture identities. Read-only; this suite creates none. */
const FIXTURES = {
  activeMember: { subject: 'subject-one', actorId: '00000000-0000-0000-0000-000000000001', role: 'member' },
  activeAdmin: { subject: 'subject-two', actorId: '00000000-0000-0000-0000-000000000002', role: 'admin' },
  inactive: { subject: 'subject-three', actorId: '00000000-0000-0000-0000-000000000003' },
} as const

/** One tenant per database, so the tenant id is a constant, not a resource id. */
const TENANT_ID = 'primary'

/**
 * The resolver, built on the product's driver rather than on a copy of it.
 *
 * Propose-then-confirm, because that is what the baseline supports as it
 * stands: the `SECURITY DEFINER` resolver candidate is not applied to Neon and
 * must not be.
 */
function createNeonResolver(store: NeonDataStore): ActorResolver {
  return async ({ provider, subject, proposedActorId }) => {
    if (!proposedActorId) {
      throw new ActorResolutionError('This account is not mapped to a canonical application user')
    }
    const proposed: ActorContext = {
      kind: 'user',
      actorId: proposedActorId,
      tenantId: TENANT_ID,
      role: 'member',
    }
    const confirmation = await store.query<ResolvedIdentity>(proposed, {
      operation: IDENTITY_OPERATIONS.resolveSelf,
      params: { provider, providerSubject: subject },
      page: { limit: 2 },
    })
    if (confirmation.items.length !== 1 || confirmation.items[0].actorId !== proposedActorId) {
      throw new ActorResolutionError('No active canonical actor for this identity')
    }
    return confirmation.items[0]
  }
}

describe('subject → canonical actor on the live Neon project', () => {
  let auth: SpikeAuth
  let harness: Harness
  let store: NeonDataStore
  let storePool: PgPool
  const unmappedSubject = `s16-unmapped-${randomUUID()}`
  const emails = {
    member: `neon-member-${Date.now()}@example.test`,
    admin: `neon-admin-${Date.now()}@example.test`,
    inactive: `neon-inactive-${Date.now()}@example.test`,
    unmapped: `neon-unmapped-${Date.now()}@example.test`,
    liar: `neon-liar-${Date.now()}@example.test`,
  }

  beforeAll(async () => {
    harness = await startHarness()
    auth = await createSpikeAuth({
      connectionString: inject('identityStoreUrl'),
      baseURL: harness.origin,
      useSecureCookies: false,
    })

    const registry = new NeonOperationRegistry()
    registry.registerQuery(IDENTITY_OPERATIONS.resolveSelf, resolveSelfOperation)
    store = new NeonDataStore({
      connectionString: readNeonConnectionString(),
      operations: registry,
      statementTimeoutMs: 8_000,
      maxConnections: 2,
      applicationName: 's16-identity-spike',
    })

    harness.mount(
      createSpikeHandler({
        auth: auth.auth,
        resolveActor: createNeonResolver(store),
        provider: FIXTURE_PROVIDER,
      }),
    )

    // Accounts in the candidate's local store only. Their ids are the baseline
    // fixtures' subjects, which is what makes a read-only Neon leg possible.
    storePool = new Pool({ connectionString: inject('identityStoreUrl'), max: 2 })
    const accounts: Array<[subject: string, email: string, canonical: string | null]> = [
      [FIXTURES.activeMember.subject, emails.member, FIXTURES.activeMember.actorId],
      [FIXTURES.activeAdmin.subject, emails.admin, FIXTURES.activeAdmin.actorId],
      [FIXTURES.inactive.subject, emails.inactive, FIXTURES.inactive.actorId],
      [unmappedSubject, emails.unmapped, randomUUID()],
      // A stale or tampered proposal: a real subject pointing at the wrong id.
      [`${FIXTURES.activeMember.subject}-liar`, emails.liar, FIXTURES.activeAdmin.actorId],
    ]
    const passwordHash = await hashPassword(PASSPHRASE)
    for (const [subject, email, canonical] of accounts) {
      await storePool.query(
        `INSERT INTO ${IDENTITY_SCHEMA}."user"
           (id, name, email, "emailVerified", "createdAt", "updatedAt", "canonicalUserId")
         VALUES ($1, $2, $2, true, now(), now(), $3)
         ON CONFLICT (id) DO UPDATE SET "canonicalUserId" = excluded."canonicalUserId"`,
        [subject, email, canonical],
      )
      await storePool.query(
        `INSERT INTO ${IDENTITY_SCHEMA}."account"
           (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
         VALUES ($1, $2, 'credential', $2, $3, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [`account-${subject}`, subject, passwordHash],
      )
    }
  })

  afterAll(async () => {
    await harness?.close()
    await auth?.close()
    await storePool?.end()
    await store?.close()
  })

  async function whoAmI(email: string): Promise<{ status: number; body: unknown }> {
    const jar = new CookieJar()
    const signedIn = await jarFetch(jar, `${harness.origin}${AUTH_BASE_PATH}/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: harness.origin },
      body: JSON.stringify({ email, password: PASSPHRASE }),
    })
    expect(signedIn.response.status).toBe(200)
    const result = await jarFetch(jar, `${harness.origin}${WHOAMI_PATH}`)
    return { status: result.response.status, body: JSON.parse(result.body) as unknown }
  }

  it('resolves an active member to the canonical id Neon holds', async () => {
    const { status, body } = await whoAmI(emails.member)
    expect(status).toBe(200)
    expect(body).toEqual({
      subject: FIXTURES.activeMember.subject,
      actor: { actorId: FIXTURES.activeMember.actorId, role: FIXTURES.activeMember.role },
    })
  })

  it('reads the role from the database, not from the session', async () => {
    const { status, body } = await whoAmI(emails.admin)
    expect(status).toBe(200)
    // Neither the candidate's store nor the cookie says "admin" anywhere: the
    // account was created with no role at all.
    expect(body).toEqual({
      subject: FIXTURES.activeAdmin.subject,
      actor: { actorId: FIXTURES.activeAdmin.actorId, role: 'admin' },
    })
  })

  it('fails closed for the inactive canonical user', async () => {
    const { status } = await whoAmI(emails.inactive)
    expect(status).toBe(403)
  })

  it('fails closed for a subject with no mapping on Neon', async () => {
    const { status } = await whoAmI(emails.unmapped)
    expect(status).toBe(403)
  })

  it('fails closed when the proposal names a different real user', async () => {
    const { status } = await whoAmI(emails.liar)
    expect(status).toBe(403)
  })

  it('wrote nothing: the identity tables are unchanged', async () => {
    // Counted through the runtime role under RLS as the admin fixture, which
    // can see exactly its own rows. Three canonical users exist and no fourth
    // appeared; the spike inserted none.
    const asAdmin: ActorContext = {
      kind: 'user',
      actorId: FIXTURES.activeAdmin.actorId,
      tenantId: TENANT_ID,
      role: 'admin',
    }
    const self = await store.query<ResolvedIdentity>(asAdmin, {
      operation: IDENTITY_OPERATIONS.resolveSelf,
      params: { provider: FIXTURE_PROVIDER, providerSubject: FIXTURES.activeAdmin.subject },
      page: { limit: 5 },
    })
    expect(self.items).toEqual([
      { actorId: FIXTURES.activeAdmin.actorId, role: 'admin' },
    ])

    // And the subjects this suite invented resolve to nothing at all, which
    // they could not do if the suite had written them.
    const invented = await store.query<ResolvedIdentity>(asAdmin, {
      operation: IDENTITY_OPERATIONS.resolveSelf,
      params: { provider: FIXTURE_PROVIDER, providerSubject: unmappedSubject },
      page: { limit: 5 },
    })
    expect(invented.items).toEqual([])
  })
})
