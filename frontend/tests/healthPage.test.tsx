// @vitest-environment jsdom
/**
 * Health after the Phase 3 conversion to the canonical `src/ui` contracts.
 *
 * Pins what the redesign must not have changed: which controls only an admin
 * sees, that the recent-runs and accounts sections say so when empty, and that
 * a failed publishing-compatibility read renders as a failure rather than a
 * silently empty table. The Monday-briefing action moved from a hover flyout
 * to a dialog (presentation only) — its admin gate, endpoint call and status
 * states are pinned as they were.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Instance, SyncRun } from '../src/lib/types'

const data = vi.hoisted(() => ({ value: null as unknown }))
const auth = vi.hoisted(() => ({ isAdmin: true }))
const authPost = vi.hoisted(() => vi.fn())
const listSequencePublishTargets = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('../src/lib/DataContext', () => ({ useData: () => ({ data: data.value, refetch: vi.fn() }) }))
vi.mock('../src/lib/AuthContext', () => ({ useAuth: () => ({ isAdmin: auth.isAdmin }) }))
vi.mock('../src/lib/api', () => ({ authPost, authFetch: vi.fn() }))
vi.mock('../src/lib/sequenceBuilderApi', () => ({ listSequencePublishTargets }))
vi.mock('../src/lib/ToastContext', () => ({ useToast: () => toast }))

import { Health } from '../src/pages/Health'

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'notebook-1',
    label: 'Notebook One',
    last_sync_at: '2026-09-23T09:00:00.000Z',
    agent_version: '1.30.0',
    account_name: 'Ada Admin LI',
    account_url: null,
    account_avatar: null,
    config: null,
    config_updated_at: null,
    ...overrides,
  }
}

function run(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 'run-1',
    instance_id: 'notebook-1',
    started_at: '2026-09-23T09:00:00.000Z',
    finished_at: '2026-09-23T09:00:05.000Z',
    status: 'ok',
    rows_upserted: 42,
    error: null,
    ...overrides,
  }
}

async function renderHealth() {
  render(<MemoryRouter><Health /></MemoryRouter>)
  await act(async () => {})
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  auth.isAdmin = true
  listSequencePublishTargets.mockResolvedValue([])
})

describe('Health, populated', () => {
  beforeEach(() => {
    data.value = {
      instances: [instance()],
      syncRuns: [
        run(),
        run({ id: 'run-2', status: 'error', rows_upserted: null, error: 'Boom: parse failed at row 12' }),
      ],
    }
  })

  it('gives an admin the Monday-briefing action and the compatibility panel', async () => {
    await renderHealth()
    expect(screen.getByRole('button', { name: 'Monday briefing' })).toBeTruthy()
    expect(screen.getByText('Publishing compatibility')).toBeTruthy()
    expect(listSequencePublishTargets).toHaveBeenCalledTimes(1)
  })

  it('lists sync runs with a status per row, and the accounts panel with an enabled Configure', async () => {
    await renderHealth()
    const runsTable = screen.getByRole('table', { name: 'Recent sync runs' })
    expect(within(runsTable).getByText('ok')).toBeTruthy()
    expect(within(runsTable).getByText('error')).toBeTruthy()
    expect(within(runsTable).getByText('Boom: parse failed at row 12')).toBeTruthy()

    const accounts = screen.getByText('Accounts').closest('section') as HTMLElement
    expect(within(accounts).getByText('Ada Admin LI')).toBeTruthy()
    const configure = within(accounts).getByRole('button', { name: 'Configure' })
    expect((configure as HTMLButtonElement).disabled).toBe(false)
  })

  it('expands and collapses a truncated sync error on click', async () => {
    await renderHealth()
    const toggle = screen.getByRole('button', { name: 'Boom: parse failed at row 12' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('runs the Monday briefing from its dialog and reports the result', async () => {
    authPost.mockResolvedValue({ ok: true, json: async () => ({ status: 'done' }) })
    await renderHealth()
    fireEvent.click(screen.getByRole('button', { name: 'Monday briefing' }))
    const dialog = screen.getByRole('dialog', { name: 'Monday briefing' })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Regenerate and post' }))
    })
    expect(authPost).toHaveBeenCalledWith('/api/briefing?kind=weekly', { full: true, send_slack: true })
    expect(within(dialog).getByText('Posted to Slack.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Health, empty', () => {
  beforeEach(() => {
    data.value = { instances: [], syncRuns: [] }
  })

  it('says so for both sections instead of rendering blank tables', async () => {
    await renderHealth()
    expect(screen.getByText('No sync runs yet')).toBeTruthy()
    expect(screen.getByText('No accounts registered')).toBeTruthy()
    expect(screen.getByText('No publishing probes yet')).toBeTruthy()
  })
})

describe('Health, member', () => {
  beforeEach(() => {
    auth.isAdmin = false
    data.value = { instances: [instance()], syncRuns: [run()] }
  })

  it('hides every admin-only control and never reads publishing compatibility', async () => {
    await renderHealth()
    expect(screen.queryByRole('button', { name: 'Monday briefing' })).toBeNull()
    expect(screen.queryByText('Publishing compatibility')).toBeNull()
    expect(listSequencePublishTargets).not.toHaveBeenCalled()

    const adminOnly = screen.getByRole('button', { name: 'Admin only' })
    expect((adminOnly as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull()
  })
})

describe('Health, publishing-compatibility read failure', () => {
  beforeEach(() => {
    data.value = { instances: [instance()], syncRuns: [run()] }
    listSequencePublishTargets.mockRejectedValue(new Error('Compatibility service timed out'))
  })

  it('renders the failure instead of an empty or stale table', async () => {
    await renderHealth()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toContain('Compatibility could not be loaded')
    expect(screen.getByRole('alert').textContent).toContain('Compatibility service timed out')
    expect(screen.queryByText('No publishing probes yet')).toBeNull()
  })
})
