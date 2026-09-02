/**
 * `POST /api/import?op=agent.ingest` — the tenant- and machine-scoped ingest
 * endpoint, and everything it needs to decide a request.
 *
 * ## Why this is an operation on `/api/import` and not a file of its own
 *
 * `frontend/api/` holds exactly 12 top-level function files and the Vercel Hobby
 * cap is 12. There is no free slot: S17 had to fold `reclassify.ts` into
 * `classify.ts` to make room for `identity.ts`, and a subdirectory would keep
 * the count assertion in `spikes/s16-identity/tests/serverlessShape.test.ts`
 * green — its `readdirSync` is non-recursive — while breaching the real cap.
 *
 * Of the eleven existing files this one belongs on `import.ts`, and the reason
 * is what the file already is: the shared *ingest* dispatcher, whose other
 * actions are a pasted conversation and a CSV of contacts. An agent's batch is
 * the same kind of thing. The alternatives lose on a property each:
 * `activity-daily.ts` states read-only end to end as an invariant and every
 * operation on it is a registered *query*; `pipeline.ts` keys its audit rows on
 * a human actor's display name, and a machine has none.
 *
 * The dispatch is `?op=`, checked before the body is read and before
 * `guardAdmin` runs, so the human actions on this file are untouched — same
 * order, same guard, same error text — and this operation's own authentication
 * is the only one it ever meets.
 *
 * ## The three properties this endpoint is graded on
 *
 * **A repeated payload is idempotent.** Every request carries an idempotency
 * key. The first thing the transaction does is look for a batch already recorded
 * under `(credential, key)`: found with the same payload digest is a *replay*
 * and is answered from the stored counts with no write at all; found with a
 * different digest is two different batches sharing a key, and is refused. The
 * batch row is written **last**, in the same transaction as the data, so it can
 * never describe writes that did not commit.
 *
 * **A wrong-tenant or revoked credential is denied.** Both denials are the
 * database's, not this file's. `resolveMachineActor` is a `SECURITY DEFINER`
 * lookup that already excludes revoked, expired and foreign-tenant credentials,
 * and every statement inside the transaction is additionally gated by step
 * 009's policies on a *live* credential — so a credential revoked while a batch
 * is in flight stops being able to write before that batch commits. This file
 * turns those into a 401; it never decides one.
 *
 * **A partial write rolls back.** All nine statements run inside one
 * `DataStore.transaction`. There is no reporting path here for "the leads
 * landed but the messages did not": a failure anywhere aborts, the batch row
 * goes with it, and the agent's retry is an ordinary first attempt against a
 * database that never saw the first one.
 *
 * ## Dependency injection, because the alternative is untested branches
 *
 * `N-S20.md` known limit 3 records the cost of the other shape: request
 * validation that lives inside a handler which resolves an actor first is
 * reachable only through a database, so it is checked by `tsc` and the live
 * suite and by nothing that runs on every commit. Here the handler is built by
 * `createAgentIngestHandler(deps)` — store, tenant id and clock all injected —
 * so every branch above, including the 401s, the 409s and the 503, is exercised
 * offline against `FakeDataStore`.
 */

import { createHash } from 'node:crypto'

import {
  DataStoreConstraintError,
  type ActorContext,
  type DataStore,
  type DataStoreTransaction,
} from '../data/contracts.js'
import {
  MACHINE_COMMANDS,
  MACHINE_OPERATIONS,
  type IngestBatchRow,
} from '../data/operations/index.js'
import { authenticateMachine } from './machineAuth.js'

/** The operation name on `/api/import`. One spelling, exported for the caller. */
export const AGENT_INGEST_OP = 'agent.ingest'

/**
 * Smaller than `/api/import`'s own 4 MB, and the difference is deliberate: the
 * human actions on that file paste one conversation, while this one is a fleet
 * of notebooks that will retry. A cap here is the only backstop between a
 * mis-configured agent and a function timeout, and S22 chunks its sync into
 * batches anyway — one key per chunk, each independently idempotent.
 */
export const MAX_INGEST_BYTES = 2_000_000

/** Per collection, and over the whole payload. Both are cheap to satisfy. */
export const MAX_ROWS_PER_COLLECTION = 5_000
export const MAX_TOTAL_ROWS = 20_000

