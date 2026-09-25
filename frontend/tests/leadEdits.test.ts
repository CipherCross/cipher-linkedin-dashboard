import { describe, expect, it } from 'vitest'
import { withLeadEdits, type LeadEdit } from '../src/lib/leadEdits'
import type { Lead } from '../src/lib/types'

const lead = { id: 'l1', pipeline_stage: null, assigned_to: null } as unknown as Lead

describe('withLeadEdits', () => {
  it('lays a saved edit over a row the route data does not hold', () => {
    const edits = new Map<string, LeadEdit>([['l1', { patch: { pipeline_stage: 'interested', assigned_to: 7 }, at: 200 }]])
    expect(withLeadEdits(lead, edits)).toMatchObject({ pipeline_stage: 'interested', assigned_to: 7 })
  })

  it('leaves out an edit the row was fetched after, so it cannot mask a later change', () => {
    const edits = new Map<string, LeadEdit>([['l1', { patch: { pipeline_stage: 'interested' }, at: 200 }]])
    expect(withLeadEdits(lead, edits, 100).pipeline_stage).toBe('interested')
    expect(withLeadEdits(lead, edits, 200)).toBe(lead)
    expect(withLeadEdits(lead, edits, 300)).toBe(lead)
  })

  it('returns the row itself when there is nothing to apply', () => {
    expect(withLeadEdits(lead, new Map())).toBe(lead)
    expect(withLeadEdits(lead, undefined)).toBe(lead)
  })
})
