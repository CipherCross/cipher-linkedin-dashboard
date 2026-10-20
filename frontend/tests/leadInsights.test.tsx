// @vitest-environment jsdom
/**
 * What the conversation modal shows about the lead beyond the thread, and the
 * Playbook page's "Our company": admins edit it, a fetched website is a draft
 * that never saves itself.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoachContextView } from '../src/lib/coachContext'

const toast = { error: vi.fn(), success: vi.fn(), info: vi.fn() }
vi.mock('../src/lib/ToastContext', () => ({ useToast: () => toast }))

const { LeadInsights } = await import('../src/components/conversation/LeadInsights')
const { OurCompanyPanel } = await import('../src/components/OurCompanyPanel')

afterEach(cleanup)

const view: CoachContextView = {
  profile: {
    about: 'I build payout infrastructure for marketplaces.', location: 'Madrid, Spain', current_title: 'CTO', current_company: 'Acme',
    positions: [{ title: 'CTO', company: 'Acme', start_year: 2021, end_year: null }, { title: 'Engineer', company: 'Old Co', start_year: 2015, end_year: 2020 }],
    skills: ['Payments', 'Go'], synced_at: '2026-10-12T10:00:00Z',
  },
  company: {
    company_name: 'Acme', website: 'https://www.acme.com/', industry: 'Fintech', employees: '120', founded_year: '2015',
    country: 'Spain', keywords: null, description: 'Payout rails.', fetched_at: '2026-10-12T10:00:00Z',
  },
  company_checked_at: '2026-10-12T10:00:00Z',
  website: { url: 'https://www.acme.com/', title: 'Acme', usable: true, error: null, fetched_at: '2026-10-12T10:00:00Z', excerpt: 'Acme moves money.' },
  our_company_configured: false,
  as_the_coach_sees_it: '<lead_profile>…</lead_profile>',
}

describe('the lead context in the conversation modal', () => {
  it('shows the profile, the company and its website, and what the coach reads on request', async () => {
    const client = { context: vi.fn(async () => view) }
    render(<LeadInsights lead={{ instance_id: 'nb', profile_url: 'https://www.linkedin.com/in/ada', company: 'Acme' }} client={client} />)
    await act(async () => {})
    expect(client.context).toHaveBeenCalledWith({ instance_id: 'nb', profile_url: 'https://www.linkedin.com/in/ada', company: 'Acme' })
    const profile = screen.getByRole('region', { name: 'Profile' })
    expect(within(profile).getByText('CTO at Acme')).toBeTruthy()
    expect(within(profile).getByText('Engineer at Old Co (2015–2020)')).toBeTruthy()
    const company = screen.getByRole('region', { name: 'Company' })
    expect(within(company).getByText('Fintech · 120 employees · Spain · founded 2015')).toBeTruthy()
    expect(within(company).getByRole('link', { name: /acme\.com/ }).getAttribute('href')).toBe('https://www.acme.com/')
    expect(screen.getByText(/add “Our company” on the Playbook page/)).toBeTruthy()
    expect(screen.queryByText('<lead_profile>…</lead_profile>')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'What the coach reads' }))
    expect(screen.getByText('<lead_profile>…</lead_profile>')).toBeTruthy()
  })

  it('says plainly when nothing is known yet', async () => {
    const client = { context: vi.fn(async () => ({ ...view, profile: null, company: null, company_checked_at: '2026-10-12T10:00:00Z', website: null, as_the_coach_sees_it: '' })) }
    render(<LeadInsights lead={{ instance_id: 'nb', profile_url: 'u' }} client={client} />)
    await act(async () => {})
    expect(screen.getByText(/Not synced yet/)).toBeTruthy()
    expect(screen.getByText('Not found in the CRM (Apollo imports).')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'What the coach reads' })).toBeNull()
  })
})

describe('our company on the Playbook page', () => {
  const makeClient = () => ({
    ourCompany: vi.fn(async () => ({ our_company: 'We build QA teams.', our_website: 'https://ciphercross.com', updated_at: '2026-10-01T10:00:00Z' })),
    saveOurCompany: vi.fn(async (text: string, website: string | null) => ({ our_company: text, our_website: website, updated_at: '2026-10-20T10:00:00Z' })),
    fetchWebsite: vi.fn(async () => ({ url: 'https://ciphercross.com/', title: 'CipherCross', text: 'QA for fintech.', thin: false })),
  })

  it('appends fetched website text as a draft and saves only when asked', async () => {
    const client = makeClient()
    render(<OurCompanyPanel isAdmin client={client} />)
    await act(async () => {})
    const text = screen.getByRole('textbox', { name: 'What we sell, to whom, and our proof points' }) as HTMLTextAreaElement
    expect(text.value).toBe('We build QA teams.')
    fireEvent.click(screen.getByRole('button', { name: 'Fetch website text' }))
    await act(async () => {})
    expect(client.fetchWebsite).toHaveBeenCalledWith('https://ciphercross.com')
    expect(text.value).toBe('We build QA teams.\n\n--- From https://ciphercross.com/ ---\nQA for fintech.')
    expect(client.saveOurCompany).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await act(async () => {})
    expect(client.saveOurCompany).toHaveBeenCalledWith(text.value, 'https://ciphercross.com')
  })

  it('is read-only for a member who is not an admin', async () => {
    render(<OurCompanyPanel isAdmin={false} client={makeClient()} />)
    await act(async () => {})
    expect((screen.getByRole('textbox', { name: 'What we sell, to whom, and our proof points' }) as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Fetch website text' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
