// Shared import dispatcher. Vercel Hobby caps this project at 12 top-level
// functions, so conversation history and Airtable CSV imports share one
// route while retaining separate validation and authorization rules.
import { handleCompanyImport } from './_lib/companyImport.js'
import { handleContactImport } from './_lib/contactImport.js'
import { handleConversationImport } from './_lib/conversationImport.js'
import { guardAdmin } from './_lib/auth.js'

export const maxDuration = 60

const MAX_REQUEST_BYTES = 4_000_000
const CONTACT_ACTIONS = new Set([
  'contact_metadata',
  'contact_preview',
  'company_search',
  'contact_commit',
])
const COMPANY_ACTIONS = new Set([
  'company_metadata',
  'company_preview',
  'company_commit',
])
const CONVERSATION_ACTIONS = new Set([
  'conversation_import',
  'delete_message',
  'edit_message',
])

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })

async function handle(req: Request): Promise<Response> {
  const auth = await guardAdmin(req)
  if (auth.response) return auth.response

  const contentLength = Number(req.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return json({ error: 'request body is too large' }, 413)
  }

  let payload: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return json({ error: 'JSON body must be an object' }, 400)
    }
    payload = parsed as Record<string, unknown>
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const action = typeof payload.action === 'string' ? payload.action : ''
  if (CONTACT_ACTIONS.has(action)) {
    return handleContactImport(action, payload)
  }

  if (COMPANY_ACTIONS.has(action)) {
    return handleCompanyImport(action, payload)
  }

  if (CONVERSATION_ACTIONS.has(action)) {
    return handleConversationImport(payload, req)
  }

  return json({ error: 'unknown import action' }, 400)
}

export const POST = (req: Request) => handle(req)
