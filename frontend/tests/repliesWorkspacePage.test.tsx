// @vitest-environment jsdom
/**
 * The Replies page itself, on the canonical primitives (Phase 7 of the
 * component-system redesign): the filter sheet is a FilterDialog that commits
 * every key together on Apply, the search box is a real labelled searchbox,
 * and a queue row exposes its selection through `aria-current` while still
 * routing every navigation through the unsaved-changes guard.
 *
 * Fixtures/mocking follow tests/repliesInboxComponents.test.tsx and
 * tests/repliesInboxCaching.test.tsx: a fake `ReplyReadClient` passed directly
 * to `<Replies client={...} />`, and `../src/lib/api` mocked so a save never
 * hits the network.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Replies } from '../src/pages/Replies'
import { DEFAULT_REPLY_SCOPE, type ReplyReadClient } from '../src/lib/replyReview'

vi.mock('../src/lib/api', () => ({ authFetch: vi.fn(), authPost: vi.fn() }))

const alice = { instance_id: 'one', profile_url: 'https://linkedin.com/in/alice' }
const bob = { instance_id: 'one', profile_url: 'https://linkedin.com/in/bob' }

const aliceItem = {
  ...alice, name: 'Alice Example', company: 'Acme', headline: null,
  latest_snippet: 'Sounds interesting', latest_direction: 'in', latest_sent_at: '2026-09-11T10:00:00.000Z',
  selected_message_id: 1, pending_count: 1, owner_id: null, action: null, next_follow_up_date: null,
  do_not_contact: false, review_revision: 0, workflow_revision: 0, revision: 0, inbound_revision: 1,
  acknowledged_inbound_revision: 0,
}
const bobItem = {
  ...bob, name: 'Bob Example', company: 'Widgets Inc', headline: null,
  latest_snippet: 'Not right now', latest_direction: 'in', latest_sent_at: '2026-09-10T10:00:00.000Z',
  selected_message_id: 2, pending_count: 1, owner_id: null, action: null, next_follow_up_date: null,
  do_not_contact: false, review_revision: 0, workflow_revision: 0, revision: 0, inbound_revision: 1,
  acknowledged_inbound_revision: 0,
}
const aliceMessage = {
  ...alice, id: 1, campaign_id: null, direction: 'in', body: 'Sounds interesting', sent_at: '2026-09-11T10:00:00.000Z', review: null,
}
const bobMessage = {
  ...bob, id: 2, campaign_id: null, direction: 'in', body: 'Not right now', sent_at: '2026-09-10T10:00:00.000Z', review: null,
}

function makeClient(): ReplyReadClient {
  return {
    capabilities: vi.fn().mockResolvedValue({
      available: true, active: true, manual_ready: true, mode: 'manual',
      members: [{ id: 1, name: 'Ann', active: true }],
      instances: [{ id: 'one', label: 'Notebook one' }],
      campaigns: [{ id: 'one:1', name: 'Campaign A', instance_id: 'one' }],
    }),
    facets: vi.fn().mockResolvedValue({ facets: { owners: [{ id: null, count: 2 }] }, scope: DEFAULT_REPLY_SCOPE }),
    inbox: vi.fn().mockResolvedValue({ items: [aliceItem, bobItem], next_cursor: null, scope: DEFAULT_REPLY_SCOPE }),
    thread: vi.fn(async (request: { profile_url: string }) => ({
      messages: request.profile_url === alice.profile_url ? [aliceMessage] : [bobMessage],
      older_cursor: null, newer_cursor: null, workflow: null, inbound_revision: 1,
    })) as unknown as ReplyReadClient['thread'],
    history: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
  }
}

function renderReplies(client: ReplyReadClient) {
  return render(<MemoryRouter initialEntries={['/']}><Replies client={client} /></MemoryRouter>)
}

describe('Replies workspace page', () => {
  afterEach(cleanup)

  it('opens the filter sheet as a FilterDialog that changes nothing until Apply, and commits every key together', async () => {
    const client = makeClient()
    renderReplies(client)
    await screen.findByText('Alice Example')
    const callsBeforeOpen = (client.inbox as ReturnType<typeof vi.fn>).mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    // It is the shared FilterDialog contract: description + Clear all/Cancel/Apply footer.
    expect(screen.getByText(/Applies to the conversation list when you apply them/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    const apply = screen.getByRole('button', { name: 'Apply' })

    // Change several draft fields at once — nothing is applied yet.
    fireEvent.change(screen.getByRole('combobox', { name: 'Arrived' }), { target: { value: 'all' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Campaign' }), { target: { value: 'one:1' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Assigned to me/ }))
    expect((client.inbox as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBeforeOpen)

    fireEvent.click(apply)
    await waitFor(() => expect((client.inbox as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBeforeOpen))
    // Every changed key lands in the SAME committed scope, not one call per field.
    const [committed] = (client.inbox as ReturnType<typeof vi.fn>).mock.calls.at(-1)!
    expect(committed).toMatchObject({ scope: 'all', campaign: 'one:1', my: true })
  })

  it('leaves the applied scope untouched on Cancel', async () => {
    const client = makeClient()
    renderReplies(client)
    await screen.findByText('Alice Example')
    const callsBeforeOpen = (client.inbox as ReturnType<typeof vi.fn>).mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Arrived' }), { target: { value: 'all' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByText(/Applies to the conversation list when you apply them/)).toBeNull()
    expect((client.inbox as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBeforeOpen)

    // Reopening starts from the still-unapplied scope, not the discarded draft.
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    expect((screen.getByRole('combobox', { name: 'Arrived' }) as HTMLSelectElement).value).toBe('new')
  })

  it('leaves the applied scope untouched on Escape', async () => {
    const client = makeClient()
    renderReplies(client)
    await screen.findByText('Alice Example')
    const callsBeforeOpen = (client.inbox as ReturnType<typeof vi.fn>).mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Arrived' }), { target: { value: 'all' } })
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Arrived' }), { key: 'Escape' })

    await waitFor(() => expect(screen.queryByText(/Applies to the conversation list when you apply them/)).toBeNull())
    expect((client.inbox as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBeforeOpen)
  })

  it('exposes the search box as a labelled searchbox', async () => {
    const client = makeClient()
    renderReplies(client)
    await screen.findByText('Alice Example')
    const search = screen.getByRole('searchbox', { name: 'Search conversations' })
    expect(search.tagName).toBe('INPUT')
    fireEvent.change(search, { target: { value: 'acme' } })
    expect((search as HTMLInputElement).value).toBe('acme')
  })

  it('marks the selected queue row with aria-current, and guards a switch away from a dirty review', async () => {
    const client = makeClient()
    renderReplies(client)
    const aliceRow = await screen.findByRole('button', { name: /Alice Example/ })
    const bobRow = screen.getByRole('button', { name: /Bob Example/ })
    expect(aliceRow.getAttribute('aria-current')).toBeNull()

    fireEvent.click(aliceRow)
    await waitFor(() => expect(aliceRow.getAttribute('aria-current')).toBe('true'))
    expect(bobRow.getAttribute('aria-current')).toBeNull()

    // Dirty the review by picking a sentiment — no save yet.
    await screen.findByRole('radio', { name: 'Negative' })
    fireEvent.click(screen.getByRole('radio', { name: 'Negative' }))

    // Selecting another conversation while dirty must be intercepted by the guard.
    fireEvent.click(bobRow)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(bobRow.getAttribute('aria-current')).toBeNull()
    // The dialog's own dismiss control shares its accessible name ("Keep
    // editing") with the explicit footer button, so pick the one with that
    // visible text rather than the icon-only close control.
    const keepEditing = screen.getAllByRole('button', { name: 'Keep editing' }).find((button) => button.textContent === 'Keep editing')!

    fireEvent.click(keepEditing)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The selection AND the unsaved draft both survive "Keep editing".
    expect(aliceRow.getAttribute('aria-current')).toBe('true')
    expect((screen.getByRole('radio', { name: 'Negative' }) as HTMLInputElement).checked).toBe(true)
  })
})
