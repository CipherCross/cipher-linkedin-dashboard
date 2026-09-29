// @vitest-environment jsdom
/**
 * `DataProvider`'s load: the shell bootstrap once per tab, then the active
 * route's snapshot, with quiet same-route refreshes and coalescing.
 *
 * Real: `DataProvider` and `routeSnapshotRequest`. Replaced: the
 * `dashboardReads` fetchers.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HashRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchNeonDashboard = vi.fn()
const fetchNeonBootstrap = vi.fn()
const fetchNeonRouteSnapshot = vi.fn()
const fetchNeonFollowUpState = vi.fn()

// The route key is the real one: it decides when a snapshot restarts, which is
// part of what these tests pin. It is a pure function of the hash.
vi.mock('../src/lib/dashboardReads', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dashboardReads')>('../src/lib/dashboardReads')
  return {
    fetchNeonBootstrap: (...a: unknown[]) => fetchNeonBootstrap(...a),
    fetchNeonDashboard: (...a: unknown[]) => fetchNeonDashboard(...a),
    fetchNeonRouteSnapshot: (...a: unknown[]) => fetchNeonRouteSnapshot(...a),
    fetchNeonFollowUpState: (...a: unknown[]) => fetchNeonFollowUpState(...a),
    routeSnapshotRequest: actual.routeSnapshotRequest,
  }
})

vi.mock('../src/lib/leadPhotos', () => ({ leadPhotoUrls: () => ({}) }))

const { DataProvider, useData } = await import('../src/lib/DataContext')

/** Renders the two fields under test, so an assertion is a DOM read. */
function Probe() {
  const { data, loading, phase, refetch } = useData()
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="phase">{phase}</span>
      <span data-testid="roster">{data ? String(data.teamMembers.length) : 'none'}</span>
      <span data-testid="last-sync">{data?.instances[0]?.last_sync_at ?? ''}</span>
      <span data-testid="error">{data?.error ?? ''}</span>
      <button onClick={() => void refetch()}>Refresh</button>
    </div>
  )
}

const paint = () =>
  render(
    <HashRouter>
      <DataProvider>
        <Probe />
      </DataProvider>
    </HashRouter>,
  )

const roster = () => screen.getByTestId('roster').textContent
const errorText = () => screen.getByTestId('error').textContent

/** A complete route snapshot with every slice empty. */
const neonAnswer = () => ({
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
  fetchNeonRouteSnapshot.mockReset()
  fetchNeonRouteSnapshot.mockResolvedValue({})
  fetchNeonFollowUpState.mockReset()
  fetchNeonBootstrap.mockResolvedValue({
    instances: [],
    campaigns: [],
    teamMembers: [{ id: 1, name: 'Ada', active: true, created_at: '', email: null, role: 'admin' }],
  })
})

describe('DataProvider dispatch', () => {
  it('keeps Overview on route-owned metrics without starting the tenant-wide snapshot', async () => {
    window.history.replaceState(null, '', '#/')
    fetchNeonDashboard.mockResolvedValue(neonAnswer())

    paint()

    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('full'))
    expect(screen.getByTestId('loading').textContent).toBe('false')
    expect(fetchNeonDashboard).not.toHaveBeenCalled()

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchNeonDashboard).not.toHaveBeenCalled()
    expect(screen.getByTestId('phase').textContent).toBe('full')
  })

  it('keeps Leads on bootstrap data instead of starting the full tenant snapshot', async () => {
    window.history.replaceState(null, '', '#/leads')
    fetchNeonDashboard.mockResolvedValue(neonAnswer())

    paint()

    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('full'))
    expect(fetchNeonDashboard).not.toHaveBeenCalled()
  })

  it('loads the bootstrap once, then the route snapshot over its roster', async () => {
    fetchNeonRouteSnapshot.mockResolvedValue(neonAnswer())

    paint()

    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('full'))
    expect(fetchNeonBootstrap).toHaveBeenCalledTimes(1)
    expect(fetchNeonRouteSnapshot).toHaveBeenCalledTimes(1)
    expect(roster()).toBe('1')
  })

  it('replaces the one-time bootstrap heartbeat with the Health snapshot heartbeat', async () => {
    fetchNeonBootstrap.mockResolvedValue({
      instances: [{ id: 'notebook-1', last_sync_at: '2026-08-17T08:00:00.000Z' }],
      campaigns: [],
      teamMembers: [],
    })
    fetchNeonRouteSnapshot.mockResolvedValue({
      instances: [{ id: 'notebook-1', last_sync_at: '2026-08-18T08:00:00.000Z' }],
      syncRuns: [],
    })

    paint()

    await waitFor(() => {
      expect(screen.getByTestId('last-sync').textContent)
        .toBe('2026-08-18T08:00:00.000Z')
    })
  })

  it('coalesces repeated refreshes while the active route snapshot is in flight', async () => {

    let finishSnapshot!: (value: ReturnType<typeof neonAnswer>) => void
    fetchNeonRouteSnapshot.mockImplementation(
      () => new Promise((resolve) => { finishSnapshot = resolve }),
    )

    paint()
    await waitFor(() => expect(fetchNeonRouteSnapshot).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchNeonRouteSnapshot).toHaveBeenCalledTimes(1)

    act(() => finishSnapshot(neonAnswer()))
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('full'))
  })
})

