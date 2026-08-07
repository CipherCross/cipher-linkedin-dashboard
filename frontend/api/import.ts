// Shared import dispatcher. Vercel Hobby caps this project at 12 top-level
// functions, so conversation history and Airtable CSV imports share one
// route while retaining separate validation and authorization rules.
//
// S21 adds a second authentication model to this file: `?op=agent.ingest` is the
// notebooks' machine-authenticated batch endpoint, and it is dispatched at the
// top of `handle` — before the body is read and before `guardAdmin` runs — so
// the human actions below are untouched, in the same order, behind the same
// guard, with the same error text. The two never share a code path; they share
// a serverless slot, which is the whole reason this file has more than one
// subject (see `_lib/agent/ingest.ts` on why there is no free slot for a
// twelfth function and why this file is the right host).
import { handleCompanyImport } from './_lib/companyImport.js'
import { handleContactImport } from './_lib/contactImport.js'
import { handleConversationImport } from './_lib/conversationImport.js'
import { guardAdmin } from './_lib/auth.js'
import {
  AGENT_INGEST_OP,
  createAgentIngestHandler,
} from './_lib/agent/ingest.js'
import { readDeploymentTenantId } from './_lib/agent/tenant.js'
import { getMachineDataStore } from './_lib/data/machineStore.js'
import { machineStoreConfigured } from './_lib/data/neonConfig.js'

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

/**
 * Built once per function instance, and lazily: resolving the machine store
 * needs a credential, and importing this module must not.
 *
 * A deployment with no `NEON_MACHINE_DATABASE_URL` — which is every deployment
 * today — resolves `store: null`, and the handler answers 503 rather than
 * throwing on import and taking the human import actions down with it.
 */
let agentIngest: ((request: Request) => Promise<Response>) | null = null

function agentIngestHandler(): (request: Request) => Promise<Response> {
  if (!agentIngest) {
    agentIngest = createAgentIngestHandler({
      store: machineStoreConfigured() ? getMachineDataStore() : null,
      tenantId: readDeploymentTenantId(),
    })
  }
  return agentIngest
}

async function handle(req: Request): Promise<Response> {
  const op = (new URL(req.url).searchParams.get('op') ?? '').trim()
  if (op === AGENT_INGEST_OP) return agentIngestHandler()(req)
  if (op !== '') {
    return json({ error: `operation is not allowlisted: ${op}` }, 400)
  }

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
