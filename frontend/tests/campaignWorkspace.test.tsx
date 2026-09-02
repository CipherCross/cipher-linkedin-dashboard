// @vitest-environment jsdom
/**
 * The campaign page as a deployment drilldown: it lands on leads and replies,
 * names where the campaign came from, and shows the chain that was actually
 * published rather than the sequence's current draft.
 *
 * Three things here are worth a red test rather than a glance:
 *
 * 1. **The landing tab.** The page used to open on KPI cards; the whole point of
 *    the redesign is that the first thing on screen is the reply list. A refactor
 *    that restores the analytics default would otherwise pass silently.
 * 2. **Provenance.** A campaign made by hand in Linked Helper must never render
 *    Builder provenance it does not have. This is the failure the spec calls out
 *    by name, and it is invisible in a build.
 * 3. **The deployed chain.** `compiled_action_chain` is the immutable publish
 *    snapshot. Rendering it from the live sequence document instead would look
 *    identical until someone edits the base — so the test feeds a chain that
 *    disagrees with any plausible draft.
 *
 * ## What is real
 *
 * `CampaignDetail`, the shared `LeadsAndRepliesWorkspace`, `LeadReplyIdentity`,
 * `DeployedSequence`, `MessageSequence` and the router (the page reads its tab
 * and filters out of `useSearchParams`, so a fake would have to reimplement it).
 * Replaced: `DataContext`, `ConversationContext`, `ToastContext` and `authPost`.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CampaignMetrics, CampaignSequenceContext, ConversationReplyIntent, DashboardData,
  Instance, Lead, Message,
} from '../src/lib/types'

const openConversation = vi.fn()

/** Mutable so each test can paint a different deployment shape. */
let currentData: DashboardData

vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({ data: currentData, refetch: vi.fn(), patchCampaign: vi.fn() }),
}))
vi.mock('../src/lib/ConversationContext', () => ({
  useConversation: () => ({ openConversation }),
}))
vi.mock('../src/lib/ToastContext', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))
vi.mock('../src/lib/api', () => ({ authFetch: vi.fn(), authPost: vi.fn() }))

const { CampaignDetail } = await import('../src/pages/CampaignDetail')

const CAMPAIGN_ID = 'notebook-1:42'

const INSTANCE = {
  id: 'notebook-1',
  label: 'Mykyta',
  account_name: 'Mykyta S',
} as unknown as Instance

const CAMPAIGN = {
  campaign_id: CAMPAIGN_ID,
  instance_id: 'notebook-1',
  campaign_name: 'Founders Q3',
  status: 'running',
  runtime_status: 'sleeping',
  is_archived: false,
  status_observed_at: '2026-09-01T12:00:00.000Z',
  status_source: 'fixture-build-v1',
  status_raw: '{"runtime":"S"}',
  invites_sent: 3,
  accepted: 2,
  replies: 2,
  acceptance_rate: 0.66,
  reply_rate: 0.66,
  briefing_context: null,
  briefing_context_updated_at: null,
} as unknown as CampaignMetrics

/** Three leads that separate every filter: one P3 replier, one plain replier,
 *  one never-replied. */
const lead = (over: Partial<Lead>): Lead => ({
  id: over.profile_url ?? 'x',
  instance_id: 'notebook-1',
  campaign_id: CAMPAIGN_ID,
  profile_url: 'https://www.linkedin.com/in/x',
  full_name: null,
  headline: null,
  company: null,
  added_at: null,
  invited_at: '2026-08-01T00:00:00.000Z',
  connected_at: null,
  first_message_at: null,
  replied_at: null,
  last_action_at: '2026-08-01T00:00:00.000Z',
  pipeline_stage: null,
  pipeline_substatus: null,
  lost_reason: null,
  pipeline_stage_changed_at: null,
  assigned_to: null,
  ...over,
} as Lead)

const ADA = lead({
  id: 'lead-ada',
  profile_url: 'https://www.linkedin.com/in/ada',
  full_name: 'Ada Lovelace',
  company: 'Analytical Engines',
  connected_at: '2026-08-03T00:00:00.000Z',
  replied_at: '2026-08-05T09:00:00.000Z',
  last_action_at: '2026-08-05T09:00:00.000Z',
})
const GRACE = lead({
  id: 'lead-grace',
  profile_url: 'https://www.linkedin.com/in/grace',
  full_name: 'Grace Hopper',
  company: 'Naval Systems',
  connected_at: '2026-08-02T00:00:00.000Z',
  replied_at: '2026-08-04T09:00:00.000Z',
  last_action_at: '2026-08-04T09:00:00.000Z',
})
const ALAN = lead({
  id: 'lead-alan',
  profile_url: 'https://www.linkedin.com/in/alan',
  full_name: 'Alan Turing',
  company: 'Bletchley',
})