describe('DataProvider quiet refresh', () => {
  it('refreshes the route on screen without dropping it back to the skeleton', async () => {
    fetchNeonRouteSnapshot.mockResolvedValue({
      instances: [{ id: 'notebook-1', last_sync_at: '2026-08-18T08:00:00.000Z' }],
      syncRuns: [],
    })

    paint()
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('full'))

    // Hold the refresh open so the in-flight state is observable.
    let finishSnapshot!: (value: unknown) => void
    fetchNeonRouteSnapshot.mockImplementation(
      () => new Promise((resolve) => { finishSnapshot = resolve }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(fetchNeonRouteSnapshot).toHaveBeenCalledTimes(2))

    // Layout unmounts the page (and any open drawer) on either of these.
    expect(screen.getByTestId('loading').textContent).toBe('false')
    expect(screen.getByTestId('phase').textContent).toBe('full')

    await act(async () => {
      finishSnapshot({
        instances: [{ id: 'notebook-1', last_sync_at: '2026-08-19T08:00:00.000Z' }],
        syncRuns: [],
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('last-sync').textContent).toBe('2026-08-19T08:00:00.000Z')
    })
    expect(screen.getByTestId('loading').textContent).toBe('false')
  })
})

describe('DataProvider per-conversation follow-up state', () => {
  const STATE = {
    instance_id: 'notebook-1', profile_url: 'https://example.test/in/ada',
    next_follow_up_date: '2026-09-30', owner_id: 1, revision: 3,
    last_event_id: 9, last_mutation_id: null, created_at: '', updated_at: '', updated_by: 'x', archived_at: null,
  }

  function FollowUpProbe() {
    const { data, phase, refetch, loadFollowUpState } = useData()
    return (
      <div>
        <span data-testid="phase">{phase}</span>
        <span data-testid="available">{String(data?.followUpsAvailable ?? false)}</span>
        <span data-testid="due">{data?.followUpStates.map((s) => s.next_follow_up_date).join(',') ?? ''}</span>
        <button onClick={() => void loadFollowUpState(STATE.instance_id, STATE.profile_url)}>Load</button>
        <button onClick={() => void refetch()}>Refresh</button>
      </div>
    )
  }

  it('gives a page-local route one conversation\'s state, and keeps it through a refresh', async () => {
    // Leads carries no follow-up data of its own, so the drawer's Schedule
    // follow-up used to be hidden there. The loaded state must also survive the
    // five-minute refresh, which recommits the route's (empty) data.
    window.history.replaceState(null, '', '#/leads')
    fetchNeonFollowUpState.mockResolvedValue({ state: STATE, available: true })
    render(<HashRouter><DataProvider><FollowUpProbe /></DataProvider></HashRouter>)
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('full'))
    expect(screen.getByTestId('available').textContent).toBe('false')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load' })) })
    expect(fetchNeonFollowUpState).toHaveBeenCalledWith(STATE.instance_id, STATE.profile_url)
    expect(screen.getByTestId('available').textContent).toBe('true')
    expect(screen.getByTestId('due').textContent).toBe('2026-09-30')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })) })
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('full'))
    expect(screen.getByTestId('available').textContent).toBe('true')
    expect(screen.getByTestId('due').textContent).toBe('2026-09-30')
  })

  it('leaves a route that carries its own follow-up data alone', async () => {
    window.history.replaceState(null, '', '#/pipeline')
    fetchNeonRouteSnapshot.mockResolvedValue({ followUpStates: [], followUpsAvailable: true })
    render(<HashRouter><DataProvider><FollowUpProbe /></DataProvider></HashRouter>)
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('full'))

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load' })) })
    expect(fetchNeonFollowUpState).not.toHaveBeenCalled()
  })
})

