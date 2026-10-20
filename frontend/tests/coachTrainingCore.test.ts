/**
 * The trainer's pure parts: the overfitting check (ported from the Skill
 * Trainer's find_leaks), what the editor model reads, and the history diff.
 */
import { describe, expect, it } from 'vitest'
import { findLeaks } from '../api/_lib/coachLeaks'
import { editorInput } from '../api/_lib/coachEditor'
import { lineDiff } from '../src/lib/coachTraining'

describe('the overfitting check', () => {
  const sources = [{ label: 'conversation', text: 'We build reconciliation for payout teams at fast growing fintechs.' }]

  it('flags a six-word phrase the prompt copied, and merges a longer run into one hit', () => {
    const leaks = findLeaks('Say: we build reconciliation for payout teams at fast growing fintechs, always.', sources)
    expect(leaks).toEqual([{ phrase: 'we build reconciliation for payout teams at fast growing fintechs', source: 'conversation' }])
  })

  it('ignores five-word overlaps and phrases the seed prompt already had', () => {
    expect(findLeaks('we build reconciliation for payout only', sources)).toEqual([])
    expect(findLeaks('we build reconciliation for payout teams', sources, ['we build reconciliation for payout teams'])).toEqual([])
  })
})

describe('what the editor reads', () => {
  const input = editorInput({
    currentPrompt: 'CURRENT PROMPT',
    cases: [{
      conversation: 'PROSPECT: what does it cost?',
      promptVersion: 3,
      output: {
        next_action: 'reply',
        summary: 'Asked about price.',
        ideas: [{ angle: 'A', message: 'Idea one', why: 'w' }, { angle: 'B', message: 'Idea two', why: 'w' }],
        issues: [{ kind: 'no_cta', quote: 'q', fix: 'f' }],
      },
      feedback: [
        { target: 'idea', target_index: 1, verdict: 'bad', comment: 'Answer the price first' },
        { target: 'take', target_index: null, verdict: null, comment: 'Too salesy overall' },
      ],
    }],
    general: 'Be brief',
    earlier: [{ from: 1, to: 2, comments: ['Earlier comment'], note: null, instruction: false }],
  })

  it('carries the marks and comments next to the output they judge', () => {
    expect(input).toContain('<current_prompt>\nCURRENT PROMPT')
    expect(input).toContain('prompt_version="3"')
    expect(input).toMatch(/<idea n="2" marked="bad">[\s\S]*Idea two[\s\S]*comment: Answer the price first/)
    expect(input).toMatch(/<idea n="1">/)
    expect(input).toContain('Too salesy overall')
    expect(input).toContain('<general_feedback>\nBe brief')
    expect(input).toContain('Round v1→v2:\n- Earlier comment')
  })

  it('sends a direct instruction without the reviewed cases', () => {
    const direct = editorInput({ currentPrompt: 'P', instruction: 'Add a rule', cases: [] })
    expect(direct).toContain('<team_instruction_about_the_prompt>')
    expect(direct).not.toContain('<reviewed_cases>')
  })
})

describe('the history diff', () => {
  it('marks added and removed lines and keeps the rest', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ])
  })
})
