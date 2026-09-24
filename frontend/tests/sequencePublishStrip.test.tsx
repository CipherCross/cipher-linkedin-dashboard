// @vitest-environment jsdom
/**
 * The editor's latest-publish strip takes its tone from `publishStatusTone`,
 * the same owner as the Hub's status badge, so one status never reads as a
 * warning in one place and a failure in the other.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SequencePublishJob } from '../src/lib/sequenceBuilderApi'

vi.mock('../src/lib/sequenceBuilderApi', () => ({
  SequenceBuilderApiError: class extends Error {},
  createSequencePublishJob: vi.fn(),
  listSequencePublishTargets: vi.fn(),
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
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))
vi.mock('../src/lib/AuthContext', () => ({ useAuth: () => ({ isAdmin: true }) }))

const { PublishJobStrip } = await import('../src/pages/SequenceBuilder')

function job(status: string): SequencePublishJob {
  return {
    id: 'job-1', sequence_revision: 3, target_instance_id: 'notebook-1',
    target_machine_key: 'nb-1', status, claim_generation: 0,
    branches: [{}, {}], queued_at: '2026-09-24T10:00:00Z',
  }
}

afterEach(cleanup)

describe('PublishJobStrip', () => {
  it.each([
    ['success', 'success', 'Published', 'bg-app-success-subtle'],
    ['partial_failure', 'warning', 'Partially published', 'bg-app-warning-subtle'],
    ['conflict', 'warning', 'Needs review', 'bg-app-warning-subtle'],
    ['failed', 'danger', 'Failed', 'bg-app-danger-subtle'],
    ['publishing', 'info', 'Creating paused campaigns', null],
  ])('%s → %s', (status, tone, label, background) => {
    render(<PublishJobStrip job={job(status)} />)
    const strip = screen.getByRole('region', { name: 'Latest campaign publishing status' })
    expect(strip.dataset.tone).toBe(tone)
    expect(strip.textContent).toContain(label)
    expect(strip.textContent).toContain('2 campaigns')
    if (background) expect(strip.className).toContain(background)
    else expect(strip.className).not.toMatch(/bg-app-(success|warning|danger)-subtle/)
  })
})
