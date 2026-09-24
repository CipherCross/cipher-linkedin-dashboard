// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { createSequenceDocument, type SequenceDetail, type SequenceRecord } from '../src/lib/sequenceBuilder'

const getSequence = vi.fn()
const saveSequence = vi.fn()
const listSequences = vi.fn()
const fetchNeonSequenceHub = vi.fn()
const toastError = vi.fn()

vi.mock('../src/lib/sequenceBuilderApi', () => {
  class MockSequenceBuilderApiError extends Error {
    readonly status: number
    readonly current: SequenceRecord | null

    constructor(status: number, body: { error?: unknown; sequence?: unknown }) {
      super(typeof body.error === 'string' ? body.error : `Request failed (${status})`)
      this.status = status
      this.current = body.sequence && typeof body.sequence === 'object'
        ? body.sequence as SequenceRecord
        : null
    }
  }
  return {
    SequenceBuilderApiError: MockSequenceBuilderApiError,
    getSequence: (...args: unknown[]) => getSequence(...args),
    saveSequence: (...args: unknown[]) => saveSequence(...args),
    listSequences: (...args: unknown[]) => listSequences(...args),
    createSequence: vi.fn(),
    setSequenceArchived: vi.fn(),
    createSequenceComment: vi.fn(),
    replySequenceComment: vi.fn(),
    setSequenceCommentResolved: vi.fn(),
  }
})

vi.mock('../src/lib/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: toastError, info: vi.fn() }),
}))

vi.mock('../src/lib/dashboardReads', () => ({
  fetchNeonSequenceHub: (...args: unknown[]) => fetchNeonSequenceHub(...args),
}))

vi.mock('../src/lib/AuthContext', () => ({ useAuth: () => ({ isAdmin: false }) }))

const { SequenceBuilder } = await import('../src/pages/SequenceBuilder')

function record(patch: Partial<SequenceRecord> = {}): SequenceRecord {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Founder outreach',
    document: createSequenceDocument(),
    revision: 1,
    archived: false,
    created_by: '11111111-1111-4111-8111-111111111111',
    created_by_name: 'Alex',
    updated_by: '11111111-1111-4111-8111-111111111111',
    updated_by_name: 'Alex',
    created_at: '2026-08-27T10:00:00.000Z',
    updated_at: '2026-08-27T10:00:00.000Z',
    ...patch,
  }
}

function detail(sequence = record()): SequenceDetail {
  return { sequence, versions: [], comments: [] }
}

