import { beforeEach, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), release: vi.fn() }))
vi.mock('pg', async (importOriginal) => {
  const original = await importOriginal<typeof import('pg')>()
  return { ...original, default: { ...original.default, Pool: class {
    connect = mocked.connect
    on = vi.fn()
    end = vi.fn()
  } } }
})
import { NeonDataStore } from '../api/_lib/data/neon.js'
import { buildApplicationRegistry } from '../api/_lib/data/operations/index.js'

beforeEach(() => {
  vi.resetAllMocks()
  mocked.connect.mockResolvedValue({ query: mocked.query, release: mocked.release })
  mocked.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM pg_roles')
    ? [{ superuser: false, bypassrls: false, row_security: 'on' }] : [] }))
})

it('rechecks the runtime principal after an outage without recreating the data store', async () => {
  const store = new NeonDataStore({
    connectionString: 'postgresql://app_runtime:private@private.test/db',
    operations: buildApplicationRegistry(),
  })
  mocked.connect.mockRejectedValueOnce(Object.assign(new Error(
    'Your account or project has exceeded the quota. Upgrade your plan to increase limits.',
  ), { code: '53000' }))
  await expect(store.resolveActor({ provider: 'identity', subject: 'member' }))
    .rejects.toMatchObject({ code: 'DATASTORE_QUOTA_EXCEEDED' })
  await expect(store.resolveActor({ provider: 'identity', subject: 'member' })).resolves.toBeNull()
  expect(mocked.query.mock.calls.some(([sql]) => sql.includes('FROM pg_roles'))).toBe(true)
  expect(mocked.connect).toHaveBeenCalledTimes(3)
  expect(mocked.release).toHaveBeenCalledTimes(2)
})

it('still refuses an unsafe runtime principal after connectivity recovers', async () => {
  const store = new NeonDataStore({
    connectionString: 'postgresql://app_runtime:private@private.test/db',
    operations: buildApplicationRegistry(),
  })
  mocked.connect.mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
  await expect(store.resolveActor({ provider: 'identity', subject: 'member' })).rejects.toMatchObject({ code: 'DATASTORE_CONNECT_FAILED' })
  mocked.query.mockResolvedValue({ rows: [{ superuser: true, bypassrls: true, row_security: 'off' }] })
  await expect(store.resolveActor({ provider: 'identity', subject: 'member' })).rejects.toMatchObject({ name: 'DataStoreAuthorizationError' })
  expect(mocked.query).toHaveBeenCalledTimes(1)
})