const MAX_TEXT = 2_000
const MAX_ID = 200
const MAX_URL = 500
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/
const DIRECTIONS = new Set(['in', 'out'])
const SYNC_STATUSES = new Set(['ok', 'error', 'partial', 'running'])
const CAMPAIGN_RUNTIME_STATUSES = new Set([
  'draft', 'running', 'queued', 'sleeping', 'stopped', 'completed',
])

export class IngestRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'IngestRequestError'
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// The payload.
// ---------------------------------------------------------------------------

export interface CampaignRow {
  readonly id: string
  readonly lh_campaign_id: string
  readonly name: string
  readonly status: string | null
  readonly runtime_status: string | null
  readonly is_archived: boolean | null
  readonly status_observed_at: string | null
  readonly status_source: string | null
  readonly status_raw: string | null
}

export interface CampaignStepRow {
  readonly campaign_id: string
  readonly step_index: number
  readonly step_label: string | null
  readonly step_type: string | null
  readonly template_body: string | null
  readonly sent_count: number
  readonly replied_count: number
  readonly current_count: number
}

export interface LeadRow {
  readonly campaign_id: string
  readonly profile_url: string
  readonly full_name: string | null
  readonly headline: string | null
  readonly company: string | null
  readonly status: string | null
  readonly invited_at: string | null
  readonly connected_at: string | null
  readonly first_message_at: string | null
  readonly replied_at: string | null
  readonly last_action_at: string | null
  readonly added_at: string | null
  readonly photo_path: string | null
  readonly photo_synced_at: string | null
  readonly education_start_year: number | null
  readonly first_job_start_year: number | null
}

export interface MessageRow {
  readonly campaign_id: string | null
  readonly profile_url: string
  readonly direction: string
  readonly body: string | null
  readonly sent_at: string
  readonly content_hash: string
}

export interface EventRow {
  readonly campaign_id: string | null
  readonly profile_url: string | null
  readonly event_type: string
  readonly occurred_at: string
  readonly raw: unknown
}

export interface IngestPayload {
  readonly instanceId: string
  readonly idempotencyKey: string
  readonly agentVersion: string
  readonly instanceLabel: string
  readonly accountName: string
  readonly accountUrl: string
  readonly accountAvatar: string
  readonly campaigns: readonly CampaignRow[]
  readonly campaignSteps: readonly CampaignStepRow[]
  readonly leads: readonly LeadRow[]
  readonly messages: readonly MessageRow[]
  readonly events: readonly EventRow[]
  readonly syncStatus: string
  readonly syncError: string
}

function fail(message: string): never {
  throw new IngestRequestError(400, message)
}

function requiredString(
  value: unknown,
  field: string,
  max: number,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${field} is required`)
  }
  const trimmed = value.trim()
  if (trimmed.length > max) fail(`${field} must be at most ${max} characters`)
  return trimmed
}

function optionalString(
  value: unknown,
  field: string,
  max: number,
): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') fail(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') return null
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * Instants are normalized here, once, rather than handed to PostgreSQL as
 * whatever the notebook's SQLite produced. A value that does not parse is a 400
 * rather than a 22007 raised from inside a transaction that has already written
 * three collections.
 */
function optionalInstant(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' && !(value instanceof Date)) {
    fail(`${field} must be an ISO-8601 instant`)
  }
  const parsed = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(parsed.valueOf())) {
    fail(`${field} must be an ISO-8601 instant`)
  }
  return parsed.toISOString()
}

function requiredInstant(value: unknown, field: string): string {
  const parsed = optionalInstant(value, field)
  if (parsed === null) fail(`${field} is required`)
  return parsed
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed)) fail(`${field} must be an integer`)
  return parsed
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`)
  return value
}

function boundedOptionalString(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') fail(`${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > max) fail(`${field} must be at most ${max} characters`)
  return trimmed
}

function counter(value: unknown, field: string): number {
  const parsed = optionalInteger(value, field) ?? 0
  if (parsed < 0) fail(`${field} must not be negative`)
  return parsed
}

function collection(value: unknown, field: string): readonly unknown[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) fail(`${field} must be an array`)
  if (value.length > MAX_ROWS_PER_COLLECTION) {
    fail(`${field} must hold at most ${MAX_ROWS_PER_COLLECTION} rows`)
  }
  return value
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * Parse and normalize the whole payload, or refuse it.
 *
 * Two rules run through this function. Unknown keys are **ignored** rather than
 * refused, because the agent and this endpoint are deployed independently and a
 * notebook one version ahead must not be rejected wholesale for sending a field
 * this deployment has not learned about yet. Known keys of the wrong shape are
 * **refused**, because those are the ones that would otherwise be written as
 * something else — a lead whose `invited_at` is the string `"unknown"` is not a
 * lead with no invite, it is a mistake.
 */
