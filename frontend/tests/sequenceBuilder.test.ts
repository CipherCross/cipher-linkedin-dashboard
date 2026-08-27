import { describe, expect, it } from 'vitest'
import {
  CONNECTION_REQUEST_WARNING_LIMIT,
  addBranch,
  addMessageStep,
  addVariation,
  createSequenceDocument,
  graphemeCount,
  interpolateTokens,
  makeConnectionStep,
  moveVariation,
  removeVariation,
  repairBranches,
  resolveCommentAnchor,
  selectionPreview,
  updateBranch,
} from '../src/lib/sequenceBuilder'

describe('Sequence Builder document operations', () => {
  it('starts with one optional connection request and one follow-up message', () => {
    const document = createSequenceDocument()
    expect(document.steps.map((step) => step.kind)).toEqual(['connection', 'message'])
    expect(document.steps[0].variations[0].text).toBe('')
  })

  it('moves a variation across steps without leaving an invalid empty source', () => {
    let document = createSequenceDocument()
    const source = document.steps[1]
    const target = document.steps[0]
    const variation = source.variations[0]
    document = moveVariation(document, variation.id, source.id, target.id)

    expect(document.steps[0].variations.map((item) => item.id)).toContain(variation.id)
    expect(document.steps[1].variations).toHaveLength(1)
    expect(document.steps[1].variations[0].id).not.toBe(variation.id)
  })

  it('swaps a message into the unique first connection-request position', () => {
    let document = addMessageStep(createSequenceDocument())
    const chosen = document.steps[2]
    const oldConnection = document.steps[0]
    document = makeConnectionStep(document, chosen.id)

    expect(document.steps[0]).toMatchObject({ id: chosen.id, kind: 'connection' })
    expect(document.steps.filter((step) => step.kind === 'connection')).toHaveLength(1)
    expect(document.steps.find((step) => step.id === oldConnection.id)?.kind).toBe('message')
  })

  it('repairs branch selections after a selected variation is removed', () => {
    let document = createSequenceDocument()
    const step = document.steps[1]
    document = addVariation(document, step.id)
    document = addBranch(document)
    const selected = document.steps[1].variations[1]
    const branch = document.branches[0]
    document = updateBranch(document, branch.id, {
      selections: { ...branch.selections, [step.id]: selected.id },
    })
    document = removeVariation(document, step.id, selected.id)

    expect(document.branches[0].selections[step.id]).toBe(document.steps[1].variations[0].id)
  })

  it('repairs incomplete branches to exactly one selection per step', () => {
    const document = createSequenceDocument()
    const repaired = repairBranches({
      ...document,
      branches: [{ id: 'branch_a', name: 'A', selections: {} }],
    })
    expect(Object.keys(repaired.branches[0].selections)).toEqual(document.steps.map((step) => step.id))
  })

  it('supports emoji-aware warning counts and personalization previews', () => {
    expect(graphemeCount('👨‍👩‍👧‍👦')).toBe(1)
    expect(graphemeCount('a'.repeat(CONNECTION_REQUEST_WARNING_LIMIT + 1))).toBe(201)
    expect(interpolateTokens('Hi {firstName} from {companyName}', {
      firstName: 'Alex',
      companyName: 'Northstar',
      jobTitle: 'VP',
      senderName: 'Sam',
    })).toBe('Hi Alex from Northstar')
  })
})

describe('selection comment anchors', () => {
  it('re-anchors an unchanged quote after text is inserted before it', () => {
    const anchor = { start: 6, end: 11, quote: 'world' }
    expect(resolveCommentAnchor('Hello brave world', anchor)).toEqual({
      start: 12,
      end: 17,
      quote: 'world',
      stale: false,
    })
  })

  it('preserves a deleted selection as stale context', () => {
    const anchor = { start: 6, end: 11, quote: 'world' }
    expect(resolveCommentAnchor('Hello team', anchor)?.stale).toBe(true)
  })

  it('renders active comment ranges without changing the message text', () => {
    const parts = selectionPreview('Hello world', [{ start: 6, end: 11, quote: 'world' }])
    expect(parts).toEqual([
      { text: 'Hello ', highlighted: false },
      { text: 'world', highlighted: true },
    ])
  })
})
