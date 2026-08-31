import type { NeonCommandOperation, NeonQueryOperation, NeonRow } from '../neon.js'
import { jsonObject, nullableText } from './library.js'

export const SEQUENCE_PUBLISH_OPERATIONS = {
  targets: 'sequencePublish.targets',
  jobs: 'sequencePublish.jobs',
  jobByKey: 'sequencePublish.jobByKey',
} as const

export const SEQUENCE_PUBLISH_COMMANDS = {
  createJob: 'sequencePublish.createJob',
  createBranches: 'sequencePublish.createBranches',
} as const

export const MACHINE_PUBLISH_COMMANDS = {
  reportTarget: 'sequencePublish.reportTarget',
  claim: 'sequencePublish.claim',
  heartbeat: 'sequencePublish.heartbeat',
  setState: 'sequencePublish.setState',
  branchResult: 'sequencePublish.branchResult',
  finish: 'sequencePublish.finish',
} as const

const object = (value: unknown): Record<string, unknown> => jsonObject(value)
const array = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
  : []

export interface SequencePublishTargetRow {
  instance_id: string
  machine_key: string
  account_snapshot: Record<string, unknown>
  capability_snapshot: Record<string, unknown>
  compatible: boolean
  compatibility_error_code: string | null
  probed_at: string
}

const mapTarget = (row: NeonRow): SequencePublishTargetRow => ({
  instance_id: String(row.instance_id),
  machine_key: String(row.machine_key),
  account_snapshot: object(row.account_snapshot),
  capability_snapshot: object(row.capability_snapshot),
  compatible: row.compatible === true,
  compatibility_error_code: nullableText(row.compatibility_error_code),
  probed_at: String(row.probed_at),
})

export const sequencePublishTargetsOperation: NeonQueryOperation<SequencePublishTargetRow> = {
  build: () => ({
    text: `SELECT instance_id, machine_key, account_snapshot, capability_snapshot,
                  compatible, compatibility_error_code, probed_at
             FROM public.sequence_publish_targets
            ORDER BY instance_id`,
  }),
  mapRow: mapTarget,
}

export interface SequencePublishJobRow {
  id: string
  sequence_document_id: string
  sequence_revision: number
  sequence_version_id: number
  sequence_name: string
  document_snapshot: Record<string, unknown>
  document_fingerprint: string
  compiler_version: string
  publish_options: Record<string, unknown>
  target_instance_id: string
  target_machine_key: string
  target_account_snapshot: Record<string, unknown>
  idempotency_key: string
  payload_digest: string
  status: string
  attempt: number
  claim_generation: number
  lease_expires_at: string | null
  queued_at: string
  started_at: string | null
  finished_at: string | null
  error_code: string | null
  error_details: Record<string, unknown> | null
  branches: Record<string, unknown>[]
}

const mapJob = (row: NeonRow): SequencePublishJobRow => ({
  id: String(row.id),
  sequence_document_id: String(row.sequence_document_id),
  sequence_revision: Number(row.sequence_revision),
  sequence_version_id: Number(row.sequence_version_id),
  sequence_name: String(row.sequence_name),
  document_snapshot: object(row.document_snapshot),
  document_fingerprint: String(row.document_fingerprint),
  compiler_version: String(row.compiler_version),
  publish_options: object(row.publish_options),
  target_instance_id: String(row.target_instance_id),
  target_machine_key: String(row.target_machine_key),
  target_account_snapshot: object(row.target_account_snapshot),
  idempotency_key: String(row.idempotency_key),
  payload_digest: String(row.payload_digest),
  status: String(row.status),
  attempt: Number(row.attempt),
  claim_generation: Number(row.claim_generation),
  lease_expires_at: nullableText(row.lease_expires_at),
  queued_at: String(row.queued_at),
  started_at: nullableText(row.started_at),
  finished_at: nullableText(row.finished_at),
  error_code: nullableText(row.error_code),
  error_details: row.error_details ? object(row.error_details) : null,
  branches: array(row.branches),
})

