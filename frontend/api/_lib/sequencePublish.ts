import { authorizationResponse } from './auth.js'
import { unavailableResponse } from './data/availability.js'
import {
  SEQUENCE_OPERATIONS,
  SEQUENCE_PUBLISH_COMMANDS,
  SEQUENCE_PUBLISH_OPERATIONS,
  type SequenceDocumentRow,
  type SequencePublishJobRow,
  type SequencePublishTargetRow,
  type SequenceVersionRow,
} from './data/operations/index.js'
import {
  DataStoreConstraintError,
  DataStoreSchemaError,
  type DataStoreTransaction,
} from './data/contracts.js'
import { neonWriter } from './neonWrites.js'
import {
  compileSequenceCampaigns,
  canonicalJson,
  sequencePublishPayloadDigest,
  sha256Hex,
  SequencePublishValidationError,
  type SequencePublishOptions,
  type VerifiedAccountSnapshot,
} from '../../src/lib/sequencePublish.js'
import type { SequenceDocument } from '../../src/lib/sequenceBuilder.js'

export const SEQUENCE_PUBLISH_ACTIONS = new Set([
  'list_sequence_publish_targets',
  'list_sequence_publish_jobs',
  'create_sequence_publish_job',
])

export function isSequencePublishAction(value: unknown): value is string {
  return typeof value === 'string' && SEQUENCE_PUBLISH_ACTIONS.has(value)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
})
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

function accountSnapshot(target: SequencePublishTargetRow): VerifiedAccountSnapshot | null {
  const value = target.account_snapshot
  const text = (key: string) => typeof value[key] === 'string' && String(value[key]).trim() ? String(value[key]).trim() : null
  const accountId = text('accountId')
  const accountName = text('accountName')
  const senderName = text('senderName')
  const workspaceId = text('workspaceId')
  const lhVersion = text('lhVersion')
  const compatibilityProfile = text('compatibilityProfile')
  if (!accountId || !accountName || !senderName || !workspaceId || !lhVersion || !compatibilityProfile) return null
  return {
    instanceId: target.instance_id,
    machineKey: target.machine_key,
    accountId, accountName, senderName, workspaceId, lhVersion, compatibilityProfile,
  }
}

function publishOptions(value: unknown): SequencePublishOptions | null {
  const raw = record(value)
  if (!raw || !Array.isArray(raw.branchIds) || raw.branchIds.some((id) => typeof id !== 'string')) return null
  if (typeof raw.visit !== 'boolean' || typeof raw.follow !== 'boolean' || !Array.isArray(raw.interMessageDelayHours)) return null
  if (raw.interMessageDelayHours.some((hours) => typeof hours !== 'number')) return null
  const optional = (key: string) => raw[key] === undefined || typeof raw[key] === 'number'
  if (!optional('preInviteDelayHours') || !optional('inviteToFirstMessageDelayHours')) return null
  return {
    branchIds: raw.branchIds as string[],
    visit: raw.visit,
    follow: raw.follow,
    ...(raw.preInviteDelayHours === undefined ? {} : { preInviteDelayHours: Number(raw.preInviteDelayHours) }),
    ...(raw.inviteToFirstMessageDelayHours === undefined ? {} : { inviteToFirstMessageDelayHours: Number(raw.inviteToFirstMessageDelayHours) }),
    interMessageDelayHours: raw.interMessageDelayHours as number[],
  }
}

async function one<T>(transaction: DataStoreTransaction, operation: string, params?: Record<string, string>): Promise<T | null> {
  const page = await transaction.query<T>({ operation, params, page: { limit: 2 } })
  return page.items.length === 1 ? page.items[0] : null
}

function failure(error: unknown): Response {
  const denial = authorizationResponse(error)
  if (denial) return denial
  const unavailable = unavailableResponse(error)
  if (unavailable) return unavailable
  if (error instanceof DataStoreSchemaError) return json({ error: 'Sequence publishing migration is not available.', code: 'LEDGER_STEP_PENDING' }, 503)
  if (error instanceof DataStoreConstraintError) return json({ error: 'The publish request conflicts with existing data.' }, 409)
  console.error('Sequence publishing failed:', error instanceof Error ? error.name : 'UnknownError')
  return json({ error: 'Sequence publishing could not be completed.' }, 500)
}

