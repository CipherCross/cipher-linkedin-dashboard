import { beforeEach, describe, expect, it, vi } from 'vitest'

const guardMember = vi.fn()
const db = vi.fn()

vi.mock('../api/_lib/auth.js', () => ({
  authorizationResponse: () => null,
  guardMember: (...args: unknown[]) => guardMember(...args),
}))

vi.mock('../api/_lib/core.js', () => ({
  db: (...args: unknown[]) => db(...args),
}))

vi.mock('../api/_lib/data/writePath.js', () => ({
  deploymentWritePath: () => 'supabase',
}))

vi.mock('../api/_lib/neonWrites.js', () => ({
  neonAddNote: vi.fn(),
  neonAssign: vi.fn(),
  neonDeleteNote: vi.fn(),
  neonFollowUp: vi.fn(),
  neonSetGender: vi.fn(),
  neonSetInstanceConfig: vi.fn(),
  neonSetStage: vi.fn(),
  neonWriter: vi.fn(),
}))

const { POST } = await import('../api/pipeline.js')

const legacyActions = [
  'add_member',
  'set_member_active',
  'invite_member',
  'update_member',
] as const

beforeEach(() => {
  guardMember.mockReset()
  guardMember.mockResolvedValue({
    principal: { member: { role: 'admin', name: 'Admin' } },
  })
  db.mockReset()
})

describe('retired legacy team-member mutations', () => {
  it.each(legacyActions)('returns a deliberate redirect for %s before constructing the legacy client', async (action) => {
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
    expect(db).not.toHaveBeenCalled()
  })
})