function renderEditor() {
  return render(
    <MemoryRouter initialEntries={['/sequences/22222222-2222-4222-8222-222222222222']}>
      <Routes>
        <Route path="/sequences/:id" element={<SequenceBuilder />} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderLibrary() {
  return render(
    <MemoryRouter initialEntries={['/sequences']}>
      <Routes>
        <Route path="/sequences" element={<SequenceBuilder />} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(cleanup)

beforeEach(() => {
  getSequence.mockReset()
  saveSequence.mockReset()
  listSequences.mockReset().mockResolvedValue([])
  fetchNeonSequenceHub.mockReset().mockResolvedValue({
    items: [
      {
        id: 'managed:sequence-one', kind: 'managed', source: 'builder',
        sequence_document_id: 'sequence-one', name: 'Founder outreach', revision: 4,
        archived: false, branch_count: 2, updated_at: '2026-09-01T12:00:00Z',
        deployment_count: 3, account_count: 2, leads: 30, replies: 4, p3: 1,
        latest_reply: null,
        deployments: [
          {
            key: 'running', lineage: 'publish', campaign_id: 'notebook-1:10',
            campaign_name: 'Founder A', campaign_status: 'active', runtime_status: 'running',
            is_archived: false, status_observed_at: '2026-09-01T12:45:00Z',
            status_source: 'fixture-build-v1', status_raw: '{"runtime":"R"}',
            instance_id: 'notebook-1', account_name: 'Alice', account_avatar: null,
            last_sync_at: '2026-09-01T12:46:00Z', sequence_revision: 4,
            branch_id: 'a', branch_letter: 'A', publish_status: 'success',
            awaiting_sync: false, leads: 10, replies: 2, p3: 1, latest_reply: null,
          },
          {
            key: 'archived', lineage: 'publish', campaign_id: 'notebook-2:20',
            campaign_name: 'Founder B old', campaign_status: 'stopped', runtime_status: 'completed',
            is_archived: true, status_observed_at: '2026-09-01T12:40:00Z',
            status_source: 'fixture-build-v1', status_raw: '{"runtime":"C"}',
            instance_id: 'notebook-2', account_name: 'Bob', account_avatar: null,
            last_sync_at: '2026-09-01T12:41:00Z', sequence_revision: 4,
            branch_id: 'b', branch_letter: 'B', publish_status: 'success',
            awaiting_sync: false, leads: 15, replies: 2, p3: 0, latest_reply: null,
          },
          {
            key: 'unknown', lineage: 'explicit_link', campaign_id: 'notebook-2:21',
            campaign_name: 'Founder B unknown', campaign_status: 'active', runtime_status: null,
            is_archived: null, status_observed_at: '2026-09-01T12:30:00Z',
            status_source: 'unsupported:STATUS_PROFILE_UNVERIFIED', status_raw: null,
            instance_id: 'notebook-2', account_name: 'Bob', account_avatar: null,
            last_sync_at: '2026-09-01T12:31:00Z', sequence_revision: null,
            branch_id: null, branch_letter: null, publish_status: null,
            awaiting_sync: false, leads: 5, replies: 0, p3: 0, latest_reply: null,
          },
        ],
      },
    ],
    newestReplies: [],
  })
  toastError.mockReset()
  getSequence.mockResolvedValue(detail())
  saveSequence.mockImplementation(async (input: { name: string }) =>
    record({ name: input.name, revision: 2, updated_at: '2026-08-27T10:01:00.000Z' }),
  )
})

describe('Sequence Builder autosave', () => {
  it('saves one debounced revision after the name changes', async () => {
    renderEditor()
    const name = await screen.findByRole('textbox', { name: 'Sequence name' })
    fireEvent.change(name, { target: { value: 'New founder sequence' } })

    await waitFor(() => expect(saveSequence).toHaveBeenCalledTimes(1), { timeout: 2_500 })
    expect(saveSequence).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 1,
      name: 'New founder sequence',
    }))
    await waitFor(() => expect(screen.getByText('All changes saved')).toBeDefined())
  })

  it('does not overwrite the local draft when the server reports a conflict', async () => {
    const api = await import('../src/lib/sequenceBuilderApi')
    saveSequence.mockRejectedValue(
      new api.SequenceBuilderApiError(409, {
        error: 'Sequence changed in another session.',
        sequence: record({ name: 'Remote name', revision: 2 }),
      }),
    )
    renderEditor()
    const name = await screen.findByRole('textbox', { name: 'Sequence name' })
    fireEvent.change(name, { target: { value: 'My local draft' } })

    await screen.findByText('This sequence changed in another session.', {}, { timeout: 2_500 })
    expect((screen.getByRole('textbox', { name: 'Sequence name' }) as HTMLInputElement).value).toBe('My local draft')
    expect(screen.getByRole('button', { name: 'Load newer version' })).toBeDefined()
  })
})

/** The deployment filters live in an overlay now, so every assertion about one
 *  opens it first. The page keeps ONE user-facing name, "Sequences" — the
 *  sidebar used to say "Sequence Builder" and this landing page "Sequence Hub". */
const openDeploymentFilters = () => {
  fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
}
/** The overlay edits a draft; nothing reaches the table until Apply. */
const applyDeploymentFilters = () => {
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Deployment filters' })).getByRole('button', { name: 'Apply' }))
}

describe('Sequences deployments', () => {
  it('starts sequence-first and hides archived or archive-unknown campaigns by default', async () => {
    renderLibrary()
    expect(await screen.findByRole('heading', { name: 'Sequences' })).toBeTruthy()
    const liveCampaign = (await screen.findByText('Founder A')).closest('tr') as HTMLElement
    expect(within(liveCampaign).getByText('Running')).toBeTruthy()
    expect(within(liveCampaign).getByText('Published')).toBeTruthy()
    expect(screen.queryByText('Founder B old')).toBeNull()
    expect(screen.queryByText('Founder B unknown')).toBeNull()

    openDeploymentFilters()
    fireEvent.change(screen.getByLabelText('Archive'), { target: { value: 'all' } })
    applyDeploymentFilters()
    expect(screen.getByText('Founder B old')).toBeTruthy()
    expect(screen.getByText('Founder B unknown')).toBeTruthy()
    const archivedCampaign = screen.getByText('Founder B old').closest('tr') as HTMLElement
    const unknownCampaign = screen.getByText('Founder B unknown').closest('tr') as HTMLElement
    expect(within(archivedCampaign).getByText('Archived')).toBeTruthy()
    expect(within(unknownCampaign).getByText('Unsupported')).toBeTruthy()
  })

  it('filters deployments by notebook and runtime without changing Builder state', async () => {
    renderLibrary()
    await screen.findByText('Founder A')
    openDeploymentFilters()
    fireEvent.change(screen.getByLabelText('Archive'), { target: { value: 'all' } })
    fireEvent.change(screen.getByLabelText('Notebook'), { target: { value: 'notebook-2' } })
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'completed' } })
    applyDeploymentFilters()
    expect(screen.getByText('Founder B old')).toBeTruthy()
    expect(screen.queryByText('Founder A')).toBeNull()
    expect(screen.queryByText('Founder B unknown')).toBeNull()
  })
})