const message = (over: Partial<Message>): Message => ({
  id: 0,
  instance_id: 'notebook-1',
  campaign_id: CAMPAIGN_ID,
  profile_url: 'https://www.linkedin.com/in/x',
  direction: 'in',
  body: null,
  sent_at: '2026-08-05T09:00:00.000Z',
  sentiment: null,
  reason: null,
  classified_at: null,
  intent_level: null,
  intent_reason: null,
  ...over,
} as unknown as Message)

const MESSAGES: Message[] = [
  message({
    id: 1,
    profile_url: ADA.profile_url,
    body: 'Send me a calendar link and I will book it.',
    sent_at: '2026-08-05T09:00:00.000Z',
    sentiment: 'positive',
    intent_level: 'p3',
  }),
  message({
    id: 2,
    profile_url: GRACE.profile_url,
    body: 'Not right now, thanks.',
    sent_at: '2026-08-04T09:00:00.000Z',
    sentiment: 'negative',
  }),
]

/** The durable P3 milestone lives here, not on the message rows — the workspace
 *  must prefer it so a reclassified thread keeps its highest intent. */
const INTENTS: ConversationReplyIntent[] = [{
  instance_id: 'notebook-1',
  profile_url: ADA.profile_url,
  highest_intent: 'p3',
} as unknown as ConversationReplyIntent]

const BUILDER_CONTEXT: CampaignSequenceContext = {
  source: 'builder',
  sequence_document_id: 'seq-1',
  sequence_name: 'Founder outreach',
  sequence_revision: 7,
  branch_id: 'branch-a',
  branch_letter: 'B',
  publish_status: 'success',
  lineage: 'publish',
  deployed_document: null,
  // Deliberately unlike any draft: the published copy says "revision seven copy",
  // so a component that re-renders the live document instead of this snapshot
  // cannot accidentally pass.
  compiled_action_chain: [
    { type: 'VisitAndExtract', settings: {} },
    { type: 'Waiter', settings: { delay: 2 } },
    {
      type: 'InvitePerson',
      settings: {
        messageTemplate: {
          type: 'variants',
          variants: [{
            type: 'variant',
            child: {
              type: 'group',
              children: [
                { type: 'text', value: 'Hi ' },
                { type: 'var', name: 'firstName' },
                { type: 'text', value: ', revision seven copy.' },
              ],
            },
          }],
        },
      },
    },
    { type: 'FilterContactsOutOfMyNetwork', settings: {} },
    {
      type: 'MessageToPerson',
      settings: {
        messageTemplate: {
          type: 'variants',
          variants: [{
            type: 'variant',
            child: { type: 'group', children: [{ type: 'text', value: 'Following up once.' }] },
          }],
        },
      },
    },
    { type: 'CheckForReplies', settings: { moveToSuccessfulAfterMs: 3_600_000 * 48 } },
  ],
}

const dashboardData = (context: CampaignSequenceContext | null): DashboardData => ({
  instances: [INSTANCE],
  campaigns: [CAMPAIGN],
  activity: [],
  leads: [ADA, GRACE, ALAN],
  syncRuns: [],
  messages: MESSAGES,
  conversationReplyIntents: INTENTS,
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
  campaignSequenceContext: context,
})

const paint = (search = '') =>
  render(
    <MemoryRouter initialEntries={[`/campaign/${encodeURIComponent(CAMPAIGN_ID)}${search}`]}>
      <Routes>
        <Route path="/campaign/:id" element={<CampaignDetail />} />
      </Routes>
    </MemoryRouter>,
  )

const rowNames = () => Array.from(
  document.querySelectorAll('.leads-replies-table tbody tr'),
).map((row) => row.getAttribute('aria-label'))

const chip = (label: string) => screen
  .getAllByRole('tab')
  .find((node) => node.textContent?.startsWith(label)) as HTMLButtonElement

afterEach(cleanup)
beforeEach(() => {
  openConversation.mockReset()
  currentData = dashboardData(BUILDER_CONTEXT)
})