describe('DataProvider lead edits', () => {
  function EditProbe() {
    const { phase, patchLead, leadEdits } = useData()
    return (
      <div>
        <span data-testid="phase">{phase}</span>
        <span data-testid="edit">{leadEdits.get('page-local-lead')?.patch.pipeline_stage ?? ''}</span>
        <button onClick={() => patchLead('page-local-lead', { pipeline_stage: 'interested' })}>Move</button>
      </div>
    )
  }

  it('keeps an edit to a lead that data.leads does not hold', async () => {
    // Leads is page-local, so data.leads is empty there; the edit must still be
    // somewhere the drawer and the table can read it back from.
    window.history.replaceState(null, '', '#/leads')
    render(<HashRouter><DataProvider><EditProbe /></DataProvider></HashRouter>)
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('full'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Move' })) })
    expect(screen.getByTestId('edit').textContent).toBe('interested')
  })
})

describe('DataProvider route restarts', () => {
  const navigate = async (hash: string) => {
    await act(async () => {
      window.location.hash = hash
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it('does not restart the snapshot for a selection-only query parameter', async () => {
    window.history.replaceState(null, '', '#/hypotheses')
    fetchNeonRouteSnapshot.mockResolvedValue(neonAnswer())

    paint()
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('full'))
    expect(fetchNeonRouteSnapshot).toHaveBeenCalledTimes(1)

    await navigate('#/hypotheses?h=7')
    await navigate('#/hypotheses')
    expect(fetchNeonRouteSnapshot).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('phase').textContent).toBe('full')
    expect(screen.getByTestId('loading').textContent).toBe('false')
  })

  it('restarts only when a parameter the snapshot reads changes', async () => {
    window.history.replaceState(null, '', '#/campaign/notebook-1%3A42')
    fetchNeonRouteSnapshot.mockResolvedValue(neonAnswer())

    paint()
    await waitFor(() => expect(fetchNeonRouteSnapshot).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('full'))

    await navigate('#/campaign/notebook-1%3A42?tab=performance&range=28d')
    expect(fetchNeonRouteSnapshot).toHaveBeenCalledTimes(1)

    // Held open: a different snapshot is not on screen yet, so while it loads
    // the route does drop to the skeleton — unlike a same-route refresh.
    fetchNeonRouteSnapshot.mockImplementation(() => new Promise(() => {}))
    await navigate('#/campaign/notebook-1%3A42?tab=performance&cmp=notebook-2%3A7')
    await waitFor(() => expect(fetchNeonRouteSnapshot).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('phase').textContent).toBe('bootstrap')
    expect(screen.getByTestId('loading').textContent).toBe('true')
    expect(fetchNeonRouteSnapshot.mock.calls[1][0]).toMatchObject({ route: 'campaign', compareIds: 'notebook-2:7' })
  })
})

describe('DataProvider failure handling', () => {
  it('reports a thrown Neon read rather than committing an empty dashboard', async () => {
    // A failed read throws and fails the load, instead of silently emptying one
    // panel. The visible consequence is an error, and `loading` clears.
    fetchNeonRouteSnapshot.mockRejectedValue(new Error('dashboard.routeSnapshot: boom'))

    paint()

    await waitFor(() => expect(errorText()).toMatch(/dashboard\.routeSnapshot: boom/))
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
  })
})
