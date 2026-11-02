// `import_stats` sits on the human /api/import surface, behind the same admin
// guard as the CSV importers: a member is refused before Airtable is reached,
// and an admin reaches the read-only handler.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const neonWriter = vi.fn()

vi.mock('../api/_lib/neonWrites.js', () => ({
  neonWriter: (...args: unknown[]) => neonWriter(...args),
}))

const { POST } = await import('../api/import.js')

const actor = (role: 'admin' | 'member') => ({
  store: {},
  actor: { kind: 'user', actorId: role, tenantId: 'primary', role },
})

const stats = (body: Record<string, unknown>) =>
  POST(new Request('https://dashboard.test/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'import_stats', ...body }),
  }))

let fetcher: ReturnType<typeof vi.fn>

beforeEach(() => {
  neonWriter.mockReset()
  fetcher = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetcher)
  vi.stubEnv('AIRTABLE_TOKEN', '')
  vi.stubEnv('AIRTABLE_BASE_ID', '')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('import_stats authorization', () => {
  it('refuses a member with 403 and never reaches Airtable', async () => {
    neonWriter.mockResolvedValue(actor('member'))
    const response = await stats({ base: 'web2mob', from: '2026-10-01', to: '2026-10-07' })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'Admin access required' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('lets an admin reach the handler', async () => {
    neonWriter.mockResolvedValue(actor('admin'))
    const response = await stats({ base: 'web2mob', from: '2026-10-01', to: '2026-10-07' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true, base: 'web2mob', configured: false, from: '2026-10-01', to: '2026-10-07',
    })
  })

  it('answers 400 for an unknown base, after the admin check', async () => {
    neonWriter.mockResolvedValue(actor('admin'))
    const response = await stats({ base: 'nowhere', from: '2026-10-01', to: '2026-10-07' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'base must be one of the known Airtable bases' })
  })
})
