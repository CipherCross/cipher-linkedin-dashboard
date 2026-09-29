/**
 * The fail-closed bearer check every cron, agent-notify and MCP caller meets.
 * The comparison is `timingSafeEqual`; a length mismatch refuses before it.
 */
import * as crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:crypto')
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

const { AuthorizationError, guardMachine, requireMachineSecret } = await import(
  '../api/_lib/auth.js'
)

function withAuth(value?: string): Request {
  return new Request('https://dashboard.test/api/briefing', {
    headers: value === undefined ? {} : { authorization: value },
  })
}

function statusOf(run: () => void): number | null {
  try {
    run()
    return null
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorizationError)
    return (error as InstanceType<typeof AuthorizationError>).status
  }
}

afterEach(() => {
  delete process.env.CRON_SECRET
  vi.mocked(crypto.timingSafeEqual).mockClear()
})

describe('requireMachineSecret', () => {
  it('accepts the exact bearer through a constant-time comparison', () => {
    process.env.CRON_SECRET = 's3cret-value'
    expect(statusOf(() => requireMachineSecret(withAuth('Bearer s3cret-value'), 'CRON_SECRET'))).toBeNull()
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1)
  })

  it('refuses a same-length wrong secret with 401', () => {
    process.env.CRON_SECRET = 's3cret-value'
    expect(statusOf(() => requireMachineSecret(withAuth('Bearer s3cret-valuX'), 'CRON_SECRET'))).toBe(401)
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1)
  })

  it('refuses a length mismatch with 401 without comparing', () => {
    process.env.CRON_SECRET = 's3cret-value'
    for (const header of ['Bearer s3cret', 'Bearer s3cret-value-longer', 's3cret-value', '', undefined]) {
      expect(statusOf(() => requireMachineSecret(withAuth(header), 'CRON_SECRET'))).toBe(401)
    }
    expect(crypto.timingSafeEqual).not.toHaveBeenCalled()
  })

  it('compares bytes, so a multi-byte header of equal character count is refused', () => {
    process.env.CRON_SECRET = 'abc'
    expect(statusOf(() => requireMachineSecret(withAuth('Bearer abé'), 'CRON_SECRET'))).toBe(401)
  })

  it('fails closed with 500 when the secret is not configured', () => {
    expect(statusOf(() => requireMachineSecret(withAuth('Bearer '), 'CRON_SECRET'))).toBe(500)
  })

  it('guardMachine answers the refusal as a response', async () => {
    process.env.CRON_SECRET = 's3cret-value'
    expect(await guardMachine(withAuth('Bearer s3cret-value'), 'CRON_SECRET')).toBeNull()
    const denied = await guardMachine(withAuth('Bearer nope'), 'CRON_SECRET')
    expect(denied?.status).toBe(401)
  })
})
