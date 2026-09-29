// @vitest-environment jsdom
/**
 * The Leads Explorer's coaching digest panel, and its error slot.
 *
 * A failed digest read must not render as "no digests computed yet": the page
 * sets `digestErr`, which the expanded panel renders. This file makes a change
 * that swallowed the error a red test.
 *
 * ## What is real
 *
 * The page component, its panel markup, its collapse state and the effect that
 * fetches. Replaced: the four contexts, `dashboardReads` and `authFetch`.
 * `MemoryRouter` is real rather than mocked, because the page reads its filters
 * from `useSearchParams` and a fake would have to reimplement it.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CoachingDigest, DashboardData, Instance } from '../src/lib/types'

const fetchNeonCoachingDigests = vi.fn()

vi.mock('../src/lib/dashboardReads', () => ({
  fetchNeonCoachingDigests: (...a: unknown[]) => fetchNeonCoachingDigests(...a),
  fetchNeonLeadsSearchPage: async () => ({
    items: [], total: 0, allTotal: 0, replyCounts: { total: 0, c: {} },
  }),
}))

vi.mock('../src/lib/api', () => ({ authFetch: vi.fn(), authPost: vi.fn() }))
vi.mock('../src/lib/AuthContext', () => ({ useAuth: () => ({ isAdmin: true }) }))
vi.mock('../src/lib/ToastContext', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))
vi.mock('../src/lib/ConversationContext', () => ({
  useConversation: () => ({ openConversation: vi.fn() }),
}))
vi.mock('../src/lib/usePipelineActions', () => ({
  usePipelineActions: () => ({
    setStage: vi.fn(),
    members: [],
    memberName: () => '',
  }),
}))

const instance = (id: string): Instance =>
  ({ id, label: `Label ${id}`, account_name: null }) as unknown as Instance

/** Two notebooks, so "has a digest" and "has none" render side by side. */
const INSTANCES = [instance('notebook-1'), instance('notebook-2')]

const EMPTY_DATA: DashboardData = {
  instances: INSTANCES,
  campaigns: [],
  activity: [],
  leads: [],
  syncRuns: [],
  messages: [],
  conversationReplyIntents: [],
  annotations: [],
  steps: [],
  teamMembers: [],
  pipelineEvents: [],
  followUpStates: [],
  latestConversationMessages: [],
  followUpsAvailable: false,
  savedSearches: [],
  icps: [],
  icpPersonas: [],
  icpIndustries: [],
  hypotheses: [],
      hypothesisCampaigns: [],
      campaignSequenceContext: null,
}

vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({ data: EMPTY_DATA, refetch: vi.fn() }),
}))

const { LeadsExplorer } = await import('../src/pages/LeadsExplorer')

const DIGEST: CoachingDigest = {
  instance_id: 'notebook-1',
  summary: 'Answer the question before pitching.',
  patterns: [{ count: 7, issue: 'Pitching first', advice: 'Answer, then ask.' }],
  computed_at: '2026-08-05T09:00:00.000Z',
  model: 'test',
} as unknown as CoachingDigest

const paint = () =>
  render(
    <MemoryRouter>
      <LeadsExplorer />
    </MemoryRouter>,
  )

/** The panel is collapsed by default, so every assertion about it needs this. */
const expand = async () => {
  const toggle = document.querySelector('[data-digest="toggle"]') as HTMLButtonElement
  expect(toggle).not.toBeNull()
  await act(async () => {
    toggle.click()
  })
}

const panelBanner = () => document.querySelector('[data-digest="body"] [data-digest="error"]')

afterEach(cleanup)

beforeEach(() => {
  fetchNeonCoachingDigests.mockReset()
})

describe('the coaching digest panel', () => {
  it('is collapsed at first paint but fetches anyway', async () => {
    fetchNeonCoachingDigests.mockResolvedValue([DIGEST])
    paint()

    // Rendered lazily, fetched eagerly. Recorded because the browser run measured
    // the same thing (expanding costs zero requests) and it is easy to assume the
    // opposite from the word "collapsible".
    expect(document.querySelector('[data-digest="body"]')).toBeNull()
    await waitFor(() => expect(fetchNeonCoachingDigests).toHaveBeenCalledTimes(1))
  })

  it('renders one block per notebook, with patterns as rows', async () => {
    fetchNeonCoachingDigests.mockResolvedValue([DIGEST])
    paint()
    await waitFor(() => expect(fetchNeonCoachingDigests).toHaveBeenCalled())
    await expand()

    // One block per *instance*, not per digest — the panel indexes
    // `digests[instance.id]`, which is why the read is walked rather than capped.
    expect(document.querySelectorAll('[data-digest="instance"]')).toHaveLength(2)
    expect(screen.getByText(/Answer the question before pitching/)).toBeDefined()
    // `patterns` is `jsonb`; a JSON *string* would make `.map` throw rather than
    // render, so the row count is what proves it crossed as an array.
    expect(document.querySelectorAll('[data-digest="patterns"] li')).toHaveLength(1)
    // The notebook with no digest says so, rather than looking broken.
    expect(screen.getByText(/Not generated yet/)).toBeDefined()
    expect(panelBanner()).toBeNull()
  })

  it('fills the panel’s error slot when the read fails — mutation 12', async () => {
    fetchNeonCoachingDigests.mockRejectedValue(
      new Error('coaching.digests: Could not load dashboard data'),
    )
    paint()
    await waitFor(() => expect(fetchNeonCoachingDigests).toHaveBeenCalled())
    await expand()

    const banner = panelBanner()
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toMatch(/Couldn't load the coaching digest/)
    // And the message carries the operation name, so the failure is diagnosable
    // from a screenshot.
    expect(banner?.textContent).toMatch(/coaching\.digests/)
  })
})