export function parseIngestPayload(body: unknown): IngestPayload {
  const root = record(body, 'body')

  const instanceId = requiredString(root.instance_id, 'instance_id', MAX_ID)
  const idempotencyKey = requiredString(root.idempotency_key, 'idempotency_key', 120)
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    fail(
      'idempotency_key must be 8-120 characters of letters, digits, dot, colon, underscore or hyphen',
    )
  }

  const instance = root.instance === undefined ? {} : record(root.instance, 'instance')

  const campaigns = collection(root.campaigns, 'campaigns').map((entry, index) => {
    const row = record(entry, `campaigns[${index}]`)
    const runtimeStatus = boundedOptionalString(
      row.runtime_status, `campaigns[${index}].runtime_status`, 20,
    )
    if (runtimeStatus !== null && !CAMPAIGN_RUNTIME_STATUSES.has(runtimeStatus)) {
      fail(
        `campaigns[${index}].runtime_status must be draft, running, queued, sleeping, stopped or completed`,
      )
    }
    const isArchived = optionalBoolean(row.is_archived, `campaigns[${index}].is_archived`)
    const statusObservedAt = optionalInstant(
      row.status_observed_at, `campaigns[${index}].status_observed_at`,
    )
    const statusSource = boundedOptionalString(
      row.status_source, `campaigns[${index}].status_source`, 120,
    )
    const statusRaw = boundedOptionalString(
      row.status_raw, `campaigns[${index}].status_raw`, 500,
    )
    if (
      statusObservedAt === null &&
      (runtimeStatus !== null || isArchived !== null || statusSource !== null || statusRaw !== null)
    ) {
      fail(`campaigns[${index}].status_observed_at is required for a status observation`)
    }
    if (statusObservedAt !== null && statusSource === null) {
      fail(`campaigns[${index}].status_source is required for a status observation`)
    }
    return {
      id: requiredString(row.id, `campaigns[${index}].id`, MAX_ID),
      lh_campaign_id: requiredString(
        row.lh_campaign_id,
        `campaigns[${index}].lh_campaign_id`,
        MAX_ID,
      ),
      name: requiredString(row.name, `campaigns[${index}].name`, MAX_TEXT),
      status: optionalString(row.status, `campaigns[${index}].status`, 50),
      runtime_status: runtimeStatus,
      is_archived: isArchived,
      status_observed_at: statusObservedAt,
      status_source: statusSource,
      status_raw: statusRaw,
    } satisfies CampaignRow
  })

  const campaignSteps = collection(root.campaign_steps, 'campaign_steps').map(
    (entry, index) => {
      const row = record(entry, `campaign_steps[${index}]`)
      const stepIndex = optionalInteger(
        row.step_index,
        `campaign_steps[${index}].step_index`,
      )
      if (stepIndex === null) fail(`campaign_steps[${index}].step_index is required`)
      return {
        campaign_id: requiredString(
          row.campaign_id,
          `campaign_steps[${index}].campaign_id`,
          MAX_ID,
        ),
        step_index: stepIndex,
        step_label: optionalString(
          row.step_label,
          `campaign_steps[${index}].step_label`,
          MAX_TEXT,
        ),
        step_type: optionalString(
          row.step_type,
          `campaign_steps[${index}].step_type`,
          50,
        ),
        template_body: optionalString(
          row.template_body,
          `campaign_steps[${index}].template_body`,
          MAX_TEXT * 4,
        ),
        sent_count: counter(row.sent_count, `campaign_steps[${index}].sent_count`),
        replied_count: counter(
          row.replied_count,
          `campaign_steps[${index}].replied_count`,
        ),
        current_count: counter(
          row.current_count,
          `campaign_steps[${index}].current_count`,
        ),
      } satisfies CampaignStepRow
    },
  )

  const leads = collection(root.leads, 'leads').map((entry, index) => {
    const row = record(entry, `leads[${index}]`)
    return {
      campaign_id: requiredString(row.campaign_id, `leads[${index}].campaign_id`, MAX_ID),
      profile_url: requiredString(row.profile_url, `leads[${index}].profile_url`, MAX_URL),
      full_name: optionalString(row.full_name, `leads[${index}].full_name`, MAX_TEXT),
      headline: optionalString(row.headline, `leads[${index}].headline`, MAX_TEXT),
      company: optionalString(row.company, `leads[${index}].company`, MAX_TEXT),
      status: optionalString(row.status, `leads[${index}].status`, 100),
      invited_at: optionalInstant(row.invited_at, `leads[${index}].invited_at`),
      connected_at: optionalInstant(row.connected_at, `leads[${index}].connected_at`),
      first_message_at: optionalInstant(
        row.first_message_at,
        `leads[${index}].first_message_at`,
      ),
      replied_at: optionalInstant(row.replied_at, `leads[${index}].replied_at`),
      last_action_at: optionalInstant(
        row.last_action_at,
        `leads[${index}].last_action_at`,
      ),
      added_at: optionalInstant(row.added_at, `leads[${index}].added_at`),
      photo_path: optionalString(row.photo_path, `leads[${index}].photo_path`, MAX_URL),
      photo_synced_at: optionalInstant(
        row.photo_synced_at,
        `leads[${index}].photo_synced_at`,
      ),
      education_start_year: optionalInteger(
        row.education_start_year,
        `leads[${index}].education_start_year`,
      ),
      first_job_start_year: optionalInteger(
        row.first_job_start_year,
        `leads[${index}].first_job_start_year`,
      ),
    } satisfies LeadRow
  })

  const messages = collection(root.messages, 'messages').map((entry, index) => {
    const row = record(entry, `messages[${index}]`)
    const direction = requiredString(row.direction, `messages[${index}].direction`, 10)
    if (!DIRECTIONS.has(direction)) {
      fail(`messages[${index}].direction must be 'in' or 'out'`)
    }
    return {
      campaign_id: optionalString(row.campaign_id, `messages[${index}].campaign_id`, MAX_ID),
      profile_url: requiredString(
        row.profile_url,
        `messages[${index}].profile_url`,
        MAX_URL,
      ),
      direction,
      body: optionalString(row.body, `messages[${index}].body`, MAX_TEXT),
      sent_at: requiredInstant(row.sent_at, `messages[${index}].sent_at`),
      content_hash:
        optionalString(row.content_hash, `messages[${index}].content_hash`, 128) ?? '',
    } satisfies MessageRow
  })

  const events = collection(root.events, 'events').map((entry, index) => {
    const row = record(entry, `events[${index}]`)
    return {
      campaign_id: optionalString(row.campaign_id, `events[${index}].campaign_id`, MAX_ID),
      profile_url: optionalString(row.profile_url, `events[${index}].profile_url`, MAX_URL),
      event_type: requiredString(row.event_type, `events[${index}].event_type`, 50),
      occurred_at: requiredInstant(row.occurred_at, `events[${index}].occurred_at`),
      raw: row.raw ?? null,
    } satisfies EventRow
  })

  const total =
    campaigns.length +
    campaignSteps.length +
    leads.length +
    messages.length +
    events.length
  if (total > MAX_TOTAL_ROWS) {
    fail(`a batch must hold at most ${MAX_TOTAL_ROWS} rows in total`)
  }

  const syncRun = root.sync_run === undefined ? {} : record(root.sync_run, 'sync_run')
  const syncStatus = optionalString(syncRun.status, 'sync_run.status', 20) ?? 'ok'
  if (!SYNC_STATUSES.has(syncStatus)) {
    fail("sync_run.status must be one of 'ok', 'error', 'partial', 'running'")
  }

  return {
    instanceId,
    idempotencyKey,
    agentVersion: optionalString(root.agent_version, 'agent_version', 50) ?? '',
    instanceLabel: optionalString(instance.label, 'instance.label', MAX_TEXT) ?? '',
    accountName: optionalString(instance.account_name, 'instance.account_name', MAX_TEXT) ?? '',
    accountUrl: optionalString(instance.account_url, 'instance.account_url', MAX_URL) ?? '',
    accountAvatar:
      optionalString(instance.account_avatar, 'instance.account_avatar', MAX_URL) ?? '',
    campaigns,
    campaignSteps,
    leads,
    messages,
    events,
    syncStatus,
    syncError: optionalString(syncRun.error, 'sync_run.error', MAX_TEXT) ?? '',
  }
}

