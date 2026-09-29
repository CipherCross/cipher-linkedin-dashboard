import { describe, expect, it } from 'vitest'

import { FakeDataStore } from '../api/_lib/data/fake.js'
import { resolveApplicationActor } from '../api/_lib/identity/application.js'
import {
  FakeIdentityProvider,
  FAKE_SESSION_COOKIE,
} from '../api/_lib/identity/fakeProvider.js'
import { neonWriter } from '../api/_lib/neonWrites.js'

const SUBJECT = 'better-auth-subject'
const ACTOR_ID = '00000000-0000-0000-0000-000000000042'

function identityHarness() {
  const store = new FakeDataStore()
  const identity = new FakeIdentityProvider()
  identity.seedAccount({
    subject: SUBJECT,
    email: 'member@example.test',
    password: 'not-used',
  })
  const session = identity.seedSession(SUBJECT)
  store.seedActor('better-auth', SUBJECT, {
    actorId: ACTOR_ID,
    role: 'member',
  })
  return { store, identity, session }
}

describe('application data-plane authentication', () => {
  it('resolves an HttpOnly identity session through the canonical database actor', async () => {
    const { store, identity, session } = identityHarness()
    const resolved = await resolveApplicationActor(
      new Request('https://dashboard.test/api/activity-daily', {
        headers: { cookie: `${FAKE_SESSION_COOKIE}=${session}` },
      }),
      { store, identity },
    )

    expect(resolved.provider).toBe('better-auth')
    expect(resolved.subject).toBe(SUBJECT)
    expect(resolved.actor).toMatchObject({ actorId: ACTOR_ID, role: 'member' })
  })

  it('ignores a bearer token: the session cookie is the only credential', async () => {
    const { store, identity } = identityHarness()
    await expect(
      resolveApplicationActor(
        new Request('https://dashboard.test/api/activity-daily', {
          headers: { authorization: 'Bearer deliberately-not-verified' },
        }),
        { store, identity },
      ),
    ).rejects.toMatchObject({ status: 401, message: 'Authentication required' })
  })

  it('does not read VITE_AUTH_PATH: identity is the only path whatever it says', async () => {
    const { store, identity, session } = identityHarness()
    const previous = process.env.VITE_AUTH_PATH
    process.env.VITE_AUTH_PATH = 'supabase'
    try {
      const resolved = await resolveApplicationActor(
        new Request('https://dashboard.test/api/activity-daily', {
          headers: { cookie: `${FAKE_SESSION_COOKIE}=${session}` },
        }),
        { store, identity },
      )
      expect(resolved.provider).toBe('better-auth')
    } finally {
      if (previous === undefined) delete process.env.VITE_AUTH_PATH
      else process.env.VITE_AUTH_PATH = previous
    }
  })

  it('uses the same identity-only boundary for Neon writes', async () => {
    const { store, identity, session } = identityHarness()
    const writer = await neonWriter(
      new Request('https://dashboard.test/api/pipeline', {
        headers: { cookie: `${FAKE_SESSION_COOKIE}=${session}` },
      }),
      { store, identity },
    )
    expect(writer.actor.actorId).toBe(ACTOR_ID)

    await expect(
      neonWriter(
        new Request('https://dashboard.test/api/pipeline', {
          headers: { authorization: 'Bearer deliberately-not-verified' },
        }),
        { store, identity },
      ),
    ).rejects.toMatchObject({ status: 401 })
  })
})
