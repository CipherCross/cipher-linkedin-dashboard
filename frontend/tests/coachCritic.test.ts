/**
 * The experimental coach/critic loop (Coach training only): it stops at the
 * first approval with nothing blocking, never runs more than three drafts or
 * past its time budget, keeps the draft when the critic fails, and each side
 * sees what it needs — the critic the coach's full instructions, the coach the
 * critique.
 */
import { describe, expect, it, vi } from 'vitest'

const calls: { system: string; prompt: string; model: string }[] = []
vi.mock('ai', () => ({
  generateObject: vi.fn(async ({ system, prompt, model }: { system: string; prompt: string; model: string }) => {
    calls.push({ system, prompt, model })
    return { object: { approve: true, summary: 'Fine.', points: [] } }
  }),
}))
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: (m: string) => m }))

const { runCriticLoop, runCritic, renderCritique, CRITIC_MODEL } = await import('../api/_lib/coachCritic')
const { revisionPrompt } = await import('../api/_lib/coachCore')

const thread = [{ direction: 'in', body: 'What does it cost?', sent_at: '2026-10-20T10:00:00Z', source: 'sync', chat_store: true, origin: null, step_type: null, message_ordinal: null }]
const now = new Date('2026-10-21T10:00:00Z')
const take = (label: string) => ({ next_action: 'reply', summary: label, issues: [], ideas: [{ angle: 'a', message: `${label} message`, why: 'w' }] })
const critique = (approve: boolean, blocking: boolean) => ({
  approve,
  summary: approve ? 'Good to send.' : 'Sounds robotic.',
  points: blocking ? [{ target: 'idea' as const, index: 0, criterion: 'sounds_ai' as const, severity: 'blocking' as const, problem: 'Stock opener.', suggestion: 'Start with the answer.' }] : [],
})

describe('the coach/critic loop', () => {
  it('stops at the first approval and keeps the first draft as final', async () => {
    const coach = vi.fn(async () => take('first'))
    const critic = vi.fn(async () => critique(true, false))
    const loop = await runCriticLoop('SYS', thread as never, now, { coach, critic })
    expect(loop.agreed).toBe(true)
    expect(loop.rounds).toHaveLength(1)
    expect(coach).toHaveBeenCalledTimes(1)
    expect(loop.final.summary).toBe('first')
  })

  it('revises against the critique and stops when the critic approves', async () => {
    const coach = vi.fn()
      .mockResolvedValueOnce(take('first'))
      .mockResolvedValueOnce({ ...take('second'), notes_to_reviewer: ['Kept the price range: the prospect asked.'] })
    const critic = vi.fn()
      .mockResolvedValueOnce(critique(false, true))
      .mockResolvedValueOnce(critique(true, false))
    const loop = await runCriticLoop('SYS', thread as never, now, { coach, critic })
    expect(loop.agreed).toBe(true)
    expect(loop.first.summary).toBe('first')
    expect(loop.final.summary).toBe('second')
    // The revision call carries the previous take and the critique.
    const revision = coach.mock.calls[1][3]
    expect(revision.previous.summary).toBe('first')
    expect(revision.critique).toContain('[blocking] idea 0 — sounds_ai: Stock opener. Suggestion: Start with the answer.')
    // The critic sees the coach's reply on the next round.
    expect(critic.mock.calls[1][3].notes_to_reviewer).toEqual(['Kept the price range: the prospect asked.'])
  })

  it('never runs more than three drafts, and an approval with a blocking point is not agreement', async () => {
    const coach = vi.fn(async () => take('again'))
    const critic = vi.fn(async () => critique(true, true))
    const loop = await runCriticLoop('SYS', thread as never, now, { coach, critic })
    expect(loop.agreed).toBe(false)
    expect(loop.stopped).toBe('rounds')
    expect(coach).toHaveBeenCalledTimes(3)
    expect(critic).toHaveBeenCalledTimes(3)
  })

  it('stops starting rounds past its time budget, and keeps the draft when the critic fails', async () => {
    let t = 0
    const slow = await runCriticLoop('SYS', thread as never, now, {
      coach: vi.fn(async () => take('x')), critic: vi.fn(async () => { t += 200_000; return critique(false, true) }),
      clock: () => t,
    })
    expect(slow.stopped).toBe('time')
    expect(slow.rounds).toHaveLength(1)
    const broken = await runCriticLoop('SYS', thread as never, now, {
      coach: vi.fn(async () => take('kept')), critic: vi.fn(async () => { throw new Error('overloaded') }),
    })
    expect(broken.stopped).toBe('critic_error')
    expect(broken.final.summary).toBe('kept')
    expect(broken.rounds[0].error).toBe('overloaded')
  })

  it('gives the critic the coach’s full instructions, the dated thread and the take, on a stronger model', async () => {
    calls.length = 0
    await runCritic('COACH SYSTEM PROMPT', thread as never, now, take('t') as never)
    expect(calls[0].model).toBe(CRITIC_MODEL)
    expect(calls[0].prompt).toContain('COACH INSTRUCTIONS (the coach’s full system prompt):\nCOACH SYSTEM PROMPT'.replace('’', "'"))
    expect(calls[0].prompt).toContain('NOW: ')
    expect(calls[0].prompt).toContain('[idea 0] (a) t message')
    expect(calls[0].system).toContain('Be fair.')
  })

  it('asks the coach for the complete output again, with room to disagree', () => {
    const prompt = revisionPrompt({ previous: take('p') as never, critique: renderCritique(critique(false, true)) })
    expect(prompt).toContain('Return the COMPLETE output again')
    expect(prompt).toContain('notes_to_reviewer')
  })
})
