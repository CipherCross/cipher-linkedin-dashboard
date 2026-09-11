import { describe, expect, it } from 'vitest'
import {
  REPLY_REVIEW_OPERATIONS,
  analyticsOperation,
  capabilitiesOperation,
  facetsOperation,
  inboxOperation,
  replyFilterBuilder,
  replyFilterValues,
  reviewHistoryOperation,
  threadOperation,
} from '../api/_lib/data/operations/replyReviews.js'
import { activateOperation, deleteReasonsOperation, insertReasonsOperation, lockThreadOperation, projectReviewOperation, saveReviewOperation, setWorkflowOperation } from '../api/_lib/data/operations/replyReviewWrites.js'

describe('manual reply-review Neon operations', () => {
  it('exports the five named read operations', () => {
    expect(Object.values(REPLY_REVIEW_OPERATIONS).slice(0, 5)).toEqual([
      'replies.capabilities', 'replies.inbox', 'replies.facets', 'replies.thread', 'replies.analytics',
    ])
  })

  it('exposes schema readiness separately from manual activation progress', () => {
    const statement = capabilitiesOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { probe: null }, page: { limit: 1, cursor: null }, after: undefined, range: undefined })
    expect(statement.text).toContain('activation_in_progress')
    expect(statement.text).toContain('activation_processed')
    expect(capabilitiesOperation.mapRow!({ schema_version: 'reply-review-v1', mode: 'prepared', activation_in_progress: true, activation_cursor: 10, activation_processed: 10, activation_total: 20, activation_cutoff: 30, activation_batch_size: 500, activation_mutation_id: 'm' })).toMatchObject({ available: true, active: false, manual_ready: false, reason: 'not_activated', activation_in_progress: true, activation_processed: 10 })
  })

  it('keeps filters parameterized and escapes body search as a literal', () => {
    const predicate = replyFilterBuilder('i', 1)
    expect(predicate.sql).toContain('$7::text')
    expect(predicate.sql).toContain("ESCAPE '\\'")
    expect(replyFilterValues({ query: '100%_ready', reason_id: 'budget' })).toContain('100%_ready')
    expect(predicate.sql).not.toContain('100%_ready')
  })

  it('uses the same scope values in list and analytics requests', () => {
    const list = inboxOperation.build({
      actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' },
      params: { scope: 'all', captureStartedAt: null, instanceId: null, campaignId: null, ownerId: null, sentiment: null, reasonId: null, action: null, query: null, view: 'all', unacknowledged: false, unowned: false, overdue: false, my: false, currentActorId: null, from: null, to: null, metricScope: null },
      page: { limit: 50, cursor: null }, after: undefined, range: undefined,
    })
    const analytics = analyticsOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', instanceId: null, campaignId: null, ownerId: null, metricBase: null }, page: { limit: 1, cursor: null }, after: undefined, range: undefined })
    expect(list.text).toContain("i.direction = 'in'")
    expect(analytics.text).toContain("m.direction = 'in'")
    expect(analytics.values).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null, null, null, null, null, null, null, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'])
  })

  it('maps the analytics missing-reason drilldown to manual negative/objection messages', () => {
    const analytics = analyticsOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', instanceId: null, campaignId: null, ownerId: null, metricBase: 'dialogues' }, page: { limit: 1, cursor: null }, after: undefined, range: undefined })
    expect(analytics.text).toContain("'missing_reason'")
    const drilldown = inboxOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: {
      scope: 'all', captureStartedAt: null, instanceId: null, campaignId: null, ownerId: null,
      sentiment: null, reasonId: null, action: null, query: null, view: 'all', unacknowledged: false,
      unowned: false, overdue: false, my: false, currentActorId: null, from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z', metricScope: 'reason:missing_reason',
    }, page: { limit: 50, cursor: null }, after: undefined, range: undefined })
    expect(drilldown.values).toContain('missing_reason')
    expect(drilldown.text).toContain("= 'missing_reason' AND EXISTS")
    expect(drilldown.text).toContain("sf.sentiment IN ('negative','objection')")
    expect(drilldown.text).toContain("sf.sentiment_provenance IN ('human','legacy_manual')")
    expect(drilldown.text).toContain('NOT EXISTS (SELECT 1 FROM public.reply_review_reasons rm')
  })

  it('keeps every analytics drilldown representable in the Replies predicate', () => {
    const scopes = [
      'coverage:dialogues', 'coverage:full_dialogues', 'coverage:messages', 'coverage:unreviewed_dialogues',
      'coverage:unreviewed_intent', 'coverage:legacy_ai', 'coverage:account', 'coverage:campaign',
      'coverage:weekly_volume', 'coverage:weekly_messages',
      'sentiment:positive', 'sentiment:neutral', 'sentiment:negative', 'sentiment:objection',
      'sentiment:referral', 'sentiment:auto', 'sentiment:latest_unreviewed', 'sentiment:only_auto',
      'sentiment:business_rate', 'sentiment:negative_objection',
      'reason:no_need', 'reason:timing', 'reason:budget', 'reason:existing_solution', 'reason:offer_fit',
      'reason:wrong_person', 'reason:trust_information', 'reason:do_not_contact', 'reason:other', 'reason:missing_reason',
      'workflow:do_not_contact', 'workflow:needs_confirmation', 'workflow:overdue', 'workflow:follow_up_today',
      'workflow:follow_up_later', 'workflow:needs_reply', 'workflow:awaiting_reply', 'workflow:resolved',
      'workflow:closed_soft', 'workflow:closed_hard', 'workflow:transfers',
    ] as const
    for (const metricScope of scopes) {
      const statement = inboxOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: {
        scope: 'all', captureStartedAt: null, instanceId: null, campaignId: null, ownerId: null,
        sentiment: null, reasonId: null, action: null, query: null, view: 'all', unacknowledged: false,
        unowned: false, overdue: false, my: false, currentActorId: null, from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z', metricScope,
      }, page: { limit: 50, cursor: null }, after: undefined, range: undefined })
      expect(statement.values?.[20], metricScope).toBe(metricScope.slice(metricScope.indexOf(':') + 1))
      expect(statement.text).toContain("$21::text IS NULL OR")
      const [kind, value] = metricScope.split(':')
      if (kind === 'sentiment' && ['positive', 'neutral', 'negative', 'objection', 'referral', 'auto'].includes(value)) expect(statement.values?.[4]).toBe(value)
      if (kind === 'sentiment' && !['positive', 'neutral', 'negative', 'objection', 'referral', 'auto'].includes(value)) expect(statement.values?.[4]).toBeNull()
      if (kind === 'reason') expect(statement.values?.[3]).toBe(value)
      if (kind === 'workflow' && ['needs_reply', 'follow_up', 'awaiting_reply', 'resolved', 'closed_soft', 'closed_hard'].includes(value)) expect(statement.values?.[5]).toBe(value)
      if (kind === 'workflow' && !['needs_reply', 'follow_up', 'awaiting_reply', 'resolved', 'closed_soft', 'closed_hard'].includes(value)) expect(statement.values?.[5]).toBeNull()
    }
  })

  it('locks the exact existing thread key and uses optimistic revisions', () => {
    const lock = lockThreadOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { instanceId: 'n1', profileUrl: 'p' } })
    expect(lock.text).toContain('hashtextextended(jsonb_build_array')
    expect(saveReviewOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { instanceId: 'n1', profileUrl: 'p', messageId: 4, expectedRevision: 2, sentiment: 'negative', intentState: 'none', intentLevel: null, comment: null, taxonomyVersion: 'reply-review-v1', actorId: 'actor' } }).text).toContain('revision = $2::bigint')
    expect(setWorkflowOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { instanceId: 'n1', profileUrl: 'p', expectedRevision: 3, observedInboundRevision: 4, action: 'follow_up', ownerId: 7, nextFollowUpDate: '2026-09-12', doNotContact: false, supportingMessageId: null, actorId: 'actor', mutationId: '00000000-0000-4000-8000-000000000000' } }).values).toContain(3)
  })

  it('applies every inbox view and independent queue flags in SQL', () => {
    for (const view of ['all', 'unreviewed', 'needs_reply', 'deferred', 'completed'] as const) {
      const statement = inboxOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: {
        scope: 'new', captureStartedAt: '2026-09-01T00:00:00.000Z', instanceId: null, campaignId: null, ownerId: null,
        sentiment: null, reasonId: null, action: null, query: null, view, unacknowledged: true, unowned: true, overdue: true,
        my: true, currentActorId: '17', from: null, to: null, metricScope: null,
      }, page: { limit: 50, cursor: null }, after: undefined, range: undefined })
      expect(statement.text).toContain(`$12::text = '${view}'`)
      expect(statement.text).toContain('inbound_revision')
      expect(statement.text).toContain('first_seen_at')
    }
    expect(inboxOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: {
      scope: 'all', captureStartedAt: null, instanceId: null, campaignId: null, ownerId: null, sentiment: null, reasonId: null, action: null, query: null,
      view: 'all', unacknowledged: false, unowned: false, overdue: false, my: true, currentActorId: '00000000-0000-4000-8000-000000000001', from: null, to: null, metricScope: null,
    }, page: { limit: 50, cursor: null }, after: undefined, range: undefined }).text).toContain('team_members tm')
    const bounded = inboxOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: {
      scope: 'all', captureStartedAt: null, instanceId: null, campaignId: null, ownerId: null, sentiment: null, reasonId: null, action: null, query: null,
      view: 'all', unacknowledged: false, unowned: false, overdue: false, my: false, currentActorId: null,
      from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', metricScope: 'coverage:latest_unreviewed',
    }, page: { limit: 50, cursor: null }, after: undefined, range: undefined })
    expect(bounded.values).toContain('2026-01-01T00:00:00.000Z')
    expect(bounded.values).toContain('2026-02-01T00:00:00.000Z')
    expect(bounded.text).toContain('latest_sentiment')
    expect(bounded.text).toContain("$21::text = 'latest_unreviewed'")
    expect(bounded.text).toContain("$21::text = 'follow_up_today'")
    const cursor = inboxOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: {
      scope: 'all', captureStartedAt: null, instanceId: null, campaignId: null, ownerId: null, sentiment: null, reasonId: null, action: null, query: null,
      view: 'all', unacknowledged: false, unowned: false, overdue: false, my: false, currentActorId: null, from: null, to: null, metricScope: null,
    }, page: { limit: 50, cursor: null }, after: ['2026-02-01T00:00:00.000Z', 'n1', 'p1'], range: undefined })
    expect(cursor.text).toContain('(f.sort_at, f.instance_id, f.profile_url)')
    expect(cursor.text).toContain('(instance_id,profile_url) > ($19::text,$20::text)')
    expect(cursor.text).toContain('sort_at END DESC NULLS LAST')
  })

  it('splits reason replacement into two commands inside the caller transaction', () => {
    expect(deleteReasonsOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { messageId: 4 } }).text).toContain('DELETE FROM')
    expect(insertReasonsOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { messageId: 4, reasonIds: ['budget'] } }).text).toContain('INSERT INTO')
    expect(deleteReasonsOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { messageId: 4 } }).text).not.toContain('WITH')
  })

  it('keeps sentiment and intent projection provenance independent', () => {
    const statement = projectReviewOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: {
      instanceId: 'n1', profileUrl: 'p', messageId: 4, expectedRevision: 1, sentiment: null, intentState: 'unreviewed', intentLevel: null,
      comment: null, taxonomyVersion: 'reply-review-v1', actorId: 'actor', reviewedAt: '2020-01-01T00:00:00.000Z',
    } })
    expect(statement.text).toContain("classified_model = CASE WHEN $2::text IS NULL THEN NULL")
    expect(statement.text).toContain("intent_classified_model = CASE WHEN $3::text = 'unreviewed' THEN NULL")
    expect(statement.text).toContain('intent_taxonomy_version = CASE WHEN $3::text = \'unreviewed\' THEN NULL')
    expect(statement.text).toContain('clock_timestamp()')
    expect(statement.text).not.toContain('SET sentiment = $2::text, intent_level')
  })

  it('preserves system and machine history provenance instead of coercing it to human', () => {
    const mapped = reviewHistoryOperation.mapRow!({
      id: 4, instance_id: 'n1', profile_url: 'p', message_id: null, actor_id: null,
      provenance: 'machine', before: {}, after: {}, occurred_at: '2026-01-01T00:00:00Z', mutation_id: 'm',
    })
    expect(mapped.provenance).toBe('machine')
  })

  it('keeps resumable activation progress and replay metadata in the operator result', () => {
    const statement = activateOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { mutationId: 'm', actorId: 'actor', batchSize: 250 } })
    expect(statement.text).toContain('activate_manual_reply_review($1::uuid, $2::integer)')
    expect(statement.values).toEqual(['m', 250])
    const mapped = activateOperation.mapResult!([{ result: { mode: 'prepared', complete: false, processed: 500, remaining: 1200, cursor: 500, replayed: false, mutation_id: 'm' } }], 1)
    expect(mapped).toMatchObject({ mode: 'prepared', complete: false, processed: 500, remaining: 1200, cursor: 500, replayed: false, mutation_id: 'm' })
  })

  it('threads are bounded by a keyset cursor, not a full-history read', () => {
    const statement = threadOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { instanceId: 'n1', profileUrl: 'p', focusMessageId: null, direction: 'newer' }, page: { limit: 100, cursor: null }, after: ['2026-09-01T00:00:00.000Z', 10], range: undefined })
    expect(statement.text).toContain('ORDER BY m.sent_at ASC, m.id ASC')
    expect(statement.text).toContain('(m.sent_at, m.id) >')
    expect(statement.text).not.toContain('m.id >= $3::bigint')
    expect(statement.text).toContain("$6::text = 'newer'")
    expect(statement.text).toContain('LIMIT 101')
    expect(statement.text).toContain('CASE WHEN $6::text = \'older\' THEN m.sent_at END DESC')
    expect(statement.text).toContain('has_older')
    expect(statement.text).toContain('has_newer')
    const older = threadOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { instanceId: 'n1', profileUrl: 'p', focusMessageId: 20, direction: 'older' }, page: { limit: 100, cursor: null }, after: undefined, range: undefined })
    expect(older.text).toContain("$6::text = 'older'")
    expect(older.text).toContain('ORDER BY m.sent_at DESC, m.id DESC LIMIT 101')
    expect(older.text).toContain('(m.sent_at, m.id) < (f.sent_at, f.id)')
    expect(older.text).toContain('CASE WHEN $6::text = \'older\' THEN m.sent_at END DESC')
    expect(older.text).not.toContain('m.id >= $3::bigint')
    const newerFocus = threadOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { instanceId: 'n1', profileUrl: 'p', focusMessageId: 20, direction: 'newer' }, page: { limit: 50, cursor: null }, after: undefined, range: undefined })
    expect(newerFocus.text).toContain("$4::timestamptz IS NULL AND $6::text = 'newer'")
    expect(newerFocus.text).toContain('(m.sent_at, m.id) >= (f.sent_at, f.id)')
    expect(newerFocus.text).toContain('ORDER BY m.sent_at ASC, m.id ASC LIMIT 51')
    const newerCursor = threadOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { instanceId: 'n1', profileUrl: 'p', focusMessageId: null, direction: 'newer' }, page: { limit: 50, cursor: null }, after: ['2026-09-01T00:00:00.000Z', 20], range: undefined })
    expect(newerCursor.text).toContain("$4::timestamptz IS NOT NULL AND $6::text = 'newer'")
    expect(newerCursor.text).toContain('(m.sent_at, m.id) > ($4::timestamptz,$5::bigint)')
  })

  it('facets aggregate the complete filtered cohort in one parameterized statement', () => {
    const statement = facetsOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: {
      scope: 'new', captureStartedAt: '2026-09-01T00:00:00.000Z', instanceId: 'n1', campaignId: null, ownerId: null,
      sentiment: null, reasonId: null, action: null, query: 'needle', view: 'unreviewed', unacknowledged: true,
      unowned: false, overdue: false, my: false, currentActorId: null, from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z', metricScope: null,
    }, page: { limit: 1, cursor: null }, after: undefined, range: undefined })
    expect(statement.text).toContain('WITH candidate AS')
    expect(statement.text).toContain('jsonb_build_object')
    expect(statement.text).toContain("'accounts'")
    expect(statement.text).toContain("'campaigns'")
    expect(statement.text).toContain("'owners'")
    expect(statement.text).toContain("'actions'")
    expect(statement.text).toContain("'sentiments'")
    expect(statement.text).toContain("'reasons'")
    expect(statement.text).toContain('public.reply_review_reasons')
    expect(statement.values).toContain('needle')
    expect(statement.values).toContain('2026-10-01T00:00:00.000Z')
    expect(facetsOperation.mapRow!({ result: {
      accounts: [{ id: 'n1', count: 2 }], campaigns: [{ id: '__none__', count: 1 }], owners: [{ id: null, count: 2 }],
      actions: [{ value: 'needs_reply', count: 1 }], sentiments: [{ value: null, count: 1 }], reasons: [{ value: 'budget', count: 1 }],
    } })).toEqual({
      accounts: [{ id: 'n1', count: 2 }], campaigns: [{ id: null, count: 1 }], owners: [{ id: null, count: 2 }],
      actions: [{ value: 'needs_reply', count: 1 }], sentiments: [{ value: null, count: 1 }], reasons: [{ value: 'budget', count: 1 }],
    })
  })

  it('keeps analytics on one valid scoped statement with independent denominators', () => {
    const statement = analyticsOperation.build({ actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'member' }, params: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', instanceId: null, campaignId: null, ownerId: null, metricBase: 'dialogues' }, page: { limit: 1, cursor: null }, after: undefined, range: undefined })
    expect(statement.text).toContain('eligible_latest')
    expect(statement.text).toContain('latest_unreviewed')
    expect(statement.text).toContain('only_auto')
    expect(statement.text).toContain('manual_negative')
    expect(statement.text).toContain("'business_rate'")
    expect(statement.text).toContain('weekly_classified')
    expect(statement.text).toContain('weekly_manual_negative')
    expect(statement.text).toContain('comparison_reasons')
    expect(statement.text).toContain('JOIN workflow_cohort wc')
    expect(statement.text).toContain('weekly_rows')
    expect(statement.text).toContain('legacy_ai')
    expect(statement.text).toContain('transfers')
    expect(statement.text).not.toContain("FROM (SELECT unnest(ARRAY['positive','neutral','negative','objection','referral','auto','unreviewed'])")
    expect(statement.text).not.toContain('jsonb_object_agg(s.value')
    expect(statement.text).toContain("'denominator'")
  })
})