const JOB_COLUMNS = `j.id::text AS id, j.sequence_document_id::text AS sequence_document_id,
  j.sequence_revision, j.sequence_version_id, j.sequence_name, j.document_snapshot,
  j.document_fingerprint, j.compiler_version, j.publish_options, j.target_instance_id,
  j.target_machine_key, j.target_account_snapshot, j.idempotency_key, j.payload_digest,
  j.status, j.attempt, j.claim_generation, j.lease_expires_at, j.queued_at, j.started_at,
  j.finished_at, j.error_code, j.error_details`

const BRANCH_AGG = `COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'branch_id', b.branch_id, 'branch_ordinal', b.branch_ordinal, 'branch_letter', b.branch_letter,
  'campaign_name', b.campaign_name, 'compiled_action_chain', b.compiled_action_chain,
  'action_fingerprint', b.action_fingerprint, 'status', b.status,
  'lh_campaign_id', b.lh_campaign_id, 'verification_summary', b.verification_summary,
  'error_code', b.error_code, 'error_details', b.error_details, 'updated_at', b.updated_at
) ORDER BY b.branch_ordinal) FROM public.sequence_publish_branches b WHERE b.job_id = j.id), '[]'::jsonb) AS branches`

export interface SequenceIdParams { sequenceId: string; [key: string]: string }
export const sequencePublishJobsOperation: NeonQueryOperation<SequencePublishJobRow, SequenceIdParams> = {
  build: ({ params }) => ({
    text: `SELECT ${JOB_COLUMNS}, ${BRANCH_AGG}
             FROM public.sequence_publish_jobs j
            WHERE j.sequence_document_id = $1::uuid
            ORDER BY j.queued_at DESC, j.id DESC`,
    values: [params?.sequenceId ?? ''],
  }),
  mapRow: mapJob,
}

export interface JobKeyParams { instanceId: string; idempotencyKey: string; [key: string]: string }
export const sequencePublishJobByKeyOperation: NeonQueryOperation<SequencePublishJobRow, JobKeyParams> = {
  build: ({ params }) => ({
    text: `SELECT ${JOB_COLUMNS}, ${BRANCH_AGG}
             FROM public.sequence_publish_jobs j
            WHERE j.target_instance_id = $1 AND j.idempotency_key = $2`,
    values: [params?.instanceId ?? '', params?.idempotencyKey ?? ''],
  }),
  mapRow: mapJob,
}

export interface CreatePublishJobParams {
  sequenceId: string; revision: number; versionId: number; sequenceName: string
  documentJson: string; documentFingerprint: string; compilerVersion: string
  optionsJson: string; targetInstanceId: string; targetMachineKey: string
  accountJson: string; idempotencyKey: string; payloadDigest: string
  [key: string]: string | number
}

export const createSequencePublishJobOperation: NeonCommandOperation<SequencePublishJobRow, CreatePublishJobParams> = {
  build: ({ actor, params }) => ({
    text: `WITH inserted AS (
      INSERT INTO public.sequence_publish_jobs
        (sequence_document_id, sequence_revision, sequence_version_id, sequence_name,
         document_snapshot, document_fingerprint, compiler_version, publish_options,
         target_instance_id, target_machine_key, target_account_snapshot,
         idempotency_key, payload_digest, created_by)
      VALUES ($1::uuid, $2::integer, $3::bigint, $4, $5::jsonb, $6, $7, $8::jsonb,
              $9, $10, $11::jsonb, $12, $13, $14::uuid)
      RETURNING *
    ) SELECT ${JOB_COLUMNS}, '[]'::jsonb AS branches FROM inserted j`,
    values: [params?.sequenceId ?? '', Number(params?.revision ?? 0), Number(params?.versionId ?? 0),
      params?.sequenceName ?? '', params?.documentJson ?? '{}', params?.documentFingerprint ?? '',
      params?.compilerVersion ?? '', params?.optionsJson ?? '{}', params?.targetInstanceId ?? '',
      params?.targetMachineKey ?? '', params?.accountJson ?? '{}', params?.idempotencyKey ?? '',
      params?.payloadDigest ?? '', actor.actorId],
  }),
  mapResult: (rows) => mapJob(rows[0]),
}

