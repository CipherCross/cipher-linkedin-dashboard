// @vitest-environment jsdom
/**
 * The Overview as an operations page.
 *
 * The old page opened with global KPI cards, then a grid of account cards that
 * each repeated a miniature version of them. Phase 3 turns the first viewport
 * into "what is running, what is broken, who replied" and pushes the portfolio
 * analytics below. Four of those properties are worth a red test rather than a
 * glance, because every one of them is invisible to `tsc -b` and to a build:
 *
 * 1. **Order by attention, not by recency.** A deployment whose publish failed
 *    can easily be the oldest row in the snapshot. A refactor that sorts by
 *    `updated_at` — the obvious thing to do — buries exactly the row somebody
 *    has to act on, and every other assertion would still pass.
 * 2. **Provenance.** A campaign made by hand in Linked Helper must not be
 *    presented as a Builder sequence. Same failure the campaign page guards.
 * 3. **Drafts are not "active".** An undeployed document has no accounts, no
 *    leads and no replies; listing it under a heading that promises what is
 *    live is a quiet lie about the fleet.
 * 4. **Section order.** "Demoted to secondary" is a DOM-order claim and nothing
 *    else — account cards under Fleet health, KPIs and funnel under Analytics,
 *    both after the operational block.
 *
 * ## What is real
 *
 * `Overview`, `ActiveSequences`, `NewReplies`, `GlobalSummary`, the
 * `lib/sequenceHub` ranking and the router. Replaced: `DataContext`,
 * `ConversationContext`, `ToastContext`, the two read functions, and the four
 * analytics children (`KpiCards`, `Funnel`, `AccountCard` and the callout
 * cards) — those are recharts-heavy and unchanged by this phase, so they are
 * stubbed down to a marker whose *position* is what is under test.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DashboardData, Instance, Lead, OverviewSummary,
  SequenceHubDeployment, SequenceHubItem, SequenceHubReplyPreview, SequenceHubSnapshot,
} from '../src/lib/types'

const NOW = new Date('2026-09-01T12:00:00.000Z')

const openConversation = vi.fn()
const createSequence = vi.fn()
const fetchNeonOverviewSummary = vi.fn()
const fetchNeonSequenceHub = vi.fn()
const resolveReadPath = vi.fn()

let currentData: DashboardData

vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({ data: currentData, phase: 'full', refetch: vi.fn() }),
}))
vi.mock('../src/lib/ConversationContext', () => ({
  useConversation: () => ({ openConversation }),
}))
vi.mock('../src/lib/ToastContext', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))
vi.mock('../src/lib/dashboardReads', () => ({
  resolveReadPath: () => resolveReadPath(),
  fetchNeonOverviewSummary: (...args: unknown[]) => fetchNeonOverviewSummary(...args),
  fetchNeonSequenceHub: (...args: unknown[]) => fetchNeonSequenceHub(...args),
}))
vi.mock('../src/lib/sequenceBuilderApi', () => ({
  createSequence: (...args: unknown[]) => createSequence(...args),
}))

/** Analytics children: present or absent, and in which section — nothing else. */
vi.mock('../src/components/KpiCards', () => ({
  KpiCards: () => <div data-testid="kpi-cards" />,
}))
vi.mock('../src/components/Funnel', () => ({
  Funnel: () => <div data-testid="funnel" />,
}))
vi.mock('../src/components/AccountCard', () => ({
  AccountCard: ({ inst }: { inst: Instance }) => (
    <div data-testid="account-card">{inst.id}</div>
  ),
}))
vi.mock('../src/components/FollowUpCalloutCard', () => ({
  FollowUpCalloutCard: () => null,
}))
vi.mock('../src/components/ImportCalloutCard', () => ({
  ImportCalloutCard: () => null,
}))

const { Overview } = await import('../src/pages/Overview')

const instance = (id: string, name: string): Instance => ({
  id,
  label: name,
  account_name: name,
  last_sync_at: '2026-09-01T11:40:00.000Z',
} as unknown as Instance)

