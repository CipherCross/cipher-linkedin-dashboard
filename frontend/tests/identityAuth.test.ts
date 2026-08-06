/**
 * The browser's identity path, measured where it decides things.
 *
 * The default run is `environment: 'node'` and nothing renders, so what is
 * proven here is the part that would otherwise only exist inside a React
 * component: which status maps to which state, what is sent on the wire, which
 * identifier an admin action names, and what a malformed answer does. The React
 * shell in `AuthContext.tsx` holds no rule of its own — every branch it takes
 * comes from a function below.
 */

import { describe, expect, it } from 'vitest'

import { AUTH_PATH_ENV, deploymentAuthPath } from '../src/lib/authPath'
import {
  currentSession,
  findSelf,
  identityUrl,
  inviteMember,
  requestPasswordReset,
  setMemberActive,
  setMemberRole,
  signIn,
  signOut,
  teamRoster,
  toTeamMember,
  type FetchLike,
  type RosterMember,
} from '../src/lib/identityAuth'

interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** A fake `fetch` that records what it was asked to do. */
function recorder(
  responder: (url: string, init: RequestInit | undefined) => Response,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return responder(url, init)
  }
  return { fetch: fetchImpl, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const ACTOR_ID = '11111111-2222-3333-4444-555555555555'

const ACTIVE_BODY = {
  subject: 'subject-abc',
  provider: 'better-auth',
  actor: { actorId: ACTOR_ID, role: 'member' },
}

function body(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>
}

describe('deploymentAuthPath', () => {
  it('is off unless a build says exactly "identity"', () => {
    expect(deploymentAuthPath({})).toBe('supabase')
    expect(deploymentAuthPath({ [AUTH_PATH_ENV]: '' })).toBe('supabase')
    expect(deploymentAuthPath({ [AUTH_PATH_ENV]: 'true' })).toBe('supabase')
    expect(deploymentAuthPath({ [AUTH_PATH_ENV]: '1' })).toBe('supabase')
    // The AI path's value, in case someone copies the wrong flag across.
    expect(deploymentAuthPath({ [AUTH_PATH_ENV]: 'neon' })).toBe('supabase')
    expect(deploymentAuthPath({ [AUTH_PATH_ENV]: 'Identity' })).toBe('supabase')
    expect(deploymentAuthPath({ [AUTH_PATH_ENV]: true })).toBe('supabase')
  })

  it('accepts the value, with surrounding whitespace', () => {
    expect(deploymentAuthPath({ [AUTH_PATH_ENV]: 'identity' })).toBe('identity')
    expect(deploymentAuthPath({ [AUTH_PATH_ENV]: '  identity  ' })).toBe('identity')
  })
})

describe('session.current — three outcomes, and a fourth that is not one', () => {
  it('200 yields the session, with the role the resolver gave', async () => {
    const { fetch, calls } = recorder(() => json(ACTIVE_BODY))
    const outcome = await currentSession(fetch)

    expect(outcome).toEqual({
      kind: 'active',
      session: {
        subject: 'subject-abc',
        provider: 'better-auth',
        actorId: ACTOR_ID,
        role: 'member',
      },
    })
    expect(calls[0].url).toBe('/api/identity?op=session.current')
    expect(calls[0].init?.method).toBe('GET')
    // The cookie is the whole credential; without this the request is anonymous.
    expect(calls[0].init?.credentials).toBe('same-origin')
  })

  it('401 is anonymous, and carries no message to render', async () => {
    const { fetch } = recorder(() => json({ error: 'Authentication required' }, 401))
    expect(await currentSession(fetch)).toEqual({ kind: 'anonymous' })
  })

  it('403 is a removed member, kept distinct from being signed out', async () => {
    const { fetch } = recorder(() =>
      json({ error: 'Your account is not an active team member' }, 403),
    )
    const outcome = await currentSession(fetch)

    expect(outcome.kind).toBe('removed')
    // The distinction is the point: a deactivated member holds a VALID session,
    // so sending them to sign in would succeed and change nothing.
    expect(outcome.kind === 'removed' && outcome.message).toBe(
      'Your account is not an active team member',
    )
  })

  it('500 is the service being unavailable, not a sign-out', async () => {
    const { fetch } = recorder(() => json({ error: 'Identity is not configured' }, 500))
    const outcome = await currentSession(fetch)
    expect(outcome.kind).toBe('unavailable')
  })

  it('a network failure is unavailable too, and does not throw', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('Failed to fetch')
    }
    const outcome = await currentSession(fetchImpl)
    expect(outcome).toEqual({ kind: 'unavailable', message: 'Failed to fetch' })
  })

  it('a 200 with no role is unavailable rather than a session', async () => {
    // A cast would let `undefined` reach `role === "admin"`. The point of
    // validating is that a malformed payload can never become an authority.
    const { fetch } = recorder(() =>
      json({ subject: 's', provider: 'p', actor: { actorId: ACTOR_ID } }),
    )
    expect((await currentSession(fetch)).kind).toBe('unavailable')
  })

  it('a 200 whose role is not one of the two is unavailable', async () => {
    const { fetch } = recorder(() =>
      json({ subject: 's', provider: 'p', actor: { actorId: ACTOR_ID, role: 'owner' } }),
    )
    expect((await currentSession(fetch)).kind).toBe('unavailable')
  })

  it('a 200 with no actor at all is unavailable', async () => {
    const { fetch } = recorder(() => json({ subject: 's', provider: 'p' }))
    expect((await currentSession(fetch)).kind).toBe('unavailable')
  })
})

