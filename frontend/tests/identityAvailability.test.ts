import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  connect: vi.fn(), query: vi.fn(), release: vi.fn(), end: vi.fn(),
  getSession: vi.fn(), handle: vi.fn(), poolConfig: vi.fn(),
}))
vi.mock('pg', () => ({ default: {
  Pool: class {
    constructor(config: unknown) { mocked.poolConfig(config) }
    connect = mocked.connect
    end = mocked.end
  },
} }))
vi.mock('better-auth', () => ({ betterAuth: () => ({
  api: { getSession: mocked.getSession }, handler: mocked.handle,
}) }))

import { BetterAuthIdentityProvider } from '../api/_lib/identity/betterAuthProvider.js'
import { createIdentityHandler } from '../api/identity.js'
import { FakeDataStore } from '../api/_lib/data/fake.js'
import { DataStoreUnavailableError } from '../api/_lib/data/contracts.js'
import { currentSession } from '../src/lib/identityAuth.js'

const origin = 'https://dashboard.test'
const quotaError = () => Object.assign(new Error(
  'Your account or project has exceeded the quota. Upgrade your plan to increase limits.',
), { code: '53000' })
const provider = () => new BetterAuthIdentityProvider({ config: {
  connectionString: 'postgresql://identity_store:private@private.test/db',
  sessionSecret: 'x'.repeat(64), baseUrl: origin,
  basePath: '/api/identity', useSecureCookies: true,
} })

beforeEach(() => {
  vi.resetAllMocks()
  mocked.connect.mockResolvedValue({ query: mocked.query, release: mocked.release })
  mocked.query.mockResolvedValue({ rows: [{ principal: 'identity_store', resolves: true }] })
  mocked.getSession.mockResolvedValue(null)
})

describe('identity database availability', () => {
  it('carries a cold-start quota failure through the endpoint to the browser without signing out', async () => {
    mocked.connect.mockRejectedValue(quotaError())
    const handler = createIdentityHandler({ identity: provider(), store: new FakeDataStore(), trustedOrigin: origin })
    const response = await handler(new Request(`${origin}/api/identity?op=session.current`))
    expect(response.status).toBe(503)
    const outcome = await currentSession(async () => response)
    expect(outcome.kind).toBe('unavailable')
    expect(outcome).toMatchObject({ message: expect.stringContaining('DATASTORE_QUOTA_EXCEEDED') })
    expect(mocked.getSession).not.toHaveBeenCalled()
    expect(JSON.stringify(outcome)).not.toContain('private')
  })

  it('also explains quota failures during sign-in', async () => {
    mocked.connect.mockRejectedValue(quotaError())
    const handler = createIdentityHandler({ identity: provider(), store: new FakeDataStore(), trustedOrigin: origin })
    const response = await handler(new Request(`${origin}/api/identity?op=session.signIn`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
    }))
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('DATASTORE_QUOTA_EXCEEDED')
    expect(mocked.handle).not.toHaveBeenCalled()
  })

  it('does not turn a warm session lookup failure into an anonymous session', async () => {
    const identity = provider()
    await identity.getSession(new Headers())
    mocked.getSession.mockRejectedValue(Object.assign(new Error('Failed to get session'), { statusCode: 500 }))
    await expect(identity.getSession(new Headers())).rejects.toBeInstanceOf(DataStoreUnavailableError)
    expect(mocked.connect).toHaveBeenCalledTimes(1)
  })

  it('keeps absent and rejected credentials anonymous', async () => {
    const identity = provider()
    expect(await identity.getSession(new Headers())).toBeNull()
    mocked.getSession.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    expect(await identity.getSession(new Headers())).toBeNull()
  })

  it('bounds connection acquisition and releases a failed principal-check connection', async () => {
    const identity = provider()
    expect(mocked.poolConfig).toHaveBeenCalledWith(expect.objectContaining({ connectionTimeoutMillis: 5_000 }))
    mocked.query.mockRejectedValue(quotaError())
    await expect(identity.getSession(new Headers())).rejects.toMatchObject({ code: 'DATASTORE_QUOTA_EXCEEDED' })
    expect(mocked.release).toHaveBeenCalledOnce()
  })
})