const NOTEBOOK_1 = instance('notebook-1', 'Mykyta S')
const NOTEBOOK_2 = instance('notebook-2', 'Alyona K')

const deployment = (over: Partial<SequenceHubDeployment>): SequenceHubDeployment => ({
  key: 'notebook-1:1',
  lineage: 'publish',
  campaign_id: 'notebook-1:1',
  campaign_name: 'Campaign',
  campaign_status: 'running',
  runtime_status: 'running',
  is_archived: false,
  status_observed_at: '2026-09-01T11:40:00.000Z',
  status_source: 'fixture-runtime-v1',
  status_raw: '{"runtime":"running"}',
  instance_id: 'notebook-1',
  account_name: 'Mykyta S',
  account_avatar: null,
  last_sync_at: '2026-09-01T11:40:00.000Z',
  sequence_revision: 4,
  branch_id: null,
  branch_letter: null,
  publish_status: 'success',
  awaiting_sync: false,
  leads: 0,
  replies: 0,
  p3: 0,
  latest_reply: null,
  ...over,
})

const reply = (over: Partial<SequenceHubReplyPreview>): SequenceHubReplyPreview => ({
  campaign_id: 'notebook-1:1',
  sequence_id: 'seq-alpha',
  sequence_name: 'Founder outreach',
  instance_id: 'notebook-1',
  account_name: 'Mykyta S',
  profile_url: 'https://www.linkedin.com/in/ada',
  lead_name: 'Ada Lovelace',
  company: 'Analytical Engines',
  body: 'Send me a calendar link and I will book it.',
  sent_at: '2026-09-01T10:00:00.000Z',
  sentiment: 'positive',
  intent_level: 'p3',
  needs_attention: true,
  ...over,
})

const item = (over: Partial<SequenceHubItem>): SequenceHubItem => ({
  id: 'managed:seq',
  kind: 'managed',
  source: 'builder',
  sequence_document_id: 'seq',
  name: 'Sequence',
  revision: 4,
  archived: false,
  branch_count: 1,
  updated_at: '2026-08-20T00:00:00.000Z',
  deployments: [],
  deployment_count: 0,
  account_count: 0,
  leads: 0,
  replies: 0,
  p3: 0,
  latest_reply: null,
  ...over,
})

/** The failed publish is also the *oldest* row — sorting by recency hides it. */
const ALPHA = item({
  id: 'managed:seq-alpha',
  sequence_document_id: 'seq-alpha',
  name: 'Founder outreach',
  branch_count: 3,
  updated_at: '2026-07-01T00:00:00.000Z',
  deployments: [
    deployment({ campaign_id: 'notebook-1:1', campaign_name: 'Founders NL', leads: 90, replies: 10, p3: 2 }),
    deployment({
      key: 'notebook-2:2',
      campaign_id: 'notebook-2:2',
      campaign_name: 'Founders DE',
      instance_id: 'notebook-2',
      account_name: 'Alyona K',
      publish_status: 'partial_failure',
      leads: 30,
      replies: 4,
      p3: 1,
    }),
  ],
  deployment_count: 2,
  account_count: 2,
  leads: 120,
  replies: 14,
  p3: 3,
  latest_reply: reply({ sent_at: '2026-07-02T09:00:00.000Z' }),
})

const BETA = item({
  id: 'managed:seq-beta',
  sequence_document_id: 'seq-beta',
  name: 'Ops leaders',
  updated_at: '2026-08-31T00:00:00.000Z',
  deployments: [deployment({ key: 'notebook-1:3', campaign_id: 'notebook-1:3', leads: 80, replies: 9, p3: 2 })],
  deployment_count: 1,
  account_count: 1,
  leads: 80,
  replies: 9,
  p3: 2,
  latest_reply: reply({
    sequence_id: 'seq-beta',
    sequence_name: 'Ops leaders',
    sent_at: '2026-09-01T11:00:00.000Z',
  }),
})

