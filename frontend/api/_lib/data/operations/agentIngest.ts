/**
 * The machine ingest vocabulary: what a notebook's sync agent may ask this
 * database for, and the three admin operations that mint and retire the
 * credentials it asks with.
 *
 * ## Two registries, because two principals
 *
 * The operations in `MACHINE_*` below are composed into `buildMachineRegistry()`
 * and reached only through `machineStore.ts`, which connects as `app_machine`.
 * The three in `AGENT_ADMIN_*` are composed into the *application* registry and
 * reached as `app_runtime` by a signed-in admin. They are deliberately not one
 * set: a machine may write leads and may not issue itself a credential, and an
 * admin may issue a credential and has no business writing leads through the
 * ingest path.
 *
 * ## Why the payload travels as one `jsonb` parameter per collection
 *
 * Each multi-row upsert is `jsonb_to_recordset($2::jsonb)` rather than N
 * parameters or a generated `VALUES` list. The alternatives lose on the two
 * things that matter here:
 *
 * - **A generated `VALUES` list makes the SQL text depend on the payload.** The
 *   registry's contract is that an operation is one fixed statement; a statement
 *   whose text grows with the batch is a statement nothing has reviewed, and the
 *   parameter count would climb past PostgreSQL's 65535 limit on a large sync.
 * - **Parallel `unnest` arrays lose the nulls.** Eighteen typed arrays that must
 *   stay index-aligned is a shape where one mis-sorted column silently writes
 *   one person's headline onto another's row. The record type names each column
 *   once, beside its type, and a payload key that is not in the list is ignored
 *   rather than positionally misread.
 *
 * ## The conflict keys are the agent's, exactly
 *
 * Every upsert here targets the same unique key `sync-agent/agent.py` passes as
 * `on_conflict`, because the two transports must be interchangeable during the
 * S22 rollout — a row written by one and re-sent by the other has to collide
 * rather than duplicate. `events` and `messages` name their constraint rather
 * than inferring it: `events_identity_key` is `NULLS NOT DISTINCT`, and column
 * inference across a nullable member of that key is the kind of thing that
 * silently starts inserting duplicates when a planner detail changes.
 *
 * ## What is deliberately absent
 *
 * No delete, of any row, in any operation. Step 009 grants the machine
 * principal no `DELETE` at all, so an ingest cannot remove a lead that vanished
 * from the notebook's local database — which is the behaviour the Supabase
 * transport already has, and changing it is not a transport decision.
 */

import { RESOLVE_MACHINE_ACTOR_OPERATION } from '../contracts.js'
import { NeonOperationRegistry } from '../neon.js'
import type {
  NeonActorlessQueryOperation,
  NeonCommandOperation,
  NeonQueryOperation,
  NeonRow,
} from '../neon.js'
import {
  MACHINE_PUBLISH_COMMANDS,
  claimSequencePublishCanaryOperation,
  claimSequencePublishJobOperation,
  copySequencePublishReplacementBranchesOperation,
  finishSequencePublishJobOperation,
  heartbeatSequencePublishJobOperation,
  reportSequencePublishTargetOperation,
  finishSequencePublishCanaryOperation,
  setSequencePublishBranchResultOperation,
  setSequencePublishJobStateOperation,
} from './sequencePublishing.js'

export const MACHINE_OPERATIONS = {
  /** The batch already recorded under this key, if there is one. */
  batchByKey: 'agent.batchByKey',
  /** This notebook's own remote-config blob. See `instanceConfigOperation`. */
  instanceConfig: 'agent.instanceConfig',
} as const

export const MACHINE_COMMANDS = {
  upsertInstance: 'agent.upsertInstance',
  upsertCampaigns: 'agent.upsertCampaigns',
  upsertCampaignSteps: 'agent.upsertCampaignSteps',
  upsertLeads: 'agent.upsertLeads',
  upsertMessages: 'agent.upsertMessages',
  upsertEvents: 'agent.upsertEvents',
  recordSyncRun: 'agent.recordSyncRun',
  recordBatch: 'agent.recordBatch',
  stampCredentialUse: 'agent.stampCredentialUse',
  /** Record that this notebook checked a lead and found no avatar. */
  stampLeadPhotoCheck: 'agent.stampLeadPhotoCheck',
  /** Persist the source photo path after the authenticated object upload. */
  upsertLeadPhoto: 'agent.upsertLeadPhoto',
} as const

export const AGENT_ADMIN_OPERATIONS = {
  credentialDirectory: 'agent.credentialDirectory',
} as const

export const AGENT_ADMIN_COMMANDS = {
  issueCredential: 'agent.issueCredential',
  revokeCredential: 'agent.revokeCredential',
} as const

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

// ---------------------------------------------------------------------------
// Establishing the machine actor.
// ---------------------------------------------------------------------------

export interface ResolveCredentialRow {
  readonly credentialId: string
  readonly instanceId: string
  readonly tenantId: string
}

export interface ResolveCredentialParams {
  readonly credentialId: string
  readonly secretHash: string
  readonly tenantId: string
  readonly [key: string]: string
}

/**
 * The second — and, by the registry's rule, last — actorless operation.
 *
 * All three inputs are bound parameters of a `SECURITY DEFINER` function that
 * refuses on any of them. Nothing here decides anything: this file cannot tell
 * a revoked credential from an unknown one, and neither can its caller.
 */
export const resolveCredentialOperation: NeonActorlessQueryOperation<
  ResolveCredentialRow,
  ResolveCredentialParams
