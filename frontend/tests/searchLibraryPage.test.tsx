// @vitest-environment jsdom
/**
 * Searches is the Phase 4 reference for list + dirty form: grouped library
 * cards, a platform selector, and an editor Dialog behind the shared dirty
 * guard. These pin the behaviour the redesign must keep.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedSearch } from '../src/lib/types'

const api = vi.hoisted(() => ({ authPost: vi.fn() }))
const data = vi.hoisted(() => ({
  savedSearches: [] as SavedSearch[],
  upsertSavedSearch: vi.fn(),
  removeSavedSearch: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('../src/lib/api', () => api)
vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({
    data: { savedSearches: data.savedSearches },
    upsertSavedSearch: data.upsertSavedSearch,
    removeSavedSearch: data.removeSavedSearch,
  }),
}))
vi.mock('../src/lib/ToastContext', () => ({ useToast: () => toast }))
vi.mock('../src/lib/usePipelineActions', () => ({ usePipelineActions: () => ({ actor: 'Fixture Author' }) }))

import { SearchLibrary } from '../src/pages/SearchLibrary'

const search = (over: Partial<SavedSearch>): SavedSearch => ({
  id: 1, name: 'Fintech VPs', platform: 'Apollo', description: 'US, 200–1000', include_keywords: ['fintech'],
  exclude_keywords: ['intern'], boolean_query: '"VP Sales" NOT intern', filters: { seniority: ['vp', 'head'] },
  notes: null, author: 'Ada', archived: false, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  ...over,
} as SavedSearch)

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  data.savedSearches = [
    search({}),
    search({ id: 2, name: 'Ops leaders', platform: 'Sales Navigator', include_keywords: [], exclude_keywords: [], boolean_query: null }),
    search({ id: 3, name: 'Old list', archived: true }),
  ]
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } })
})

describe('the search library list', () => {
  it('groups cards by platform and hides archived ones until asked', () => {
    render(<SearchLibrary />)
    expect(screen.getByRole('heading', { level: 2, name: /Apollo/ })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /Sales Navigator/ })).toBeTruthy()
    expect(screen.queryByText('Old list')).toBeNull()
    fireEvent.click(screen.getByLabelText(/Show archived/))
    expect(screen.getByText('Old list')).toBeTruthy()
    expect(screen.getByText('Archived')).toBeTruthy()
  })

  it('filters by platform through a single-choice control', () => {
    render(<SearchLibrary />)
    const platform = screen.getByRole('radiogroup', { name: 'Platform' })
    fireEvent.click(within(platform).getByRole('radio', { name: 'Sales Navigator' }))
    expect(within(platform).getByRole('radio', { name: 'Sales Navigator' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText('Fintech VPs')).toBeNull()
    expect(screen.getByText('Ops leaders')).toBeTruthy()
  })

  it('says "no match" when the text search excludes everything, and "empty" when there is nothing', () => {
    const { unmount } = render(<SearchLibrary />)
    fireEvent.change(screen.getByLabelText('Search the library'), { target: { value: 'zzz' } })
    expect(screen.getByText('No searches match these filters').closest('[data-empty-kind]')?.getAttribute('data-empty-kind')).toBe('no-match')
    unmount()
    data.savedSearches = []
    render(<SearchLibrary />)
    expect(screen.getByText('No searches yet').closest('[data-empty-kind]')?.getAttribute('data-empty-kind')).toBe('empty')
  })

  it('copies the boolean query and archives through the save endpoint', async () => {
    api.authPost.mockResolvedValue(ok({ search: search({ archived: true }) }))
    render(<SearchLibrary />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('"VP Sales" NOT intern')
    const card = screen.getByText('Fintech VPs').closest('article')!
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Archive this search' })) })
    expect(api.authPost).toHaveBeenCalledWith('/api/playbook', { action: 'save_search', search: { id: 1, archived: true } })
    expect(data.upsertSavedSearch).toHaveBeenCalled()
  })

  it('keeps the existing confirmation before deleting', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<SearchLibrary />)
    const card = screen.getByText('Fintech VPs').closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: 'Delete this search' }))
    expect(confirm).toHaveBeenCalled()
    expect(api.authPost).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
})

describe('the search editor', () => {
  it('closes a clean editor at once and asks before discarding an edited one', () => {
    render(<SearchLibrary />)
    fireEvent.click(screen.getByRole('button', { name: 'New search' }))
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'New search' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    const card = screen.getByText('Fintech VPs').closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: 'Edit this search' }))
    const editor = screen.getByRole('dialog', { name: 'Edit search' })
    fireEvent.change(within(editor).getByLabelText(/^Name/), { target: { value: 'Fintech VPs (EU)' } })
    fireEvent.keyDown(editor, { key: 'Escape' })
    const prompt = screen.getByRole('dialog', { name: 'Discard unsaved changes?' })
    fireEvent.click(within(prompt).getAllByRole('button', { name: 'Keep editing' }).at(-1)!)
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Fintech VPs (EU)')
  })

  it('adds keywords with Enter through the labelled chip field', () => {
    render(<SearchLibrary />)
    fireEvent.click(screen.getByRole('button', { name: 'New search' }))
    const include = screen.getByLabelText('Include keywords')
    fireEvent.change(include, { target: { value: 'saas' } })
    fireEvent.keyDown(include, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Remove saas' })).toBeTruthy()
  })

  it('keeps the draft and shows the conflict when a save is refused', async () => {
    api.authPost.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) })
    render(<SearchLibrary />)
    fireEvent.click(screen.getByRole('button', { name: 'New search' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Fintech VPs' } })
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText(/^Platform/), { target: { value: 'Apollo' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create search' })) })
    expect(screen.getByRole('alert').textContent).toContain('A search with this name already exists on this platform.')
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Fintech VPs')
    expect(data.upsertSavedSearch).not.toHaveBeenCalled()
  })

  it('coerces a numeric filter value on save and closes on success', async () => {
    api.authPost.mockResolvedValue(ok({ search: search({ id: 9, name: 'New' }) }))
    render(<SearchLibrary />)
    fireEvent.click(screen.getByRole('button', { name: 'New search' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'New' } })
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText(/^Platform/), { target: { value: 'Apollo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fireEvent.change(screen.getByLabelText('Filter 1 key'), { target: { value: 'employees' } })
    fireEvent.change(screen.getByLabelText('Filter 1 value'), { target: { value: '200' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create search' })) })
    const payload = api.authPost.mock.calls[0][1].search
    expect(payload.filters).toEqual({ employees: 200 })
    expect(payload.author).toBe('Fixture Author')
    expect(data.upsertSavedSearch).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
