// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { createSequenceDocument, type SequenceDetail, type SequenceRecord } from '../src/lib/sequenceBuilder'

const getSequence = vi.fn()
const saveSequence = vi.fn()
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
    listSequences: vi.fn(),
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

afterEach(cleanup)

beforeEach(() => {
  getSequence.mockReset()
  saveSequence.mockReset()
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
