// Shared import dispatcher. Vercel Hobby caps this project at 12 top-level
// functions, so conversation history and Airtable CSV imports share one
// route while retaining separate validation and authorization rules.
//
// S21 added the first machine operation to this file, and S23 adds the
// authenticated config/photo/release operations. They are dispatched at the top
// of `handle` — before the body is read and before `guardAdmin` runs — so the
// human actions below are untouched, in the same order, behind the same guard,
// with the same error text. The subjects never share a code path; they share a
// serverless slot, which is the whole reason this file has more than one subject.
import { handleCompanyImport } from './_lib/companyImport.js'
import { handleContactImport } from './_lib/contactImport.js'
import { handleConversationImport } from './_lib/conversationImport.js'
import { AuthorizationError, authorizationResponse, guardAdmin } from './_lib/auth.js'
import {
  AGENT_INGEST_OP,
  createAgentIngestHandler,
} from './_lib/agent/ingest.js'
import {
  AGENT_CONFIG_OP,
  AGENT_PHOTO_UPLOAD_OP,
  AGENT_RELEASE_OP,
  createAgentConfigHandler,
  createAgentPhotoUploadHandler,
  createAgentReleaseHandler,
  type MachineApiDeps,
} from './_lib/agent/machineOps.js'
import { readDeploymentTenantId } from './_lib/agent/tenant.js'
import { getMachineDataStore } from './_lib/data/machineStore.js'
import { machineStoreConfigured } from './_lib/data/neonConfig.js'
import { deploymentWritePath } from './_lib/data/writePath.js'
import { neonWriter } from './_lib/neonWrites.js'

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
let machineDeps: MachineApiDeps | null = null
let agentIngest: ((request: Request) => Promise<Response>) | null = null
let agentConfig: ((request: Request) => Promise<Response>) | null = null
let agentPhotoUpload: ((request: Request) => Promise<Response>) | null = null
let agentRelease: ((request: Request) => Promise<Response>) | null = null

function getMachineDeps(): MachineApiDeps {
  if (!machineDeps) {
    machineDeps = {
      store: machineStoreConfigured() ? getMachineDataStore() : null,
      tenantId: readDeploymentTenantId(),
    }
  }
  return machineDeps
}

function agentIngestHandler(): (request: Request) => Promise<Response> {
  if (!agentIngest) agentIngest = createAgentIngestHandler(getMachineDeps())
  return agentIngest
}

function agentConfigHandler(): (request: Request) => Promise<Response> {
  if (!agentConfig) agentConfig = createAgentConfigHandler(getMachineDeps())
  return agentConfig
}

function agentPhotoUploadHandler(): (request: Request) => Promise<Response> {
  if (!agentPhotoUpload) {
    agentPhotoUpload = createAgentPhotoUploadHandler(getMachineDeps())
  }
  return agentPhotoUpload
}

function agentReleaseHandler(): (request: Request) => Promise<Response> {
  if (!agentRelease) agentRelease = createAgentReleaseHandler(getMachineDeps())
  return agentRelease
}

async function handle(req: Request): Promise<Response> {
  const op = (new URL(req.url).searchParams.get('op') ?? '').trim()
  if (op === AGENT_INGEST_OP) return agentIngestHandler()(req)
  if (op === AGENT_CONFIG_OP) return agentConfigHandler()(req)
  if (op === AGENT_PHOTO_UPLOAD_OP) return agentPhotoUploadHandler()(req)
  if (op === AGENT_RELEASE_OP) return agentReleaseHandler()(req)
  if (op !== '') {
    return json({ error: `operation is not allowlisted: ${op}` }, 400)
  }

  if (deploymentWritePath() === 'neon') {
    try {
      const writer = await neonWriter(req)
      if (writer.actor.role !== 'admin') {
        throw new AuthorizationError(403, 'Admin access required')
      }
    } catch (error) {
      const denial = authorizationResponse(error)
      if (denial) return denial
      console.error(
        'Import authorization failed:',
        error instanceof Error ? error.name : 'UnknownError',
      )
      return json({ error: 'Could not verify team access' }, 500)
    }
  } else {
    const auth = await guardAdmin(req)
    if (auth.response) return auth.response
  }

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
