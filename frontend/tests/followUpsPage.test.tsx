// @vitest-environment jsdom
/**
 * The Follow-ups queue after its Phase 6 conversion to the canonical `src/ui`
 * contracts.
 *
 * Pins what the redesign must not have changed: the default owner scope (the
 * signed-in teammate, not "all"), that an explicit `owner=all` survives a
 * re-render, the overdue/today/upcoming group order and counts, that every row
 * still opens the same conversation through the same handler with the same
 * `mode: 'follow_up'`, that the LinkedIn and Review-in-Replies links still
 * point at the lead's own profile and thread, and the empty/no-match/migration
 * states.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CampaignMetrics, ConversationLatestMessage, DashboardData, FollowUpState, Instance, Lead,
  TeamMember,
} from '../src/lib/types'
import { businessDateKey as realBusinessDateKey } from '../src/lib/followUps'

const openConversation = vi.fn()

vi.mock('../src/lib/ConversationContext', () => ({
  useConversation: () => ({ openConversation }),
}))

const ANN: TeamMember = {
  id: 1, name: 'Ann', active: true, created_at: '2026-01-01T00:00:00Z',
  auth_user_id: 'u1', email: 'ann@example.test', role: 'member',
}
const BOB: TeamMember = {
  id: 2, name: 'Bob', active: true, created_at: '2026-01-01T00:00:00Z',
  auth_user_id: 'u2', email: 'bob@example.test', role: 'member',
}

vi.mock('../src/lib/useFollowUpActions', () => ({
  useFollowUpActions: () => ({ actor: 'Ann', members: [ANN, BOB] }),
}))

const campaign = (over: Partial<CampaignMetrics>): CampaignMetrics => ({
  campaign_id: 'c1', campaign_name: 'Campaign', instance_id: 'notebook-1', status: 'active',
  runtime_status: null, is_archived: false, status_observed_at: null, status_source: null,
  status_raw: null, total_leads: 0, invites_sent: 0, accepted: 0, replies: 0,
  acceptance_rate: null, reply_rate: null, lifetime_acceptance_rate: null,
  lifetime_reply_rate: null, last_activity_at: null,
  ...over,
} as CampaignMetrics)

const lead = (over: Partial<Lead>): Lead => ({
  id: 'l1', instance_id: 'notebook-1', campaign_id: 'c1', profile_url: 'https://linkedin.com/in/x',
  full_name: 'Someone', headline: null, company: null, added_at: '2026-08-01T00:00:00Z',
  invited_at: '2026-08-01T00:00:00Z', connected_at: null, first_message_at: null,
  replied_at: null, last_action_at: null, pipeline_stage: null, pipeline_substatus: null,
  lost_reason: null, pipeline_stage_changed_at: null, assigned_to: null,
  ...over,
} as Lead)

const followUpState = (over: Partial<FollowUpState>): FollowUpState => ({
  instance_id: 'notebook-1', profile_url: 'https://linkedin.com/in/x', next_follow_up_date: null,
  owner_id: null, revision: 0, last_event_id: null, last_mutation_id: null,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', updated_by: 'Ann',
  archived_at: null,
  ...over,
} as FollowUpState)

const EMPTY_DATA: DashboardData = {
  instances: [], campaigns: [], activity: [], leads: [], syncRuns: [], messages: [],
  conversationReplyIntents: [], annotations: [], steps: [], teamMembers: [], rosterPath: 'supabase',
  pipelineEvents: [], followUpStates: [], latestConversationMessages: [], followUpsAvailable: true,
  savedSearches: [], icps: [], icpPersonas: [], icpIndustries: [], hypotheses: [],
  hypothesisCampaigns: [], campaignSequenceContext: null,
}

const data = vi.hoisted(() => ({ value: null as DashboardData | null }))

vi.mock('../src/lib/DataContext', () => ({ useData: () => ({ data: data.value }) }))

const { FollowUps, followUpRepliesHref } = await import('../src/pages/FollowUps')

/** "Today" in the same Madrid business-date sense the page itself buckets by
 *  (`followUpBucket` compares these strings directly, never local time), so
 *  the fixtures land in the bucket their name promises regardless of when or
 *  where the suite runs. */
function businessDateKey(offsetDays = 0): string {
  const [year, month, day] = realBusinessDateKey().split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + offsetDays)).toISOString().slice(0, 10)
}

const INSTANCE_1: Instance = {
  id: 'notebook-1', label: 'Notebook One', last_sync_at: null, agent_version: null,
  account_name: 'Acme LI', account_url: null, account_avatar: null, config: null,
  config_updated_at: null,
}

const paint = (initialEntries: string[] = ['/']) =>
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <FollowUps />
    </MemoryRouter>,
  )

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  data.value = null
})

describe('Follow-ups, owner scope', () => {
  beforeEach(() => {
    data.value = {
      ...EMPTY_DATA,
      instances: [INSTANCE_1],
      campaigns: [campaign({ campaign_id: 'c1', campaign_name: 'Campaign A' })],
      leads: [
        lead({ id: 'ann-lead', profile_url: 'https://linkedin.com/in/ann-contact', full_name: 'Ann Contact', assigned_to: 1 }),
        lead({ id: 'bob-lead', profile_url: 'https://linkedin.com/in/bob-contact', full_name: 'Bob Contact', assigned_to: 2 }),
      ],
      followUpStates: [
        followUpState({ profile_url: 'https://linkedin.com/in/ann-contact', owner_id: 1, next_follow_up_date: businessDateKey(-1) }),
        followUpState({ profile_url: 'https://linkedin.com/in/bob-contact', owner_id: 2, next_follow_up_date: businessDateKey(-1) }),
      ],
    }
  })

  it('defaults to the authenticated teammate’s own queue', () => {
    paint()
    expect(screen.getByText('Ann Contact')).toBeDefined()
    expect(screen.queryByText('Bob Contact')).toBeNull()
  })

  it('preserves an explicit owner=all override', () => {
    paint(['/?owner=all'])
    expect(screen.getByText('Ann Contact')).toBeDefined()
    expect(screen.getByText('Bob Contact')).toBeDefined()
  })
})