const EXTERNAL = item({
  id: 'external:notebook-2:9',
  kind: 'external',
  source: 'linked_helper',
  sequence_document_id: null,
  name: 'Old LH warm-up',
  revision: null,
  updated_at: '2026-08-30T00:00:00.000Z',
  deployments: [deployment({
    key: 'notebook-2:9',
    lineage: 'external',
    campaign_id: 'notebook-2:9',
    campaign_name: 'Old LH warm-up',
    instance_id: 'notebook-2',
    account_name: 'Alyona K',
    sequence_revision: null,
    publish_status: null,
    leads: 40,
    replies: 4,
  })],
  deployment_count: 1,
  account_count: 1,
  leads: 40,
  replies: 4,
  p3: 0,
  latest_reply: reply({
    campaign_id: 'notebook-2:9',
    sequence_id: null,
    sequence_name: 'Old LH warm-up',
    sent_at: '2026-08-30T09:00:00.000Z',
  }),
})

const DRAFT = item({
  id: 'managed:seq-draft',
  sequence_document_id: 'seq-draft',
  name: 'Draft in progress',
  updated_at: '2026-08-29T00:00:00.000Z',
})

const HUB: SequenceHubSnapshot = {
  items: [ALPHA, BETA, EXTERNAL, DRAFT],
  newestReplies: [
    reply({}),
    reply({
      campaign_id: 'notebook-2:9',
      sequence_id: null,
      sequence_name: 'Old LH warm-up',
      instance_id: 'notebook-2',
      account_name: 'Alyona K',
      profile_url: 'https://www.linkedin.com/in/unsynced',
      lead_name: 'Unsynced Person',
      company: null,
      body: 'Who is this?',
      sent_at: '2026-08-31T09:00:00.000Z',
      sentiment: 'neutral',
      intent_level: null,
    }),
  ],
}

const ADA = {
  id: 'lead-ada',
  instance_id: 'notebook-1',
  campaign_id: 'notebook-1:1',
  profile_url: 'https://www.linkedin.com/in/ada',
  full_name: 'Ada Lovelace',
  company: 'Analytical Engines',
  replied_at: '2026-09-01T10:00:00.000Z',
} as unknown as Lead

const SUMMARY = {
  totals: {
    leads: 240, invites: 200, accepted: 100, replies: 27, positive: 12,
    acceptedOfInvited: 100, repliedOfConnected: 27, added: 15,
  },
  prevTotals: null,
  intent: { p1: 4, p2: 3, p3: 5, p3Booked: 1, matureP3: 4, matureP3Booked: 1, p3Ghosted: 1 },
  intentPrev: null,
  accounts: [],
  campaigns: [],
  activity: [],
  velocity: [],
  velocityUndated: 0,
  funnel: {} as OverviewSummary['funnel'],
} as OverviewSummary

const dashboardData = (): DashboardData => ({
  instances: [NOTEBOOK_1, NOTEBOOK_2],
  campaigns: [],
  activity: [],
  leads: [ADA],
  syncRuns: [],
  messages: [],
  conversationReplyIntents: [],
  annotations: [],
  steps: [],
  teamMembers: [],
  rosterPath: 'neon',
  pipelineEvents: [],
  followUpStates: [],
  latestConversationMessages: [],
  followUpsAvailable: true,
  savedSearches: [],
  icps: [],
  icpPersonas: [],
  icpIndustries: [],
  hypotheses: [],
  hypothesisCampaigns: [],
  campaignSequenceContext: null,
})

const paint = () => render(<MemoryRouter initialEntries={['/']}><Overview /></MemoryRouter>)

/** Waits out both reads — the summary and the hub resolve independently. */
const painted = async () => {
  paint()
  await waitFor(() => expect(document.querySelector('.active-sequence')).not.toBeNull())
}

const sequenceNames = () => Array.from(
  document.querySelectorAll('.active-sequence-name'),
).map((node) => node.textContent)

afterEach(cleanup)
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  openConversation.mockReset()
  createSequence.mockReset()
  resolveReadPath.mockReset().mockResolvedValue('neon')
  fetchNeonOverviewSummary.mockReset().mockResolvedValue(SUMMARY)
  fetchNeonSequenceHub.mockReset().mockResolvedValue(HUB)
  currentData = dashboardData()
})
afterEach(() => vi.useRealTimers())

