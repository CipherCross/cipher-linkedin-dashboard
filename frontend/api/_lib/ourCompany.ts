// "Our company" — what we sell, to whom, and our proof points — sent to every
// coach as <our_company>. Edited on the Playbook page through these modes of
// POST /api/coach (the deployment is at its function limit). Fetch reads our
// website for the team to edit down; it never saves on its own.
import type { ActorContext, DataStore } from './data/contracts.js'
import {
  COACH_CONTEXT_COMMANDS,
  COACH_CONTEXT_OPERATIONS,
  type OurCompanyRow,
} from './data/operations/index.js'
import { SiteFetchError, fetchSiteText } from './siteText.js'

export const OUR_COMPANY_MODES = ['ourCompany.get', 'ourCompany.save', 'ourCompany.fetch'] as const
export type OurCompanyMode = (typeof OUR_COMPANY_MODES)[number]

export function isOurCompanyMode(mode: unknown): mode is OurCompanyMode {
  return typeof mode === 'string' && (OUR_COMPANY_MODES as readonly string[]).includes(mode)
}

const MAX_TEXT = 12_000
const MAX_URL = 500

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function handleOurCompany(
  mode: OurCompanyMode,
  body: Record<string, unknown>,
  store: DataStore,
  actor: ActorContext,
  fetcher: typeof fetchSiteText = fetchSiteText,
): Promise<Response> {
  switch (mode) {
    case 'ourCompany.get': {
      const page = await store.query<OurCompanyRow>(actor, {
        operation: COACH_CONTEXT_OPERATIONS.ourCompany, page: { limit: 1 },
      })
      return json(page.items[0] ?? { our_company: '', our_website: null, updated_at: null })
    }
    case 'ourCompany.save': {
      // Same rule as the playbook it sits beside: admins edit, everyone reads.
      if (actor.kind !== 'user' || actor.role !== 'admin') {
        return json({ error: 'Admin access required to change what we tell the coach about us' }, 403)
      }
      const text = typeof body.our_company === 'string' ? body.our_company.trim() : ''
      if (text.length > MAX_TEXT) return json({ error: `Keep it under ${MAX_TEXT} characters` }, 400)
      const website = typeof body.our_website === 'string' && body.our_website.trim() ? body.our_website.trim() : null
      if (website && website.length > MAX_URL) return json({ error: 'The website URL is too long' }, 400)
      const saved = await store.transaction(actor, (tx) => tx.execute<OurCompanyRow | null>({
        operation: COACH_CONTEXT_COMMANDS.saveOurCompany,
        params: { ourCompany: text, ourWebsite: website },
      }))
      return json(saved ?? { our_company: text, our_website: website, updated_at: null })
    }
    case 'ourCompany.fetch': {
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      if (!url || url.length > MAX_URL) return json({ error: 'A website URL is required' }, 400)
      try {
        const page = await fetcher(url)
        return json({ url: page.url, title: page.title, text: page.text, thin: page.thin })
      } catch (error) {
        return json({ error: error instanceof SiteFetchError ? error.message : 'The website could not be read' }, 422)
      }
    }
  }
}