describe('Follow-ups, due-date groups', () => {
  beforeEach(() => {
    data.value = {
      ...EMPTY_DATA,
      instances: [INSTANCE_1],
      campaigns: [campaign({ campaign_id: 'c1', campaign_name: 'Campaign A' })],
      leads: [
        lead({ id: 'l-overdue', profile_url: 'https://linkedin.com/in/overdue', full_name: 'Olive Overdue' }),
        lead({ id: 'l-today', profile_url: 'https://linkedin.com/in/today', full_name: 'Tara Today' }),
        lead({ id: 'l-upcoming', profile_url: 'https://linkedin.com/in/upcoming', full_name: 'Uma Upcoming' }),
      ],
      followUpStates: [
        followUpState({ profile_url: 'https://linkedin.com/in/overdue', owner_id: 1, next_follow_up_date: businessDateKey(-2) }),
        followUpState({ profile_url: 'https://linkedin.com/in/today', owner_id: 1, next_follow_up_date: businessDateKey(0) }),
        followUpState({ profile_url: 'https://linkedin.com/in/upcoming', owner_id: 1, next_follow_up_date: businessDateKey(5) }),
      ],
    }
  })

  it('renders Overdue, Today, and Upcoming in that order, each with a count of one', () => {
    paint(['/?owner=all'])
    const headings = screen.getAllByRole('heading', { level: 2 })
    const labels = headings.map((heading) => heading.textContent)
    expect(labels).toEqual(['Overdue', 'Today', 'Upcoming'])
    for (const heading of headings) {
      const section = heading.closest('section') as HTMLElement
      expect(within(section).getByText('1')).toBeDefined()
    }
  })

  it('gives each row exactly one primary "Open follow-up" action that opens the same lead in follow-up mode', () => {
    paint(['/?owner=all'])
    const buttons = screen.getAllByRole('button', { name: 'Open follow-up' })
    expect(buttons).toHaveLength(3)

    buttons[0].click()
    expect(openConversation).toHaveBeenCalledTimes(1)
    const [openedLead, options] = openConversation.mock.calls[0]
    expect(openedLead.full_name).toBe('Olive Overdue')
    expect(options).toEqual({ mode: 'follow_up' })
  })

  it('links LinkedIn and Review in Replies to the row’s own profile and thread', () => {
    data.value = {
      ...data.value!,
      latestConversationMessages: [
        {
          instance_id: 'notebook-1', profile_url: 'https://linkedin.com/in/overdue', message_id: 77,
          direction: 'in', body: 'Thanks for reaching out', sent_at: '2026-09-01T00:00:00Z',
        } as ConversationLatestMessage,
      ],
    }
    paint(['/?owner=all'])

    const row = screen.getByText('Olive Overdue').closest('article') as HTMLElement
    const linkedinLink = within(row).getByRole('link', { name: /LinkedIn/ })
    expect(linkedinLink.getAttribute('href')).toBe('https://linkedin.com/in/overdue')

    const repliesLink = within(row).getByRole('link', { name: 'Review in Replies' })
    expect(repliesLink.getAttribute('href')).toBe(
      followUpRepliesHref('notebook-1', 'https://linkedin.com/in/overdue', 77),
    )
  })
})

describe('Follow-ups, empty and no-match states', () => {
  it('shows the "empty" state when nothing is scheduled at all', () => {
    data.value = { ...EMPTY_DATA, instances: [INSTANCE_1] }
    paint()
    expect(document.querySelector('[data-empty-kind="empty"]')).not.toBeNull()
    expect(screen.getByText('No follow-ups scheduled')).toBeDefined()
  })

  it('shows the "no-match" state when filters exclude every scheduled follow-up', () => {
    data.value = {
      ...EMPTY_DATA,
      instances: [INSTANCE_1],
      campaigns: [campaign({ campaign_id: 'c1', campaign_name: 'Campaign A' })],
      leads: [lead({ id: 'l1', profile_url: 'https://linkedin.com/in/x', full_name: 'Findable Lead', assigned_to: 1 })],
      followUpStates: [followUpState({ profile_url: 'https://linkedin.com/in/x', owner_id: 1, next_follow_up_date: businessDateKey(-1) })],
    }
    paint(['/?owner=all&q=nobody-matches-this'])
    expect(document.querySelector('[data-empty-kind="no-match"]')).not.toBeNull()
    expect(screen.getByText('No follow-ups match these filters')).toBeDefined()
  })
})

describe('Follow-ups, migration unavailable', () => {
  it('shows the upgrade notice instead of the queue', () => {
    data.value = { ...EMPTY_DATA, instances: [INSTANCE_1], followUpsAvailable: false }
    paint()
    expect(screen.getByText('Follow-ups need a database upgrade')).toBeDefined()
    expect(screen.queryByLabelText('Search follow-ups')).toBeNull()
  })
})