describe('sign-in, sign-out and reset', () => {
  it('posts email and password, same-origin, and sends no callback URL', async () => {
    const { fetch, calls } = recorder(() => json({ ok: true }))
    expect(await signIn('  Person@Example.com ', 'passphrase', fetch)).toEqual({
      kind: 'ok',
    })

    expect(calls[0].url).toBe('/api/identity?op=session.signIn')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.credentials).toBe('same-origin')
    expect(body(calls[0])).toEqual({
      email: 'Person@Example.com',
      password: 'passphrase',
    })
    // An absent callbackURL is one fewer thing that can be aimed off-origin.
    expect(body(calls[0])).not.toHaveProperty('callbackURL')
  })

  it('never sets Origin itself — the browser stamps it, which is what makes the check work', async () => {
    const { fetch, calls } = recorder(() => json({ ok: true }))
    await signIn('a@b.co', 'p', fetch)
    const headers = new Headers(calls[0].init?.headers)
    expect(headers.has('origin')).toBe(false)
  })

  it('repeats the server’s refusal instead of guessing which half was wrong', async () => {
    const { fetch } = recorder(() => json({ message: 'Invalid email or password' }, 401))
    expect(await signIn('a@b.co', 'nope', fetch)).toEqual({
      kind: 'refused',
      message: 'Invalid email or password',
    })
  })

  it('falls back to the status when a refusal carries no message', async () => {
    const { fetch } = recorder(() => new Response('', { status: 429 }))
    expect(await signIn('a@b.co', 'p', fetch)).toEqual({
      kind: 'refused',
      message: 'HTTP 429',
    })
  })

  it('sign-out swallows a failure — a refused sign-out must not trap anyone', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('network down')
    }
    await expect(signOut(fetchImpl)).resolves.toBeUndefined()
  })

  it('the reset redirect is built from the caller’s own origin', async () => {
    const { fetch, calls } = recorder(() => json({ ok: true }))
    await requestPasswordReset('a@b.co', 'https://deck.example.com', fetch)
    expect(body(calls[0])).toEqual({
      email: 'a@b.co',
      redirectTo: 'https://deck.example.com/',
    })
  })
})

