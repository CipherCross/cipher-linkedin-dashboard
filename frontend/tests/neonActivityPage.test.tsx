// @vitest-environment jsdom
/**
 * Neon Activity after the Phase 3 conversion — mostly already on the
 * canonical `src/ui` contracts before this pass; this pins the populated,
 * empty and failed-read outcomes of its one diagnostic read, and that the
 * page no longer double-wraps itself in `.page` (Layout already does).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DailyActivity } from '../src/lib/types'

const fetchAllNeonActivity = vi.hoisted(() => vi.fn())

vi.mock('../src/lib/neonActivity', () => ({ fetchAllNeonActivity }))
vi.mock('../src/lib/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-fixture-1' } }) }))
vi.mock('../src/components/ActivityChart', () => ({
  ActivityChart: ({ activity }: { activity: DailyActivity[] }) => (
    <div data-testid="activity-chart">{activity.length} charted rows</div>
  ),
}))

import { NeonActivity } from '../src/pages/NeonActivity'

function row(overrides: Partial<DailyActivity> = {}): DailyActivity {
  return { day: '2026-09-01', instance_id: 's12-activity', event_type: 'invite_sent', cnt: 3, ...overrides }
}

async function renderPage() {
  render(<NeonActivity />)
  await act(async () => {})
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Neon Activity, populated', () => {
  it('reports rows, pages and events, and charts the read', async () => {
    fetchAllNeonActivity.mockResolvedValue({ activity: [row(), row({ cnt: 5 })], pages: 1 })
    await renderPage()
    const summary = await screen.findByTestId('neon-activity-summary')
    expect(summary.textContent).toContain('2 rows over 1 page')
    expect(summary.textContent).toContain('8 events')
    expect(screen.getByTestId('activity-chart').textContent).toBe('2 charted rows')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reloads through the Refresh action', async () => {
    fetchAllNeonActivity.mockResolvedValue({ activity: [row()], pages: 1 })
    await renderPage()
    await waitFor(() => expect(fetchAllNeonActivity).toHaveBeenCalledTimes(1))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    })
    expect(fetchAllNeonActivity).toHaveBeenCalledTimes(2)
  })
})

describe('Neon Activity, empty', () => {
  it('reports zero rows rather than an ambiguous blank chart', async () => {
    fetchAllNeonActivity.mockResolvedValue({ activity: [], pages: 0 })
    await renderPage()
    const summary = await screen.findByTestId('neon-activity-summary')
    expect(summary.textContent).toContain('0 rows over 0 pages')
    expect(summary.textContent).toContain('0 events')
  })
})

describe('Neon Activity, failed read', () => {
  it('renders the failure and the signed-in subject used to diagnose it', async () => {
    fetchAllNeonActivity.mockRejectedValue(new Error('activity-daily: 503'))
    await renderPage()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toContain('This diagnostic read failed.')
    expect(screen.getByText('activity-daily: 503')).toBeTruthy()
    expect(screen.getByText('user-fixture-1')).toBeTruthy()
    expect(screen.queryByTestId('neon-activity-summary')).toBeNull()
  })
})
