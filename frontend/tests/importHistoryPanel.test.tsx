// @vitest-environment jsdom
/**
 * ImportHistoryPanel after its Phase 5 conversion to the canonical `src/ui`
 * contracts. Pins the paste → review → import state machine the redesign
 * must not have changed: parsing, the already-saved dedup badge, the edited
 * "Back" confirmation, and the /api/import payload — none of which moved
 * when the raw buttons/inputs/textareas became `Button`/`Checkbox`/
 * `TextField`/`TextareaField`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Lead } from '../src/lib/types'

const authPost = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('../src/lib/api', () => ({ authPost, authFetch: vi.fn() }))
vi.mock('../src/lib/ToastContext', () => ({ useToast: () => toast }))

import { ImportHistoryPanel } from '../src/components/ImportHistoryPanel'

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

const LEAD: Lead = {
  id: 'lead-1',
  instance_id: 'notebook-1',
  campaign_id: 'notebook-1:1',
  profile_url: 'https://www.linkedin.com/in/igor-lead',
  full_name: 'Igor Lead',
  headline: null,
  company: 'Acme Inc',
  added_at: null,
  invited_at: null,
  connected_at: null,
  first_message_at: null,
  replied_at: null,
  last_action_at: null,
  pipeline_stage: null,
  pipeline_substatus: null,
  lost_reason: null,
  pipeline_stage_changed_at: null,
  assigned_to: null,
} as Lead

const THREAD = [
  'Jun 20',
  'Ada Admin   4:15 PM',
  'Hello Igor, thanks for connecting.',
  '',
  'Igor Lead   4:20 PM',
  'Sure, happy to chat.',
].join('\n')

let confirmSpy: ReturnType<typeof vi.spyOn>

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  confirmSpy?.mockRestore()
})

function renderPanel(props: Partial<Parameters<typeof ImportHistoryPanel>[0]> = {}) {
  const onImported = vi.fn()
  const onClose = vi.fn()
  render(
    <ImportHistoryPanel
      lead={LEAD}
      accountName="Ada Admin LI"
      existing={null}
      onImported={onImported}
      onClose={onClose}
      {...props}
    />,
  )
  return { onImported, onClose }
}

function pasteAndPreview(text = THREAD) {
  fireEvent.change(screen.getByLabelText('Paste the LinkedIn thread'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
}

describe('ImportHistoryPanel', () => {
  it('starts on the paste step with Preview disabled until there is text', () => {
    renderPanel()
    expect(screen.getByRole('list', { name: 'Import history progress' })).toBeTruthy()
    const preview = screen.getByRole('button', { name: 'Preview' })
    expect((preview as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Paste the LinkedIn thread'), { target: { value: 'x' } })
    expect((preview as HTMLButtonElement).disabled).toBe(false)
  })

  it('cancels from the paste step without saving anything', () => {
    const { onClose } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(authPost).not.toHaveBeenCalled()
  })

  it('shows a parse error for text with no recognizable message header', () => {
    renderPanel()
    pasteAndPreview('just some random pasted text with no header lines')
    expect(screen.getByText('Could not parse the thread.')).toBeTruthy()
    expect(screen.getByText(/Nothing parsed/)).toBeTruthy()
    // Still on the paste step.
    expect(screen.getByLabelText('Paste the LinkedIn thread')).toBeTruthy()
  })

  it('parses a pasted thread into reviewable, editable message blocks', () => {
    renderPanel()
    pasteAndPreview()

    expect(screen.getByTitle('Ada Admin')).toBeTruthy()
    expect(screen.getByTitle('Igor Lead')).toBeTruthy()
    expect(screen.getByLabelText('Message text from Ada Admin')).toHaveProperty(
      'value', 'Hello Igor, thanks for connecting.',
    )
    expect(screen.getByRole('button', { name: /^Save 2 messages$/ })).toBeTruthy()
    // Neither message pre-exists, so nothing is flagged as already saved.
    expect(screen.queryByText('already saved')).toBeNull()
  })

  it('flags an already-imported message as already saved and excludes it by default', () => {
    renderPanel({
      existing: [{ direction: 'out', body: 'Hello Igor, thanks for connecting.' }],
    })
    pasteAndPreview()

    expect(screen.getByText('already saved')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Save 1 message$/ })).toBeTruthy()
    expect(screen.getByText('1 already saved')).toBeTruthy()
  })

  it('asks before discarding edits when going back, and keeps the draft on "Keep editing"', () => {
    renderPanel()
    pasteAndPreview()

    // Flip a block's direction — an edit the "Back" guard must notice.
    fireEvent.click(screen.getByRole('button', { name: 'Us →' }))

    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(confirmSpy).toHaveBeenCalled()
    // Declined the confirm — still on the review step with the edit intact.
    expect(screen.getByTitle('Ada Admin')).toBeTruthy()

    confirmSpy.mockReturnValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Paste the LinkedIn thread')).toBeTruthy()
  })

  it('removes a message from review without asking (removal is not a guarded edit until acted on again)', () => {
    renderPanel()
    pasteAndPreview()
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove message' })[0])
    expect(screen.queryByTitle('Ada Admin')).toBeNull()
    expect(screen.getByRole('button', { name: /^Save 1 message$/ })).toBeTruthy()
  })

  it('saves the included messages and shows the import result', async () => {
    authPost.mockResolvedValue(ok({ inserted: 2, skipped: 0 }))
    const { onImported, onClose } = renderPanel()
    pasteAndPreview()

    fireEvent.click(screen.getByRole('button', { name: /^Save 2 messages$/ }))

    await waitFor(() => expect(screen.getByText(/^Imported/)).toBeTruthy())
    expect(screen.getByText('2')).toBeTruthy()
    expect(authPost).toHaveBeenCalledWith('/api/import', expect.objectContaining({
      action: 'conversation_import',
      instance_id: LEAD.instance_id,
      campaign_id: LEAD.campaign_id,
      profile_url: LEAD.profile_url,
      messages: expect.arrayContaining([
        expect.objectContaining({ direction: 'out', body: 'Hello Igor, thanks for connecting.' }),
        expect.objectContaining({ direction: 'in', body: 'Sure, happy to chat.' }),
      ]),
    }))
    expect(onImported).toHaveBeenCalledWith({ inserted: 2, skipped: 0 })
    expect(toast.success).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('surfaces a save failure and keeps the draft for another try', async () => {
    authPost.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'DB unavailable' }) })
    renderPanel()
    pasteAndPreview()

    fireEvent.click(screen.getByRole('button', { name: /^Save 2 messages$/ }))

    await waitFor(() => expect(screen.getByText('Could not save the messages.')).toBeTruthy())
    expect(screen.getByText('DB unavailable')).toBeTruthy()
    // Still on the review step — the draft was not thrown away.
    expect(screen.getByRole('button', { name: /^Save 2 messages$/ })).toBeTruthy()
  })
})