describe('the campaign page as a reply workspace', () => {
  it('opens on leads and replies, not on the analytics it used to lead with', () => {
    paint()

    expect(document.querySelector('.leads-replies-table')).not.toBeNull()
    // The KPI cards are the old landing content; they belong behind Performance.
    expect(document.querySelector('.kpi')).toBeNull()
    expect(rowNames()).toEqual([
      'Open conversation with Ada Lovelace',
      'Open conversation with Grace Hopper',
      'Open conversation with Alan Turing',
    ])
  })

  it('shows the latest reply, its sentiment and the durable intent beside the lead', () => {
    paint()

    const row = screen.getByLabelText('Open conversation with Ada Lovelace')
    expect(within(row).getByText(/Send me a calendar link/)).toBeTruthy()
    expect(within(row).getByText('Analytical Engines')).toBeTruthy()
    // P3 comes from conversation_reply_intent, the durable milestone.
    expect(row.textContent).toContain('P3')
    // Attribution: which account sent it, and from which campaign.
    expect(within(row).getByText('Mykyta S')).toBeTruthy()
    expect(within(row).getByText('Founders Q3')).toBeTruthy()
  })

  it('narrows to a segment and puts the segment in the URL so it can be shared', () => {
    paint()

    fireEvent.click(chip('P3'))
    expect(rowNames()).toEqual(['Open conversation with Ada Lovelace'])

    fireEvent.click(chip('No reply'))
    expect(rowNames()).toEqual(['Open conversation with Alan Turing'])
  })

  it('reopens a shared segment link on the segment it names', () => {
    paint('?people=replied')

    expect(rowNames()).toEqual([
      'Open conversation with Ada Lovelace',
      'Open conversation with Grace Hopper',
    ])
  })

  it('counts each segment on its own chip', () => {
    paint()

    expect(chip('All').textContent).toContain('3')
    expect(chip('Replied').textContent).toContain('2')
    expect(chip('P3').textContent).toContain('1')
    expect(chip('No reply').textContent).toContain('1')
  })

  it('opens the full conversation without leaving the campaign', () => {
    paint()

    fireEvent.click(screen.getByLabelText('Open conversation with Grace Hopper'))
    expect(openConversation).toHaveBeenCalledTimes(1)
    expect(openConversation.mock.calls[0][0]).toMatchObject({ full_name: 'Grace Hopper' })
    // A drawer, not a navigation: the leads table is still on screen.
    expect(document.querySelector('.leads-replies-table')).not.toBeNull()
  })

  it('filters by name, company or headline', () => {
    paint('?q=naval')

    expect(rowNames()).toEqual(['Open conversation with Grace Hopper'])
  })
})

describe('where a campaign came from', () => {
  it('shows Linked Helper runtime separately from Builder publishing state', () => {
    paint()

    expect(screen.getByLabelText(/Linked Helper runtime Sleeping, Not archived/)).toBeTruthy()
    const source = document.querySelector('.campaign-source') as HTMLElement
    expect(source.textContent).toContain('Published')
    expect(source.textContent).not.toContain('Sleeping')
  })

  it('names the sequence, revision, branch and publish state of a Builder deployment', () => {
    paint()

    const source = document.querySelector('.campaign-source') as HTMLElement
    expect(source.textContent).toContain('Sequence Builder')
    expect(within(source).getByText('Founder outreach')).toBeTruthy()
    expect(source.textContent).toContain('revision 7')
    expect(source.textContent).toContain('branch B')
    expect(source.textContent).toContain('Published')
    expect(source.querySelector('a')?.getAttribute('href')).toContain('/sequences/seq-1')
  })

  it('claims no Builder provenance for a campaign made in Linked Helper', () => {
    currentData = dashboardData(null)
    paint()

    const source = document.querySelector('.campaign-source') as HTMLElement
    expect(source.textContent).toContain('Created in Linked Helper')
    expect(source.textContent).not.toContain('Sequence Builder')
    expect(source.querySelector('a')).toBeNull()
  })
})

describe('the Sequence tab', () => {
  const openSequenceTab = () => {
    fireEvent.click(screen.getByRole('tab', { name: 'Sequence' }))
  }

  it('renders the chain that was published, tokens and waits included', () => {
    paint()
    openSequenceTab()

    const steps = Array.from(document.querySelectorAll('.deployed-step-label'))
      .map((node) => node.textContent)
    expect(steps).toEqual([
      'Visit profile and extract data',
      'Wait',
      'Connection request',
      'Wait for the invite to be accepted',
      'Message 1',
      'Check for replies',
    ])

    const invite = document.querySelectorAll('.deployed-step-body')[0]
    expect(invite.textContent).toBe('Hi {firstName}, revision seven copy.')
    expect(invite.querySelector('.deployed-step-var')?.textContent).toBe('{firstName}')

    expect(document.body.textContent).toContain('2 hours')
    expect(document.body.textContent).toContain('then wait 48 hours')
  })

  it('states the limits of an externally created campaign instead of a chain', () => {
    currentData = dashboardData(null)
    paint()
    openSequenceTab()

    expect(screen.getByRole('heading', { name: 'Created in Linked Helper' })).toBeTruthy()
    expect(document.querySelector('.deployed-sequence')).toBeNull()
    expect(document.body.textContent).toContain('no Builder')
  })

  it('says so when a hand-linked campaign has no publish snapshot to show', () => {
    currentData = dashboardData({
      ...BUILDER_CONTEXT,
      lineage: 'explicit_link',
      publish_status: null,
      branch_letter: null,
      compiled_action_chain: null,
    })
    paint()
    openSequenceTab()

    expect(document.body.textContent).toContain('linked to a sequence by hand')
    expect(document.querySelector('.deployed-step')).toBeNull()
  })
})
