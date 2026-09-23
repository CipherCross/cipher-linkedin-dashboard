// @vitest-environment jsdom
/**
 * Manager Review after the Phase 6 conversion to the canonical `src/ui`
 * contracts.
 *
 * Pins what the redesign must not have changed: the default tab, that
 * switching to Leads Added swaps the header actions (cohort window + Send to
 * Slack for a period control) and updates the `tab` URL param, the
 * "Nothing to review yet" empty state, the Send to Slack digest post and its
 * disabled/toast behavior, and that the account selector re-scopes the
 * tables. Cohort maturity math itself belongs to lib/review.ts; the fixture
 * below only has to clear its fallback 2w/4w thresholds so a digest exists.
 */
import {
  act, cleanup, fireEvent, render, screen, waitFor, within,
} from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CampaignMetrics, Instance, Lead, Message,
} from '../src/lib/types'

const data = vi.hoisted(() => ({ value: null as unknown }))
const authPost = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('../src/lib/DataContext', () => ({ useData: () => ({ data: data.value, refetch: vi.fn() }) }))
vi.mock('../src/lib/api', () => ({ authPost, authFetch: vi.fn() }))
vi.mock('../src/lib/ToastContext', () => ({ useToast: () => toast }))

import { Review } from '../src/pages/Review'

const DAY_MS = 86_400_000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString()

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'notebook-1',
    label: 'Notebook One',
    last_sync_at: daysAgo(1),
    agent_version: '1.30.0',
    account_name: 'Ada Admin LI',
    account_url: null,
    account_avatar: null,
    config: null,
    config_updated_at: null,
    ...overrides,
  }
}

function campaign(overrides: Partial<CampaignMetrics> = {}): CampaignMetrics {
  return {
    campaign_id: 'notebook-1:1',
    campaign_name: 'Intro sequence',
    instance_id: 'notebook-1',
    status: 'active',
    runtime_status: null,
    is_archived: false,
    status_observed_at: null,
    status_source: null,
    status_raw: null,
    total_leads: 4,
    invites_sent: 4,
    accepted: 3,
    replies: 2,
    acceptance_rate: 75,
    reply_rate: 66.7,
    last_activity_at: daysAgo(37),
    ...overrides,
  }
}

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'l1',
    instance_id: 'notebook-1',
    campaign_id: 'notebook-1:1',
    profile_url: 'https://www.linkedin.com/in/lead-1',
    full_name: 'Lead One',
    headline: null,
    company: null,
    added_at: daysAgo(42),
    invited_at: daysAgo(42),
    connected_at: null,
    first_message_at: null,
    replied_at: null,
    last_action_at: null,
    pipeline_stage: null,
    pipeline_substatus: null,
    lost_reason: null,
    pipeline_stage_changed_at: null,
    assigned_to: null,
    ...overrides,
  }
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    instance_id: 'notebook-1',
    campaign_id: 'notebook-1:1',
    profile_url: 'https://www.linkedin.com/in/lead-1',
    direction: 'in',
    body: 'Sounds interesting, tell me more',
    sent_at: daysAgo(37),
    sentiment: 'positive',
    reason: null,
    classified_at: null,
    ...overrides,
  }
}

// Invited 6 weeks ago: past both the accept (2w) and reply (4w) fallback
// maturity thresholds lib/review.ts falls back to when the accepted-lead
// sample is this thin, so the cohort is fully matured and buildDigest() has
// something to report. `added_at` sits inside the default "Past 3 months"
// Leads Added range too.
function maturedLeads(): Lead[] {
  return [
    lead({ id: 'l1', connected_at: daysAgo(40), replied_at: daysAgo(37) }),
    lead({
      id: 'l2', profile_url: 'https://www.linkedin.com/in/lead-2',
      connected_at: daysAgo(40), replied_at: daysAgo(36),
    }),
    lead({ id: 'l3', profile_url: 'https://www.linkedin.com/in/lead-3', connected_at: daysAgo(39) }),
    lead({ id: 'l4', profile_url: 'https://www.linkedin.com/in/lead-4' }),
  ]
}

