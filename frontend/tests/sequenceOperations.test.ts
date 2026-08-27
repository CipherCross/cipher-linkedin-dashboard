import { describe, expect, it } from 'vitest'
import { buildApplicationRegistry } from '../api/_lib/data/operations/index.js'
import {
  SEQUENCE_COMMANDS,
  SEQUENCE_OPERATIONS,
  createSequenceOperation,
  saveSequenceOperation,
  sequenceCommentsOperation,
} from '../api/_lib/data/operations/sequences.js'
import type { UserActorContext } from '../api/_lib/data/contracts.js'

const actor: UserActorContext = {
  kind: 'user',
  actorId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-test',
  role: 'member',
}

describe('Sequence Builder operation allowlist', () => {
  it('registers every read and write under fixed semantic names', () => {
    const registry = buildApplicationRegistry()
    for (const operation of Object.values(SEQUENCE_OPERATIONS)) {
      expect(registry.lookupQuery(operation)).toBeDefined()
    }
    for (const operation of Object.values(SEQUENCE_COMMANDS)) {
      expect(registry.lookupCommand(operation)).toBeDefined()
    }
  })

  it('parameterizes document JSON and actor identity on create', () => {
    const statement = createSequenceOperation.build({
      actor,
      params: {
        name: 'Founder outreach',
        documentJson: '{"version":1}',
        actorName: 'Alex',
      },
    })
    expect(statement.text).toContain('INSERT INTO public.sequence_documents')
    expect(statement.text).not.toContain('Founder outreach')
    expect(statement.values).toEqual([
      'Founder outreach',
      '{"version":1}',
      actor.actorId,
      'Alex',
    ])
  })

  it('makes autosave revision compare-and-swap explicit in SQL', () => {
    const statement = saveSequenceOperation.build({
      actor,
      params: {
        sequenceId: '22222222-2222-4222-8222-222222222222',
        expectedRevision: 7,
        name: 'Founder outreach',
        documentJson: '{"version":1}',
        actorName: 'Alex',
      },
    })
    expect(statement.text).toContain('d.revision = $2::integer')
    expect(statement.text).toContain('revision = d.revision + 1')
    expect(statement.values?.[1]).toBe(7)
  })

  it('loads threaded comments in deterministic message order', () => {
    const statement = sequenceCommentsOperation.build({
      actor,
      params: { sequenceId: '22222222-2222-4222-8222-222222222222' },
      page: { limit: 100, cursor: null },
      range: undefined,
      after: undefined,
    })
    expect(statement.text).toContain('JOIN public.sequence_comment_messages')
    expect(statement.text).toContain('ORDER BY t.created_at, t.id, m.created_at, m.id')
  })
})
