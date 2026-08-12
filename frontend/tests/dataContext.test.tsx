// @vitest-environment jsdom
/**
 * `DataProvider`'s dispatch, and the `rosterPath` marker it commits.
 *
 * ## Why this file is the one the chain kept deferring
 *
 * `N-ROSTER.md` Known limit 2 named `DataContext` untested and explained what
 * that costs: its mutation **8** set `rosterPath: 'supabase'` in the Neon fetcher
 * and **reddened nothing**, and that literal is what decides whether a Neon
 * `team_members.id` may be written back to Supabase — a silent flip re-opens the
 * misattribution the roster slice exists to close. The fix at the time was to
 * move the value into `fetchNeonDashboard` (typed `'neon'`, one test) and have
 * `DataContext` spread it. The Supabase fetcher's literal stayed, because it is
 * the *permissive* value and therefore the one every default already reaches.
 *
 * Both are covered here, and the marker's provenance is covered as a property
 * rather than as a value: the third test makes the fetcher answer `'supabase'` and
 * asserts the provider **follows it**. A literal reintroduced anywhere in
 * `DataContext.tsx` fails that test regardless of which value it names.
 *
 * ## What is real
 *
 * `DataProvider` and `fetchSupabaseDashboard` — its column ladders, its
 * thirteen-table `Promise.all`, its tolerated-error set and its aggregate — all
 * run. Replaced: `dashboardReads` (the flag and the Neon fetcher) and the Supabase
 * client, which is a chainable stub every query resolves against.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RosterPath } from '../src/lib/types'

const fetchNeonDashboard = vi.fn()
const fetchNeonBootstrap = vi.fn()
const resolveReadPath = vi.fn()

vi.mock('../src/lib/dashboardReads', () => ({
  fetchNeonBootstrap: (...a: unknown[]) => fetchNeonBootstrap(...a),
  fetchNeonDashboard: (...a: unknown[]) => fetchNeonDashboard(...a),
  resolveReadPath: () => resolveReadPath(),
}))

/**
 * Every PostgREST query the Supabase fetcher builds, answered `{ data: [], error:
 * null }`.
 *
 * A chainable stub rather than a per-table script, because what is under test is
 * the *dispatch* and the marker, not the twenty-odd selects — and because a
 * hand-written script of thirteen chained builders would be a second copy of the
 * fetcher, wrong the first time the real one gains an `.order()`. The empty page
 * also terminates every `.range()` walk on its first iteration.
 */
const fromCalls: string[] = []
const query = (): unknown => {
  const answer = { data: [] as unknown[], error: null }
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(answer).then(res, rej)
        }
        if (prop === 'catch') return (f: (e: unknown) => unknown) => Promise.resolve(answer).catch(f)
        if (prop === 'finally') return (f: () => void) => Promise.resolve(answer).finally(f)
        return () => proxy
      },
    },
  )
  return proxy
}

/** Swapped per test so the "Supabase is not configured" branch is reachable. */
let client: unknown = { from: (t: string) => (fromCalls.push(t), query()) }

vi.mock('../src/lib/supabase', () => ({
  get supabase() {
    return client
  },
}))

vi.mock('../src/lib/leadPhotos', () => ({ leadPhotoUrls: () => ({}) }))

const { DataProvider, useData } = await import('../src/lib/DataContext')

/** Renders the two fields under test, so an assertion is a DOM read. */
function Probe() {
  const { data, loading, phase } = useData()
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="phase">{phase}</span>
      <span data-testid="roster">{data ? data.rosterPath : 'none'}</span>
      <span data-testid="error">{data?.error ?? ''}</span>
    </div>
  )
}

const paint = () =>
  render(
    <DataProvider>
      <Probe />
    </DataProvider>,
  )

const roster = () => screen.getByTestId('roster').textContent
const errorText = () => screen.getByTestId('error').textContent

/** What `fetchNeonDashboard` resolves to, with the marker left to the caller. */
const neonAnswer = (rosterPath: RosterPath) => ({
  rosterPath,
  instances: [],
  campaigns: [],
  activity: [],
  syncRuns: [],
  annotations: [],
  steps: [],
  teamMembers: [],
  savedSearches: [],
  icps: [],
  icpPersonas: [],
  icpIndustries: [],
  hypotheses: [],
  hypothesisCampaigns: [],
  leads: [],
  messages: [],
  pipelineEvents: [],
  followUpStates: [],
  latestConversationMessages: [],
  followUpsAvailable: true,
  conversationReplyIntents: [],
})

afterEach(cleanup)

