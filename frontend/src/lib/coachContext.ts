// Client for the coach's lead context and "our company" (modes of POST /api/coach).
import { authFetch } from './api'

export interface LeadProfileView {
  about: string | null
  location: string | null
  current_title: string | null
  current_company: string | null
  positions: { title?: string | null; company?: string | null; start_year?: number | null; end_year?: number | null; description?: string | null }[]
  skills: string[]
  synced_at: string
}

export interface CompanyView {
  company_name: string | null
  website: string | null
  industry: string | null
  employees: string | null
  founded_year: string | null
  country: string | null
  keywords: string | null
  description: string | null
  fetched_at: string
}

export interface CoachContextView {
  profile: LeadProfileView | null
  company: CompanyView | null
  company_checked_at: string | null
  website: { url: string; title: string | null; usable: boolean; error: string | null; fetched_at: string; excerpt: string | null } | null
  our_company_configured: boolean
  as_the_coach_sees_it: string
}

export interface OurCompany {
  our_company: string
  our_website: string | null
  updated_at: string | null
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await authFetch('/api/coach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed: unknown = null
  try { parsed = await res.json() } catch { /* no body */ }
  if (!res.ok) {
    const error = (parsed as { error?: unknown } | null)?.error
    throw new Error(typeof error === 'string' ? error : `HTTP ${res.status}`)
  }
  return parsed as T
}

export const coachContextClient = {
  context: (lead: { instance_id: string; profile_url: string; company?: string | null }) =>
    call<CoachContextView>({ mode: 'context', ...lead }),
  ourCompany: () => call<OurCompany>({ mode: 'ourCompany.get' }),
  saveOurCompany: (our_company: string, our_website: string | null) =>
    call<OurCompany>({ mode: 'ourCompany.save', our_company, our_website }),
  fetchWebsite: (url: string) =>
    call<{ url: string; title: string | null; text: string; thin: boolean }>({ mode: 'ourCompany.fetch', url }),
}

export type CoachContextClient = typeof coachContextClient
