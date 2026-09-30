// @vitest-environment jsdom
/**
 * The review workflow on the collapsible-list workspace.
 *
 * At 900–1119px the list is a rail and opens over the thread; the review pane
 * stays on screen. These tests drive that band (a stubbed ResizeObserver and a
 * 1000px container — the width of a 1280 screen with the sidebar open) and pin
 * the parts of the workflow the layout must not break: a dirty review survives
 * a row pick from the overlay, Save and next lands on the next pending reply,
 * and a refused save keeps the thread and everything typed.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Replies } from '../src/pages/Replies'
import { authPost } from '../src/lib/api'
import { DEFAULT_REPLY_SCOPE, type ReplyReadClient } from '../src/lib/replyReview'

vi.mock('../src/lib/api', () => ({ authFetch: vi.fn(), authPost: vi.fn() }))
const post = vi.mocked(authPost)

const alice = { instance_id: 'one', profile_url: 'https://linkedin.com/in/alice' }
const bob = { instance_id: 'one', profile_url: 'https://linkedin.com/in/bob' }
const row = (key: typeof alice, name: string, id: number, sent: string) => ({
  ...key, name, company: null, headline: null,
  latest_snippet: `reply ${id}`, latest_direction: 'in', latest_sent_at: sent,
  selected_message_id: id, pending_count: 1, owner_id: null, action: null, next_follow_up_date: null,
  do_not_contact: false, review_revision: 0, workflow_revision: 0, revision: 0, inbound_revision: 1,
  acknowledged_inbound_revision: 0,
})
const aliceItem = row(alice, 'Alice Example', 1, '2026-09-11T10:00:00.000Z')
const bobItem = row(bob, 'Bob Example', 2, '2026-09-10T10:00:00.000Z')
const messageFor = (key: typeof alice, id: number) => ({ ...key, id, campaign_id: null, direction: 'in', body: `reply ${id}`, sent_at: '2026-09-10T10:00:00.000Z', review: null })

function makeClient(): ReplyReadClient {
  return {
    capabilities: vi.fn().mockResolvedValue({
      available: true, active: true, manual_ready: true, mode: 'manual',
      members: [{ id: 1, name: 'Ann', active: true }], instances: [{ id: 'one', label: 'Notebook one' }], campaigns: [],
    }),
    facets: vi.fn().mockResolvedValue({ facets: {}, scope: DEFAULT_REPLY_SCOPE }),
    inbox: vi.fn().mockResolvedValue({ items: [aliceItem, bobItem], next_cursor: null, scope: DEFAULT_REPLY_SCOPE }),
    thread: vi.fn(async (request: { profile_url: string }) => ({
      messages: [request.profile_url === alice.profile_url ? messageFor(alice, 1) : messageFor(bob, 2)],
      older_cursor: null, newer_cursor: null, workflow: null, inbound_revision: 1,
    })) as unknown as ReplyReadClient['thread'],
    history: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
  }
}

class StubResizeObserver { observe() {} unobserve() {} disconnect() {} }
/** Node's own half-built localStorage shadows jsdom's, so each test gets a real one. */
function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

function workspace(): HTMLElement { return document.querySelector('.replies-workspace') as HTMLElement }
function keepEditingButton() { return screen.getAllByRole('button', { name: 'Keep editing' }).find((button) => button.textContent === 'Keep editing')! }

function renderAt(width: number, client = makeClient()) {
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 700, top: 0, left: 0, right: width, bottom: 700, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
  render(<MemoryRouter initialEntries={['/']}><Replies client={client} /></MemoryRouter>)
  return client
}

