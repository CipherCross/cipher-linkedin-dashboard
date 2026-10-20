/**
 * The coach reviews only what the SDR wrote by hand. Sequence messages are
 * reviewed on the Sequences side, so the prompt tags every SDR line with what
 * produced it, and the server drops any issue that quotes something other than
 * a hand-written message — the prompt asks, this makes it true.
 */
import { describe, expect, it } from 'vitest'
import { issuesOnHandWritten, originOf, renderThread } from '../api/coach'
import {
  COACH_HARNESS, DEFAULT_COACH_PROMPT, asOfForCut, coachingMarkerOf, composeCoachSystem, cutThread, threadMarkerOf,
} from '../api/_lib/coachCore'

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

  it('cuts the thread after a message, and ignores a cut that is no longer in it', () => {
    const thread = THREAD.map((m, i) => ({ ...m, id: 10 + i }))
    expect(cutThread(thread, 11).map((m) => m.id)).toEqual([10, 11])
    expect(cutThread(thread, null)).toHaveLength(3)
    expect(cutThread(thread, 999)).toHaveLength(3)
    // A cut run renders only what the coach may see.
    expect(renderThread(cutThread(thread, 11))).not.toContain('We build')
  })

  it('makes a published prompt invalidate every cached take', () => {
    const now = new Date('2026-10-01T12:00:00Z')
    expect(coachingMarkerOf(THREAD, null, now)).not.toBe(coachingMarkerOf(THREAD, 7, now))
    expect(coachingMarkerOf(THREAD, 7, now)).toBe(`v4|p7|${threadMarkerOf(THREAD)}|d0|c0`)
    // New context (a profile synced, a company found) regenerates the take too.
    expect(coachingMarkerOf(THREAD, 7, now, 'abc')).not.toBe(coachingMarkerOf(THREAD, 7, now))
  })

  it('lets a cached take expire as days pass, since timing advice goes out of date', () => {
    const sameDay = coachingMarkerOf(THREAD, 7, new Date('2026-10-01T20:00:00Z'))
    expect(coachingMarkerOf(THREAD, 7, new Date('2026-10-01T23:00:00Z'))).toBe(sameDay)
    expect(coachingMarkerOf(THREAD, 7, new Date('2026-10-09T12:00:00Z'))).toMatch(/\|d8\|c0$/)
  })

  it('tells the coach what time it is and how old every message is', () => {
    const thread = [
      msg({ body: 'Hi Ada', sent_at: '2026-10-01T10:00:00Z' }),
      msg({ direction: 'in', origin: null, body: 'Let me think about it', sent_at: '2026-10-12T09:00:00Z' }),
    ]
    const prompt = renderThread(thread, new Date('2026-10-20T09:00:00Z'))
    expect(prompt).toMatch(/^NOW: Tue, 20 Oct 2026, 11:00 \(Europe\/Madrid time\)\. The last message was sent 8 days ago\./)
    expect(prompt).toContain('[Mon, 12 Oct 2026, 11:00 · 8 days ago] PROSPECT: Let me think about it')
    expect(prompt).toContain('[Thu, 1 Oct 2026, 12:00 · 19 days ago] SDR [SEQUENCE message 1]: Hi Ada')
    // The fixed harness owns the rule, so a trained prompt cannot drop it.
    expect(COACH_HARNESS).toContain('Never advise waiting for a period that has already passed')
  })

  it('coaches a cut as of the moment the next message arrived', () => {
    const thread = THREAD.map((m, i) => ({ ...m, id: 10 + i, sent_at: `2026-10-0${i + 1}T10:00:00Z` }))
    const now = new Date('2026-10-20T10:00:00Z')
    expect(asOfForCut(thread, 10, now).toISOString()).toBe('2026-10-02T10:00:00.000Z')
    expect(asOfForCut(thread, 12, now)).toBe(now) // nothing after the cut
    expect(asOfForCut(thread, null, now)).toBe(now)
  })

  it('puts the trainable prompt first, then the fixed harness, then the context', () => {
    const sys = composeCoachSystem('TRAINED PROMPT', 'PLAYBOOK TEXT', 'ICP TEXT')
    expect(sys.indexOf('TRAINED PROMPT')).toBe(0)
    expect(sys.indexOf(COACH_HARNESS)).toBeGreaterThan(0)
    expect(sys.indexOf('PLAYBOOK TEXT')).toBeGreaterThan(sys.indexOf(COACH_HARNESS))
    expect(sys.indexOf('ICP TEXT')).toBeGreaterThan(sys.indexOf('PLAYBOOK TEXT'))
    // The harness, not the trainable prompt, owns the never-critique-sequence rule.
    expect(COACH_HARNESS).toContain('NEVER critique')
    expect(DEFAULT_COACH_PROMPT).not.toContain('NEVER critique')
  })
})