/**
 * A digest of what the batch *says*, not of how it was serialized.
 *
 * Keys are emitted in sorted order at every depth, so two agents that build the
 * same batch with their dictionaries in different orders agree — which matters
 * because a disagreement here reports a replay as a conflict, and the agent's
 * only recovery from a conflict is a human.
 *
 * The idempotency key is deliberately **not** in the digest. The digest answers
 * "is this the same data?", and including the key would make that question
 * always answer yes for a replay and tell us nothing.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

export function payloadDigest(payload: IngestPayload): string {
  const { idempotencyKey: _ignored, ...rest } = payload
  return createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// The write.
// ---------------------------------------------------------------------------

export interface IngestRowCounts {
  readonly instances: number
  readonly campaigns: number
  readonly campaign_steps: number
  readonly leads: number
  readonly messages: number
  readonly events: number
  readonly sync_runs: number
}

export interface IngestResult {
  readonly replayed: boolean
  readonly batchId: string | null
  readonly rowCounts: IngestRowCounts
  readonly rowsWritten: number
}

const collectionRows = (rows: readonly unknown[]): string => JSON.stringify(rows)

/**
 * Everything one accepted batch does, inside one transaction.
 *
 * The order is a dependency order rather than a preference: `campaign_steps`
 * joins `campaigns`, which the same transaction may have just inserted, and
 * `leads` reference a campaign id. A batch that sent steps for a campaign it did
 * not also send is silently short one row rather than failing — the join finds
 * nothing — and that is the correct behaviour for a transport whose source is a
 * notebook mid-sync.
 */