describe('team.roster', () => {
  const ROW: RosterMember = {
    id: 7,
    userId: ACTOR_ID,
    name: 'Dana',
    email: 'dana@example.com',
    role: 'admin',
    active: true,
    createdAt: '2026-01-02T03:04:05.000Z',
  }

  it('reads the roster and reports whether it was truncated', async () => {
    const { fetch, calls } = recorder(() => json({ members: [ROW], hasMore: true }))
    const outcome = await teamRoster(fetch)

    expect(calls[0].url).toBe('/api/identity?op=team.roster')
    expect(calls[0].init?.method).toBe('GET')
    expect(outcome).toEqual({ kind: 'ok', members: [ROW], hasMore: true })
  })

  it('drops a row it cannot read rather than inventing an id for it', async () => {
    // A row with no userId cannot be the target of any admin call. Keeping it
    // with a fabricated key would aim a later disable at nobody.
    const { fetch } = recorder(() =>
      json({ members: [ROW, { id: 8, name: 'No key', role: 'member' }] }),
    )
    const outcome = await teamRoster(fetch)
    expect(outcome.kind === 'ok' && outcome.members).toEqual([ROW])
  })

  it('reports a refusal with its status instead of an empty directory', async () => {
    const { fetch } = recorder(() => json({ error: 'Could not load the team roster' }, 500))
    expect(await teamRoster(fetch)).toEqual({
      kind: 'error',
      status: 500,
      message: 'Could not load the team roster',
    })
  })

  it('finds the signed-in person by canonical id, never by row id', async () => {
    const members: RosterMember[] = [
      { ...ROW, id: 1, userId: 'aaaa-1', role: 'member' },
      { ...ROW, id: 2, userId: ACTOR_ID },
    ]
    expect(findSelf(members, ACTOR_ID)?.id).toBe(2)
    expect(findSelf(members, 'unknown')).toBeNull()
  })

  it('projects a roster row without claiming a Supabase auth user exists', async () => {
    // auth_user_id is null because on this path there IS no Supabase Auth user.
    // The Supabase page reads that field as "login enabled"; filling it with the
    // canonical uuid would answer a question from the wrong id space.
    expect(toTeamMember(ROW)).toEqual({
      id: 7,
      name: 'Dana',
      active: true,
      created_at: '2026-01-02T03:04:05.000Z',
      auth_user_id: null,
      email: 'dana@example.com',
      role: 'admin',
    })
  })
})

describe('the admin actions, and the id each one names', () => {
  it('invite sends the three fields and no password material', async () => {
    const { fetch, calls } = recorder(() => json({ ok: true, member: {} }))
    expect(await inviteMember(
      { email: ' new@example.com ', name: ' Sam ', role: 'admin' },
      fetch,
    )).toEqual({ kind: 'ok', warning: null })

    expect(calls[0].url).toBe('/api/identity?op=admin.invite')
    expect(body(calls[0])).toEqual({
      email: 'new@example.com',
      name: 'Sam',
      role: 'admin',
    })
  })

  it('surfaces a named precondition as a code, not as a fault', async () => {
    const { fetch } = recorder(() =>
      json(
        {
          error: 'Inviting a member needs migration ledger step 005…',
          code: 'LEDGER_STEP_PENDING',
        },
        503,
      ),
    )
    const outcome = await inviteMember({ email: 'a@b.co', name: 'A', role: 'member' }, fetch)
    expect(outcome.kind === 'error' && outcome.code).toBe('LEDGER_STEP_PENDING')
    expect(outcome.kind === 'error' && outcome.status).toBe(503)
  })

  it('setActive is keyed on the canonical uuid', async () => {
    const { fetch, calls } = recorder(() => json({ ok: true, sessionsRevoked: 2 }))
    await setMemberActive(ACTOR_ID, false, fetch)

    expect(calls[0].url).toBe('/api/identity?op=admin.setActive')
    expect(body(calls[0])).toEqual({ userId: ACTOR_ID, active: false })
    // The bigint row id must never travel under this name: the SQL function
    // takes a uuid, and the two identifiers name different things.
    expect(body(calls[0]).userId).not.toBe(7)
  })

  it('reports a disable whose session revocation failed as a partial success', async () => {
    const { fetch } = recorder(() =>
      json({
        ok: true,
        member: {},
        sessionsRevoked: null,
        warning: 'their existing session could not be revoked',
      }),
    )
    expect(await setMemberActive(ACTOR_ID, false, fetch)).toEqual({
      kind: 'ok',
      warning: 'their existing session could not be revoked',
    })
  })

  it('setRole is keyed on the canonical uuid too', async () => {
    const { fetch, calls } = recorder(() => json({ ok: true }))
    await setMemberRole(ACTOR_ID, 'admin', fetch)

    expect(calls[0].url).toBe('/api/identity?op=admin.setRole')
    expect(body(calls[0])).toEqual({ userId: ACTOR_ID, role: 'admin' })
  })

  it('turns a 403 into an error the caller can show, not a thrown exception', async () => {
    const { fetch } = recorder(() => json({ error: 'Admin access required' }, 403))
    expect(await setMemberRole(ACTOR_ID, 'admin', fetch)).toEqual({
      kind: 'error',
      status: 403,
      message: 'Admin access required',
      code: null,
    })
  })
})

describe('the op names the browser may call', () => {
  it('encodes the op into the query string, never the body', () => {
    expect(identityUrl('session.current')).toBe('/api/identity?op=session.current')
    expect(identityUrl('a b')).toBe('/api/identity?op=a%20b')
  })
})