export async function handleSequencePublishAction(request: Request, payload: Record<string, unknown>): Promise<Response> {
  const action = payload.action
  if (!isSequencePublishAction(action)) return json({ error: 'unknown action' }, 400)
  try {
    const writer = await neonWriter(request)
    if (writer.actor.role !== 'admin') return json({ error: 'Admin access required' }, 403)

    if (action === 'list_sequence_publish_targets') {
      const page = await writer.store.query<SequencePublishTargetRow>(writer.actor, {
        operation: SEQUENCE_PUBLISH_OPERATIONS.targets,
        page: { limit: 100 },
      })
      return json({ ok: true, targets: page.items })
    }
    if (!UUID.test(String(payload.sequence_id ?? ''))) return json({ error: 'sequence_id must be a UUID' }, 400)
    const sequenceId = String(payload.sequence_id)
    if (action === 'list_sequence_publish_jobs') {
      const page = await writer.store.query<SequencePublishJobRow>(writer.actor, {
        operation: SEQUENCE_PUBLISH_OPERATIONS.jobs,
        params: { sequenceId },
        page: { limit: 100 },
      })
      return json({ ok: true, jobs: page.items })
    }

    const targetInstanceId = typeof payload.target_instance_id === 'string' ? payload.target_instance_id.trim() : ''
    const idempotencyKey = typeof payload.idempotency_key === 'string' ? payload.idempotency_key.trim() : ''
    const options = publishOptions(payload.options)
    if (!targetInstanceId || targetInstanceId.length > 160) return json({ error: 'target_instance_id is required' }, 400)
    if (!idempotencyKey || idempotencyKey.length > 160) return json({ error: 'idempotency_key is required' }, 400)
    if (!options) return json({ error: 'publish options are invalid' }, 400)

    const result = await writer.store.transaction(writer.actor, async (transaction) => {
      const targetPage = await transaction.query<SequencePublishTargetRow>({
        operation: SEQUENCE_PUBLISH_OPERATIONS.targets,
        page: { limit: 100 },
      })
      const target = targetPage.items.find((item) => item.instance_id === targetInstanceId)
      if (!target || !target.compatible) return { response: json({ error: 'The selected machine has not passed publishing compatibility preflight.', code: 'TARGET_NOT_COMPATIBLE' }, 409) }
      const account = accountSnapshot(target)
      if (!account) return { response: json({ error: 'The selected machine account snapshot is incomplete.', code: 'TARGET_SNAPSHOT_INVALID' }, 409) }
      const sequence = await one<SequenceDocumentRow>(transaction, SEQUENCE_OPERATIONS.detail, { sequenceId })
      if (!sequence) return { response: json({ error: 'Sequence not found' }, 404) }
      if (sequence.archived) return { response: json({ error: 'Archived sequences cannot be published' }, 409) }
      const versions = await transaction.query<SequenceVersionRow>({
        operation: SEQUENCE_OPERATIONS.versions,
        params: { sequenceId },
        page: { limit: 1000 },
      })
      const version = versions.items.find((item) => item.revision === sequence.revision)
      if (!version) return { response: json({ error: 'The current immutable sequence version is missing.', code: 'VERSION_SNAPSHOT_MISSING' }, 409) }
      let campaigns
      try {
        campaigns = compileSequenceCampaigns(sequence.name, sequence.document as unknown as SequenceDocument, options, account)
      } catch (error) {
        if (error instanceof SequencePublishValidationError) return { response: json({ error: error.message, issues: error.issues }, 400) }
        throw error
      }
      const documentJson = canonicalJson(sequence.document)
      const documentFingerprint = sha256Hex(documentJson)
      const immutablePayload = {
        sequenceId, revision: sequence.revision, versionId: version.id, sequenceName: sequence.name,
        documentFingerprint, compilerVersion: campaigns[0]?.compilerVersion,
        options, targetInstanceId, targetMachineKey: target.machine_key,
        account, campaigns,
      }
      const payloadDigest = sequencePublishPayloadDigest(immutablePayload)
      const replay = await one<SequencePublishJobRow>(transaction, SEQUENCE_PUBLISH_OPERATIONS.jobByKey, { instanceId: targetInstanceId, idempotencyKey })
      if (replay) {
        return replay.payload_digest === payloadDigest
          ? { job: replay, replay: true }
          : { response: json({ error: 'This idempotency key was already used for a different publish payload.', code: 'IDEMPOTENCY_CONFLICT' }, 409) }
      }
      const job = await transaction.execute<SequencePublishJobRow>({
        operation: SEQUENCE_PUBLISH_COMMANDS.createJob,
        params: {
          sequenceId, revision: sequence.revision, versionId: version.id, sequenceName: sequence.name,
          documentJson, documentFingerprint, compilerVersion: campaigns[0]?.compilerVersion ?? '',
          optionsJson: JSON.stringify(options), targetInstanceId, targetMachineKey: target.machine_key,
          accountJson: JSON.stringify(account), idempotencyKey, payloadDigest,
        },
      })
      await transaction.execute<number>({
        operation: SEQUENCE_PUBLISH_COMMANDS.createBranches,
        params: {
          jobId: job.id,
          rows: JSON.stringify(campaigns.map((campaign) => ({
            branch_id: campaign.branchId, branch_ordinal: campaign.branchOrdinal,
            branch_letter: campaign.branchLetter, campaign_name: campaign.campaignName,
            compiled_action_chain: campaign.actions, action_fingerprint: campaign.actionFingerprint,
          }))),
        },
      })
      return { job: { ...job, branches: campaigns }, replay: false }
    })
    if ('response' in result && result.response) return result.response
    return json({ ok: true, job: result.job, replay: result.replay }, result.replay ? 200 : 201)
  } catch (error) {
    return failure(error)
  }
}
