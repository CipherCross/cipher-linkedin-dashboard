import { beforeEach, describe, expect, it, vi } from 'vitest'

const neonWriter = vi.fn()

vi.mock('../api/_lib/neonWrites.js', () => ({
  neonAddNote: vi.fn(),
  neonAssign: vi.fn(),
  neonDeleteNote: vi.fn(),
  neonFollowUp: vi.fn(),
  neonSetGender: vi.fn(),
  neonSetInstanceConfig: vi.fn(),
  neonSetStage: vi.fn(),
  neonWriter: (...args: unknown[]) => neonWriter(...args),
}))

const { POST } = await import('../api/pipeline.js')

const legacyActions = [
  'add_member',
  'set_member_active',
  'invite_member',
  'update_member',
] as const

beforeEach(() => {
  neonWriter.mockReset()
  neonWriter.mockResolvedValue({
    store: {},
    actor: { kind: 'user', actorId: 'admin', tenantId: 'primary', role: 'admin' },
  })
})

describe('retired legacy team-member mutations', () => {
  it.each(legacyActions)('returns a deliberate redirect for %s', async (action) => {
    const response = await POST(
      new Request('https://dashboard.test/api/pipeline', {
        method: 'POST',
        body: JSON.stringify({ action }),
      }),
    )

    expect(response.status).toBe(410)
    expect(await response.json()).toEqual({
      error: 'Team administration moved to /api/identity.',
      redirect: '/api/identity',
    })
  })

  it.each(legacyActions)('refuses %s to a member before redirecting', async (action) => {
    neonWriter.mockResolvedValue({
      store: {},
      actor: { kind: 'user', actorId: 'member', tenantId: 'primary', role: 'member' },
    })
    const response = await POST(
      new Request('https://dashboard.test/api/pipeline', {
        method: 'POST',
        body: JSON.stringify({ action }),
      }),
    )
    expect(response.status).toBe(403)
  })
})