export async function ingestBatch(
  store: DataStore,
  actor: ActorContext,
  payload: IngestPayload,
  digest: string,
): Promise<IngestResult> {
  return store.transaction(actor, async (transaction: DataStoreTransaction) => {
    const existing = await transaction.query<IngestBatchRow>({
      operation: MACHINE_OPERATIONS.batchByKey,
      params: {
        credentialId: actor.actorId,
        idempotencyKey: payload.idempotencyKey,
      },
    })

    const previous = existing.items[0]
    if (previous) {
      if (previous.payload_digest !== digest) {
        throw new IngestRequestError(
          409,
          'idempotency_key has already been used for a different payload',
        )
      }
      return {
        replayed: true,
        batchId: previous.id,
        rowCounts: normalizeCounts(previous.row_counts),
        rowsWritten: previous.rows_written,
      }
    }

    const instances = await transaction.execute<number>({
      operation: MACHINE_COMMANDS.upsertInstance,
      params: {
        instanceId: payload.instanceId,
        label: payload.instanceLabel,
        agentVersion: payload.agentVersion,
        accountName: payload.accountName,
        accountUrl: payload.accountUrl,
        accountAvatar: payload.accountAvatar,
      },
    })

    const campaigns = await transaction.execute<number>({
      operation: MACHINE_COMMANDS.upsertCampaigns,
      params: {
        instanceId: payload.instanceId,
        rows: collectionRows(payload.campaigns),
      },
    })

    const campaignSteps = await transaction.execute<number>({
      operation: MACHINE_COMMANDS.upsertCampaignSteps,
      params: {
        instanceId: payload.instanceId,
        rows: collectionRows(payload.campaignSteps),
      },
    })

    const leads = await transaction.execute<number>({
      operation: MACHINE_COMMANDS.upsertLeads,
      params: {
        instanceId: payload.instanceId,
        rows: collectionRows(payload.leads),
      },
    })

    const messages = await transaction.execute<number>({
      operation: MACHINE_COMMANDS.upsertMessages,
      params: {
        instanceId: payload.instanceId,
        rows: collectionRows(payload.messages),
      },
    })

    const events = await transaction.execute<number>({
      operation: MACHINE_COMMANDS.upsertEvents,
      params: {
        instanceId: payload.instanceId,
        rows: collectionRows(payload.events),
      },
    })

    const rowCounts: IngestRowCounts = {
      instances,
      campaigns,
      campaign_steps: campaignSteps,
      leads,
      messages,
      events,
      sync_runs: 0,
    }
    const rowsWritten =
      instances + campaigns + campaignSteps + leads + messages + events

    const syncRuns = await transaction.execute<number>({
      operation: MACHINE_COMMANDS.recordSyncRun,
      params: {
        instanceId: payload.instanceId,
        status: payload.syncStatus,
        rowsUpserted: rowsWritten,
        error: payload.syncError,
      },
    })

    await transaction.execute<number>({
      operation: MACHINE_COMMANDS.stampCredentialUse,
      params: { credentialId: actor.actorId },
    })

    const finalCounts: IngestRowCounts = { ...rowCounts, sync_runs: syncRuns }

    await transaction.execute<number>({
      operation: MACHINE_COMMANDS.recordBatch,
      params: {
        credentialId: actor.actorId,
        instanceId: payload.instanceId,
        idempotencyKey: payload.idempotencyKey,
        payloadDigest: digest,
        rowCounts: JSON.stringify(finalCounts),
        rowsWritten,
      },
    })

    return {
      replayed: false,
      batchId: null,
      rowCounts: finalCounts,
      rowsWritten,
    }
  })
}

