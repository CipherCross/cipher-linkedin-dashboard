/**
 * The copilot is told what ICPs exist, on whichever provider answers.
 *
 * `icpRoster.test.ts` covers the loader. This covers the call site, and it is
 * the one that actually broke: `chat.ts` read `neon ? '' : await loadIcpRoster()`,
 * so a Neon deployment built a system prompt with no ICP layer in it and nothing
 * anywhere said so. A test of the loader alone would have stayed green through
 * that, which is why the assertion here is on the prompt the model is handed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The system prompt of the last `streamText` call. */
let systemPrompt = ''
let rosterCalls = 0

vi.mock('ai', () => ({
  streamText: (options: { system: string }) => {
    systemPrompt = options.system
    return { toUIMessageStreamResponse: () => new Response('stream') }
  },
  convertToModelMessages: (messages: unknown) => messages,
  stepCountIs: (n: number) => n,
}))
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: (id: string) => id }))
vi.mock('../api/_lib/tools.js', () => ({ buildTools: () => ({}) }))
vi.mock('../api/_lib/neonWrites.js', () => ({
  neonWriter: async () => ({ store: {}, actor: { role: 'member' } }),
}))
vi.mock('../api/_lib/auth.js', () => ({
  guardMember: async () => ({ response: null }),
  authorizationResponse: () => null,
  AuthorizationError: class extends Error {},
}))
vi.mock('../api/_lib/core.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadIcpRoster: async () => {
      rosterCalls += 1
      return 'ICPs (Ideal Customer Profiles):\n- "Fintech scale-ups": payments'
    },
  }
})

const { POST } = await import('../api/chat.js')

function chatRequest(): Request {
  return new Request('https://dashboard.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  })
}

beforeEach(() => {
  systemPrompt = ''
  rosterCalls = 0
})

describe('the chat system prompt', () => {
  for (const [label, flag] of [
    ['the Neon path', 'neon'],
    ['the Supabase path', undefined],
  ] as const) {
    it(`carries the ICP roster on ${label}`, async () => {
      if (flag) process.env.NEON_AI_PATH_DEFAULT = flag
      else delete process.env.NEON_AI_PATH_DEFAULT

      await POST(chatRequest())

      expect(rosterCalls).toBe(1)
      expect(systemPrompt).toContain('Fintech scale-ups')
      // The pointer that makes the roster useful rather than decorative.
      expect(systemPrompt).toContain('hypothesis_overview')
    })
  }

  it('names no provider to the model', async () => {
    delete process.env.NEON_AI_PATH_DEFAULT
    await POST(chatRequest())
    // The prompt told the model it was querying "the team's Supabase Postgres
    // database" on every deployment, including the ones that have no Supabase.
    expect(systemPrompt).not.toMatch(/supabase/i)
    expect(systemPrompt).toContain("Postgres database")
  })
})
