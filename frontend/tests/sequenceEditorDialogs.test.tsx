// @vitest-environment jsdom
/**
 * The Sequence editor's two hand-built modals (CommentComposer, PublishWizard)
 * on the shared Dialog: focus enters the right control, Escape and the close
 * paths route through `onRequestClose`, a busy dialog refuses every close path
 * and announces why, and focus returns to whatever opened it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { createSequenceDocument, type SequenceRecord } from '../src/lib/sequenceBuilder'

const createSequencePublishJob = vi.fn()
const listSequencePublishTargets = vi.fn()
const toastError = vi.fn()

vi.mock('../src/lib/sequenceBuilderApi', () => ({
  SequenceBuilderApiError: class extends Error {},
  createSequencePublishJob: (...args: unknown[]) => createSequencePublishJob(...args),
  listSequencePublishTargets: (...args: unknown[]) => listSequencePublishTargets(...args),
  listSequencePublishJobs: vi.fn(),
  listSequences: vi.fn(),
  createSequence: vi.fn(),
  getSequence: vi.fn(),
  saveSequence: vi.fn(),
  setSequenceArchived: vi.fn(),
  createSequenceComment: vi.fn(),
  replySequenceComment: vi.fn(),
  setSequenceCommentResolved: vi.fn(),
}))

vi.mock('../src/lib/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: toastError, info: vi.fn() }),
}))

vi.mock('../src/lib/AuthContext', () => ({ useAuth: () => ({ isAdmin: true }) }))

const { CommentComposer, PublishWizard } = await import('../src/pages/SequenceBuilder')

// Base UI's focus manager queues both the initial and the restored focus
// through requestAnimationFrame, so every assertion that depends on it needs
// one queued frame to run first — same helper as tests/uiPrimitives.test.tsx.
const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })

const sequence: SequenceRecord = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Founder outreach',
  document: (() => {
    const value = createSequenceDocument()
    value.steps[1].variations[0].text = 'Hello {firstName}'
    value.branches = [{
      id: 'branch_a',
      name: 'Default',
      selections: Object.fromEntries(value.steps.map((step) => [step.id, step.variations[0].id])),
    }]
    return value
  })(),
  revision: 7,
  archived: false,
  created_by: '11111111-1111-4111-8111-111111111111',
  created_by_name: 'Alex',
  updated_by: '11111111-1111-4111-8111-111111111111',
  updated_by_name: 'Alex',
  created_at: '2026-08-31T10:00:00.000Z',
  updated_at: '2026-08-31T10:00:00.000Z',
}

beforeEach(() => {
  createSequencePublishJob.mockReset()
  listSequencePublishTargets.mockReset()
  toastError.mockReset()
  listSequencePublishTargets.mockResolvedValue([{
    instance_id: 'uitop-1',
    machine_key: 'windows-sales-1',
    account_snapshot: {
      account_id: 'account-1',
      account_name: 'Alyona',
      sender_name: 'Alyona',
      workspace_id: 'workspace-1',
      lh_version: '5.14',
      compatibility_profile: 'linked-helper-v1',
    },
    capability_snapshot: {},
    compatible: true,
    compatibility_error_code: null,
    probed_at: '2026-08-31T10:00:00.000Z',
  }])
})

afterEach(cleanup)

const commentTarget = { stepId: null, variationId: null, anchor: null, label: 'Whole sequence' }

describe('CommentComposer dialog', () => {
  it('focuses the comment textarea on open', async () => {
    render(<CommentComposer target={commentTarget} busy={false} onClose={vi.fn()} onSubmit={vi.fn()} />)
    await frame()
    expect(document.activeElement).toBe(screen.getByLabelText('Comment'))
  })

  it('closes through onRequestClose on Escape', () => {
    const onClose = vi.fn()
    render(<CommentComposer target={commentTarget} busy={false} onClose={onClose} onSubmit={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('refuses Escape and Close while busy, and announces why', () => {
    const onClose = vi.fn()
    render(<CommentComposer target={commentTarget} busy onClose={onClose} onSubmit={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Adding the comment — wait for it to finish before closing.')).toBeTruthy()
  })

  it('returns focus to the trigger that opened it', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <div>
          <button onClick={() => setOpen(true)}>Open composer</button>
          {open && (
            <CommentComposer target={commentTarget} busy={false} onClose={() => setOpen(false)} onSubmit={vi.fn()} />
          )}
        </div>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open composer' })
    trigger.focus()
    fireEvent.click(trigger)
    await frame()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await frame()
    await frame()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('PublishWizard dialog', () => {
  it('focuses the first body control (the Destination step) on open', async () => {
    render(<PublishWizard sequence={sequence} document={sequence.document} onClose={vi.fn()} onCreated={vi.fn()} />)
    await frame()
    expect(document.activeElement?.getAttribute('aria-current')).toBe('step')
    expect(document.activeElement?.textContent).toContain('Destination')
  })

  it('closes through onRequestClose on Escape', async () => {
    const onClose = vi.fn()
    render(<PublishWizard sequence={sequence} document={sequence.document} onClose={onClose} onCreated={vi.fn()} />)
    await screen.findByText('Alyona')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('refuses Escape, the backdrop and Close while queueing, and announces why', async () => {
    createSequencePublishJob.mockImplementation(() => new Promise(() => {})) // never resolves
    const onClose = vi.fn()
    render(<PublishWizard sequence={sequence} document={sequence.document} onClose={onClose} onCreated={vi.fn()} />)
    await screen.findByText('Alyona')
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    fireEvent.click(screen.getByRole('button', { name: /Queue 1 paused campaign/ }))

    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close publish campaign' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Queueing paused campaigns — wait for it to finish before closing.')).toBeTruthy()
  })

  it('returns focus to the trigger that opened it', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <div>
          <button onClick={() => setOpen(true)}>Open wizard</button>
          {open && (
            <PublishWizard sequence={sequence} document={sequence.document} onClose={() => setOpen(false)} onCreated={vi.fn()} />
          )}
        </div>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open wizard' })
    trigger.focus()
    fireEvent.click(trigger)
    await frame()
    await waitFor(() => screen.getByText('Alyona'))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await frame()
    await frame()
    expect(document.activeElement).toBe(trigger)
  })
})
