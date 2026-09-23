// @vitest-environment jsdom
/**
 * ICPs is Phase 4's card-viewer-editor route: `LibraryCard`'s stretched-title
 * open button (no more nested `role="button"` div), a read-only viewer
 * `Dialog`, and an editor `Dialog` behind the shared dirty guard. These pin the
 * behaviour the redesign must keep — same data, same admin calls, same accessible
 * names on the icon-only row actions.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hypothesis, Icp as IcpRow, IcpIndustry, IcpPersona } from '../src/lib/types'

const api = vi.hoisted(() => ({ authPost: vi.fn() }))
const data = vi.hoisted(() => ({
  icps: [] as IcpRow[],
  icpPersonas: [] as IcpPersona[],
  icpIndustries: [] as IcpIndustry[],
  hypotheses: [] as Hypothesis[],
  upsertIcp: vi.fn(),
  removeIcp: vi.fn(),
  upsertIcpPersona: vi.fn(),
  removeIcpPersona: vi.fn(),
  upsertIcpIndustry: vi.fn(),
  removeIcpIndustry: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('../src/lib/api', () => api)
vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({
    data: {
      icps: data.icps, icpPersonas: data.icpPersonas, icpIndustries: data.icpIndustries, hypotheses: data.hypotheses,
    },
    upsertIcp: data.upsertIcp,
    removeIcp: data.removeIcp,
    upsertIcpPersona: data.upsertIcpPersona,
    removeIcpPersona: data.removeIcpPersona,
    upsertIcpIndustry: data.upsertIcpIndustry,
    removeIcpIndustry: data.removeIcpIndustry,
  }),
}))
vi.mock('../src/lib/ToastContext', () => ({ useToast: () => toast }))

import { Icp } from '../src/pages/Icp'

const icp = (over: Partial<IcpRow>): IcpRow => ({
  id: 1, name: 'Web 2 Mob', airtable_url: null, main_product: 'Mobile app', core_sphere: 'SaaS',
  secondary_sphere: null, product_stage: null, monetization: null, features_note: null,
  purchase_triggers: [], features: [], company_countries: [], company_headcount: null, company_age: null,
  apollo_industries: [], funding: null, dev_team_availability: null, dev_team_location: null,
  exclude_keywords: [], archived: false, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  ...over,
} as IcpRow)

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  data.icps = [icp({}), icp({ id: 2, name: 'Old ICP', archived: true, main_product: null, core_sphere: null })]
  data.icpPersonas = [{
    id: 10, icp_id: 1, kind: 'Management', job_titles: ['VP Sales'], age_range: null, location: null,
    background: null, profile_status: null, connections_note: null, followers_note: null, sort: 0,
    created_at: '', updated_at: '',
  }]
  data.icpIndustries = [{
    id: 20, icp_id: 1, name: 'Fintech', include_keywords: ['payments'], created_at: '', updated_at: '',
  }]
  data.hypotheses = [{ id: 30, name: 'H1', icp_id: 1, description: null, archived: false, created_at: '', updated_at: '' }]
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } })
})

describe('the ICP list', () => {
  it('shows an active ICP with its counts and hides the archived one until asked', () => {
    render(<Icp />)
    const card = screen.getByText('Web 2 Mob').closest('article')!
    expect(card.textContent).toMatch(/1 persona · 1 industry · 1 hypothesis/)
    expect(screen.queryByText('Old ICP')).toBeNull()

    fireEvent.click(screen.getByLabelText(/Show archived/))
    expect(screen.getByText('Old ICP')).toBeTruthy()
    expect(screen.getByText('Archived')).toBeTruthy()
  })

  it('says "empty" when there are no ICPs and "no match" when the filter excludes all of them', () => {
    const { unmount } = render(<Icp />)
    // Only the archived ICP exists so far and "Show archived" starts off.
    data.icps = [icp({ id: 2, name: 'Old ICP', archived: true })]
    unmount()
    render(<Icp />)
    expect(screen.getByText('No ICPs match this filter').closest('[data-empty-kind]')?.getAttribute('data-empty-kind'))
      .toBe('no-match')

    data.icps = []
    cleanup()
    render(<Icp />)
    expect(screen.getByText('No ICPs yet').closest('[data-empty-kind]')?.getAttribute('data-empty-kind')).toBe('empty')
  })

  it('opens the read-only viewer from a real button, so a real browser reaches it by keyboard too', () => {
    render(<Icp />)
    const openControl = screen.getByRole('button', { name: 'Open ICP Web 2 Mob' })
    // Nested interactives were the defect this card replaced: the open action
    // must be a native <button>, which is what makes Enter/Space work without
    // any hand-rolled key handler (jsdom does not simulate that native default
    // action, so this asserts the element rather than the keypress).
    expect(openControl.tagName).toBe('BUTTON')

    fireEvent.click(openControl)
    const viewer = screen.getByRole('dialog', { name: 'Web 2 Mob' })
    expect(within(viewer).getByText(/1 persona · 1 industry · 1 hypothesis/)).toBeTruthy()
  })

  it('archives through the save endpoint and restores the same way', async () => {
    api.authPost.mockResolvedValue(ok({ icp: icp({ archived: true }) }))
    render(<Icp />)
    const card = screen.getByText('Web 2 Mob').closest('article')!
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Archive' })) })
    expect(api.authPost).toHaveBeenCalledWith('/api/playbook', { action: 'save_icp', icp: { id: 1, archived: true } })
    expect(data.upsertIcp).toHaveBeenCalled()
  })

  it('keeps the existing confirmation before deleting', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<Icp />)
    const card = screen.getByText('Web 2 Mob').closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: 'Delete' }))
    expect(confirm).toHaveBeenCalled()
    expect(api.authPost).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
})

describe('the ICP viewer', () => {
  it('copies every field as text and opens the editor on Edit ICP', () => {
    render(<Icp />)
    fireEvent.click(screen.getByRole('button', { name: 'Open ICP Web 2 Mob' }))
    const viewer = screen.getByRole('dialog', { name: 'Web 2 Mob' })

    fireEvent.click(within(viewer).getByRole('button', { name: 'Copy all fields' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Web 2 Mob'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Persona — Management'))

    fireEvent.click(within(viewer).getByRole('button', { name: 'Edit ICP' }))
    expect(screen.queryByRole('dialog', { name: 'Web 2 Mob' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Edit ICP' })).toBeTruthy()
  })
})

describe('the ICP editor', () => {
  it('closes a clean editor at once and asks before discarding an edited one', () => {
    render(<Icp />)
    fireEvent.click(screen.getByRole('button', { name: 'New ICP' }))
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'New ICP' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'New ICP' }))
    const editor = screen.getByRole('dialog', { name: 'New ICP' })
    fireEvent.change(within(editor).getByLabelText(/^Name/), { target: { value: 'Fintech EU' } })
    fireEvent.keyDown(editor, { key: 'Escape' })
    const prompt = screen.getByRole('dialog', { name: 'Discard unsaved changes?' })
    fireEvent.click(within(prompt).getAllByRole('button', { name: 'Keep editing' }).at(-1)!)
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Fintech EU')
  })

  it('keeps the draft and shows the error when a save is refused', async () => {
    api.authPost.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Save exploded' }) })
    render(<Icp />)
    fireEvent.click(screen.getByRole('button', { name: 'New ICP' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Fintech EU' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create ICP' })) })
    expect(screen.getByRole('alert').textContent).toContain('Save exploded')
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Fintech EU')
    expect(data.upsertIcp).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'New ICP' })).toBeTruthy()
  })

  it('adds a persona through the fieldset and saves it after the ICP', async () => {
    api.authPost.mockImplementation(async (_url: string, body: Record<string, unknown>) => {
      if (body.action === 'save_icp') return ok({ icp: icp({ id: 9, name: 'Fintech EU' }) })
      if (body.action === 'save_icp_persona') {
        return ok({ persona: { id: 99, icp_id: 9, ...(body.persona as object) } })
      }
      return ok({})
    })
    render(<Icp />)
    fireEvent.click(screen.getByRole('button', { name: 'New ICP' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Fintech EU' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add persona' }))
    fireEvent.change(screen.getByLabelText('Persona 1 name'), { target: { value: 'Technical' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create ICP' })) })

    const personaCall = api.authPost.mock.calls.find((c) => c[1].action === 'save_icp_persona')
    expect(personaCall?.[1].persona).toMatchObject({ icp_id: 9, kind: 'Technical' })
    expect(data.upsertIcp).toHaveBeenCalled()
    expect(data.upsertIcpPersona).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