describe('Sequences hub on canonical contracts (Phase 10)', () => {
  it('keeps the table unchanged until Apply, and Cancel discards the draft', async () => {
    renderLibrary()
    await screen.findByText('Founder A')
    openDeploymentFilters()
    fireEvent.change(screen.getByLabelText('Notebook'), { target: { value: 'notebook-2' } })
    // Still the applied state underneath the open draft.
    expect(screen.getByText('Founder A')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Deployment filters' })).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Deployment filters' })).toBeNull()
    expect(screen.getByText('Founder A')).toBeTruthy()
    // Reopening starts from the applied values, not the discarded draft.
    openDeploymentFilters()
    expect((screen.getByLabelText('Notebook') as HTMLSelectElement).value).toBe('any')
  })

  it('applies every draft filter at once, and a no-match offers Clear filters', async () => {
    renderLibrary()
    await screen.findByText('Founder A')
    openDeploymentFilters()
    fireEvent.change(screen.getByLabelText('Notebook'), { target: { value: 'notebook-1' } })
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'completed' } })
    applyDeploymentFilters()
    expect(screen.getByRole('button', { name: /Filters/ }).textContent).toContain('2')
    expect(screen.getByText('No deployments match these filters')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByText('Founder A')).toBeTruthy()
  })

  it('shows a failed deployments read as a retryable error', async () => {
    fetchNeonSequenceHub.mockReset().mockRejectedValueOnce(new Error('hub down'))
    renderLibrary()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('hub down')
    const calls = fetchNeonSequenceHub.mock.calls.length
    fetchNeonSequenceHub.mockResolvedValue({ items: [] })
    fireEvent.click(within(alert).getByRole('button', { name: /Retry|Try again/ }))
    await waitFor(() => expect(fetchNeonSequenceHub.mock.calls.length).toBe(calls + 1))
  })

  it('opens a Build card through a real link and archives from a named button without opening it', async () => {
    listSequences.mockReset().mockResolvedValue([record()])
    const api = await import('../src/lib/sequenceBuilderApi')
    vi.mocked(api.setSequenceArchived).mockResolvedValue(record({ archived: true }))
    renderLibrary()
    await screen.findByText('Founder A')
    fireEvent.click(screen.getByRole('tab', { name: /Build/ }))
    const link = await screen.findByRole('link', { name: 'Founder outreach' })
    expect(link.getAttribute('href')).toBe('/sequences/22222222-2222-4222-8222-222222222222')
    expect(document.querySelector('article[role="button"], article[tabindex]')).toBeNull()
    const status = screen.getByRole('radiogroup', { name: 'Builder sequence status' })
    expect(within(status).getByRole('radio', { name: /Current/ }).getAttribute('aria-checked')).toBe('true')
    // Each scope says how many sequences it holds.
    expect(within(status).getByRole('radio', { name: /Current/ }).textContent).toBe('Current1')
    expect(within(status).getByRole('radio', { name: /Archived/ }).textContent).toBe('Archived0')
    fireEvent.click(screen.getByRole('button', { name: 'Archive Founder outreach' }))
    await waitFor(() => expect(api.setSequenceArchived).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', true))
    // Archived, so it left the Current view; the page did not navigate away.
    expect(screen.getByRole('heading', { name: 'Sequences' })).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Founder outreach' })).toBeNull())
    fireEvent.click(within(status).getByRole('radio', { name: /Archived/ }))
    expect(screen.getByRole('link', { name: 'Founder outreach' })).toBeTruthy()
  })
})
