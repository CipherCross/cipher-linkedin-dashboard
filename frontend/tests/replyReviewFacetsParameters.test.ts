import { describe, expect, it } from 'vitest'
import { analyticsOperation, facetsOperation, inboxOperation } from '../api/_lib/data/operations/replyReviews.js'

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

  it('projects review_revision from the message selected for the inbox row', () => {
    const statement = inboxOperation.build({
      actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' },
      params: {
        scope: 'all', captureStartedAt: null, instanceId: null, campaignId: null, ownerId: null,
        sentiment: null, reasonId: null, action: null, query: null, view: 'all',
        unacknowledged: false, unowned: false, overdue: false, my: false, currentActorId: null,
        from: null, to: null, metricScope: null,
      },
      page: { limit: 50, cursor: null }, after: undefined, range: undefined,
    })

    expect(statement.text).toContain('pending_review_revision')
    expect(statement.text).toContain('latest_review_revision')
    expect(statement.text).toContain('CASE WHEN f.pending_message_id IS NOT NULL')
    expect(statement.text).toContain('COALESCE(f.pending_review_revision, 0)')
    expect(statement.text).toContain('COALESCE(f.latest_review_revision, 0)')
    expect(statement.text).toContain('AS review_revision')
  })

  it('sources weekly_latest from weeks before ordering its distinct rows', () => {
    const statement = analyticsOperation.build({
      actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' },
      params: {
        from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z',
        instanceId: null, campaignId: null, ownerId: null, metricBase: 'dialogues',
      },
      page: { limit: 1, cursor: null }, after: undefined, range: undefined,
    })
    const weeklyLatest = statement.text.match(/weekly_latest AS \(([\s\S]*?)\), weekly_classified AS/)

    expect(weeklyLatest).not.toBeNull()
    expect(weeklyLatest![1]).toContain('FROM weeks')
    expect(weeklyLatest![1].indexOf('FROM weeks')).toBeLessThan(weeklyLatest![1].indexOf('ORDER BY'))
  })
})
