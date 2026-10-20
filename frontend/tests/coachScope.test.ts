/**
 * The coach reviews only what the SDR wrote by hand. Sequence messages are
 * reviewed on the Sequences side, so the prompt tags every SDR line with what
 * produced it, and the server drops any issue that quotes something other than
 * a hand-written message — the prompt asks, this makes it true.
 */
import { describe, expect, it } from 'vitest'
import { issuesOnHandWritten, originOf, renderThread } from '../api/coach'

type Msg = Parameters<typeof renderThread>[0][number]

const msg = (over: Partial<Msg>): Msg => ({
  direction: 'out',
  body: '',
  sent_at: '2026-10-01T10:00:00Z',
  source: 'agent',
  chat_store: true,
  origin: 'sequence',
  step_type: 'MessageToPerson',
  message_ordinal: 1,
  ...over,
})

const THREAD: Msg[] = [
  msg({ body: 'Hi Ada, loved your talk on engines.', origin: 'sequence', message_ordinal: 1 }),
  msg({ direction: 'in', body: 'Thanks! What do you do?', origin: null }),
  msg({ body: 'We build   analytics for engine makers. Want a demo next week?', origin: 'manual' }),
]

describe('the coach scope', () => {
  it('reads the step attribution: matched is sequence, unmatched is hand-written, missing is unverified', () => {
    expect(originOf({ direction: 'out', step_method: 'lead_campaign' })).toBe('sequence')
    expect(originOf({ direction: 'out', step_method: 'instance_template' })).toBe('sequence')
    expect(originOf({ direction: 'out', step_method: 'none' })).toBe('manual')
    // An unsynced template variant: unmatched, but sent in many conversations.
    expect(originOf({ direction: 'out', step_method: 'none', reused_threads: 4 })).toBe('manual')
    expect(originOf({ direction: 'out', step_method: 'none', reused_threads: 5 })).toBe('template')
    expect(originOf({ direction: 'out', step_method: null })).toBe('unverified')
    expect(originOf({ direction: 'in', step_method: null })).toBeNull()
  })

  it('tags every SDR line with what produced it', () => {
    const prompt = renderThread(THREAD)
    expect(prompt).toContain('SDR [SEQUENCE message 1]: Hi Ada')
    expect(prompt).toContain('PROSPECT: Thanks!')
    expect(prompt).toContain('SDR [HAND-WRITTEN]: We build')
    expect(prompt).not.toContain('"issues" must be empty')
  })

  it('tells the model to return no issues when the SDR wrote nothing by hand', () => {
    const prompt = renderThread(THREAD.slice(0, 2))
    expect(prompt).toContain('"issues" must be empty')
  })

  it('tags a reused opening as a template, which is never reviewed', () => {
    const thread = [...THREAD, msg({ body: 'Quick one: are you hiring for payouts?', origin: 'template' })]
    expect(renderThread(thread)).toContain('SDR [TEMPLATE]: Quick one')
    expect(issuesOnHandWritten([{ quote: 'are you hiring for payouts', fix: 'x' }], thread)).toEqual([])
  })

  it('drops an issue that quotes a sequence message, keeps one that quotes a hand-written one', () => {
    const issues = [
      { quote: 'loved your talk on engines', fix: 'x' },
      { quote: '“we build analytics for engine makers.”', fix: 'y' },
      { quote: '', fix: 'z' },
      { quote: 'something nobody wrote', fix: 'w' },
    ]
    expect(issuesOnHandWritten(issues, THREAD).map((i) => i.fix)).toEqual(['y'])
  })

  it('only trusts who is waiting when hand-typed messages are captured', () => {
    const synced = THREAD.slice(0, 2).map((m) => ({ ...m, chat_store: false }))
    expect(renderThread(synced)).toContain('may be INCOMPLETE')
    expect(renderThread(THREAD.slice(0, 2))).toContain('waiting on the SDR to respond')
  })
})
