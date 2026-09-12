import { describe, expect, it } from 'vitest'
import { facetsOperation } from '../api/_lib/data/operations/replyReviews.js'

describe('manual reply-review facets parameters', () => {
  it('keeps SQL placeholders contiguous and explicitly typed', () => {
    const statement = facetsOperation.build({
      actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' },
      params: {
        scope: 'new', captureStartedAt: '2026-09-01T00:00:00.000Z', instanceId: 'n1', campaignId: null,
        ownerId: null, sentiment: null, reasonId: null, action: null, query: 'needle',
        view: 'unreviewed', unacknowledged: true, unowned: false, overdue: false, my: false,
        currentActorId: null, from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z',
        metricScope: 'coverage:messages',
      },
      page: { limit: 1, cursor: null }, after: undefined, range: undefined,
    })

    const placeholders = [...statement.text.matchAll(/\$(\d+)::([a-z]+)/g)]
    const numbers = [...new Set(placeholders.map((match) => Number(match[1])))]
    const max = Math.max(...numbers)

    expect(numbers).toEqual(Array.from({ length: max }, (_, index) => index + 1))
    expect(statement.values).toHaveLength(max)
    expect(statement.text).not.toMatch(/\$(\d+)(?!\d|::)/)
    expect(max).toBe(18)
  })
})
