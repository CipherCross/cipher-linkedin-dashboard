// @vitest-environment jsdom
/**
 * Faces in the Replies queue. A row whose conversation has a lead with a synced
 * photo renders that photo, addressed by lead id; a contact with no lead row
 * renders initials of its profile identifier and asks for no photo at all.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_REPLY_SCOPE, type ReplyReadClient } from '../src/lib/replyReview'

vi.mock('../src/lib/api', () => ({ authFetch: vi.fn(), authPost: vi.fn() }))
const photoGet = vi.fn(async (lead: { id: string } | null | undefined) => (lead?.id === 'lead-ann' ? 'https://photos.test/ann.jpg' : null))
vi.mock('../src/lib/leadPhotos', () => ({ leadPhotoUrls: { get: (lead: { id: string }) => photoGet(lead), clear: () => {} } }))

const { Replies } = await import('../src/pages/Replies')

const row = (profile: string, extra: Record<string, unknown>) => ({
  instance_id: 'one', profile_url: `https://www.linkedin.com/in/${profile}`, company: null, headline: null,
  latest_snippet: 'hi', latest_direction: 'in', latest_sent_at: '2026-09-11T10:00:00.000Z',
  selected_message_id: 1, pending_count: 1, owner_id: null, action: null, next_follow_up_date: null,
  do_not_contact: false, review_revision: 0, workflow_revision: 0, revision: 0, inbound_revision: 1,
  acknowledged_inbound_revision: 0, ...extra,
})

function client(): ReplyReadClient {
  return {
    capabilities: vi.fn().mockResolvedValue({ available: true, active: true, manual_ready: true, mode: 'manual', members: [], instances: [{ id: 'one', label: 'Notebook one' }], campaigns: [] }),
    facets: vi.fn().mockResolvedValue({ facets: {}, scope: DEFAULT_REPLY_SCOPE }),
    inbox: vi.fn().mockResolvedValue({ items: [
      row('ann', { name: 'Ann Photo', lead_id: 'lead-ann', photo_path: 'one/ann.jpg' }),
      row('ben', { name: 'Ben Nophoto', lead_id: 'lead-ben', photo_path: null }),
      row('david-glauber-1b1961191', { name: null, lead_id: null, photo_path: null }),
    ], next_cursor: null, scope: DEFAULT_REPLY_SCOPE }),
    thread: vi.fn().mockResolvedValue({ messages: [], older_cursor: null, newer_cursor: null, workflow: null }),
    history: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
  }
}

describe('Replies queue faces', () => {
  afterEach(() => { cleanup(); photoGet.mockClear() })

  it('shows the lead photo by lead id and initials for everyone else', async () => {
    const { container } = render(<MemoryRouter><Replies client={client()} /></MemoryRouter>)
    const ann = await screen.findByRole('button', { name: /Ann Photo/ })
    await waitFor(() => expect(ann.querySelector('img')?.getAttribute('src')).toBe('https://photos.test/ann.jpg'))
    // Only the lead that has a synced photo is asked for one.
    expect(photoGet.mock.calls.map(([lead]) => lead?.id)).toEqual(['lead-ann'])
    const ben = screen.getByRole('button', { name: /Ben Nophoto/ })
    expect(ben.querySelector('img')).toBeNull()
    expect(ben.querySelector('[data-avatar="fallback"]')?.textContent).toBe('BN')
    // A contact with no lead keeps "LinkedIn contact" plus its identifier.
    const unknown = screen.getByRole('button', { name: /LinkedIn contact/ })
    expect(unknown.textContent).toContain('david-glauber-1b1961191')
    expect(unknown.querySelector('img')).toBeNull()
    expect(container.querySelectorAll('.replies-list-item img')).toHaveLength(1)
  })
})