function maturedMessages(): Message[] {
  return [
    message({ id: 1, profile_url: 'https://www.linkedin.com/in/lead-1', sent_at: daysAgo(37), intent_level: 'p3' }),
    message({
      id: 2, profile_url: 'https://www.linkedin.com/in/lead-2',
      sent_at: daysAgo(36), sentiment: 'neutral',
    }),
  ]
}

function populatedData(overrides: {
  leads?: Lead[]
  messages?: Message[]
  campaigns?: CampaignMetrics[]
  instances?: Instance[]
} = {}) {
  return {
    instances: overrides.instances ?? [instance()],
    campaigns: overrides.campaigns ?? [campaign()],
    leads: overrides.leads ?? maturedLeads(),
    messages: overrides.messages ?? maturedMessages(),
    steps: [],
    pipelineEvents: [],
    conversationReplyIntents: [],
  }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.search}</div>
}

async function renderReview() {
  render(<MemoryRouter><Review /><LocationProbe /></MemoryRouter>)
  await act(async () => {})
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Review, populated with a matured cohort', () => {
  beforeEach(() => {
    data.value = populatedData()
  })

  it('defaults to the Review tab and swaps the header actions when Leads Added is selected', async () => {
    await renderReview()

    expect(screen.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('radiogroup', { name: 'Cohort window' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Send to Slack/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Date range' })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Leads Added' }))

    expect(screen.getByRole('tab', { name: 'Leads Added' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('button', { name: 'Date range' })).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Cohort window' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Send to Slack/ })).toBeNull()
    expect(screen.getByTestId('location').textContent).toContain('tab=leads-added')
  })

  it('posts the digest to /api/review-digest and toasts success', async () => {
    authPost.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    await renderReview()

    const button = screen.getByRole('button', { name: /Send to Slack/ }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    await waitFor(() => expect(authPost).toHaveBeenCalledTimes(1))
    expect(authPost.mock.calls[0][0]).toBe('/api/review-digest')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Review digest sent to Slack'))
  })

  it('toasts the error message when the digest post fails', async () => {
    authPost.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'Slack is down' }) })
    await renderReview()

    fireEvent.click(screen.getByRole('button', { name: /Send to Slack/ }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't send digest: Slack is down"))
  })

  it('keeps the Leads Added table in its fixed order, largest first, with a total', async () => {
    await renderReview()
    fireEvent.click(screen.getByRole('tab', { name: 'Leads Added' }))

    // The table has never been re-sortable; the conversion must not make it so.
    const header = screen.getByRole('columnheader', { name: /Leads added/ })
    expect(within(header).queryByRole('button')).toBeNull()
    expect(screen.getByRole('table', { name: 'Leads added by campaign' })).toBeTruthy()
  })

  it('re-scopes the tables when the account selector changes', async () => {
    data.value = populatedData({
      instances: [instance(), instance({ id: 'notebook-2', label: 'Notebook Two', account_name: 'Beta Admin LI' })],
      campaigns: [campaign(), campaign({
        campaign_id: 'notebook-2:9', campaign_name: 'Second campaign', instance_id: 'notebook-2',
      })],
      leads: [
        ...maturedLeads(),
        lead({
          id: 'l5', instance_id: 'notebook-2', campaign_id: 'notebook-2:9',
          profile_url: 'https://www.linkedin.com/in/lead-5', connected_at: daysAgo(40), replied_at: daysAgo(37),
        }),
      ],
    })
    await renderReview()

    expect(screen.getAllByText('Second campaign').length).toBeGreaterThan(0)

    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), { target: { value: 'notebook-1' } })

    expect(screen.queryAllByText('Second campaign').length).toBe(0)
  })
})

describe('Review, no invites yet', () => {
  beforeEach(() => {
    data.value = populatedData({ leads: [lead({ invited_at: null, added_at: null })], messages: [] })
  })

  it('shows the empty state and a disabled Send to Slack action', async () => {
    await renderReview()

    expect(screen.getByText('Nothing to review yet')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Send to Slack/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
