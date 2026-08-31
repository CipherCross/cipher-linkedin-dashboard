// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const { PublishWizard } = await import('../src/pages/SequenceBuilder')

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
  createSequencePublishJob.mockResolvedValue({
    id: 'job-1', sequence_revision: 7, target_instance_id: 'uitop-1',
    target_machine_key: 'windows-sales-1', status: 'queued', claim_generation: 0,
    branches: [{}], queued_at: '2026-08-31T10:01:00.000Z',
  })
})

afterEach(cleanup)

describe('Sequence publish wizard', () => {
  it('explains the destination, exposes timing, and reviews human-readable paused campaigns', async () => {
    const onCreated = vi.fn()
    render(<PublishWizard sequence={sequence} document={sequence.document} onClose={vi.fn()} onCreated={onCreated} />)

    expect(await screen.findByText('Alyona')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    expect(screen.getByRole('heading', { name: 'Choose branches and timing' })).toBeDefined()
    expect(screen.getByLabelText('Hours before connection request')).toBeDefined()
    expect(screen.getByLabelText('Hours after connection')).toBeDefined()
    fireEvent.change(screen.getByLabelText('Hours before connection request'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    expect(screen.getByRole('heading', { name: 'Review before publishing' })).toBeDefined()
    expect(screen.getByText('Send connection request')).toBeDefined()
    expect(screen.getByText('Check for reply')).toBeDefined()
    expect(screen.getByText('Safe by default')).toBeDefined()
    expect(screen.queryByText('InvitePerson')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Queue 1 paused campaign/ }))
    await waitFor(() => expect(createSequencePublishJob).toHaveBeenCalledWith(expect.objectContaining({
      sequenceId: sequence.id,
      targetInstanceId: 'uitop-1',
      options: expect.objectContaining({ preInviteDelayHours: 12, inviteToFirstMessageDelayHours: 24 }),
    })))
    expect(onCreated).toHaveBeenCalledTimes(1)
  })

  it('keeps incompatible destinations visible and blocks selection', async () => {
    listSequencePublishTargets.mockResolvedValueOnce([{
      instance_id: 'uitop-2', machine_key: 'windows-sales-2', account_snapshot: {},
      capability_snapshot: {}, compatible: false, compatibility_error_code: 'version_not_supported',
      probed_at: '2026-08-31T10:00:00.000Z',
    }])
    render(<PublishWizard sequence={sequence} document={sequence.document} onClose={vi.fn()} onCreated={vi.fn()} />)

    expect(await screen.findByText('Not ready')).toBeDefined()
    expect(screen.getByText('version not supported')).toBeDefined()
    expect(screen.getByRole('button', { name: /Continue/ })).toHaveProperty('disabled', true)
  })
})
