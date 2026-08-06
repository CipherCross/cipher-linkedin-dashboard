// @vitest-environment jsdom
/**
 * The two remaining page-local read branches small enough to mount: the lead
 * notes panel and the follow-up history walk.
 *
 * These are S13's branches rather than the coaching slice's, and no mutation pass
 * ever pointed at them — which is the argument for covering them now rather than
 * later. Two browser runs opened them (`N-S13-switch.md`, `N-BROWSER-RUN.md`) and
 * neither run is repeatable, so what stands behind them today is `tsc -b`.
 *
 * ## The follow-up history is the interesting one
 *
 * `N-BROWSER-RUN.md` Known limit 5 records that the cursor walk was **not**
 * re-measured: the lead the run happened to open had one page of events, so
 * "Load more" never appeared. The three-page walk is `N-S13-switch.md`'s
 * observation and nothing since. The `hasMore` / `nextCursor` handling here is the
 * repeatable version — and it is the half where the two paths genuinely differ,
 * because the Neon branch takes the server's cursor while the Supabase branch
 * seeks on `(occurred_at, id)` client-side.
 *
 * `ConversationDrawer` — the third page-local branch, `messages.thread` — is
 * deliberately **not** here. It is a thousand lines with a dozen contexts, and a
 * mount that heavy would be its own slice; it is recorded as a known limit.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Lead } from '../src/lib/types'

const fetchNeonLeadNotes = vi.fn()
const fetchNeonFollowUpHistory = vi.fn()
const resolveReadPath = vi.fn()

vi.mock('../src/lib/dashboardReads', () => ({
  fetchNeonLeadNotes: (...a: unknown[]) => fetchNeonLeadNotes(...a),
  fetchNeonFollowUpHistory: (...a: unknown[]) => fetchNeonFollowUpHistory(...a),
  resolveReadPath: () => resolveReadPath(),
}))

vi.mock('../src/lib/supabase', () => ({ supabase: null }))
vi.mock('../src/lib/api', () => ({ authPost: vi.fn(), authFetch: vi.fn() }))
vi.mock('../src/lib/ToastContext', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))
vi.mock('../src/lib/usePipelineActions', () => ({
  usePipelineActions: () => ({
    addNote: vi.fn(),
    deleteNote: vi.fn(),
    actor: 'Tester',
    members: [],
    assignableMembers: [],
    memberWritesBlockedReason: null,
    memberName: () => '',
  }),
}))
/**
 * `followUpsAvailable: true` is load-bearing: `FollowUpPanel` short-circuits to
 * "Apply database migration 046" without it and renders no history at all, which
 * would make every assertion below pass vacuously against the wrong markup.
 */
vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({
    data: { followUpStates: [], followUpsAvailable: true, teamMembers: [] },
    patchFollowUpState: vi.fn(),
    refetch: vi.fn(),
  }),
}))
vi.mock('../src/lib/useFollowUpActions', () => ({
  useFollowUpActions: () => ({
    actor: 'Tester',
    members: [],
    assignableMembers: [],
    memberWritesBlockedReason: null,
    states: new Map(),
    schedule: vi.fn(),
    reschedule: vi.fn(),
    reassign: vi.fn(),
    complete: vi.fn(),
    skip: vi.fn(),
    cancel: vi.fn(),
  }),
}))

const { LeadNotesPanel } = await import('../src/components/LeadNotesPanel')
const { FollowUpPanel } = await import('../src/components/FollowUpPanel')

const LEAD = {
  id: '22222222-2222-4222-8222-222222222222',
  instance_id: 'notebook-1',
  profile_url: 'https://example.test/in/lead',
  full_name: 'A Lead',
} as unknown as Lead

const event = (id: number) => ({
  id,
  instance_id: LEAD.instance_id,
  profile_url: LEAD.profile_url,
  mutation_id: `m-${id}`,
  event_kind: 'scheduled',
  occurred_at: `2026-08-0${(id % 9) + 1}T00:00:00.000Z`,
  actor: 'Tester',
  reason: null,
  previous_due_date: null,
  new_due_date: '2026-08-10',
  previous_owner_id: null,
  new_owner_id: null,
  previous_owner_name: null,
  new_owner_name: null,
})

afterEach(cleanup)

beforeEach(() => {
  fetchNeonLeadNotes.mockReset()
  fetchNeonFollowUpHistory.mockReset()
  resolveReadPath.mockReset()
  resolveReadPath.mockResolvedValue('neon')
})

const expandNotes = async () => {
  const toggle = document.querySelector('.conv-coaching-toggle') as HTMLButtonElement
  await act(async () => {
    toggle.click()
  })
}