> = {
  build: (params) => ({
    text:
      'SELECT credential_id::text AS credential_id, instance_id, tenant_id' +
      '  FROM public.agent_credential_resolve($1::uuid, $2, $3)',
    values: [
      String(params?.credentialId ?? ''),
      String(params?.secretHash ?? ''),
      String(params?.tenantId ?? ''),
    ],
  }),
  mapRow: (row: NeonRow): ResolveCredentialRow => ({
    credentialId: String(row.credential_id),
    instanceId: String(row.instance_id),
    tenantId: String(row.tenant_id),
  }),
}

// ---------------------------------------------------------------------------
// The batch ledger.
// ---------------------------------------------------------------------------

export interface IngestBatchRow {
  readonly id: string
  readonly payload_digest: string
  readonly row_counts: Record<string, number>
  readonly rows_written: number
  readonly received_at: string | null
}

export interface BatchByKeyParams {
  readonly credentialId: string
  readonly idempotencyKey: string
  readonly [key: string]: string
}

/**
 * The replay lookup. It reads only the calling credential's own batches — the
 * policy would not show it another one's — and it is what turns a repeated
 * payload into an answer instead of a second write.
 */
export const batchByKeyOperation: NeonQueryOperation<
  IngestBatchRow,
  BatchByKeyParams
> = {
  build: ({ params }) => ({
    text:
      'SELECT b.id::text AS id, b.payload_digest, b.row_counts, b.rows_written,' +
      '       b.received_at' +
      '  FROM public.agent_ingest_batch b' +
      ' WHERE b.credential_id = $1::uuid' +
      '   AND b.idempotency_key = $2',
    values: [params?.credentialId ?? '', params?.idempotencyKey ?? ''],
  }),
  mapRow: (row: NeonRow): IngestBatchRow => ({
    id: String(row.id),
    payload_digest: String(row.payload_digest),
    row_counts: (row.row_counts ?? {}) as Record<string, number>,
    rows_written: Number(row.rows_written ?? 0),
    received_at: text(row.received_at),
  }),
}

export interface InstanceConfigRow {
  readonly id: string
  readonly config: Record<string, unknown>
  readonly config_updated_at: string | null
}

/**
 * The notebook's own remote-config blob — S23's replacement for the agent's
 * direct PostgREST read of `instances?select=config` with the service key.
 *
 * **No `WHERE id = …` clause, and that is the point.** `instances_machine_actor`
 * (step 009 section D) restricts every `app_machine` statement on this relation
 * to `id = public.machine_actor_instance()`, and that function re-derives
 * "exists, not revoked, not expired" on every statement. So an unrestricted
 * `SELECT` here returns exactly one row — this credential's notebook — or zero
 * rows for a credential that has been revoked or has expired *since the handler
 * resolved it*.
 *
 * Writing the filter here as well would have been the defensive-looking choice
 * and is the weaker one: it would compare a value this process carries against a
 * column, which is a check the handler can get wrong, in place of a check the
 * database re-derives per statement and the handler cannot influence at all. The
 * `LIMIT 2` is the assertion — see the mapper's caller in `machineOps.ts`, which
 * treats a second row as a fault rather than picking one.
 */
export const instanceConfigOperation: NeonQueryOperation<
  InstanceConfigRow,
  Record<string, never>
> = {
  build: () => ({
    text:
      'SELECT i.id, i.config, i.config_updated_at' +
      '  FROM public.instances i' +
      ' LIMIT 2',
    values: [],
  }),
  mapRow: (row: NeonRow): InstanceConfigRow => ({
    id: String(row.id),
    config:
      row.config && typeof row.config === 'object' && !Array.isArray(row.config)
        ? (row.config as Record<string, unknown>)
        : {},
    config_updated_at: text(row.config_updated_at),
  }),
}

export interface RecordBatchParams {
  readonly credentialId: string
  readonly instanceId: string
  readonly idempotencyKey: string
  readonly payloadDigest: string
  readonly rowCounts: string
  readonly rowsWritten: number
  readonly [key: string]: string | number
}

/**
 * The commit marker, written **last** and with no `ON CONFLICT` clause.
 *
 * Both of those are the design. Written last, it carries the final counts and
 * needs no second statement to complete it — which is why step 009 grants the
 * machine principal `INSERT` on this relation and not `UPDATE`, so a batch
 * record cannot be rewritten after the fact by anything at all.
 *
 * With no `ON CONFLICT`, a concurrent identical batch that committed while this
 * one was working raises a unique violation here, the transaction rolls back,
 * and the caller is told the key is already taken. `DO NOTHING` would instead
 * commit this batch's writes while claiming nothing had happened.
 */