describe('active sequences', () => {
  it('excludes archived and archive-unknown deployments from operational card totals', async () => {
    fetchNeonSequenceHub.mockResolvedValueOnce({
      items: [item({
        name: 'Mixed fleet',
        deployments: [
          deployment({ key: 'current', leads: 10, replies: 2, p3: 1 }),
          deployment({ key: 'archived', instance_id: 'notebook-2', account_name: 'Alyona K', runtime_status: 'completed', is_archived: true, leads: 50, replies: 20, p3: 5 }),
          deployment({ key: 'archive-unknown', instance_id: 'notebook-2', account_name: 'Alyona K', runtime_status: 'running', is_archived: null, leads: 70, replies: 30, p3: 7 }),
        ],
        deployment_count: 3, account_count: 2, leads: 130, replies: 52, p3: 13,
      })],
      newestReplies: [],
    })
    await painted()

    const card = document.querySelector('.active-sequence') as HTMLElement
    expect(within(card).getByText('10')).toBeTruthy()
    expect(within(card).getByText('2')).toBeTruthy()
    expect(within(card).getByText('1 Running')).toBeTruthy()
    expect(card.textContent).toContain('1 archived excluded')
    expect(card.textContent).toContain('1 archive unknown excluded')
    expect(card.textContent).not.toContain('Alyona K')
  })

  it('puts the broken deployment first even though it is the oldest', async () => {
    await painted()

    expect(sequenceNames()).toEqual(['Founder outreach', 'Ops leaders', 'Old LH warm-up'])

    const first = document.querySelectorAll('.active-sequence')[0] as HTMLElement
    expect(within(first).getByText('Partially published')).toBeTruthy()
    expect(first.querySelector('.attention-alert')).not.toBeNull()
    // The two healthy ones are not dressed up as problems.
    const healthy = document.querySelectorAll('.active-sequence')[1] as HTMLElement
    expect(within(healthy).getByText('1 Running')).toBeTruthy()
  })

  it('names every account a sequence runs on, and its aggregate counts', async () => {
    await painted()

    const first = document.querySelectorAll('.active-sequence')[0] as HTMLElement
    expect(first.textContent).toContain('Mykyta S · Alyona K')
    expect(within(first).getByText('120')).toBeTruthy()
    expect(within(first).getByText('14')).toBeTruthy()
    expect(within(first).getByText('3 branches')).toBeTruthy()
  })

  it('claims no Builder provenance for a campaign made in Linked Helper', async () => {
    await painted()

    const external = document.querySelectorAll('.active-sequence')[2] as HTMLElement
    expect(within(external).getByText('Linked Helper')).toBeTruthy()
    expect(external.textContent).not.toContain('Builder')
    // No Builder document to open — the card goes to the campaign instead.
    expect(within(external).getByText('Old LH warm-up').getAttribute('href'))
      .toBe('/campaign/notebook-2%3A9')

    const managed = document.querySelectorAll('.active-sequence')[0] as HTMLElement
    expect(within(managed).getByText('Builder')).toBeTruthy()
    expect(within(managed).getByText('Founder outreach').getAttribute('href'))
      .toBe('/sequences/seq-alpha')
  })

  it('keeps an undeployed draft out of the running list and offers it as the next edit', async () => {
    await painted()

    expect(sequenceNames()).not.toContain('Draft in progress')
    const resume = screen.getByText('Continue “Draft in progress”')
    expect(resume.getAttribute('href')).toBe('/sequences/seq-draft')
  })

  it('creates a draft and opens it', async () => {
    createSequence.mockResolvedValue({ id: 'seq-new' })
    await painted()

    fireEvent.click(screen.getByRole('button', { name: /New sequence/ }))
    await waitFor(() => expect(createSequence).toHaveBeenCalledTimes(1))
  })
})

