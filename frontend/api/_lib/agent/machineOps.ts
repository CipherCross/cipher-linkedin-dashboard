/**
 * The S23 machine API operations that sit beside the batch ingest route.
 *
 * They deliberately share one bearer credential and one authentication helper:
 * config, photos, notify and release are four capabilities, but they are all
 * capabilities of the same notebook. The database re-derives revocation and
 * expiry for every statement; this layer only binds the request to the
 * authenticated instance and chooses the provider operation.
 */

import {
  DataStoreContractError,
  type DataStore,
} from '../data/contracts.js'
import {
  MACHINE_COMMANDS,
  MACHINE_OPERATIONS,
  type InstanceConfigRow,
} from '../data/operations/agentIngest.js'
import {
  MACHINE_PUBLISH_COMMANDS,
  type SequencePublishJobRow,
} from '../data/operations/sequencePublishing.js'
import { authenticateMachine, machineUnauthorized } from './machineAuth.js'
import { leadPhotoObjectKey, sniffImageContentType } from '../storage/leadPhotoObjects.js'
import { getObjectStorageProvider } from '../storage/runtime.js'
import type { ObjectStorageProvider } from '../storage/provider.js'
import { sha256Base64 } from '../storage/manifest.js'
import {
  AgentReleaseError,
  AgentReleaseStore,
  AgentReleaseConfigurationError,
} from '../storage/releaseArtifacts.js'

export const AGENT_CONFIG_OP = 'agent.config'
export const AGENT_PHOTO_UPLOAD_OP = 'agent.photoUpload'
export const AGENT_RELEASE_OP = 'agent.release'
export const AGENT_PUBLISH_PROBE_OP = 'agent.publishProbe'
export const AGENT_PUBLISH_CLAIM_OP = 'agent.publishClaim'
export const AGENT_PUBLISH_HEARTBEAT_OP = 'agent.publishHeartbeat'
export const AGENT_PUBLISH_STATE_OP = 'agent.publishState'
export const AGENT_PUBLISH_BRANCH_OP = 'agent.publishBranch'
export const AGENT_PUBLISH_FINISH_OP = 'agent.publishFinish'

export const PHOTO_UPLOAD_MAX_BYTES = 5 * 1024 * 1024

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export interface MachineApiDeps {
  readonly store: DataStore | null
  readonly tenantId: string | null
  readonly objectStorage?: (tenantId: string) => ObjectStorageProvider
  readonly releaseStore?: AgentReleaseStore
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch { return null }
}

function boundedString(body: Record<string, unknown>, key: string, max = 160): string | null {
  const value = body[key]
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null
}

function boundedObject(body: Record<string, unknown>, key: string): string | null {
  const value = body[key]
  return value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : null
}

function publishError(error: unknown): string {
  return error instanceof DataStoreContractError ? error.code : error instanceof Error ? error.name : 'unknown'
}