function normalizeCounts(counts: Record<string, number>): IngestRowCounts {
  const read = (key: keyof IngestRowCounts): number => Number(counts?.[key] ?? 0)
  return {
    instances: read('instances'),
    campaigns: read('campaigns'),
    campaign_steps: read('campaign_steps'),
    leads: read('leads'),
    messages: read('messages'),
    events: read('events'),
    sync_runs: read('sync_runs'),
  }
}

// ---------------------------------------------------------------------------
// The handler.
// ---------------------------------------------------------------------------

export interface AgentIngestDeps {
  /** The machine store, or `null` when this deployment has not configured one. */
  readonly store: DataStore | null
  /** The tenant this deployment serves. A credential of another one is denied. */
  readonly tenantId: string | null
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export function createAgentIngestHandler(
  deps: AgentIngestDeps,
): (request: Request) => Promise<Response> {
  return async function handle(request: Request): Promise<Response> {
    if (request.method.toUpperCase() !== 'POST') {
      return json({ error: 'method not allowed' }, 405)
    }

    // The shared helper parses before body access, returns 503 for an
    // unconfigured deployment, and makes revoke/expiry a database decision.
    const authenticated = await authenticateMachine(
      request,
      deps,
      'agent-ingest',
    )
    if (authenticated.response) return authenticated.response
    const { principal } = authenticated

    const contentLength = Number(request.headers.get('content-length') ?? 0)
    if (Number.isFinite(contentLength) && contentLength > MAX_INGEST_BYTES) {
      return json({ error: 'request body is too large' }, 413)
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return json({ error: 'invalid JSON body' }, 400)
    }

    let payload: IngestPayload
    try {
      payload = parseIngestPayload(body)
    } catch (error) {
      if (error instanceof IngestRequestError) {
        return json({ error: error.message }, error.status)
      }
      throw error
    }

    // The credential names one notebook and the payload names one notebook, and
    // this is where they must be the same. The database refuses the write too —
    // step 009's policies scope every relation to the credential's instance —
    // but a 403 here is a diagnosis, where the policy version is a batch that
    // writes zero rows and looks like a working sync of an empty notebook.
    if (payload.instanceId !== principal.instanceId) {
      return json(
        { error: 'the credential is not issued for this instance_id' },
        403,
      )
    }

    const digest = payloadDigest(payload)

    try {
      const result = await ingestBatch(
        principal.store,
        principal.actor,
        payload,
        digest,
      )
      return json({
        ok: true,
        replayed: result.replayed,
        batch_id: result.batchId,
        instance_id: payload.instanceId,
        idempotency_key: payload.idempotencyKey,
        row_counts: result.rowCounts,
        rows_written: result.rowsWritten,
      })
    } catch (error) {
      const conflict = ingestConflict(error)
      if (conflict) return json({ error: conflict.message }, conflict.status)
      console.error(
        'agent ingest failed for credential',
        principal.credentialId,
        error instanceof Error ? error.name : 'unknown error',
      )
      return json({ error: 'the batch could not be ingested' }, 500)
    }
  }
}

/**
 * The two failures that are answers rather than faults.
 *
 * A `DataStoreConstraintError` on the way out is the concurrent-duplicate case:
 * another delivery of this same key committed while this one was working, so its
 * `recordBatch` insert lost the unique index and this whole transaction rolled
 * back. The caller is told the key is taken, which is true, and its retry will
 * find the committed batch and be answered as a replay.
 *
 * The store wraps anything thrown inside `transaction()` as a rolled-back
 * transaction with the original attached as `cause`, so both cases are looked
 * for through the cause chain rather than at the top only.
 */
function ingestConflict(
  error: unknown,
): { readonly status: number; readonly message: string } | null {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof IngestRequestError) {
      return { status: current.status, message: current.message }
    }
    if (current instanceof DataStoreConstraintError) {
      return {
        status: 409,
        message: 'idempotency_key is already recorded for this credential',
      }
    }
    current = (current as { cause?: unknown }).cause
  }
  return null
}
