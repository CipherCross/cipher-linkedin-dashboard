// @vitest-environment jsdom
/**
 * `#/companies`: the three tabs and their four load states, the Airtable sync
 * button's round loop, and manual linking. The reads are faked at the
 * `lib/companies` boundary; the sync and link writes are faked at `authPost`,
 * so the page drives the real loop in `runAirtableSync`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CompaniesPage, CompanyRow, CountriesFunnel, UnlinkedPage } from '../src/lib/companies'

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }))
vi.mock('../src/lib/ToastContext', () => ({ useToast: () => toast }))
vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({
    data: {
      instances: [{ id: 'notebook-1', label: 'Notebook 1', account_name: 'Alyona' }],
      campaigns: [{ campaign_id: 'notebook-1:4', instance_id: 'notebook-1', campaign_name: 'Fintech founders' }],
    },
  }),
}))
const authPost = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/api', () => ({ authFetch: vi.fn(), authPost }))

const reads = vi.hoisted(() => ({
  companies: vi.fn(),
  countries: vi.fn(),
  unlinked: vi.fn(),
}))
vi.mock('../src/lib/companies', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/companies')>('../src/lib/companies')
  return {
    ...actual,
    fetchCompaniesPage: reads.companies,
    fetchCountriesFunnel: reads.countries,
    fetchUnlinkedLeads: reads.unlinked,
  }
})

const { Companies } = await import('../src/pages/Companies')

const company = (over: Partial<CompanyRow> = {}): CompanyRow => ({
  base_key: 'web2mob', record_id: 'recAAAAAAAAAAAAAA', name: 'Acme Health', website: 'https://acme.test',
  domain: 'acme.test', linkedin_url: null, hq_country: 'Portugal', country_code: 'PT', country_name: 'Portugal',
  industry: 'Healthcare', employees: 120, ai_niche: 'Diagnostics', approve_status: 'Approve',
  leads: 4, invited: 4, connected: 2, accepted_of_invited: 2, first_message: 2, replied: 1, p3: 1,
  last_activity: '2026-11-01T10:00:00Z', accounts: 1, accept_rate: 0.5,
  ...over,
})

const page = (items: CompanyRow[], over: Partial<CompaniesPage> = {}): CompaniesPage => ({
  items, total: items.length, allTotal: items.length,
  facets: {
    countries: [{ value: 'PT', label: 'Portugal', count: 1 }, { value: 'unknown', label: 'Unknown', count: 2 }],
    industries: [{ value: 'Healthcare', label: 'Healthcare', count: 1 }],
    bases: [{ value: 'web2mob', label: 'web2mob', count: 1 }],
    approveStatuses: [{ value: 'Approve', label: 'Approve', count: 1 }],
  },
  ...over,
})

function Search() {
  return <output aria-label="search">{useLocation().pathname}{useLocation().search}</output>
}
const location = () => screen.getByLabelText('search').textContent ?? ''

async function paint(entry = '/companies') {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/companies" element={<Companies />} />
        <Route path="/companies/:base/:recordId" element={<p>Company detail</p>} />
      </Routes>
      <Search />
    </MemoryRouter>,
  )
  await act(async () => {})
}

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body })

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  reads.companies.mockResolvedValue(page([company()]))
  reads.countries.mockResolvedValue({
    axis: 'lead',
    rows: [
      { iso2: 'PT', name: 'Portugal', region: 'Europe', people: 10, invited: 8, accepted: 4, replied: 2, p3: 1, companies: 3, maturing: 6, accept_rate: 0.5, reply_rate: 0.25, p3_rate: 0.125, maturing_share: 0.75, maturing_flag: true },
      { iso2: null, name: 'Unknown', region: null, people: 2, invited: 2, accepted: 1, replied: 0, p3: 0, companies: 0, maturing: 0, accept_rate: 0.5, reply_rate: 0, p3_rate: 0, maturing_share: 0, maturing_flag: false },
    ],
    unresolved: [{ value: 'Somewhere Remote', people: 2, companies: 0 }],
    totals: { people: 12, invited: 10, accepted: 5, replied: 2, p3: 1, maturing: 6 },
    unlinked_people: 0,
  } satisfies CountriesFunnel)
  reads.unlinked.mockResolvedValue({
    items: [{
      instance_id: 'notebook-1', profile_url: 'https://www.linkedin.com/in/ada', full_name: 'Ada Lovelace',
      headline: 'CTO', company: 'Engines', country_code: 'GB', location: 'London', invited: true, replied: true,
      last_action_at: '2026-11-01T10:00:00Z', campaigns: ['Fintech founders'],
    }],
    total: 1, allTotal: 1,
  } satisfies UnlinkedPage)
})

describe('the Companies tab', () => {
  it('lists linked companies with their funnel and opens one from its row', async () => {
    await paint()
    expect(screen.getByRole('heading', { level: 1, name: 'Companies' })).toBeTruthy()
    expect(reads.companies).toHaveBeenCalledWith(expect.objectContaining({ sort: 'leads', dir: 'desc', page: 0 }))
    const table = screen.getByRole('table', { name: 'Companies' })
    const link = within(table).getByRole('link', { name: 'Acme Health' })
    expect(link.getAttribute('href')).toBe('/companies/web2mob/recAAAAAAAAAAAAAA')
    const row = link.closest('tr')!
    expect(within(row).getByText('50%')).toBeTruthy()
    expect(within(row).getByText('Portugal')).toBeTruthy()
    fireEvent.click(within(row).getByText('Diagnostics'))
    expect(location()).toBe('/companies/web2mob/recAAAAAAAAAAAAAA')
  })

  it('says there is nothing linked yet when the dataset is empty', async () => {
    reads.companies.mockResolvedValue(page([], { allTotal: 0 }))
    await paint()
    expect(screen.getByText('No companies linked yet')).toBeTruthy()
    expect(screen.queryByText('No companies match these filters')).toBeNull()
  })

  it('tells no-match apart from empty, and clears the filters', async () => {
    reads.companies.mockResolvedValue(page([], { allTotal: 5 }))
    await paint('/companies?q=zzz&country=PT')
    expect(reads.companies).toHaveBeenCalledWith(expect.objectContaining({ q: 'zzz', country: 'PT' }))
    expect(screen.getByText('No companies match these filters')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(location()).toBe('/companies')
  })

  it('shows a failed read as a retryable error', async () => {
    reads.companies.mockRejectedValueOnce(new Error('companies.searchPage: boom'))
    await paint()
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Companies could not load.')).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await act(async () => {})
    expect(reads.companies).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('commits the sheet filters together on Apply', async () => {
    await paint('/companies?page=2')
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    const sheet = screen.getByRole('dialog', { name: 'Filters' })
    fireEvent.change(within(sheet).getByLabelText('Size'), { target: { value: '51-200' } })
    fireEvent.change(within(sheet).getByLabelText('Replies'), { target: { value: 'yes' } })
    expect(location()).toBe('/companies?page=2')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Apply' }))
    const params = new URLSearchParams(location().split('?')[1])
    expect(params.get('size')).toBe('51-200')
    expect(params.get('reply')).toBe('yes')
    expect(params.has('page')).toBe(false)
  })

  it('sorts from a header button', async () => {
    await paint()
    fireEvent.click(screen.getByRole('button', { name: /Accept %/ }))
    const params = new URLSearchParams(location().split('?')[1])
    expect(params.get('sort')).toBe('accept_rate')
    expect(params.get('dir')).toBe('desc')
  })
})

describe('Sync from Airtable', () => {
  it('repeats the sync while it is not done, then reports and reloads', async () => {
    authPost
      .mockResolvedValueOnce(json({ done: false, bases: [{ base: 'web2mob', companies: { upserted: 100, done: false }, contacts: { upserted: 50, done: false } }], links: { leads: 0, matched: 0, changed: 0 } }))
      .mockResolvedValueOnce(json({ done: true, bases: [{ base: 'web2mob', companies: { upserted: 5, done: true }, contacts: { upserted: 7, done: true } }], links: { leads: 200, matched: 174, changed: 12 } }))
    await paint()
    fireEvent.click(screen.getByRole('button', { name: 'Sync from Airtable' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(authPost).toHaveBeenCalledTimes(2)
    expect(authPost).toHaveBeenCalledWith('/api/import?op=airtable.sync', {})
    expect(toast.success.mock.calls[0][0]).toContain('105 companies and 57 contacts updated')
    expect(toast.success.mock.calls[0][0]).toContain('174 of 200 leads linked')
    expect(reads.companies).toHaveBeenCalledTimes(2)
  })

  it('reports a failed sync as an error and still reloads', async () => {
    authPost.mockResolvedValueOnce(json({ error: 'Airtable is not configured' }, 503))
    await paint()
    fireEvent.click(screen.getByRole('button', { name: 'Sync from Airtable' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.error.mock.calls[0][0]).toContain('Airtable is not configured')
  })
})

describe('the Countries tab', () => {
  it('shows each country with invite-cohort rates, a maturing flag and the Unknown row', async () => {
    await paint('/companies?tab=countries')
    expect(reads.countries).toHaveBeenCalledWith(expect.objectContaining({ axis: 'lead' }))
    const table = screen.getByRole('table', { name: 'Funnel by country' })
    const portugal = within(table).getByRole('link', { name: 'Portugal' })
    expect(portugal.getAttribute('href')).toBe('/leads?country=PT')
    const row = portugal.closest('tr')!
    expect(within(row).getByText('25%')).toBeTruthy()
    expect(within(row).getByText('Maturing')).toBeTruthy()
    expect(within(table).getByRole('link', { name: 'Unknown' }).getAttribute('href')).toBe('/leads?country=unknown')
    expect(screen.getByText('Somewhere Remote')).toBeTruthy()
  })

  it('switches to the company HQ axis and says how many people it cannot place', async () => {
    reads.countries.mockImplementation(async ({ axis }: { axis: string }) => ({
      axis, rows: [], unresolved: [], totals: { people: 0, invited: 0, accepted: 0, replied: 0, p3: 0, maturing: 0 },
      unlinked_people: 7,
    }))
    await paint('/companies?tab=countries')
    fireEvent.click(screen.getByRole('radio', { name: 'Company HQ' }))
    await act(async () => {})
    expect(reads.countries).toHaveBeenLastCalledWith(expect.objectContaining({ axis: 'company' }))
    expect(screen.getByText(/7 people are not linked to a company/)).toBeTruthy()
    expect(screen.getByText('No linked companies in this scope')).toBeTruthy()
  })
})

describe('the Unlinked leads tab', () => {
  it('links a lead to a company found by search', async () => {
    reads.companies.mockResolvedValue(page([company({ name: 'Engines Ltd', record_id: 'recBBBBBBBBBBBBBB' })]))
    authPost.mockResolvedValueOnce(json({ ok: true, link: { base_key: 'web2mob', record_id: 'recBBBBBBBBBBBBBB', method: 'manual' } }))
    await paint('/companies?tab=unlinked')
    const table = screen.getByRole('table', { name: 'Unlinked leads' })
    expect(within(table).getByText('Engines')).toBeTruthy()
    fireEvent.click(within(table).getByRole('button', { name: 'Link to company' }))
    const dialog = screen.getByRole('dialog', { name: 'Link Ada Lovelace to a company' })
    // The LinkedIn company pre-fills the search.
    expect((within(dialog).getByLabelText('Search companies') as HTMLInputElement).value).toBe('Engines')
    await waitFor(() => expect(reads.companies).toHaveBeenCalledWith(expect.objectContaining({ scope: 'all', q: 'Engines' })))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Link to Engines Ltd' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Ada Lovelace linked to Engines Ltd.'))
    expect(authPost).toHaveBeenCalledWith('/api/import?op=company.link', {
      instance_id: 'notebook-1', profile_url: 'https://www.linkedin.com/in/ada',
      base_key: 'web2mob', record_id: 'recBBBBBBBBBBBBBB',
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(reads.unlinked).toHaveBeenCalledTimes(2)
  })

  it('says every lead is linked when nothing is left', async () => {
    reads.unlinked.mockResolvedValue({ items: [], total: 0, allTotal: 0 })
    await paint('/companies?tab=unlinked')
    expect(screen.getByText('Every lead is linked to a company')).toBeTruthy()
  })

  it('switching tabs keeps only the account', async () => {
    await paint('/companies?q=acme&inst=notebook-1&country=PT')
    fireEvent.click(screen.getByRole('tab', { name: 'Unlinked leads' }))
    expect(location()).toBe('/companies?tab=unlinked&inst=notebook-1')
  })
})
