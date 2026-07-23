import { describe, expect, it } from 'vitest'
import { replyIntentMetrics } from '../src/lib/leads'
import type {
  ConversationReplyIntent, Lead, Message, PipelineEvent, ReplyIntent,
} from '../src/lib/types'

const lead = (id: string, profile: string, campaign = 'i1:c1'): Lead =>
  ({
    id,
    instance_id: 'i1',
    campaign_id: campaign,
    profile_url: profile,
    pipeline_stage: null,
    pipeline_stage_changed_at: null,
  }) as Lead

let messageId = 1
const message = (
  profile: string,
  direction: 'in' | 'out',
  sentAt: string,
  intent: ReplyIntent | null = null,
  campaign = 'i1:c1',
): Message =>
  ({
    id: messageId++,
    instance_id: 'i1',
    campaign_id: campaign,
    profile_url: profile,
    direction,
    body: 'fixture',
    sent_at: sentAt,
    sentiment: direction === 'in' ? 'positive' : null,
    reason: null,
    classified_at: null,
    intent_level: intent,
  }) as Message

const booking = (id: number, leadId: string, at: string): PipelineEvent => ({
  id,
  lead_id: leadId,
  kind: 'stage',
  actor: 'test',
  from_stage: 'negotiations_call',
  to_stage: 'call_booked',
  from_substatus: null,
  to_substatus: null,
  from_assignee: null,
  to_assignee: null,
  lost_reason: null,
  occurred_at: at,
})

const allTime = { id: 'all', label: 'All time', from: null, to: null }
const now = new Date('2026-07-23T12:00:00Z')

describe('P1–P3 conversation outcomes', () => {
  it('keeps P3 durable after a later P1 acknowledgement', () => {
    const l = lead('l1', 'https://linkedin.test/in/one')
    const metrics = replyIntentMetrics(
      [l],
      [
        message(l.profile_url, 'in', '2026-06-01T10:00:00Z', 'p3'),
        message(l.profile_url, 'in', '2026-06-02T10:00:00Z', 'p1'),
      ],
      [],
      allTime,
      { now },
    )
    expect(metrics.p3).toBe(1)
    expect(metrics.p1).toBe(1)
  })

  it('counts only bookings recorded strictly after first P3', () => {
    const l = lead('l2', 'https://linkedin.test/in/two')
    const messages = [message(l.profile_url, 'in', '2026-06-01T10:00:00Z', 'p3')]

    const before = replyIntentMetrics(
      [l],
      messages,
      [booking(1, l.id, '2026-05-31T10:00:00Z')],
      allTime,
      { now },
    )
    expect(before.p3Booked).toBe(0)

    const after = replyIntentMetrics(
      [l],
      messages,
      [
        booking(2, l.id, '2026-05-31T10:00:00Z'),
        booking(3, l.id, '2026-06-03T10:00:00Z'),
      ],
      allTime,
      { now },
    )
    expect(after.p3Booked).toBe(1)
    expect(after.matureP3BookingRate).toBe(100)
  })

  it('requires a recorded unanswered outbound older than 30 days for ghosting', () => {
    const a = lead('l3', 'https://linkedin.test/in/ghost')
    const b = lead('l4', 'https://linkedin.test/in/replied')
    const metrics = replyIntentMetrics(
      [a, b],
      [
        message(a.profile_url, 'in', '2026-05-01T10:00:00Z', 'p3'),
        message(a.profile_url, 'out', '2026-05-02T10:00:00Z'),
        message(b.profile_url, 'in', '2026-05-01T10:00:00Z', 'p3'),
        message(b.profile_url, 'out', '2026-05-02T10:00:00Z'),
        message(b.profile_url, 'in', '2026-05-03T10:00:00Z', 'p1'),
      ],
      [],
      allTime,
      { now },
    )
    expect(metrics.p3).toBe(2)
    expect(metrics.p3Ghosted).toBe(1)
  })

  it('attributes a conversation only to the campaign of its first P3', () => {
    const l1 = lead('l5', 'https://linkedin.test/in/multi', 'i1:c1')
    const l2 = lead('l6', l1.profile_url, 'i1:c2')
    const messages = [
      message(l1.profile_url, 'in', '2026-05-01T10:00:00Z', 'p3', 'i1:c1'),
      message(l1.profile_url, 'in', '2026-05-10T10:00:00Z', 'p3', 'i1:c2'),
    ]
    expect(
      replyIntentMetrics([l1, l2], messages, [], allTime, {
        now,
        campaignId: 'i1:c1',
      }).p3,
    ).toBe(1)
    expect(
      replyIntentMetrics([l1, l2], messages, [], allTime, {
        now,
        campaignId: 'i1:c2',
      }).p3,
    ).toBe(0)
  })

  it('uses the full-thread projection for outbound follow-ups older than the UI cache', () => {
    const l = lead('l7', 'https://linkedin.test/in/projected')
    const intentRow: ConversationReplyIntent = {
      instance_id: l.instance_id,
      profile_url: l.profile_url,
      highest_intent: 'p3',
      first_p1_at: null,
      first_p2_at: null,
      first_p3_at: '2026-01-01T10:00:00Z',
      first_p3_campaign_id: l.campaign_id,
      last_out_after_p3_at: '2026-01-02T10:00:00Z',
      last_in_after_p3_at: null,
    }
    const metrics = replyIntentMetrics(
      [l],
      [message(l.profile_url, 'in', intentRow.first_p3_at!, 'p3')],
      [],
      allTime,
      { now, intentRows: [intentRow] },
    )
    expect(metrics.p3Ghosted).toBe(1)
  })
})