describe('new replies', () => {
  it('shows who replied, from which account and under which sequence', async () => {
    await painted()

    const rows = document.querySelectorAll('.new-reply')
    expect(rows).toHaveLength(2)
    const ada = rows[0] as HTMLElement
    expect(within(ada).getByText('Ada Lovelace')).toBeTruthy()
    expect(within(ada).getByText('Analytical Engines')).toBeTruthy()
    expect(ada.textContent).toContain('Send me a calendar link')
    expect(ada.textContent).toContain('Mykyta S · Founder outreach')
    expect(ada.textContent).toContain('P3')
  })

  it('opens the shared conversation drawer without leaving the page', async () => {
    await painted()

    fireEvent.click(screen.getByLabelText('Open conversation with Ada Lovelace'))
    expect(openConversation).toHaveBeenCalledTimes(1)
    expect(openConversation.mock.calls[0][0]).toMatchObject({ full_name: 'Ada Lovelace' })
    expect(document.querySelector('.new-reply-list')).not.toBeNull()
  })

  it('falls back to the campaign when the lead is not in the loaded snapshot', async () => {
    await painted()

    const link = screen.getByLabelText('Open Unsynced Person in Old LH warm-up')
    expect(link.getAttribute('href')).toBe('/campaign/notebook-2%3A9?people=replied')
  })
})

describe('what the first viewport leads with', () => {
  it('reads sequences, then replies, then the summary, then analytics', async () => {
    await painted()

    const order = Array.from(document.querySelectorAll(
      '.active-sequences, .new-replies, .overview-summary-strip, #fleet-health-title, #analytics-title',
    )).map((node) => node.id || node.className.split(' ').pop())

    expect(order).toEqual([
      'active-sequences',
      'new-replies',
      'overview-summary-strip',
      'fleet-health-title',
      'analytics-title',
    ])
  })

  it('demotes the account cards under Fleet health and the charts under Analytics', async () => {
    await painted()

    const fleet = document.getElementById('fleet-health-title')!.closest('section')!
    expect(within(fleet).getAllByTestId('account-card')).toHaveLength(2)
    expect(within(fleet).queryByTestId('kpi-cards')).toBeNull()

    const analytics = document.getElementById('analytics-title')!.closest('section')!
    expect(within(analytics).getByTestId('kpi-cards')).toBeTruthy()
    expect(within(analytics).getByTestId('funnel')).toBeTruthy()
  })

  it('keeps a compact portfolio summary above the analytics it replaces', async () => {
    await painted()

    const strip = document.querySelector('.overview-summary-strip') as HTMLElement
    expect(within(strip).getByText('240')).toBeTruthy()
    expect(within(strip).getByText('200')).toBeTruthy()
    // Accepted 100 of 200 invites, replies 27 of 100 accepted.
    expect(strip.textContent).toContain('50.0%')
    expect(strip.textContent).toContain('27.0%')
    expect(strip.textContent).toContain('P3')
  })

  it('reads one bounded aggregate for the whole operational block', async () => {
    await painted()

    // Reply previews and per-sequence counts come from `sequences.hub` alone —
    // no lead or message collection is fetched to draw the first viewport.
    expect(fetchNeonSequenceHub).toHaveBeenCalledTimes(1)
    expect(fetchNeonSequenceHub).toHaveBeenCalledWith()
  })
})

describe('when the hub cannot be served', () => {
  it('leaves the operational block out on the legacy read path', async () => {
    resolveReadPath.mockResolvedValue('supabase')
    paint()

    await waitFor(() => expect(resolveReadPath).toHaveBeenCalled())
    await waitFor(() => expect(document.querySelector('.active-sequences')).toBeNull())
    expect(fetchNeonSequenceHub).not.toHaveBeenCalled()
  })

  it('says so in place rather than blanking the page', async () => {
    fetchNeonSequenceHub.mockRejectedValue(new Error('hub is down'))
    paint()

    // Both panels read the one snapshot, so both say why they are empty.
    await waitFor(() => expect(screen.getAllByText(/hub is down/)).toHaveLength(2))
    expect(document.querySelector('.active-sequence')).toBeNull()
    // The rest of the page is unaffected.
    expect(document.getElementById('analytics-title')).not.toBeNull()
  })
})