function saved(messageId: number) {
  return new Response(JSON.stringify({
    review: { message_id: messageId, sentiment: 'positive', intent_state: 'unreviewed', intent_level: null, reason_ids: [], comment: null, taxonomy_version: 'v1', reviewed_by: 1, reviewed_at: null, revision: 1, provenance: 'human', complete: true },
    workflow: null, inbound_revision: 1, needs_action_confirmation: false, mutation_id: 'server-id',
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('Replies review workflow on the collapsible list', () => {
  beforeEach(() => { post.mockReset(); vi.stubGlobal('localStorage', memoryStorage()) })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('keeps the review pane and turns the list into a rail at laptop width', async () => {
    renderAt(1000)
    await screen.findByText('Alice Example')
    expect(workspace().className).toContain('band-mid')
    expect(workspace().className).toContain('list-rail')
    // The rows keep their accessible names in the rail.
    expect(screen.getByRole('button', { name: /Alice Example/ })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: 'Review reply and next step' })).toBeTruthy()
    expect(document.querySelector('.replies-pane-switch')).toBeNull()
  })

  it('opens the list over the thread and closes it on Escape and after a row pick', async () => {
    renderAt(1000)
    await screen.findByText('Alice Example')
    fireEvent.click(screen.getByRole('button', { name: 'Show the conversation list' }))
    expect(workspace().className).toContain('list-overlay')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(workspace().className).toContain('list-rail'))

    fireEvent.click(screen.getByRole('button', { name: 'Show the conversation list' }))
    fireEvent.click(screen.getByRole('button', { name: /Alice Example/ }))
    await waitFor(() => expect(workspace().className).toContain('list-rail'))
    expect(screen.getByRole('button', { name: /Alice Example/ }).getAttribute('aria-current')).toBe('true')
  })

  it('keeps the draft, the thread and the open list when a row pick meets a dirty review', async () => {
    renderAt(1000)
    await screen.findByText('Alice Example')
    fireEvent.click(screen.getByRole('button', { name: /Alice Example/ }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Negative' }))

    fireEvent.click(screen.getByRole('button', { name: 'Show the conversation list' }))
    // The dialog's buttons are outside the list; pressing one must not close it.
    fireEvent.click(screen.getByRole('button', { name: /Bob Example/ }))
    await screen.findByRole('dialog')
    fireEvent.pointerDown(keepEditingButton())
    fireEvent.click(keepEditingButton())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(workspace().className).toContain('list-overlay')
    expect(screen.getByRole('button', { name: /Alice Example/ }).getAttribute('aria-current')).toBe('true')
    expect((screen.getByRole('radio', { name: 'Negative' }) as HTMLInputElement).checked).toBe(true)

    // Discard goes through, and only then does the list step back.
    fireEvent.click(screen.getByRole('button', { name: /Bob Example/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Bob Example/ }).getAttribute('aria-current')).toBe('true'))
    expect(workspace().className).toContain('list-rail')
  })

  it('moves to the next pending reply after Save and next', async () => {
    post.mockResolvedValue(saved(1))
    renderAt(1000)
    await screen.findByText('Alice Example')
    fireEvent.click(screen.getByRole('button', { name: /Alice Example/ }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Positive' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save and next' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: /Bob Example/ }).getAttribute('aria-current')).toBe('true'))
  })

  it.each([
    ['a conflict', 409, 'This conversation changed'],
    ['a server error', 500, 'Save exploded'],
  ])('keeps the thread and the typed review after %s', async (_label, status, message) => {
    post.mockResolvedValue(new Response(JSON.stringify({ error: status === 409 ? 'This conversation changed meanwhile' : message }), { status, headers: { 'content-type': 'application/json' } }))
    renderAt(1000)
    await screen.findByText('Alice Example')
    fireEvent.click(screen.getByRole('button', { name: /Alice Example/ }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Positive' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save and next' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    await screen.findByText(/Could not save/)
    expect(screen.getByRole('button', { name: /Alice Example/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: /Bob Example/ }).getAttribute('aria-current')).toBeNull()
    expect((screen.getByRole('radio', { name: 'Positive' }) as HTMLInputElement).checked).toBe(true)
  })

  it('lets a wide screen pin the list to the rail and remembers it', async () => {
    renderAt(1300)
    await screen.findByText('Alice Example')
    expect(workspace().className).toContain('list-full')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the conversation list' }))
    expect(workspace().className).toContain('list-rail')
    expect(window.localStorage.getItem('replies.listCollapsed')).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'Expand the conversation list' }))
    expect(workspace().className).toContain('list-full')
  })
})