export function createAgentPublishHandler(
  deps: MachineApiDeps,
  operation: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method.toUpperCase() !== 'POST') return methodNotAllowed(request.method)
    const authenticated = await auth(request, deps, operation)
    if (authenticated.response) return authenticated.response
    const { principal } = authenticated
    const body = await jsonBody(request)
    if (!body) return json({ error: 'JSON body must be an object' }, 400)
    try {
      if (operation === AGENT_PUBLISH_PROBE_OP) {
        const machineKey = boundedString(body, 'machine_key')
        const accountJson = boundedObject(body, 'account_snapshot')
        const capabilityJson = boundedObject(body, 'capability_snapshot')
        if (!machineKey || !accountJson || !capabilityJson || typeof body.compatible !== 'boolean') return json({ error: 'machine_key, account_snapshot, capability_snapshot and compatible are required' }, 400)
        const count = await principal.store.transaction(principal.actor, (transaction) => transaction.execute<number>({
          operation: MACHINE_PUBLISH_COMMANDS.reportTarget,
          params: {
            instanceId: principal.instanceId, machineKey, accountJson, capabilityJson,
            compatible: body.compatible as boolean, errorCode: boundedString(body, 'error_code', 120) ?? '', credentialId: principal.credentialId,
          },
        }))
        return json({ ok: count === 1, instance_id: principal.instanceId, compatible: body.compatible })
      }
      if (operation === AGENT_PUBLISH_CLAIM_OP) {
        const job = await principal.store.transaction(principal.actor, (transaction) => transaction.execute<SequencePublishJobRow | null>({
          operation: MACHINE_PUBLISH_COMMANDS.claim,
          params: { credentialId: principal.credentialId, leaseSeconds: 120 },
        }))
        return json({ ok: true, job })
      }
      const jobId = boundedString(body, 'job_id', 80)
      const generation = Number(body.claim_generation)
      if (!jobId || !Number.isInteger(generation) || generation < 1) return json({ error: 'job_id and claim_generation are required' }, 400)
      if (operation === AGENT_PUBLISH_HEARTBEAT_OP) {
        const count = await principal.store.transaction(principal.actor, (transaction) => transaction.execute<number>({ operation: MACHINE_PUBLISH_COMMANDS.heartbeat, params: { jobId, generation, leaseSeconds: 120 } }))
        return count === 1 ? json({ ok: true }) : json({ error: 'stale or expired publish claim' }, 409)
      }
      if (operation === AGENT_PUBLISH_STATE_OP) {
        const status = boundedString(body, 'status', 40)
        if (!status || !['preflight', 'publishing', 'failed'].includes(status)) return json({ error: 'invalid publish state' }, 400)
        const count = await principal.store.transaction(principal.actor, (transaction) => transaction.execute<number>({ operation: MACHINE_PUBLISH_COMMANDS.setState, params: { jobId, generation, status, leaseSeconds: 120, errorCode: boundedString(body, 'error_code', 120) ?? '', errorJson: boundedObject(body, 'error_details') ?? '' } }))
        return count === 1 ? json({ ok: true }) : json({ error: 'stale or expired publish claim' }, 409)
      }
      if (operation === AGENT_PUBLISH_BRANCH_OP) {
        const branchId = boundedString(body, 'branch_id', 100)
        const status = boundedString(body, 'status', 40)
        if (!branchId || !status || !['publishing', 'created', 'conflict', 'failed'].includes(status)) return json({ error: 'branch_id and valid status are required' }, 400)
        const count = await principal.store.transaction(principal.actor, (transaction) => transaction.execute<number>({ operation: MACHINE_PUBLISH_COMMANDS.branchResult, params: { jobId, branchId, generation, status, campaignId: boundedString(body, 'lh_campaign_id', 160) ?? '', verificationJson: boundedObject(body, 'verification_summary') ?? '', errorCode: boundedString(body, 'error_code', 120) ?? '', errorJson: boundedObject(body, 'error_details') ?? '' } }))
        return count === 1 ? json({ ok: true }) : json({ error: 'stale or expired publish claim' }, 409)
      }
      if (operation === AGENT_PUBLISH_FINISH_OP) {
        const count = await principal.store.transaction(principal.actor, (transaction) => transaction.execute<number>({ operation: MACHINE_PUBLISH_COMMANDS.finish, params: { jobId, generation } }))
        return count === 1 ? json({ ok: true }) : json({ error: 'publish job is not ready to finish' }, 409)
      }
      return json({ error: 'unknown publish operation' }, 400)
    } catch (error) {
      console.error(`machine ${operation} failed`, publishError(error))
      return json({ error: 'the publish operation failed' }, 502)
    }
  }
}

function methodNotAllowed(method: string): Response {
  return json({ error: `${method} is not allowed` }, 405)
}

function safeErrorLabel(error: unknown): string {
  if (error instanceof DataStoreContractError) return error.code
  if (error instanceof Error) return error.name
  return 'unknown'
}

async function auth(
  request: Request,
  deps: MachineApiDeps,
  realm: string,
) {
  try {
    return await authenticateMachine(request, deps, realm)
  } catch (error) {
    console.error(`machine ${realm} authentication failed`, safeErrorLabel(error))
    return { response: json({ error: 'machine authentication failed' }, 500) }
  }
}

/** GET this notebook's remote configuration, without accepting an instance id. */
export function createAgentConfigHandler(
  deps: MachineApiDeps,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method.toUpperCase() !== 'GET') {
      return methodNotAllowed(request.method)
    }
    const authenticated = await auth(request, deps, 'agent-config')
    if (authenticated.response) return authenticated.response
    const { principal } = authenticated

    try {
      const page = await principal.store.query<InstanceConfigRow>(
        principal.actor,
        {
          operation: MACHINE_OPERATIONS.instanceConfig,
          page: { limit: 2 },
        },
      )
      // A revoked/expired credential can resolve at the first statement and
      // then see zero rows at this one. Do not turn that into an empty config:
      // the notebook needs to stop treating a denied identity as valid.
      if (page.items.length !== 1 || page.items[0].id !== principal.instanceId) {
        return machineUnauthorized('agent-config')
      }
      const row = page.items[0]
      return json({
        instance_id: row.id,
        config: row.config,
        config_updated_at: row.config_updated_at,
      })
    } catch (error) {
      console.error('agent config read failed', safeErrorLabel(error))
      return json({ error: 'the remote config could not be read' }, 500)
    }
  }
}

function requiredHeader(
  request: Request,
  name: string,
  maxLength: number,
): string | null {
  const value = request.headers.get(name)?.trim() ?? ''
  if (!value || value.length > maxLength) return null
  return value
}

/**
 * Upload one avatar or mark one lead as checked with no avatar.
 *
 * The request carries a source `photo_path` (`instance/slug.jpg`), not a raw
 * object key. The API checks its first segment against the credential's own
 * instance and derives the tenant-prefixed destination key itself. A handler
 * bug that forgets the instance check is therefore still caught by the key
 * derivation and the provider's tenant binding; the two checks are intentional.
 */