beforeEach(() => {
  window.history.replaceState(null, '', '#/health')
  fetchNeonDashboard.mockReset()
  fetchNeonBootstrap.mockReset()
  fetchNeonBootstrap.mockResolvedValue({
    rosterPath: 'neon',
    instances: [],
    campaigns: [],
    teamMembers: [],
  })
  resolveReadPath.mockReset()
  fromCalls.length = 0
  client = { from: (t: string) => (fromCalls.push(t), query()) }
})

describe('DataProvider dispatch', () => {
  it('paints the Neon bootstrap before starting the tenant-wide snapshot on Overview', async () => {
    window.history.replaceState(null, '', '#/')
    resolveReadPath.mockResolvedValue('neon')
    fetchNeonDashboard.mockResolvedValue(neonAnswer('neon'))

    paint()

    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('bootstrap'))
    expect(screen.getByTestId('loading').textContent).toBe('false')
    expect(fetchNeonDashboard).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('dashboard:overview-ready'))
    await waitFor(() => expect(fetchNeonDashboard).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('full'))
  })

  it('keeps Leads on bootstrap data instead of starting the full tenant snapshot', async () => {
    window.history.replaceState(null, '', '#/leads')
    resolveReadPath.mockResolvedValue('neon')
    fetchNeonDashboard.mockResolvedValue(neonAnswer('neon'))

    paint()

    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('bootstrap'))
    expect(fetchNeonDashboard).not.toHaveBeenCalled()
  })

  it('takes the Neon fetcher on the Neon flag and opens no Supabase connection', async () => {
    resolveReadPath.mockResolvedValue('neon')
    fetchNeonDashboard.mockResolvedValue(neonAnswer('neon'))

    paint()

    await waitFor(() => expect(roster()).toBe('neon'))
    expect(fetchNeonDashboard).toHaveBeenCalledTimes(1)
    // The point of the whole read slice: no PostgREST query at all.
    expect(fromCalls).toEqual([])
  })

  it('takes the Supabase fetcher on the default flag and commits its own marker', async () => {
    resolveReadPath.mockResolvedValue('supabase')

    paint()

    await waitFor(() => expect(roster()).toBe('supabase'))
    expect(fetchNeonDashboard).not.toHaveBeenCalled()
    // N-ROSTER Known limit 2's remaining literal, now reached. It is the
    // permissive value, so the failure it guards against is over-restriction of a
    // working dashboard rather than a wrong write — but "visible rather than
    // silent" is not the same as "covered".
    expect(fromCalls).toContain('team_members')
    expect(fromCalls).toContain('instances')
  })

  it('commits the marker the fetcher returned, never one of its own', async () => {
    // The mutation-8 test. `fetchNeonDashboard` is typed `'neon'` in the real
    // module, so this combination cannot occur in production — which is exactly
    // what makes it a probe: the only way the provider can answer 'supabase' here
    // is by *reading* the fetcher's field. Any literal in `DataContext.tsx`,
    // whichever value it names, fails this.
    resolveReadPath.mockResolvedValue('neon')
    fetchNeonDashboard.mockResolvedValue(neonAnswer('supabase'))

    paint()

    await waitFor(() => expect(fetchNeonDashboard).toHaveBeenCalled())
    await waitFor(() => expect(roster()).toBe('supabase'))
  })

  it('asks for the read path exactly once per load, not once per relation', async () => {
    // S12 measured actor resolution at 196 ms of a 525 ms request; the flag
    // lookup is memoized in `dashboardReads` for the same reason. Asserted here
    // because `load()` is where a stray second call would appear.
    resolveReadPath.mockResolvedValue('neon')
    fetchNeonDashboard.mockResolvedValue(neonAnswer('neon'))

    paint()

    await waitFor(() => expect(roster()).toBe('neon'))
    expect(resolveReadPath).toHaveBeenCalledTimes(1)
  })
})

describe('DataProvider failure handling', () => {
  it('reports an unconfigured Supabase instead of hanging on the skeleton', async () => {
    resolveReadPath.mockResolvedValue('supabase')
    client = null

    paint()

    await waitFor(() => expect(errorText()).toMatch(/Supabase is not configured/))
    // `loading` must clear, or the dashboard shows a skeleton forever with the
    // reason invisible.
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
    expect(fetchNeonDashboard).not.toHaveBeenCalled()
  })

  it('reports a thrown Neon read rather than committing an empty dashboard', async () => {
    // Design call 5 of S13: on the Neon path a failed read throws and fails the
    // load, instead of silently emptying one panel. The visible consequence is an
    // error, and the invariant is that `rosterPath` is not quietly set to
    // something while no roster was read.
    resolveReadPath.mockResolvedValue('neon')
    fetchNeonDashboard.mockRejectedValue(new Error('leads.directory: boom'))

    paint()

    await waitFor(() => expect(errorText()).toMatch(/leads\.directory: boom/))
  })
})
