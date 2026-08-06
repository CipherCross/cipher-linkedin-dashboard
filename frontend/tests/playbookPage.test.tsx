// @vitest-environment jsdom
/**
 * The Playbook page's read branch, and the editor lock that hangs off it.
 *
 * `N-BROWSER-RUN.md` mutation 11 deleted the `setLoadError` call from this page's
 * Neon branch and **reddened nothing**. That call is what disables the textarea
 * and the Save button, and the reason it exists is stated in `Playbook.tsx`
 * itself: while it is null an admin can type into a box and Save, so a failed
 * load rendered as an empty document invites saving a fragment over the real
 * playbook. Losing it is silent, and it was — until this file.
 *
 * ## What is real and what is replaced
 *
 * The component is real, including its `loaded`/`loadError`/`dirty` state machine
 * and the `disabled` expressions the lock is made of. Replaced: `dashboardReads`
 * (so the three outcomes can be produced on demand), `AuthContext` (admin, since
 * a non-admin is locked for a different reason and would mask this one), the
 * Supabase client, the toast, and `react-markdown` — the preview pane's renderer
 * is not what this file is about and it is ESM-heavy.
 *
 * ## The three outcomes, kept apart
 *
 * `fetchNeonPlaybook` answers a document, `null`, or throws, and the page must
 * render those as three different things. Collapsing the middle one into either
 * neighbour is how the lock gets defeated: an unwritten singleton that locked the
 * editor would make the playbook unwritable forever, and a failure that rendered
 * as empty is the case above.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchNeonPlaybook = vi.fn()
const resolveReadPath = vi.fn()
const maybeSingle = vi.fn()
const authPost = vi.fn()

vi.mock('../src/lib/dashboardReads', () => ({
  fetchNeonPlaybook: (...a: unknown[]) => fetchNeonPlaybook(...a),
  resolveReadPath: () => resolveReadPath(),
}))

vi.mock('../src/lib/api', () => ({
  authPost: (...a: unknown[]) => authPost(...a),
  authFetch: vi.fn(),
}))

vi.mock('../src/lib/ToastContext', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))

vi.mock('../src/lib/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true }),
}))

/** The Supabase branch's client, shaped only as far as `load()` uses it. */
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ maybeSingle: () => maybeSingle() }) }),
  },
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => children ?? null,
}))
vi.mock('remark-gfm', () => ({ default: () => undefined }))

const { Playbook } = await import('../src/pages/Playbook')

const editor = () => screen.getByRole('textbox') as HTMLTextAreaElement
const saveButton = () =>
  screen
    .getAllByRole('button')
    .find((b) => /^(Save changes|Saved|Saving…)$/.test(b.textContent ?? '')) as HTMLButtonElement

/**
 * Explicit, because Vitest here runs without `globals: true` — so RTL's automatic
 * cleanup, which registers itself on a global `afterEach`, never installs. Without
 * this every render accumulates in the same document and `getByRole` fails with
 * "multiple elements found", which reads as a component bug and is not one.
 */
afterEach(cleanup)

beforeEach(() => {
  fetchNeonPlaybook.mockReset()
  resolveReadPath.mockReset()
  maybeSingle.mockReset()
  authPost.mockReset()
})

describe('Playbook on the application-API read path', () => {
  beforeEach(() => {
    resolveReadPath.mockResolvedValue('neon')
  })

  it('renders the document and its "last saved" stamp, with the editor unlocked', async () => {
    fetchNeonPlaybook.mockResolvedValue({
      content: '# Real playbook\n\nDo not overwrite me.',
      updated_at: '2026-08-05T09:30:00.000Z',
    })

    render(<Playbook />)

    await waitFor(() => expect(editor()).toBeDefined())
    expect(editor().value).toBe('# Real playbook\n\nDo not overwrite me.')
    expect(editor().disabled).toBe(false)
    // `updated_at` is the column the coaching slice widened the projection by. A
    // projection that dropped it passes every offline test *except* this one.
    expect(document.body.textContent).toMatch(/last saved/)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('locks the editor and the Save button when the read fails — mutation 11', async () => {
    fetchNeonPlaybook.mockRejectedValue(
      new Error('coach.playbook: Could not load dashboard data'),
    )

    render(<Playbook />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())
    expect(screen.getByRole('alert').textContent).toMatch(/Couldn't load playbook/)
    // The two assertions the lock is made of.
    expect(editor().disabled).toBe(true)
    expect(saveButton().disabled).toBe(true)
    // And nothing was written to the editor, so there is no fragment to save even
    // if the lock were bypassed.
    expect(editor().value).toBe('')
  })

  it('renders an unwritten singleton as an empty *unlocked* editor', async () => {
    // `null` means nobody has written a playbook — `public.playbook` ships with no
    // seeded row. Locking here would make the document unwritable forever, which
    // is the opposite failure to the one above and just as silent.
    fetchNeonPlaybook.mockResolvedValue(null)

    render(<Playbook />)

    await waitFor(() => expect(editor()).toBeDefined())
    expect(editor().value).toBe('')
    expect(editor().disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    // No stamp: there is nothing saved to have a date.
    expect(document.body.textContent).not.toMatch(/last saved/)
  })

  it('reads through the application API and never touches Supabase', async () => {
    fetchNeonPlaybook.mockResolvedValue({ content: 'x', updated_at: null })

    render(<Playbook />)

    await waitFor(() => expect(fetchNeonPlaybook).toHaveBeenCalledTimes(1))
    expect(maybeSingle).not.toHaveBeenCalled()
  })
})

describe('Playbook on the Supabase read path', () => {
  beforeEach(() => {
    resolveReadPath.mockResolvedValue('supabase')
  })

  it('takes the Supabase branch and leaves the application API alone', async () => {
    maybeSingle.mockResolvedValue({
      data: { content: 'from postgrest', updated_at: '2026-08-04T00:00:00.000Z' },
      error: null,
    })

    render(<Playbook />)

    await waitFor(() => expect(editor().value).toBe('from postgrest'))
    expect(fetchNeonPlaybook).not.toHaveBeenCalled()
    expect(editor().disabled).toBe(false)
  })

  it('locks the editor on a PostgREST error too — the branches agree on this', async () => {
    // The Neon branch was added beside this one, and the lock is the property the
    // two paths must not disagree about. Pinning both is what makes a future
    // divergence a red test rather than a code review.
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'permission denied' } })

    render(<Playbook />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())
    expect(editor().disabled).toBe(true)
    expect(saveButton().disabled).toBe(true)
  })
})