describe('LeadNotesPanel on the application-API read path', () => {
  it('fetches on first expand and not before', async () => {
    fetchNeonLeadNotes.mockResolvedValue([])
    render(<LeadNotesPanel lead={LEAD} />)

    // The panel is collapsed and the effect is guarded by `open`, so a mount that
    // fetched would put a request behind every drawer open for a panel nobody
    // looked at.
    //
    // Flushed first, and that flush *is* part of the assertion: the effect awaits
    // `resolveReadPath()` before it reads, so a synchronous check here passes even
    // when the guard is gone. The mutation pass caught this test being vacuous
    // before it caught anything about the code — replacing the guard with
    // `if (notes !== null) return` reddened nothing until this await was added.
    await act(async () => {})
    expect(fetchNeonLeadNotes).not.toHaveBeenCalled()

    await expandNotes()
    await waitFor(() => expect(fetchNeonLeadNotes).toHaveBeenCalledWith(LEAD.id))
    expect(fetchNeonLeadNotes).toHaveBeenCalledTimes(1)
  })

  it('does not refetch on a second expand', async () => {
    fetchNeonLeadNotes.mockResolvedValue([
      { id: 1, lead_id: LEAD.id, author: 'Tester', body: 'A note', created_at: null },
    ])
    render(<LeadNotesPanel lead={LEAD} />)

    await expandNotes()
    await waitFor(() => expect(screen.getByText('A note')).toBeDefined())
    await expandNotes() // collapse
    await expandNotes() // expand again
    // `notes !== null` is the guard. Without it every toggle costs a request.
    expect(fetchNeonLeadNotes).toHaveBeenCalledTimes(1)
  })

  it('shows the failure instead of an empty note list', async () => {
    // "No notes yet." and "the read failed" are different facts, and the second
    // one is the one an SDR would otherwise act on by re-typing a note.
    fetchNeonLeadNotes.mockRejectedValue(new Error('leads.notes: Could not load dashboard data'))
    render(<LeadNotesPanel lead={LEAD} />)

    await expandNotes()
    await waitFor(() =>
      expect(document.querySelector('.conv-coaching-body .banner')?.textContent).toMatch(
        /leads\.notes/,
      ),
    )
    expect(screen.queryByText('No notes yet.')).toBeNull()
  })

  it('falls back to the Supabase branch, which is unconfigured here, and says so', async () => {
    resolveReadPath.mockResolvedValue('supabase')
    render(<LeadNotesPanel lead={LEAD} />)

    await expandNotes()
    await waitFor(() =>
      expect(screen.getByText('Supabase is not configured.')).toBeDefined(),
    )
    expect(fetchNeonLeadNotes).not.toHaveBeenCalled()
  })
})

describe('FollowUpPanel history on the application-API read path', () => {
  const paint = () =>
    render(
      <FollowUpPanel
        lead={LEAD}
        onBack={() => {}}
        onImport={() => {}}
        onCompleted={() => {}}
      />,
    )

  it('loads the first page on mount and offers "Load more" while the server says there is more', async () => {
    fetchNeonFollowUpHistory.mockResolvedValue({
      events: [event(1), event(2)],
      nextCursor: 'cursor-1',
      hasMore: true,
    })

    paint()

    await waitFor(() => expect(fetchNeonFollowUpHistory).toHaveBeenCalledTimes(1))
    // The first call must carry a null cursor: a first page asking to continue
    // from somewhere is how a walk silently skips its head.
    const first = fetchNeonFollowUpHistory.mock.calls[0]
    expect(first[0]).toBe(LEAD.instance_id)
    expect(first[1]).toBe(LEAD.profile_url)
    expect(first[3]).toBeNull()
    await waitFor(() => expect(screen.getByText('Load more')).toBeDefined())
  })

  it('walks with the server’s own cursor and appends rather than replaces', async () => {
    fetchNeonFollowUpHistory
      .mockResolvedValueOnce({ events: [event(1)], nextCursor: 'cursor-1', hasMore: true })
      .mockResolvedValueOnce({ events: [event(2)], nextCursor: null, hasMore: false })

    paint()
    await waitFor(() => expect(screen.getByText('Load more')).toBeDefined())

    await act(async () => {
      screen.getByText('Load more').click()
    })

    await waitFor(() => expect(fetchNeonFollowUpHistory).toHaveBeenCalledTimes(2))
    // The cursor the *server* returned, unmodified. The Supabase branch computes
    // its own seek; this branch must not, and a client that re-derived one would
    // disagree with the server's `(occurred_at, id)` ordering.
    expect(fetchNeonFollowUpHistory.mock.calls[1][3]).toBe('cursor-1')
    // Appended: two events on screen, not one replaced by one.
    await waitFor(() =>
      expect(document.querySelectorAll('.follow-event').length).toBeGreaterThan(1),
    )
    // And the button is gone, because the server said the walk is finished.
    await waitFor(() => expect(screen.queryByText('Load more')).toBeNull())
  })

  it('hides "Load more" when the cursor is null even if hasMore says otherwise', async () => {
    // Belt and braces in the component (`hasMore && nextCursor !== null`), and
    // worth pinning: a walk that keeps offering a button it cannot act on loops
    // forever on the same page.
    fetchNeonFollowUpHistory.mockResolvedValue({
      events: [event(1)],
      nextCursor: null,
      hasMore: true,
    })

    paint()
    await waitFor(() => expect(fetchNeonFollowUpHistory).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('Load more')).toBeNull())
  })

  it('reports a failed history read', async () => {
    fetchNeonFollowUpHistory.mockRejectedValue(
      new Error('conversations.followUpHistory: Could not load dashboard data'),
    )

    paint()

    await waitFor(() =>
      expect(document.body.textContent).toMatch(/conversations\.followUpHistory/),
    )
  })
})
