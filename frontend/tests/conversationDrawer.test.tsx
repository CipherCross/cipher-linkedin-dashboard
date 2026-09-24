// @vitest-environment jsdom
/**
 * The conversation drawer on the shared Dialog contract (Phase 7).
 *
 * It used to be a hand-built `aria-modal` aside with its own document Escape
 * listener, Tab trap and body scroll lock. What these pin is what that move
 * must keep or fix: every close path reaches `onClose`, Escape inside the
 * message editor cancels the edit and not the conversation, the lost-reason
 * dialog nests inside it and closes on its own, and a failed thread read is a
 * retryable error rather than an empty thread.
 *
 * The page's contexts, the reads and the writes are replaced; the drawer, its
 * panels and the Dialog are real.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Lead } from '../src/lib/types'

const fetchNeonThread = vi.fn()
const setStage = vi.fn(async () => {})
const capabilities = vi.fn(async (): Promise<unknown> => ({ available: false }))
const saveReview = vi.fn(async (): Promise<unknown> => null)

vi.mock('../src/lib/dashboardReads', () => ({
  fetchNeonThread: (...a: unknown[]) => fetchNeonThread(...a),
  fetchNeonLeadNotes: vi.fn(async () => []),
  fetchNeonFollowUpHistory: vi.fn(async () => ({ events: [], nextCursor: null, hasMore: false })),
  resolveReadPath: async () => 'neon',
  resolvePhotoPath: async () => 'disabled',
}))
vi.mock('../src/lib/replyReview', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/replyReview')>('../src/lib/replyReview')
  return {
    ...actual,
    defaultReplyReadClient: {
      ...actual.defaultReplyReadClient,
      capabilities: () => capabilities(),
      // Manual-review mode reads the thread through the replies client.
      thread: async () => ({ messages: await fetchNeonThread() }),
    },
  }
})
vi.mock('../src/lib/useReplyReviewActions', () => ({
  useReplyReviewActions: () => ({ saving: false, error: null, conflict: null, saveReview: () => saveReview() }),
}))
vi.mock('../src/lib/supabase', () => ({ supabase: null }))
vi.mock('../src/lib/api', () => ({ authPost: vi.fn(), authFetch: vi.fn() }))
vi.mock('../src/lib/AuthContext', () => ({ useAuth: () => ({ isAdmin: true }) }))
vi.mock('../src/lib/ToastContext', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))
vi.mock('../src/lib/usePipelineActions', () => ({
  usePipelineActions: () => ({
    setStage, assign: vi.fn(), addNote: vi.fn(), deleteNote: vi.fn(), actor: 'Tester',
    members: [], assignableMembers: [], memberWritesBlockedReason: null, memberName: () => '',
  }),
}))

const LEAD = {
  id: '22222222-2222-4222-8222-222222222222', instance_id: 'notebook-1', campaign_id: 'notebook-1:1',
  profile_url: 'https://example.test/in/ada', full_name: 'Ada Lovelace', headline: 'CTO', company: 'Engines',
  pipeline_stage: null, pipeline_substatus: null, assigned_to: null, gender: null,
} as unknown as Lead

vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({
    data: {
      leads: [LEAD], campaigns: [], instances: [], followUpStates: [], followUpsAvailable: false,
    },
    refetch: vi.fn(),
    patchLead: vi.fn(),
  }),
}))

const { ConversationDrawer } = await import('../src/components/ConversationDrawer')

const THREAD = [
  { id: 1, direction: 'out', body: 'Hi Ada', sent_at: '2026-09-20T10:00:00Z', source: 'agent' },
  { id: 2, direction: 'in', body: 'Hello!', sent_at: '2026-09-20T11:00:00Z', source: 'agent' },
  { id: 3, direction: 'out', body: 'Pasted by hand', sent_at: '2026-09-20T12:00:00Z', source: 'manual' },
]

let onClose: ReturnType<typeof vi.fn<() => void>>

async function paint() {
  onClose = vi.fn<() => void>()
  render(
    <MemoryRouter>
      <ConversationDrawer lead={LEAD} onClose={onClose} />
    </MemoryRouter>,
  )
  await act(async () => {})
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  fetchNeonThread.mockResolvedValue(THREAD)
  capabilities.mockResolvedValue({ available: false })
  saveReview.mockResolvedValue(null)
})

describe('the conversation drawer', () => {
  it('is a modal dialog named for the lead, closed by Close and by Escape', async () => {
    await paint()
    const dialog = screen.getByRole('dialog', { name: 'Ada Lovelace' })
    expect(within(dialog).getByRole('region', { name: 'Messages' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('cancels a message edit on Escape without closing the conversation', async () => {
    await paint()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit imported message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit imported message' })
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Edit imported message' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Ada Lovelace' })).toBeTruthy()
  })

  it('nests the lost-reason dialog, which closes on its own and requires a reason', async () => {
    await paint()
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'lost' } })
    const lost = screen.getByRole('dialog', { name: 'Mark as lost — Ada Lovelace' })
    const confirm = within(lost).getByRole('button', { name: 'Mark lost' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.keyDown(lost, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: /Mark as lost/ })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(setStage).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'lost' } })
    const again = screen.getByRole('dialog', { name: /Mark as lost/ })
    fireEvent.change(within(again).getByLabelText(/^Reason/), { target: { value: 'Went with a competitor' } })
    fireEvent.click(within(again).getByRole('button', { name: 'Mark lost' }))
    expect(setStage).toHaveBeenCalledWith(expect.objectContaining({ id: LEAD.id }), 'lost', { lostReason: 'Went with a competitor' })
  })

  it('shows a failed thread read as a retryable error, not an empty thread', async () => {
    fetchNeonThread.mockRejectedValue(new Error('messages.thread: boom'))
    await paint()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('messages.thread: boom')
    expect(screen.queryByText('No messages yet')).toBeNull()
    const calls = fetchNeonThread.mock.calls.length
    fetchNeonThread.mockResolvedValue(THREAD)
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })) })
    await waitFor(() => expect(fetchNeonThread.mock.calls.length).toBe(calls + 1))
    expect(await screen.findByText('Hello!')).toBeTruthy()
  })

  it('makes the coach and the notes disclosures', async () => {
    await paint()
    const coach = screen.getByRole('button', { name: 'AI coach' })
    expect(coach.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(coach)
    expect(coach.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(coach.getAttribute('aria-controls')!)).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Notes' }).getAttribute('aria-expanded')).toBe('false')
  })

  describe('closing over unsaved work', () => {
    const prompt = () => screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })
    // The prompt's own close control is also named Keep editing; use the footer one.
    const keepEditing = () => fireEvent.click(within(prompt()!).getAllByRole('button', { name: 'Keep editing' }).at(-1)!)

    it('asks before closing over a pasted, unsaved import, and Keep editing keeps it', async () => {
      await paint()
      fireEvent.click(screen.getByRole('button', { name: 'Import history' }))
      const paste = screen.getByLabelText(/Paste the LinkedIn thread/)
      fireEvent.change(paste, { target: { value: 'Ada Lovelace  4:15 PM\nHello' } })

      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Ada Lovelace' }), { key: 'Escape' })
      expect(prompt()).not.toBeNull()
      expect(onClose).not.toHaveBeenCalled()
      keepEditing()
      expect(prompt()).toBeNull()
      expect((screen.getByLabelText(/Paste the LinkedIn thread/) as HTMLTextAreaElement).value).toContain('Hello')

      fireEvent.click(within(screen.getByRole('dialog', { name: 'Ada Lovelace' })).getAllByRole('button', { name: 'Close' })[0])
      fireEvent.click(within(prompt()!).getByRole('button', { name: 'Discard changes' }))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('holds a drawer link over unsaved work until Discard, then navigates', async () => {
      onClose = vi.fn<() => void>()
      render(
        <MemoryRouter initialEntries={['/leads']}>
          <Routes>
            <Route path="/leads" element={<ConversationDrawer lead={LEAD} onClose={onClose} />} />
            <Route path="/campaign/:id" element={<p>Campaign page</p>} />
          </Routes>
        </MemoryRouter>,
      )
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: 'Import history' }))
      fireEvent.change(screen.getByLabelText(/Paste the LinkedIn thread/), { target: { value: 'Ada Lovelace  4:15 PM\nHello' } })
      fireEvent.click(screen.getByRole('link', { name: 'notebook-1:1' }))
      expect(prompt()).not.toBeNull()
      expect(screen.queryByText('Campaign page')).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
      fireEvent.click(within(prompt()!).getByRole('button', { name: 'Discard changes' }))
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(await screen.findByText('Campaign page')).toBeTruthy()
    })

    it('closes at once when the import view holds nothing', async () => {
      await paint()
      fireEvent.click(screen.getByRole('button', { name: 'Import history' }))
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Ada Lovelace' }), { key: 'Escape' })
      expect(prompt()).toBeNull()
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('asks before closing or switching views over an edited review, and stops asking once it is saved', async () => {
      capabilities.mockResolvedValue({ available: true })
      await paint()
      await screen.findByRole('group', { name: 'Sentiment' })
      fireEvent.click(screen.getByRole('radio', { name: 'Neutral' }))

      // Opening Import would unmount the form and drop the edit.
      fireEvent.click(screen.getByRole('button', { name: 'Import history' }))
      expect(prompt()).not.toBeNull()
      keepEditing()
      expect(screen.getByRole('group', { name: 'Sentiment' })).toBeTruthy()

      // A refused save keeps the draft, so closing still asks.
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await act(async () => {})
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Ada Lovelace' }), { key: 'Escape' })
      expect(prompt()).not.toBeNull()
      keepEditing()

      saveReview.mockResolvedValue({ review: {} })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await act(async () => {})
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Ada Lovelace' }), { key: 'Escape' })
      expect(prompt()).toBeNull()
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})