export function createAgentPhotoUploadHandler(
  deps: MachineApiDeps,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method.toUpperCase() !== 'POST') {
      return methodNotAllowed(request.method)
    }
    const authenticated = await auth(request, deps, 'agent-photo-upload')
    if (authenticated.response) return authenticated.response
    const { principal } = authenticated

    const campaignId = requiredHeader(request, 'x-agent-campaign-id', 200)
    const profileUrl = requiredHeader(request, 'x-agent-profile-url', 500)
    const photoPath = requiredHeader(request, 'x-agent-photo-path', 500)
    if (!campaignId || !profileUrl || !photoPath) {
      return json(
        { error: 'x-agent-campaign-id, x-agent-profile-url and x-agent-photo-path are required' },
        400,
      )
    }

    const sourceInstance = photoPath.split('/')[0]
    if (sourceInstance !== principal.instanceId) {
      return json(
        { error: 'the credential is not issued for this photo instance' },
        403,
      )
    }

    const declaredLength = Number(request.headers.get('content-length') ?? 0)
    if (Number.isFinite(declaredLength) && declaredLength > PHOTO_UPLOAD_MAX_BYTES) {
      return json({ error: 'photo body is too large' }, 413)
    }

    const absent = request.headers.get('x-agent-photo-absent') === '1'
    if (absent) {
      if (declaredLength > 0) {
        return json({ error: 'an absent photo must have an empty body' }, 400)
      }
      try {
        const updated = await principal.store.transaction(
          principal.actor,
          (transaction) =>
            transaction.execute<number>({
              operation: MACHINE_COMMANDS.stampLeadPhotoCheck,
              params: { instanceId: principal.instanceId, campaignId, profileUrl },
            }),
        )
        if (updated !== 1) return json({ error: 'lead was not found' }, 404)
        return json({ ok: true, photo_path: null, photo_synced: true })
      } catch (error) {
        console.error('agent photo check failed', safeErrorLabel(error))
        return json({ error: 'the photo check could not be recorded' }, 500)
      }
    }

    let body: Uint8Array
    try {
      body = new Uint8Array(await request.arrayBuffer())
    } catch {
      return json({ error: 'photo body could not be read' }, 400)
    }
    if (body.length === 0) return json({ error: 'photo body is required' }, 400)
    if (body.length > PHOTO_UPLOAD_MAX_BYTES) {
      return json({ error: 'photo body is too large' }, 413)
    }

    let key: string
    try {
      key = leadPhotoObjectKey({ tenantId: principal.tenantId, photoPath })
    } catch {
      return json({ error: 'photo_path is not a valid lead photo path' }, 400)
    }
    const contentType = sniffImageContentType(body)
    if (!contentType) {
      return json({ error: 'photo body is not a supported image' }, 415)
    }

    try {
      const provider = (deps.objectStorage ?? getObjectStorageProvider)(
        principal.tenantId,
      )
      if (provider.tenantId !== principal.tenantId) {
        return json({ error: 'object storage tenant mismatch' }, 503)
      }
      const stat = await provider.putObject({
        key,
        body,
        contentType,
        checksumSha256: sha256Base64(body),
      })
      const updated = await principal.store.transaction(
        principal.actor,
        (transaction) =>
          transaction.execute<number>({
            operation: MACHINE_COMMANDS.upsertLeadPhoto,
            params: { instanceId: principal.instanceId, campaignId, profileUrl, photoPath },
          }),
      )
      if (updated !== 1) {
        return json({ error: 'lead was not found after photo upload' }, 404)
      }
      return json({
        ok: true,
        photo_path: photoPath,
        object_key: key,
        size_bytes: stat.sizeBytes,
        sha256: stat.checksumSha256,
      })
    } catch (error) {
      console.error('agent photo upload failed', safeErrorLabel(error))
      return json({ error: 'the photo upload could not be completed' }, 502)
    }
  }
}

/** Issue a short-lived release URL only after machine authentication. */
export function createAgentReleaseHandler(
  deps: MachineApiDeps,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method.toUpperCase() !== 'GET') {
      return methodNotAllowed(request.method)
    }
    const authenticated = await auth(request, deps, 'agent-release')
    if (authenticated.response) return authenticated.response

    try {
      const release = deps.releaseStore ?? new AgentReleaseStore()
      const version = await release.currentVersion()
      const manifest = await release.manifest(version)
      const download = release.downloadUrl(version)
      return json({
        version,
        manifest: {
          version: manifest.version,
          sha256: manifest.sha256,
          size_bytes: manifest.sizeBytes,
          released_at: manifest.releasedAt,
          signature: manifest.signature,
        },
        download_url: download.url,
        download_expires_at: download.expiresAt,
      })
    } catch (error) {
      if (error instanceof AgentReleaseConfigurationError) {
        return json({ error: 'the release path is not configured' }, 503)
      }
      if (error instanceof AgentReleaseError) {
        return json({ error: 'the current release is unavailable' }, 502)
      }
      console.error('agent release lookup failed', safeErrorLabel(error))
      return json({ error: 'the release lookup failed' }, 502)
    }
  }
}