export interface CreatePublishBranchesParams { jobId: string; rows: string; [key: string]: string }
export const createSequencePublishBranchesOperation: NeonCommandOperation<number, CreatePublishBranchesParams> = {
  build: ({ params }) => ({
    text: `INSERT INTO public.sequence_publish_branches
      (job_id, branch_id, branch_ordinal, branch_letter, campaign_name, compiled_action_chain, action_fingerprint)
      SELECT $1::uuid, r.branch_id, r.branch_ordinal, r.branch_letter, r.campaign_name,
             r.compiled_action_chain, r.action_fingerprint
        FROM jsonb_to_recordset($2::jsonb) AS r(
          branch_id text, branch_ordinal integer, branch_letter text, campaign_name text,
          compiled_action_chain jsonb, action_fingerprint text)`,
    values: [params?.jobId ?? '', params?.rows ?? '[]'],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

export interface ReportPublishTargetParams {
  instanceId: string; machineKey: string; accountJson: string; capabilityJson: string
  compatible: boolean; errorCode: string; credentialId: string
  [key: string]: string | boolean
}
export const reportSequencePublishTargetOperation: NeonCommandOperation<number, ReportPublishTargetParams> = {
  build: ({ params }) => ({
    text: `INSERT INTO public.sequence_publish_targets
      (instance_id, machine_key, account_snapshot, capability_snapshot, compatible,
       compatibility_error_code, probed_by_credential_id, probed_at)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, NULLIF($6, ''), $7::uuid, now())
      ON CONFLICT (instance_id) DO UPDATE SET
        machine_key = EXCLUDED.machine_key, account_snapshot = EXCLUDED.account_snapshot,
        capability_snapshot = EXCLUDED.capability_snapshot, compatible = EXCLUDED.compatible,
        compatibility_error_code = EXCLUDED.compatibility_error_code,
        probed_by_credential_id = EXCLUDED.probed_by_credential_id, probed_at = now()`,
    values: [params?.instanceId ?? '', params?.machineKey ?? '', params?.accountJson ?? '{}',
      params?.capabilityJson ?? '{}', params?.compatible === true, params?.errorCode ?? '',
      params?.credentialId ?? ''],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

export interface ClaimPublishJobParams { credentialId: string; leaseSeconds: number; [key: string]: string | number }
export const claimSequencePublishJobOperation: NeonCommandOperation<SequencePublishJobRow | null, ClaimPublishJobParams> = {
  build: ({ params }) => ({
    text: `WITH candidate AS (
      SELECT id FROM public.sequence_publish_jobs
       WHERE target_instance_id = public.machine_actor_instance()
         AND (status = 'queued' OR (status IN ('claimed','preflight','publishing') AND lease_expires_at < now()))
       ORDER BY queued_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE public.sequence_publish_jobs j SET status = 'claimed', attempt = attempt + 1,
        claimed_by_credential_id = $1::uuid, claim_generation = claim_generation + 1,
        claimed_at = now(), lease_expires_at = now() + make_interval(secs => $2::integer),
        finished_at = NULL, error_code = NULL, error_details = NULL
       FROM candidate WHERE j.id = candidate.id RETURNING j.*
    ) SELECT ${JOB_COLUMNS}, ${BRANCH_AGG} FROM claimed j`,
    values: [params?.credentialId ?? '', Number(params?.leaseSeconds ?? 120)],
  }),
  mapResult: (rows) => rows[0] ? mapJob(rows[0]) : null,
}

export interface LeaseParams { jobId: string; generation: number; leaseSeconds: number; [key: string]: string | number }
export const heartbeatSequencePublishJobOperation: NeonCommandOperation<number, LeaseParams> = {
  build: ({ params }) => ({
    text: `UPDATE public.sequence_publish_jobs SET lease_expires_at = now() + make_interval(secs => $3::integer)
      WHERE id = $1::uuid AND claim_generation = $2::integer
        AND claimed_by_credential_id = current_setting('app.actor_id', true)::uuid
        AND status IN ('claimed','preflight','publishing')`,
    values: [params?.jobId ?? '', Number(params?.generation ?? 0), Number(params?.leaseSeconds ?? 120)],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

export interface JobStateParams extends LeaseParams { status: string; errorCode: string; errorJson: string }
export const setSequencePublishJobStateOperation: NeonCommandOperation<number, JobStateParams> = {
  build: ({ params }) => ({
    text: `UPDATE public.sequence_publish_jobs SET status = $3,
        started_at = COALESCE(started_at, CASE WHEN $3 IN ('preflight','publishing') THEN now() END),
        lease_expires_at = now() + make_interval(secs => $4::integer),
        error_code = NULLIF($5, ''), error_details = NULLIF($6, '')::jsonb
      WHERE id = $1::uuid AND claim_generation = $2::integer
        AND claimed_by_credential_id = current_setting('app.actor_id', true)::uuid
        AND status IN ('claimed','preflight','publishing')`,
    values: [params?.jobId ?? '', Number(params?.generation ?? 0), params?.status ?? '',
      Number(params?.leaseSeconds ?? 120), params?.errorCode ?? '', params?.errorJson ?? ''],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

export interface BranchResultParams {
  jobId: string; branchId: string; generation: number; status: string
  campaignId: string; verificationJson: string; errorCode: string; errorJson: string
  [key: string]: string | number
}
export const setSequencePublishBranchResultOperation: NeonCommandOperation<number, BranchResultParams> = {
  build: ({ params }) => ({
    text: `UPDATE public.sequence_publish_branches b SET status = $4,
        lh_campaign_id = NULLIF($5, ''), verification_summary = NULLIF($6, '')::jsonb,
        error_code = NULLIF($7, ''), error_details = NULLIF($8, '')::jsonb,
        started_at = COALESCE(b.started_at, now()),
        finished_at = CASE WHEN $4 IN ('created','conflict','failed') THEN now() ELSE NULL END
      FROM public.sequence_publish_jobs j
      WHERE b.job_id = $1::uuid AND b.branch_id = $2 AND j.id = b.job_id
        AND j.claim_generation = $3::integer
        AND j.claimed_by_credential_id = current_setting('app.actor_id', true)::uuid
        AND j.status IN ('claimed','preflight','publishing')`,
    values: [params?.jobId ?? '', params?.branchId ?? '', Number(params?.generation ?? 0),
      params?.status ?? '', params?.campaignId ?? '', params?.verificationJson ?? '',
      params?.errorCode ?? '', params?.errorJson ?? ''],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

export interface FinishPublishJobParams { jobId: string; generation: number; [key: string]: string | number }
export const finishSequencePublishJobOperation: NeonCommandOperation<number, FinishPublishJobParams> = {
  build: ({ params }) => ({
    text: `UPDATE public.sequence_publish_jobs j SET
        status = CASE
          WHEN NOT EXISTS (SELECT 1 FROM public.sequence_publish_branches b WHERE b.job_id = j.id AND b.status <> 'created') THEN 'success'
          WHEN EXISTS (SELECT 1 FROM public.sequence_publish_branches b WHERE b.job_id = j.id AND b.status = 'created') THEN 'partial_failure'
          WHEN EXISTS (SELECT 1 FROM public.sequence_publish_branches b WHERE b.job_id = j.id AND b.status = 'conflict')
               AND NOT EXISTS (SELECT 1 FROM public.sequence_publish_branches b WHERE b.job_id = j.id AND b.status = 'failed') THEN 'conflict'
          ELSE 'failed' END,
        finished_at = now(), lease_expires_at = NULL
      WHERE j.id = $1::uuid AND j.claim_generation = $2::integer
        AND j.claimed_by_credential_id = current_setting('app.actor_id', true)::uuid
        AND j.status IN ('claimed','preflight','publishing')
        AND NOT EXISTS (SELECT 1 FROM public.sequence_publish_branches b WHERE b.job_id = j.id AND b.status IN ('queued','publishing'))`,
    values: [params?.jobId ?? '', Number(params?.generation ?? 0)],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}