export const recordBatchOperation: NeonCommandOperation<number, RecordBatchParams> = {
  build: ({ params }) => ({
    text:
      'INSERT INTO public.agent_ingest_batch' +
      ' (credential_id, instance_id, idempotency_key, payload_digest, row_counts, rows_written)' +
      ' VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6)',
    values: [
      params?.credentialId ?? '',
      params?.instanceId ?? '',
      params?.idempotencyKey ?? '',
      params?.payloadDigest ?? '',
      params?.rowCounts ?? '{}',
      Number(params?.rowsWritten ?? 0),
    ],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

export interface CredentialIdParams {
  readonly credentialId: string
  readonly [key: string]: string
}

export interface LeadPhotoCheckParams {
  readonly instanceId: string
  readonly campaignId: string
  readonly profileUrl: string
  readonly [key: string]: string
}

/**
 * The no-avatar half of the photo API. The agent must be able to converge a
 * checked lead without inventing an object path; `photo_synced_at` with a NULL
 * path is the existing meaning on both providers.
 */
export const stampLeadPhotoCheckOperation: NeonCommandOperation<
  number,
  LeadPhotoCheckParams
> = {
  build: ({ params }) => ({
    text:
      'UPDATE public.leads SET photo_synced_at = now(), updated_at = now()' +
      ' WHERE instance_id = $1 AND campaign_id = $2 AND profile_url = $3',
    values: [
      params?.instanceId ?? '',
      params?.campaignId ?? '',
      params?.profileUrl ?? '',
    ],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

export interface LeadPhotoUploadParams extends LeadPhotoCheckParams {
  readonly photoPath: string
}

/**
 * Store the application path only after the object upload has succeeded. The
 * storage key is derived by the API, not accepted as a machine parameter, so a
 * credential for one notebook cannot name another notebook's object.
 */
export const upsertLeadPhotoOperation: NeonCommandOperation<
  number,
  LeadPhotoUploadParams
> = {
  build: ({ params }) => ({
    text:
      'UPDATE public.leads SET photo_path = $4, photo_synced_at = now(), updated_at = now()' +
      ' WHERE instance_id = $1 AND campaign_id = $2 AND profile_url = $3',
    values: [
      params?.instanceId ?? '',
      params?.campaignId ?? '',
      params?.profileUrl ?? '',
      params?.photoPath ?? '',
    ],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

/**
 * `last_used_at`, stamped inside the ingest transaction rather than beside it.
 *
 * So a batch that rolled back leaves the column showing the last time the
 * credential actually wrote something, which is the question an operator asks
 * of it. The column-level grant in step 009 is what keeps this statement from
 * being able to touch anything else on the row.
 */
export const stampCredentialUseOperation: NeonCommandOperation<
  number,
  CredentialIdParams
> = {
  build: ({ params }) => ({
    text:
      'UPDATE public.agent_credential SET last_used_at = now()' +
      ' WHERE id = $1::uuid',
    values: [params?.credentialId ?? ''],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

// ---------------------------------------------------------------------------
// The upserts. One per collection the agent pushes.
// ---------------------------------------------------------------------------

export interface InstanceUpsertParams {
  readonly instanceId: string
  readonly label: string
  readonly agentVersion: string
  readonly accountName: string
  readonly accountUrl: string
  readonly accountAvatar: string
  readonly [key: string]: string
}

/**
 * The notebook's own row. `config` and `config_updated_at` are never named:
 * they are the *dashboard's* half of this table — the remote config an operator
 * edits on the Health page and the agent reads back — and an ingest that
 * included them would let a notebook overwrite its own instructions.
 *
 * Every text column is `COALESCE(NULLIF(excluded, ''), existing)`, so a sync
 * that could not read an account name leaves the one already there rather than
 * blanking it.
 */
export const upsertInstanceOperation: NeonCommandOperation<
  number,
  InstanceUpsertParams
> = {
  build: ({ params }) => ({
    text:
      'INSERT INTO public.instances' +
      ' (id, label, last_sync_at, agent_version, account_name, account_url, account_avatar)' +
      ' VALUES ($1, $2, now(), NULLIF($3, \'\'), NULLIF($4, \'\'), NULLIF($5, \'\'), NULLIF($6, \'\'))' +
      ' ON CONFLICT (id) DO UPDATE SET' +
      '   label = COALESCE(NULLIF(EXCLUDED.label, \'\'), public.instances.label),' +
      '   last_sync_at = now(),' +
      '   agent_version = COALESCE(EXCLUDED.agent_version, public.instances.agent_version),' +
      '   account_name = COALESCE(EXCLUDED.account_name, public.instances.account_name),' +
      '   account_url = COALESCE(EXCLUDED.account_url, public.instances.account_url),' +
      '   account_avatar = COALESCE(EXCLUDED.account_avatar, public.instances.account_avatar)',
    values: [
      params?.instanceId ?? '',
      params?.label ?? '',
      params?.agentVersion ?? '',
      params?.accountName ?? '',
      params?.accountUrl ?? '',
      params?.accountAvatar ?? '',
    ],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

export interface CollectionParams {
  readonly instanceId: string
  readonly rows: string
  readonly [key: string]: string
}

export const upsertCampaignsOperation: NeonCommandOperation<
  number,
  CollectionParams
> = {
  build: ({ params }) => ({
    text:
      'INSERT INTO public.campaigns' +
      ' (id, instance_id, lh_campaign_id, name, status, runtime_status, is_archived,' +
      '  status_observed_at, status_source, status_raw, updated_at)' +
      ' SELECT r.id, $1, r.lh_campaign_id, r.name, COALESCE(NULLIF(r.status, \'\'), \'unknown\'),' +
      '        r.runtime_status, r.is_archived, r.status_observed_at,' +
      '        r.status_source, r.status_raw, now()' +
      '   FROM jsonb_to_recordset($2::jsonb)' +
      '     AS r(id text, lh_campaign_id text, name text, status text,' +
      '          runtime_status text, is_archived boolean, status_observed_at timestamptz,' +
      '          status_source text, status_raw text)' +
      ' ON CONFLICT (id) DO UPDATE SET' +
      '   name = EXCLUDED.name,' +
      '   status = EXCLUDED.status,' +
      '   runtime_status = CASE WHEN EXCLUDED.status_observed_at IS NOT NULL' +
      '     AND (public.campaigns.status_observed_at IS NULL' +
      '       OR EXCLUDED.status_observed_at >= public.campaigns.status_observed_at)' +
      '     THEN EXCLUDED.runtime_status ELSE public.campaigns.runtime_status END,' +
      '   is_archived = CASE WHEN EXCLUDED.status_observed_at IS NOT NULL' +
      '     AND (public.campaigns.status_observed_at IS NULL' +
      '       OR EXCLUDED.status_observed_at >= public.campaigns.status_observed_at)' +
      '     THEN EXCLUDED.is_archived ELSE public.campaigns.is_archived END,' +
      '   status_source = CASE WHEN EXCLUDED.status_observed_at IS NOT NULL' +
      '     AND (public.campaigns.status_observed_at IS NULL' +
      '       OR EXCLUDED.status_observed_at >= public.campaigns.status_observed_at)' +
      '     THEN EXCLUDED.status_source ELSE public.campaigns.status_source END,' +
      '   status_raw = CASE WHEN EXCLUDED.status_observed_at IS NOT NULL' +
      '     AND (public.campaigns.status_observed_at IS NULL' +
      '       OR EXCLUDED.status_observed_at >= public.campaigns.status_observed_at)' +
      '     THEN EXCLUDED.status_raw ELSE public.campaigns.status_raw END,' +
      '   status_observed_at = CASE WHEN EXCLUDED.status_observed_at IS NOT NULL' +
      '     AND (public.campaigns.status_observed_at IS NULL' +
      '       OR EXCLUDED.status_observed_at >= public.campaigns.status_observed_at)' +
      '     THEN EXCLUDED.status_observed_at ELSE public.campaigns.status_observed_at END,' +
      '   updated_at = now()',
    values: [params?.instanceId ?? '', params?.rows ?? '[]'],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

/**
 * Steps carry no instance of their own and reach one through their campaign, so
 * the join is what scopes them — and the step-009 policy re-derives exactly the
 * same join, so a step whose campaign belongs to another notebook is refused by
 * the database even though this statement's `WHERE` would have admitted it.
 */
export const upsertCampaignStepsOperation: NeonCommandOperation<
  number,
  CollectionParams
> = {
  build: ({ params }) => ({
    text:
      'INSERT INTO public.campaign_steps' +
      ' (campaign_id, step_index, step_label, step_type, template_body,' +
      '  sent_count, replied_count, current_count, updated_at)' +
      ' SELECT r.campaign_id, r.step_index, r.step_label, r.step_type, r.template_body,' +
      '        COALESCE(r.sent_count, 0), COALESCE(r.replied_count, 0),' +
      '        COALESCE(r.current_count, 0), now()' +
      '   FROM jsonb_to_recordset($2::jsonb)' +
      '     AS r(campaign_id text, step_index integer, step_label text, step_type text,' +
      '          template_body text, sent_count integer, replied_count integer,' +
      '          current_count integer)' +
      '   JOIN public.campaigns c ON c.id = r.campaign_id AND c.instance_id = $1' +
      ' ON CONFLICT (campaign_id, step_index) DO UPDATE SET' +
      '   step_label = EXCLUDED.step_label,' +
      '   step_type = EXCLUDED.step_type,' +
      '   template_body = EXCLUDED.template_body,' +
      '   sent_count = EXCLUDED.sent_count,' +
      '   replied_count = EXCLUDED.replied_count,' +
      '   current_count = EXCLUDED.current_count,' +
      '   updated_at = now()',
    values: [params?.instanceId ?? '', params?.rows ?? '[]'],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

/**
 * The funnel rows. Milestones are written as sent and **not** coalesced here:
 * the baseline's `leads_keep_milestones` trigger already refuses to regress a
 * non-NULL milestone to NULL, and duplicating that rule in the statement would
 * create a second place for it to be true, which is one more than the number of
 * places a rule can be maintained in.
 */
export const upsertLeadsOperation: NeonCommandOperation<number, CollectionParams> = {
  build: ({ params }) => ({
    text:
      'INSERT INTO public.leads' +
      ' (instance_id, campaign_id, profile_url, full_name, headline, company, status,' +
      '  invited_at, connected_at, first_message_at, replied_at, last_action_at, added_at,' +
      '  photo_path, photo_synced_at, education_start_year, first_job_start_year, updated_at)' +
      ' SELECT $1, r.campaign_id, r.profile_url, r.full_name, r.headline, r.company, r.status,' +
      '        r.invited_at, r.connected_at, r.first_message_at, r.replied_at,' +
      '        r.last_action_at, r.added_at, r.photo_path, r.photo_synced_at,' +
      '        r.education_start_year, r.first_job_start_year, now()' +
      '   FROM jsonb_to_recordset($2::jsonb)' +
      '     AS r(campaign_id text, profile_url text, full_name text, headline text,' +
      '          company text, status text, invited_at timestamptz, connected_at timestamptz,' +
      '          first_message_at timestamptz, replied_at timestamptz,' +
      '          last_action_at timestamptz, added_at timestamptz, photo_path text,' +
      '          photo_synced_at timestamptz, education_start_year integer,' +
      '          first_job_start_year integer)' +
      ' ON CONFLICT (campaign_id, profile_url) DO UPDATE SET' +
      '   full_name = COALESCE(EXCLUDED.full_name, public.leads.full_name),' +
      '   headline = COALESCE(EXCLUDED.headline, public.leads.headline),' +
      '   company = COALESCE(EXCLUDED.company, public.leads.company),' +
      '   status = COALESCE(EXCLUDED.status, public.leads.status),' +
      '   invited_at = EXCLUDED.invited_at,' +
      '   connected_at = EXCLUDED.connected_at,' +
      '   first_message_at = EXCLUDED.first_message_at,' +
      '   replied_at = EXCLUDED.replied_at,' +
      '   last_action_at = COALESCE(EXCLUDED.last_action_at, public.leads.last_action_at),' +
      '   added_at = COALESCE(EXCLUDED.added_at, public.leads.added_at),' +
      '   photo_path = COALESCE(EXCLUDED.photo_path, public.leads.photo_path),' +
      '   photo_synced_at = COALESCE(EXCLUDED.photo_synced_at, public.leads.photo_synced_at),' +
      '   education_start_year = COALESCE(EXCLUDED.education_start_year, public.leads.education_start_year),' +
      '   first_job_start_year = COALESCE(EXCLUDED.first_job_start_year, public.leads.first_job_start_year),' +
      '   updated_at = now()',
    values: [params?.instanceId ?? '', params?.rows ?? '[]'],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

/**
 * Messages: one statement, three write paths, and one rule that outranks all of
 * them — a row's *classification* is never written here.
 *
 * ## Why there are three paths
 *
 * The agent used to derive a message from `action_result_messages`, whose
 * `sent_at` is the LH2 **action-run** time: later than the real send, sometimes
 * by weeks, and with no id of its own. The chat-store extractor reports the real
 * send time and a stable `external_id`. The same message therefore arrives a
 * second time looking like a different one, and a plain upsert on
 * `messages_identity_key` would insert it: two rows for one message, and the
 * older of the two is the one carrying the sentiment label, the intent level and
 * the `notified_at` stamp.
 *
 * So a keyed row first tries to **adopt** the legacy row it is the truth about —
 * same instance, profile, direction and `content_hash`, `sent_at` inside the
 * window the run-time lag lives in (a day early to allow for clock skew, 45 days
 * late for the lag itself), closest first. Adoption is an `UPDATE` that writes
 * the identity (`external_id`, the real `sent_at`, `platform`, `message_type`)
 * and nothing else. **`sentiment`, `intent_level`, `classified_at`,
 * `notified_at`, `first_seen_at` and their siblings are never in any SET list in
 * this statement** — they are written by the AI layer and by the notifier, and
 * carrying them here would erase a classification or re-announce a reply that
 * has already been announced. Adopting instead of inserting is the whole point:
 * it is how those columns survive the migration.
 *
 * What is not adopted is inserted on `(instance_id, external_id)`; a row with no
 * `external_id` at all — every older agent — takes the original
 * `messages_identity_key` path, unchanged.
 *
 * ## Why it is one statement, and what that forces
 *
 * The registry's contract is one fixed parameterised statement per operation, so
 * the three paths are data-modifying CTEs. They share a single snapshot, which
 * means the insert CTEs cannot discover the adoptions by re-reading
 * `public.messages` — they would not see them. They exclude adopted rows by
 * joining `adopted`'s own `RETURNING`.
 *
 * Two `DISTINCT ON` layers keep each arbiter from being hit twice in one
 * statement (PostgreSQL aborts the whole command with "cannot affect row a
 * second time"): the batch is deduplicated on `external_id`, and a legacy row
 * can be claimed by at most one incoming row. Both inserts additionally carry a
 * `NOT EXISTS` on the identity key, so a same-second same-body duplicate is
 * skipped rather than aborting the batch.
 */
export const upsertMessagesOperation: NeonCommandOperation<
  number,
  CollectionParams
> = {
  build: ({ params }) => ({
    text:
      'WITH raw AS (' +
      '  SELECT r.*, row_number() OVER () AS ord' +
      '    FROM jsonb_to_recordset($2::jsonb)' +
      '      AS r(campaign_id text, profile_url text, direction text, body text,' +
      '           sent_at timestamptz, content_hash text, external_id text,' +
      '           platform text, message_type text)' +
      '), by_external AS (' +
      // The parentheses are load-bearing: without them the ORDER BY binds to the
      // UNION rather than to the DISTINCT ON branch, and the dedup picks an
      // arbitrary row of each external_id instead of the first one sent.
      '  (SELECT DISTINCT ON (external_id) * FROM raw WHERE external_id IS NOT NULL' +
      '    ORDER BY external_id, ord)' +
      '  UNION ALL' +
      '  (SELECT * FROM raw WHERE external_id IS NULL)' +
      '), incoming AS (' +
      // Second dedup, on the legacy identity key across the WHOLE batch. The
      // data-modifying CTEs below all see one snapshot and can only arbitrate on
      // one index each, so two incoming rows that land on the same
      // (profile, direction, sent_at, hash) — whether both keyed, keyed and
      // legacy, or an adopted row's new identity and a sibling insert — would
      // raise a plain unique violation and abort the batch. Keyed rows win the
      // tie; among equals the first one sent does.
      '  SELECT DISTINCT ON (profile_url, direction, sent_at, COALESCE(content_hash, \'\'))' +
      '         * FROM by_external' +
      '   ORDER BY profile_url, direction, sent_at, COALESCE(content_hash, \'\'),' +
      '            (external_id IS NULL), ord' +
      '), keyed AS (' +
      '  SELECT * FROM incoming WHERE external_id IS NOT NULL' +
      '), candidates AS (' +
      '  SELECT DISTINCT ON (k.external_id)' +
      '         k.external_id, k.campaign_id, k.profile_url, k.direction, k.body,' +
      '         k.sent_at, k.content_hash, k.platform, k.message_type, m.id AS message_id,' +
      '         abs(extract(epoch FROM (m.sent_at - k.sent_at))) AS distance' +
      '    FROM keyed k' +
      '    JOIN public.messages m' +
      '      ON m.instance_id = $1' +
      '     AND m.external_id IS NULL' +
      '     AND m.profile_url = k.profile_url' +
      '     AND m.direction = k.direction' +
      // A legacy sync row hashes the same LH2 text, so the hash matches exactly.
      // A MANUAL row was pasted out of the LinkedIn UI and differs in whitespace
      // and case, so it is matched the way /api/import-conversation dedups it:
      // trimmed, whitespace-collapsed, lower-cased (conversationImport.ts
      // normalizeForDedup). Bounded to source='manual' and non-empty bodies so
      // the normalised compare never runs over the sync bulk.
      '     AND (m.content_hash = COALESCE(k.content_hash, \'\')' +
      '          OR (m.source = \'manual\' AND COALESCE(k.body, \'\') <> \'\'' +
      '              AND lower(regexp_replace(btrim(replace(COALESCE(m.body, \'\'), E\'\\r\', \'\')), \'\\s+\', \' \', \'g\'))' +
      '                = lower(regexp_replace(btrim(replace(k.body, E\'\\r\', \'\')), \'\\s+\', \' \', \'g\'))))' +
      '     AND m.sent_at BETWEEN k.sent_at - interval \'1 day\'' +
      '                       AND k.sent_at + interval \'45 days\'' +
      '   WHERE NOT EXISTS (' +
      '           SELECT 1 FROM public.messages x' +
      '            WHERE x.instance_id = $1 AND x.external_id = k.external_id)' +
      '     AND NOT EXISTS (' +
      '           SELECT 1 FROM public.messages y' +
      '            WHERE y.instance_id = $1 AND y.profile_url = k.profile_url' +
      '              AND y.direction = k.direction AND y.sent_at = k.sent_at' +
      '              AND y.content_hash = COALESCE(k.content_hash, \'\'))' +
      '   ORDER BY k.external_id, distance, m.id' +
      '), pairs AS (' +
      // The reverse collision: two incoming messages nominating one legacy row.
      // The closer one in time adopts it; the other inserts as a new row.
      '  SELECT DISTINCT ON (message_id) * FROM candidates' +
      '   ORDER BY message_id, distance, external_id' +
      '), adopted AS (' +
      '  UPDATE public.messages m SET' +
      '    external_id = p.external_id,' +
      '    sent_at = p.sent_at,' +
      // A RECALLED row carries body NULL on purpose (the sender withdrew the
      // text); that NULL is authoritative, not "no information", so it clears the
      // stored text instead of falling through the COALESCE.
      '    content_hash = CASE WHEN p.message_type = \'RECALLED\' OR p.body IS NOT NULL' +
      '                        THEN COALESCE(p.content_hash, m.content_hash)' +
      '                        ELSE m.content_hash END,' +
      '    platform = p.platform,' +
      '    message_type = p.message_type,' +
      '    source = \'sync\',' +
      '    campaign_id = COALESCE(p.campaign_id, m.campaign_id),' +
      '    body = CASE WHEN p.message_type = \'RECALLED\' THEN NULL' +
      '                ELSE COALESCE(p.body, m.body) END' +
      '  FROM pairs p' +
      '   WHERE m.id = p.message_id AND m.instance_id = $1' +
      '  RETURNING p.external_id AS external_id' +
      '), inserted_keyed AS (' +
      '  INSERT INTO public.messages' +
      '   (instance_id, campaign_id, profile_url, direction, body, sent_at,' +
      '    content_hash, source, external_id, platform, message_type)' +
      '  SELECT $1, k.campaign_id, k.profile_url, k.direction, k.body, k.sent_at,' +
      '         COALESCE(k.content_hash, \'\'), \'sync\', k.external_id,' +
      '         k.platform, k.message_type' +
      '    FROM keyed k' +
      '   WHERE NOT EXISTS (' +
      '           SELECT 1 FROM adopted a WHERE a.external_id = k.external_id)' +
      '     AND NOT EXISTS (' +
      '           SELECT 1 FROM public.messages y' +
      '            WHERE y.instance_id = $1 AND y.profile_url = k.profile_url' +
      '              AND y.direction = k.direction AND y.sent_at = k.sent_at' +
      '              AND y.content_hash = COALESCE(k.content_hash, \'\')' +
      '              AND y.external_id IS DISTINCT FROM k.external_id)' +
      '  ON CONFLICT (instance_id, external_id) WHERE external_id IS NOT NULL' +
      '  DO UPDATE SET' +
      '    body = CASE WHEN EXCLUDED.message_type = \'RECALLED\' THEN NULL' +
      '                ELSE COALESCE(EXCLUDED.body, public.messages.body) END,' +
      '    content_hash = CASE WHEN EXCLUDED.message_type = \'RECALLED\'' +
      '                          OR EXCLUDED.body IS NOT NULL' +
      '                        THEN EXCLUDED.content_hash' +
      '                        ELSE public.messages.content_hash END,' +
      '    message_type = COALESCE(EXCLUDED.message_type, public.messages.message_type),' +
      '    platform = COALESCE(EXCLUDED.platform, public.messages.platform),' +
      '    campaign_id = COALESCE(EXCLUDED.campaign_id, public.messages.campaign_id)' +
      '  RETURNING 1 AS n' +
      '), inserted_plain AS (' +
      '  INSERT INTO public.messages' +
      '   (instance_id, campaign_id, profile_url, direction, body, sent_at,' +
      '    content_hash, source)' +
      '  SELECT $1, r.campaign_id, r.profile_url, r.direction, r.body, r.sent_at,' +
      '         COALESCE(r.content_hash, \'\'), \'sync\'' +
      '    FROM incoming r' +
      '   WHERE r.external_id IS NULL' +
      '  ON CONFLICT ON CONSTRAINT messages_identity_key DO UPDATE SET' +
      '    campaign_id = COALESCE(EXCLUDED.campaign_id, public.messages.campaign_id),' +
      '    body = COALESCE(EXCLUDED.body, public.messages.body)' +
      '  RETURNING 1 AS n' +
      ')' +
      ' SELECT ((SELECT count(*) FROM adopted)' +
      '       + (SELECT count(*) FROM inserted_keyed)' +
      '       + (SELECT count(*) FROM inserted_plain))::int AS n',
    values: [params?.instanceId ?? '', params?.rows ?? '[]'],
  }),
  /**
   * The statement is a `SELECT` (its writes are CTEs), so `rowCount` is 1 — the
   * count row itself. The number this operation answers with is the same thing
   * every other upsert here answers with: rows affected.
   */
  mapResult: (rows) => Number(rows[0]?.n ?? 0),
}

/**
 * Derived events. The conflict target is named rather than inferred because
 * `events_identity_key` is `UNIQUE NULLS NOT DISTINCT` over a key with two
 * nullable members — the shape where inference and the actual index are most
 * able to disagree, and where disagreeing means silently accumulating a
 * duplicate event per sync instead of failing.
 */
export const upsertEventsOperation: NeonCommandOperation<number, CollectionParams> = {
  build: ({ params }) => ({
    text:
      'INSERT INTO public.events (instance_id, campaign_id, profile_url, event_type, occurred_at, raw)' +
      ' SELECT $1, r.campaign_id, r.profile_url, r.event_type, r.occurred_at, r.raw' +
      '   FROM jsonb_to_recordset($2::jsonb)' +
      '     AS r(campaign_id text, profile_url text, event_type text,' +
      '          occurred_at timestamptz, raw jsonb)' +
      ' ON CONFLICT ON CONSTRAINT events_identity_key DO UPDATE SET' +
      '   occurred_at = LEAST(public.events.occurred_at, EXCLUDED.occurred_at),' +
      '   raw = COALESCE(EXCLUDED.raw, public.events.raw)',
    values: [params?.instanceId ?? '', params?.rows ?? '[]'],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

export interface SyncRunParams {
  readonly instanceId: string
  readonly status: string
  readonly rowsUpserted: number
  readonly error: string
  readonly [key: string]: string | number
}

/**
 * The sync log row. Appended, never keyed — a replay never reaches this
 * statement, because the batch lookup answers first, so the log carries one row
 * per accepted batch rather than one per delivery attempt.
 */
export const recordSyncRunOperation: NeonCommandOperation<number, SyncRunParams> = {
  build: ({ params }) => ({
    text:
      'INSERT INTO public.sync_runs (instance_id, started_at, finished_at, status, rows_upserted, error)' +
      ' VALUES ($1, now(), now(), $2, $3, NULLIF($4, \'\'))',
    values: [
      params?.instanceId ?? '',
      params?.status ?? 'ok',
      Number(params?.rowsUpserted ?? 0),
      params?.error ?? '',
    ],
  }),
  mapResult: (_rows, rowCount) => rowCount,
}

// ---------------------------------------------------------------------------
// The admin half: issue, revoke, list. app_runtime, admin-gated in the database.
// ---------------------------------------------------------------------------

export interface IssueCredentialParams {
  readonly tenantId: string
  readonly instanceId: string
  readonly label: string
  readonly secretHash: string
  readonly expiresAt: string
  readonly [key: string]: string
}

export interface IssuedCredential {
  readonly id: string
  readonly tenant_id: string
  readonly instance_id: string
  readonly label: string
  readonly created_at: string | null
  readonly expires_at: string | null
}

/**
 * Issue. The hash is computed by the caller and the secret never reaches the
 * database — see `009_machine_ingest_path.sql` section E on why the function
 * does not generate it.
 *
 * There is no `authorize` hook, for the reason every write in this project
 * gives: `agent_credential_issue` raises `42501` unless `is_app_admin()` holds,
 * so the database is the decision and a hook here could only ever be a second,
 * weaker copy of it that drifts.
 */
export const issueCredentialOperation: NeonCommandOperation<
  IssuedCredential | null,
  IssueCredentialParams
> = {
  build: ({ params }) => ({
    text:
      'SELECT id::text AS id, tenant_id, instance_id, label, created_at, expires_at' +
      '  FROM public.agent_credential_issue($1, $2, $3, $4, NULLIF($5, \'\')::timestamptz)',
    values: [
      params?.tenantId ?? '',
      params?.instanceId ?? '',
      params?.label ?? '',
      params?.secretHash ?? '',
      params?.expiresAt ?? '',
    ],
  }),
  mapResult: (rows): IssuedCredential | null => {
    const row = rows[0]
    if (!row) return null
    return {
      id: String(row.id),
      tenant_id: String(row.tenant_id),
      instance_id: String(row.instance_id),
      label: String(row.label ?? ''),
      created_at: text(row.created_at),
      expires_at: text(row.expires_at),
    }
  },
}

export interface RevokeCredentialParams {
  readonly credentialId: string
  readonly reason: string
  readonly [key: string]: string
}

export interface RevokedCredential {
  readonly id: string
  readonly instance_id: string
  readonly revoked_at: string | null
  readonly revoked_reason: string | null
}

export const revokeCredentialOperation: NeonCommandOperation<
  RevokedCredential | null,
  RevokeCredentialParams
> = {
  build: ({ params }) => ({
    text:
      'SELECT id::text AS id, instance_id, revoked_at, revoked_reason' +
      '  FROM public.agent_credential_revoke($1::uuid, NULLIF($2, \'\'))',
    values: [params?.credentialId ?? '', params?.reason ?? ''],
  }),
  mapResult: (rows): RevokedCredential | null => {
    const row = rows[0]
    if (!row) return null
    return {
      id: String(row.id),
      instance_id: String(row.instance_id),
      revoked_at: text(row.revoked_at),
      revoked_reason: text(row.revoked_reason),
    }
  },
}

export interface CredentialDirectoryRow {
  readonly id: string
  readonly tenant_id: string
  readonly instance_id: string
  readonly label: string
  readonly created_at: string | null
  readonly created_by: string | null
  readonly expires_at: string | null
  readonly revoked_at: string | null
  readonly revoked_reason: string | null
  readonly last_used_at: string | null
}

/**
 * The listing. It returns no `secret_hash`, and the function does not select
 * one — a projection that never carries the column cannot leak it through a
 * response shape that grew a field.
 */
export const credentialDirectoryOperation: NeonQueryOperation<
  CredentialDirectoryRow
> = {
  build: () => ({
    text:
      'SELECT id::text AS id, tenant_id, instance_id, label, created_at,' +
      '       created_by::text AS created_by, expires_at, revoked_at, revoked_reason,' +
      '       last_used_at' +
      '  FROM public.agent_credential_directory()',
    values: [],
  }),
  mapRow: (row: NeonRow): CredentialDirectoryRow => ({
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    instance_id: String(row.instance_id),
    label: String(row.label ?? ''),
    created_at: text(row.created_at),
    created_by: text(row.created_by),
    expires_at: text(row.expires_at),
    revoked_at: text(row.revoked_at),
    revoked_reason: text(row.revoked_reason),
    last_used_at: text(row.last_used_at),
  }),
}

// ---------------------------------------------------------------------------
// The two registrations.
// ---------------------------------------------------------------------------

/**
 * The machine store's whole vocabulary. Eleven commands, two queries and one
 * actorless resolver — and deliberately nothing else: no read of another
 * notebook, no read of the dashboard's own tables, no AI guard. A notebook that
 * wanted to know what the dashboard thinks of its leads would have to ask
 * through an operation nobody has registered.
 */
export function buildMachineRegistry(): NeonOperationRegistry {
  const registry = new NeonOperationRegistry()

  registry.registerActorlessQuery(
    RESOLVE_MACHINE_ACTOR_OPERATION,
    resolveCredentialOperation,
  )

  registry.registerQuery(MACHINE_OPERATIONS.batchByKey, batchByKeyOperation)
  registry.registerQuery(
    MACHINE_OPERATIONS.instanceConfig,
    instanceConfigOperation,
  )

  registry.registerCommand(MACHINE_COMMANDS.recordBatch, recordBatchOperation)
  registry.registerCommand(
    MACHINE_COMMANDS.stampCredentialUse,
    stampCredentialUseOperation,
  )
  registry.registerCommand(
    MACHINE_COMMANDS.stampLeadPhotoCheck,
    stampLeadPhotoCheckOperation,
  )
  registry.registerCommand(
    MACHINE_COMMANDS.upsertLeadPhoto,
    upsertLeadPhotoOperation,
  )
  registry.registerCommand(
    MACHINE_COMMANDS.upsertInstance,
    upsertInstanceOperation,
  )
  registry.registerCommand(
    MACHINE_COMMANDS.upsertCampaigns,
    upsertCampaignsOperation,
  )
  registry.registerCommand(
    MACHINE_COMMANDS.upsertCampaignSteps,
    upsertCampaignStepsOperation,
  )
  registry.registerCommand(MACHINE_COMMANDS.upsertLeads, upsertLeadsOperation)
  registry.registerCommand(
    MACHINE_COMMANDS.upsertMessages,
    upsertMessagesOperation,
  )
  registry.registerCommand(MACHINE_COMMANDS.upsertEvents, upsertEventsOperation)
  registry.registerCommand(
    MACHINE_COMMANDS.recordSyncRun,
    recordSyncRunOperation,
  )
  registry.registerCommand(MACHINE_PUBLISH_COMMANDS.reportTarget, reportSequencePublishTargetOperation)
  registry.registerCommand(MACHINE_PUBLISH_COMMANDS.copyReplacementBranches, copySequencePublishReplacementBranchesOperation)
  registry.registerCommand(MACHINE_PUBLISH_COMMANDS.claimCanary, claimSequencePublishCanaryOperation)
  registry.registerCommand(MACHINE_PUBLISH_COMMANDS.finishCanary, finishSequencePublishCanaryOperation)
  registry.registerCommand(MACHINE_PUBLISH_COMMANDS.claim, claimSequencePublishJobOperation)
  registry.registerCommand(MACHINE_PUBLISH_COMMANDS.heartbeat, heartbeatSequencePublishJobOperation)
  registry.registerCommand(MACHINE_PUBLISH_COMMANDS.setState, setSequencePublishJobStateOperation)
  registry.registerCommand(MACHINE_PUBLISH_COMMANDS.branchResult, setSequencePublishBranchResultOperation)
  registry.registerCommand(MACHINE_PUBLISH_COMMANDS.finish, finishSequencePublishJobOperation)

  return registry
}

/** The admin half, composed into the *application* registry by `index.ts`. */
export function registerAgentAdminOperations(
  registry: NeonOperationRegistry,
): NeonOperationRegistry {
  registry.registerQuery(
    AGENT_ADMIN_OPERATIONS.credentialDirectory,
    credentialDirectoryOperation,
  )
  registry.registerCommand(
    AGENT_ADMIN_COMMANDS.issueCredential,
    issueCredentialOperation,
  )
  registry.registerCommand(
    AGENT_ADMIN_COMMANDS.revokeCredential,
    revokeCredentialOperation,
  )
  return registry
}
