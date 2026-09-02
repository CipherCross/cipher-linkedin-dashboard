/**
 * The machine ingest endpoint against the **fake** store — no credential, no
 * database, and every branch of the handler reachable.
 *
 * This file is what `N-S20.md` known limit 3 asked for. The lead-photo endpoint
 * put its request validation in a service precisely because a handler that
 * resolves an actor first cannot be called offline at all, and its dispatch, its
 * 503 and its response body stayed uncovered. `createAgentIngestHandler` takes
 * its store and its tenant as arguments, so the 401s, the 403, the 409s, the
 * 413, the 503 and the rollback are all exercised here, on every commit.
 *
 * The division of labour against `agentIngest.neon.test.ts` is the one
 * `writeSlice.test.ts` drew. Here: which operation the handler asks for, with
 * which parameters, in which order, and what it answers. There: whether the SQL
 * writes the rows, whether the policies refuse another notebook, whether the
 * transaction really rolls back in Postgres. A fake that reimplemented the
 * upserts would be asserting against itself.
 *
 * One thing the fake models deliberately: its command handlers **write into
 * `FakeState`**, so a transaction that throws is observable as state that did
 * not change. A fake whose commands only recorded their parameters could not
 * tell a rollback from a no-op.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { DataStoreConstraintError } from '../api/_lib/data/contracts.js'
import { FakeDataStore } from '../api/_lib/data/fake.js'
import { NeonDataStore } from '../api/_lib/data/neon.js'
import {
  MACHINE_COMMANDS,
  MACHINE_OPERATIONS,
} from '../api/_lib/data/operations/index.js'
import {
  AGENT_INGEST_OP,
  MAX_INGEST_BYTES,
  MAX_ROWS_PER_COLLECTION,
  MAX_TOTAL_ROWS,
  canonicalJson,
  createAgentIngestHandler,
  parseIngestPayload,
  payloadDigest,
} from '../api/_lib/agent/ingest.js'
import {
  AGENT_TOKEN_PREFIX,
  AgentCredentialError,
  formatAgentToken,
  generateAgentSecret,
  hashAgentSecret,
  issueAgentCredential,
  listAgentCredentials,
  parseAgentToken,
  parseIssueInput,
  parseRevokeInput,
  revokeAgentCredential,
  secretHashMatches,
  tokenFromAuthorization,
} from '../api/_lib/agent/credentials.js'
import {
  APP_TENANT_ID_ENV,
  OBJECT_STORAGE_TENANT_ID_ENV,
  TenantConfigurationError,
  readDeploymentTenantId,
} from '../api/_lib/agent/tenant.js'
import {
  AGENT_ADMIN_COMMANDS,
  AGENT_ADMIN_OPERATIONS,
  buildMachineRegistry,
} from '../api/_lib/data/operations/index.js'
import { upsertCampaignsOperation } from '../api/_lib/data/operations/agentIngest.js'

const TENANT = 'acme'
const OTHER_TENANT = 'contoso'
const INSTANCE = 'notebook-1'
const OTHER_INSTANCE = 'notebook-2'
const CREDENTIAL_ID = '9f1b0000-0000-4000-8000-00000000c001'
const SECRET = 'A'.repeat(43)
const TOKEN = formatAgentToken(CREDENTIAL_ID, SECRET)
const ADMIN_ACTOR = {
  kind: 'user' as const,
  actorId: '00000000-0000-0000-0000-0000000000a2',
  tenantId: 'primary',
  role: 'admin' as const,
}

interface Recorded {
  readonly operation: string
  readonly params: Record<string, unknown>
}

interface StoredBatch {
  readonly id: string
  readonly payload_digest: string
  readonly row_counts: Record<string, number>
  readonly rows_written: number
  readonly credential_id: string
  readonly idempotency_key: string
}

interface Harness {
  readonly store: FakeDataStore
  readonly executed: Recorded[]
  readonly handler: (request: Request) => Promise<Response>
}

/** Operations that should throw instead of answering, and what they throw. */
let failing: Map<string, () => never>

function harness(
  options: {
    readonly tenantId?: string | null
    readonly store?: FakeDataStore | null
  } = {},
): Harness {
  const store = options.store === undefined ? new FakeDataStore() : options.store
  const executed: Recorded[] = []

  if (store) {
    store.seedMachineActor(CREDENTIAL_ID, hashAgentSecret(SECRET), TENANT, {
      credentialId: CREDENTIAL_ID,
      instanceId: INSTANCE,
      tenantId: TENANT,
    })

    store.seed('batches', [] as StoredBatch[])
    store.seed('rows', {} as Record<string, unknown[]>)

    store.registerQuery(MACHINE_OPERATIONS.batchByKey, ({ params, state }) => {
      const batches = state.read<StoredBatch[]>('batches') ?? []
      return batches.filter(
        (batch) =>
          batch.credential_id === params?.credentialId &&
          batch.idempotency_key === params?.idempotencyKey,
      )
    })

    const command = (operation: string, rows: (params: Record<string, unknown>) => number) => {
      store.registerCommand(operation, ({ params, state }) => {
        const bound = (params ?? {}) as Record<string, unknown>
        executed.push({ operation, params: bound })
        const thrower = failing.get(operation)
        if (thrower) thrower()
        const written = state.read<Record<string, unknown[]>>('rows') ?? {}
        state.write('rows', { ...written, [operation]: [bound] })
        return rows(bound)
      })
    }

    const countRows = (params: Record<string, unknown>): number =>
      Array.isArray(JSON.parse(String(params.rows ?? '[]')))
        ? (JSON.parse(String(params.rows ?? '[]')) as unknown[]).length
        : 0

    command(MACHINE_COMMANDS.upsertInstance, () => 1)
    command(MACHINE_COMMANDS.upsertCampaigns, countRows)
    command(MACHINE_COMMANDS.upsertCampaignSteps, countRows)
    command(MACHINE_COMMANDS.upsertLeads, countRows)
    command(MACHINE_COMMANDS.upsertMessages, countRows)
    command(MACHINE_COMMANDS.upsertEvents, countRows)
    command(MACHINE_COMMANDS.recordSyncRun, () => 1)
    command(MACHINE_COMMANDS.stampCredentialUse, () => 1)

    store.registerCommand(MACHINE_COMMANDS.recordBatch, ({ params, state }) => {
      const bound = (params ?? {}) as Record<string, unknown>
      executed.push({ operation: MACHINE_COMMANDS.recordBatch, params: bound })
      const thrower = failing.get(MACHINE_COMMANDS.recordBatch)
      if (thrower) thrower()
      const batches = state.read<StoredBatch[]>('batches') ?? []
      // The unique index, as the database applies it.
      if (
        batches.some(
          (batch) =>
            batch.credential_id === bound.credentialId &&
            batch.idempotency_key === bound.idempotencyKey,
        )
      ) {
        throw new DataStoreConstraintError('unique', 'agent_ingest_batch key exists')
      }
      state.write('batches', [
        ...batches,
        {
          id: `batch-${batches.length + 1}`,
          credential_id: String(bound.credentialId),
          idempotency_key: String(bound.idempotencyKey),
          payload_digest: String(bound.payloadDigest),
          row_counts: JSON.parse(String(bound.rowCounts ?? '{}')),
          rows_written: Number(bound.rowsWritten ?? 0),
        },
      ])
      return 1
    })
  }

  const handler = createAgentIngestHandler({
    store,
    tenantId: options.tenantId === undefined ? TENANT : options.tenantId,
  })

  return { store: store as FakeDataStore, executed, handler }
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance_id: INSTANCE,
    idempotency_key: 'sync-2026-08-07-0001',
    agent_version: '2.0.0',
    instance: { label: 'Notebook One', account_name: 'A Person' },
    campaigns: [
      { id: `${INSTANCE}:42`, lh_campaign_id: '42', name: 'Outreach', status: 'active' },
    ],
    campaign_steps: [
      { campaign_id: `${INSTANCE}:42`, step_index: 0, step_label: 'Invite', sent_count: 3 },
    ],
    leads: [
      {
        campaign_id: `${INSTANCE}:42`,
        profile_url: 'https://example.invalid/in/one',
        full_name: 'One Person',
        invited_at: '2026-08-01T10:00:00Z',
      },
      {
        campaign_id: `${INSTANCE}:42`,
        profile_url: 'https://example.invalid/in/two',
        connected_at: '2026-08-02T10:00:00Z',
      },
    ],
    messages: [
      {
        profile_url: 'https://example.invalid/in/one',
        direction: 'in',
        body: 'Hello',
        sent_at: '2026-08-03T10:00:00Z',
        content_hash: 'abc',
      },
    ],
    events: [
      {
        campaign_id: `${INSTANCE}:42`,
        profile_url: 'https://example.invalid/in/one',
        event_type: 'invited',
        occurred_at: '2026-08-01T10:00:00Z',
      },
    ],
    sync_run: { status: 'ok' },
    ...overrides,
  }
}

function request(
  payload: unknown,
  init: { readonly token?: string | null; readonly method?: string; readonly length?: number } = {},
): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  const token = init.token === undefined ? TOKEN : init.token
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (init.length !== undefined) headers.set('content-length', String(init.length))
  return new Request(`https://dashboard.invalid/api/import?op=${AGENT_INGEST_OP}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.method === 'GET' ? undefined : JSON.stringify(payload),
  })
}

beforeEach(() => {
  failing = new Map()
})

describe('the token', () => {
  it('round-trips through format and parse', () => {
    const parsed = parseAgentToken(TOKEN)
    expect(parsed).toEqual({ credentialId: CREDENTIAL_ID, secret: SECRET })
  })

  it('names its prefix in the token it formats', () => {
    expect(TOKEN.startsWith(`${AGENT_TOKEN_PREFIX}.`)).toBe(true)
  })

  it('refuses a wrong prefix, a bad id, a short secret and a spare separator', () => {
    expect(parseAgentToken(`xxx.${CREDENTIAL_ID}.${SECRET}`)).toBeNull()
    expect(parseAgentToken(`${AGENT_TOKEN_PREFIX}.not-a-uuid.${SECRET}`)).toBeNull()
    expect(parseAgentToken(`${AGENT_TOKEN_PREFIX}.${CREDENTIAL_ID}.short`)).toBeNull()
    expect(parseAgentToken(`${TOKEN}.extra`)).toBeNull()
  })

  /**
   * The regression that made the separator a dot. `randomBytes(32)` in base64url
   * carries an underscore or a hyphen in about three tokens out of four, so an
   * underscore separator refused most of what this process itself issued — and
   * the fixed 'AAAA…' secret every other test uses could never have shown it.
   */
  it('parses a token whose real secret contains base64url separators', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const secret = generateAgentSecret()
      const parsed = parseAgentToken(formatAgentToken(CREDENTIAL_ID, secret))
      expect(parsed).toEqual({ credentialId: CREDENTIAL_ID, secret })
    }
  })

  it('refuses a non-string and an empty string', () => {
    expect(parseAgentToken(undefined)).toBeNull()
    expect(parseAgentToken(null)).toBeNull()
    expect(parseAgentToken(42)).toBeNull()
    expect(parseAgentToken('')).toBeNull()
  })

  it('reads a bearer header, case-insensitively, and refuses other schemes', () => {
    expect(tokenFromAuthorization(`Bearer ${TOKEN}`)?.credentialId).toBe(CREDENTIAL_ID)
    expect(tokenFromAuthorization(`bearer ${TOKEN}`)?.credentialId).toBe(CREDENTIAL_ID)
    expect(tokenFromAuthorization(`Basic ${TOKEN}`)).toBeNull()
    expect(tokenFromAuthorization(TOKEN)).toBeNull()
    expect(tokenFromAuthorization(null)).toBeNull()
  })

  it('generates 43-character base64url secrets that differ every time', () => {
    const first = generateAgentSecret()
    const second = generateAgentSecret()
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first).not.toEqual(second)
  })

  it('hashes to lowercase hex and is stable', () => {
    expect(hashAgentSecret(SECRET)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashAgentSecret(SECRET)).toBe(hashAgentSecret(SECRET))
    expect(hashAgentSecret(SECRET)).not.toBe(hashAgentSecret(`${SECRET}x`))
  })

  it('compares hashes without throwing on a length mismatch', () => {
    const hash = hashAgentSecret(SECRET)
    expect(secretHashMatches(hash, hash)).toBe(true)
    expect(secretHashMatches(hash, hashAgentSecret('other'))).toBe(false)
    expect(secretHashMatches(hash, 'short')).toBe(false)
    expect(secretHashMatches(hash, 42 as unknown as string)).toBe(false)
  })
})

describe('the deployment tenant', () => {
  it('is null when neither name is set', () => {
    expect(readDeploymentTenantId({})).toBeNull()
  })

  it('reads either name alone', () => {
    expect(readDeploymentTenantId({ [APP_TENANT_ID_ENV]: TENANT })).toBe(TENANT)
    expect(readDeploymentTenantId({ [OBJECT_STORAGE_TENANT_ID_ENV]: TENANT })).toBe(TENANT)
  })

  it('accepts both when they agree', () => {
    expect(
      readDeploymentTenantId({
        [APP_TENANT_ID_ENV]: TENANT,
        [OBJECT_STORAGE_TENANT_ID_ENV]: TENANT,
      }),
    ).toBe(TENANT)
  })

  it('refuses both when they name different tenants', () => {
    expect(() =>
      readDeploymentTenantId({
        [APP_TENANT_ID_ENV]: TENANT,
        [OBJECT_STORAGE_TENANT_ID_ENV]: OTHER_TENANT,
      }),
    ).toThrow(TenantConfigurationError)
  })

  it('refuses a malformed value under either name', () => {
    expect(() => readDeploymentTenantId({ [APP_TENANT_ID_ENV]: 'Acme Corp' })).toThrow(
      TenantConfigurationError,
    )
    expect(() =>
      readDeploymentTenantId({ [OBJECT_STORAGE_TENANT_ID_ENV]: '-leading' }),
    ).toThrow(TenantConfigurationError)
  })
})

describe('the payload', () => {
  it('accepts the six exact Linked Helper runtime states and keeps archive separate', () => {
    const statuses = ['draft', 'running', 'queued', 'sleeping', 'stopped', 'completed']
    const parsed = parseIngestPayload(body({
      campaigns: statuses.map((runtimeStatus, index) => ({
        id: `${INSTANCE}:${index}`,
        lh_campaign_id: String(index),
        name: `Campaign ${index}`,
        status: 'legacy-value-is-diagnostic-only',
        runtime_status: runtimeStatus,
        is_archived: index === statuses.length - 1,
        status_observed_at: '2026-09-01T14:00:00+02:00',
        status_source: 'fixture-build-v1',
        status_raw: JSON.stringify({ runtime: runtimeStatus }),
      })),
    }))

    expect(parsed.campaigns.map((campaign) => campaign.runtime_status)).toEqual(statuses)
    expect(parsed.campaigns.at(-1)?.is_archived).toBe(true)
    expect(parsed.campaigns[0].is_archived).toBe(false)
    expect(parsed.campaigns[0].status_observed_at).toBe('2026-09-01T12:00:00.000Z')
  })

  it('keeps a legacy-agent campaign unknown instead of inventing Active', () => {
    const parsed = parseIngestPayload(body())
    expect(parsed.campaigns[0]).toMatchObject({
      runtime_status: null,
      is_archived: null,
      status_observed_at: null,
      status_source: null,
      status_raw: null,
    })
  })

  it('refuses guessed or malformed campaign status observations', () => {
    const campaign = (patch: Record<string, unknown>) => ({
      id: `${INSTANCE}:42`, lh_campaign_id: '42', name: 'Outreach',
      runtime_status: 'running', is_archived: false,
      status_observed_at: '2026-09-01T12:00:00Z', status_source: 'fixture-v1',
      ...patch,
    })
    expect(() => parseIngestPayload(body({ campaigns: [campaign({ runtime_status: 'active' })] })))
      .toThrow(/runtime_status/)
    expect(() => parseIngestPayload(body({ campaigns: [campaign({ is_archived: 0 })] })))
      .toThrow(/is_archived/)
    expect(() => parseIngestPayload(body({ campaigns: [campaign({ status_observed_at: 'recently' })] })))
      .toThrow(/status_observed_at/)
    expect(() => parseIngestPayload(body({ campaigns: [campaign({ status_source: null })] })))
      .toThrow(/status_source/)
    expect(() => parseIngestPayload(body({ campaigns: [campaign({ status_source: 's'.repeat(121) })] })))
      .toThrow(/120/)
    expect(() => parseIngestPayload(body({ campaigns: [campaign({ status_raw: 'r'.repeat(501) })] })))
      .toThrow(/500/)
    expect(() => parseIngestPayload(body({ campaigns: [campaign({ status_observed_at: null })] })))
      .toThrow(/status_observed_at is required/)
  })

  it('normalizes every instant to UTC', () => {
    const parsed = parseIngestPayload(
      body({
        leads: [
          {
            campaign_id: `${INSTANCE}:42`,
            profile_url: 'https://example.invalid/in/one',
            invited_at: '2026-08-01T12:00:00+02:00',
          },
        ],
      }),
    )
    expect(parsed.leads[0].invited_at).toBe('2026-08-01T10:00:00.000Z')
  })

  it('ignores an unknown key rather than refusing the batch', () => {
    const parsed = parseIngestPayload(
      body({
        leads: [
          {
            campaign_id: `${INSTANCE}:42`,
            profile_url: 'https://example.invalid/in/one',
            a_field_from_a_newer_agent: 'whatever',
          },
        ],
      }),
    )
    expect(Object.keys(parsed.leads[0])).not.toContain('a_field_from_a_newer_agent')
  })

  it('refuses a known key of the wrong shape', () => {
    expect(() =>
      parseIngestPayload(
        body({
          leads: [
            {
              campaign_id: `${INSTANCE}:42`,
              profile_url: 'https://example.invalid/in/one',
              invited_at: 'unknown',
            },
          ],
        }),
      ),
    ).toThrow(/invited_at/)
  })

  it('requires instance_id and an idempotency key of the declared grammar', () => {
    expect(() => parseIngestPayload(body({ instance_id: '' }))).toThrow(/instance_id/)
    expect(() => parseIngestPayload(body({ idempotency_key: 'short' }))).toThrow(
      /idempotency_key/,
    )
    expect(() => parseIngestPayload(body({ idempotency_key: 'has spaces here' }))).toThrow(
      /idempotency_key/,
    )
    expect(() => parseIngestPayload(body({ idempotency_key: '_leading-underscore' }))).toThrow(
      /idempotency_key/,
    )
  })

  it('refuses a collection that is not an array', () => {
    expect(() => parseIngestPayload(body({ leads: { nope: true } }))).toThrow(/leads/)
  })

  it('treats an absent collection as empty', () => {
    const parsed = parseIngestPayload({
      instance_id: INSTANCE,
      idempotency_key: 'sync-2026-08-07-0001',
    })
    expect(parsed.leads).toEqual([])
    expect(parsed.messages).toEqual([])
    expect(parsed.syncStatus).toBe('ok')
  })

  it('caps a single collection', () => {
    const leads = Array.from({ length: MAX_ROWS_PER_COLLECTION + 1 }, (_unused, index) => ({
      campaign_id: `${INSTANCE}:42`,
      profile_url: `https://example.invalid/in/${index}`,
    }))
    expect(() => parseIngestPayload(body({ leads }))).toThrow(
      new RegExp(String(MAX_ROWS_PER_COLLECTION)),
    )
  })

  it('caps the whole batch even when no single collection is over', () => {
    const rows = (count: number, build: (index: number) => unknown) =>
      Array.from({ length: count }, (_unused, index) => build(index))
    const each = MAX_ROWS_PER_COLLECTION
    expect(() =>
      parseIngestPayload(
        body({
          leads: rows(each, (index) => ({
            campaign_id: `${INSTANCE}:42`,
            profile_url: `https://example.invalid/in/${index}`,
          })),
          messages: rows(each, (index) => ({
            profile_url: `https://example.invalid/in/${index}`,
            direction: 'in',
            sent_at: '2026-08-03T10:00:00Z',
          })),
          events: rows(each, (index) => ({
            profile_url: `https://example.invalid/in/${index}`,
            event_type: 'invited',
            occurred_at: '2026-08-01T10:00:00Z',
          })),
          campaign_steps: rows(each, (index) => ({
            campaign_id: `${INSTANCE}:42`,
            step_index: index,
          })),
          campaigns: rows(each, (index) => ({
            id: `${INSTANCE}:${index}`,
            lh_campaign_id: String(index),
            name: 'Campaign',
          })),
        }),
      ),
    ).toThrow(new RegExp(String(MAX_TOTAL_ROWS)))
  })

  it('refuses a direction that is neither in nor out', () => {
    expect(() =>
      parseIngestPayload(
        body({
          messages: [
            {
              profile_url: 'https://example.invalid/in/one',
              direction: 'sideways',
              sent_at: '2026-08-03T10:00:00Z',
            },
          ],
        }),
      ),
    ).toThrow(/direction/)
  })

  it('requires a message to carry the instant its identity key is built from', () => {
    expect(() =>
      parseIngestPayload(
        body({
          messages: [{ profile_url: 'https://example.invalid/in/one', direction: 'in' }],
        }),
      ),
    ).toThrow(/sent_at/)
  })

  it('refuses an unknown sync status and a negative counter', () => {
    expect(() => parseIngestPayload(body({ sync_run: { status: 'weird' } }))).toThrow(
      /sync_run.status/,
    )
    expect(() =>
      parseIngestPayload(
        body({
          campaign_steps: [
            { campaign_id: `${INSTANCE}:42`, step_index: 0, sent_count: -1 },
          ],
        }),
      ),
    ).toThrow(/sent_count/)
  })

  it('requires an object body', () => {
    expect(() => parseIngestPayload([])).toThrow(/body/)
    expect(() => parseIngestPayload(null)).toThrow(/body/)
    expect(() => parseIngestPayload('a string')).toThrow(/body/)
  })
})

describe('the campaign upsert contract', () => {
  const sql = upsertCampaignsOperation.build({
    actor: { kind: 'machine', actorId: CREDENTIAL_ID, tenantId: TENANT, role: 'machine' },
    params: { instanceId: INSTANCE, rows: '[]' },
  }).text

  it('defaults only the legacy diagnostic field to unknown, never active', () => {
    expect(sql).toContain("COALESCE(NULLIF(r.status, ''), 'unknown')")
    expect(sql).not.toMatch(/COALESCE\([^)]*['\"]active['\"]/)
  })

  it('replaces an observation only when the incoming timestamp is at least as new', () => {
    expect(sql.match(/EXCLUDED\.status_observed_at >= public\.campaigns\.status_observed_at/g))
      .toHaveLength(5)
    for (const field of ['runtime_status', 'is_archived', 'status_source', 'status_raw', 'status_observed_at']) {
      expect(sql).toContain(`ELSE public.campaigns.${field} END`)
    }
  })
})

describe('the payload digest', () => {
  it('is independent of key order at every depth', () => {
    const left = canonicalJson({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })
    const right = canonicalJson({ a: { c: [{ e: 4, f: 3 }], d: 2 }, b: 1 })
    expect(left).toBe(right)
  })

  it('preserves array order, which is not a set', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it('drops undefined and renders null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
  })

  it('ignores the idempotency key, so a replay compares the data', () => {
    const first = payloadDigest(parseIngestPayload(body({ idempotency_key: 'batch-000001' })))
    const second = payloadDigest(parseIngestPayload(body({ idempotency_key: 'batch-000002' })))
    expect(first).toBe(second)
  })

  it('changes when any row changes', () => {
    const base = payloadDigest(parseIngestPayload(body()))
    const changed = payloadDigest(
      parseIngestPayload(
        body({
          leads: [
            {
              campaign_id: `${INSTANCE}:42`,
              profile_url: 'https://example.invalid/in/one',
              full_name: 'A Different Person',
            },
          ],
        }),
      ),
    )
    expect(changed).not.toBe(base)
  })
})

describe('the handler: refusals', () => {
  it('refuses a request with no credential, and names the scheme', async () => {
    const { handler, executed } = harness()
    const response = await handler(request(body(), { token: null }))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toMatch(/Bearer/)
    expect(executed).toEqual([])
  })

  it('refuses a malformed token before it reads a body', async () => {
    const { handler, executed } = harness()
    const response = await handler(request(body(), { token: 'not-a-token' }))
    expect(response.status).toBe(401)
    expect(executed).toEqual([])
  })

  it('refuses an unknown credential', async () => {
    const { handler } = harness()
    const other = formatAgentToken('9f1b0000-0000-4000-8000-00000000c999', SECRET)
    const response = await handler(request(body(), { token: other }))
    expect(response.status).toBe(401)
  })

  it('refuses the right credential with the wrong secret', async () => {
    const { handler } = harness()
    const wrong = formatAgentToken(CREDENTIAL_ID, 'B'.repeat(43))
    const response = await handler(request(body(), { token: wrong }))
    expect(response.status).toBe(401)
  })

  it('refuses a credential issued for another tenant', async () => {
    const { handler } = harness({ tenantId: OTHER_TENANT })
    const response = await handler(request(body()))
    expect(response.status).toBe(401)
  })

  it('refuses a revoked credential', async () => {
    const { handler, store } = harness()
    store.revokeMachineActor(CREDENTIAL_ID, hashAgentSecret(SECRET), TENANT)
    const response = await handler(request(body()))
    expect(response.status).toBe(401)
  })

  it('refuses a batch for an instance the credential was not issued for', async () => {
    const { handler, executed } = harness()
    const response = await handler(request(body({ instance_id: OTHER_INSTANCE })))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'the credential is not issued for this instance_id',
    })
    expect(executed).toEqual([])
  })

  it('answers 503 rather than 401 when the deployment has no machine store', async () => {
    const { handler } = harness({ store: null })
    const response = await handler(request(body()))
    expect(response.status).toBe(503)
  })

  it('answers 503 when the deployment declares no tenant', async () => {
    const { handler } = harness({ tenantId: null })
    const response = await handler(request(body()))
    expect(response.status).toBe(503)
  })

  it('refuses a method other than POST', async () => {
    const { handler } = harness()
    const response = await handler(request(body(), { method: 'GET' }))
    expect(response.status).toBe(405)
  })

  it('refuses an over-large body by its declared length', async () => {
    const { handler, executed } = harness()
    const response = await handler(request(body(), { length: MAX_INGEST_BYTES + 1 }))
    expect(response.status).toBe(413)
    expect(executed).toEqual([])
  })

  it('refuses a body that is not JSON', async () => {
    const { handler } = harness()
    const broken = new Request(
      `https://dashboard.invalid/api/import?op=${AGENT_INGEST_OP}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: '{not json',
      },
    )
    const response = await handler(broken)
    expect(response.status).toBe(400)
  })

  it('reports a validation failure as a 400 that names the field', async () => {
    const { handler } = harness()
    const response = await handler(request(body({ idempotency_key: 'x' })))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/idempotency_key/)
  })
})

describe('the handler: an accepted batch', () => {
  it('writes every collection and answers with the counts', async () => {
    const { handler, executed } = harness()
    const response = await handler(request(body()))
    expect(response.status).toBe(200)
    const answered = await response.json()
    expect(answered.ok).toBe(true)
    expect(answered.replayed).toBe(false)
    expect(answered.instance_id).toBe(INSTANCE)
    expect(answered.row_counts).toEqual({
      instances: 1,
      campaigns: 1,
      campaign_steps: 1,
      leads: 2,
      messages: 1,
      events: 1,
      sync_runs: 1,
    })
    expect(answered.rows_written).toBe(7)
    expect(executed.map((entry) => entry.operation)).toEqual([
      MACHINE_COMMANDS.upsertInstance,
      MACHINE_COMMANDS.upsertCampaigns,
      MACHINE_COMMANDS.upsertCampaignSteps,
      MACHINE_COMMANDS.upsertLeads,
      MACHINE_COMMANDS.upsertMessages,
      MACHINE_COMMANDS.upsertEvents,
      MACHINE_COMMANDS.recordSyncRun,
      MACHINE_COMMANDS.stampCredentialUse,
      MACHINE_COMMANDS.recordBatch,
    ])
  })

  it('records the batch last, with the digest of the payload', async () => {
    const { handler, executed } = harness()
    await handler(request(body()))
    const recorded = executed[executed.length - 1]
    expect(recorded.operation).toBe(MACHINE_COMMANDS.recordBatch)
    expect(recorded.params.payloadDigest).toBe(payloadDigest(parseIngestPayload(body())))
    expect(recorded.params.credentialId).toBe(CREDENTIAL_ID)
    expect(recorded.params.instanceId).toBe(INSTANCE)
  })

  it('stamps the credential inside the same transaction', async () => {
    const { handler, executed } = harness()
    await handler(request(body()))
    const stamp = executed.find(
      (entry) => entry.operation === MACHINE_COMMANDS.stampCredentialUse,
    )
    expect(stamp?.params.credentialId).toBe(CREDENTIAL_ID)
  })

  it('sends every collection as one bound jsonb parameter', async () => {
    const { handler, executed } = harness()
    await handler(request(body()))
    const leads = executed.find((entry) => entry.operation === MACHINE_COMMANDS.upsertLeads)
    expect(typeof leads?.params.rows).toBe('string')
    expect(JSON.parse(String(leads?.params.rows))).toHaveLength(2)
    expect(leads?.params.instanceId).toBe(INSTANCE)
  })

  it('carries the notebook that was authenticated, never the one that was sent', async () => {
    // Both agree here; the point is which one reaches the parameters. The 403
    // test above covers the case where they disagree.
    const { handler, executed } = harness()
    await handler(request(body()))
    for (const entry of executed) {
      if ('instanceId' in entry.params) {
        expect(entry.params.instanceId).toBe(INSTANCE)
      }
    }
  })
})

describe('the handler: idempotency', () => {
  it('answers a repeated payload from the stored counts, writing nothing', async () => {
    const { handler, executed, store } = harness()
    await handler(request(body()))
    const afterFirst = executed.length
    const stored = store.read<StoredBatch[]>('batches') ?? []

    const response = await handler(request(body()))
    expect(response.status).toBe(200)
    const answered = await response.json()
    expect(answered.replayed).toBe(true)
    expect(answered.batch_id).toBe(stored[0].id)
    expect(answered.row_counts).toEqual(stored[0].row_counts)
    expect(answered.rows_written).toBe(stored[0].rows_written)
    expect(executed).toHaveLength(afterFirst)
    expect(store.read<StoredBatch[]>('batches')).toHaveLength(1)
  })

  it('is idempotent however many times the batch arrives', async () => {
    const { handler, store } = harness()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await handler(request(body()))
      expect(response.status).toBe(200)
    }
    expect(store.read<StoredBatch[]>('batches')).toHaveLength(1)
  })

  it('refuses the same key carrying different data', async () => {
    const { handler, store } = harness()
    await handler(request(body()))
    const response = await handler(
      request(
        body({
          leads: [
            {
              campaign_id: `${INSTANCE}:42`,
              profile_url: 'https://example.invalid/in/three',
            },
          ],
        }),
      ),
    )
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/different payload/)
    expect(store.read<StoredBatch[]>('batches')).toHaveLength(1)
  })

  it('treats a different key with the same data as a new batch', async () => {
    const { handler, store } = harness()
    await handler(request(body()))
    const response = await handler(request(body({ idempotency_key: 'sync-2026-08-07-0002' })))
    expect(response.status).toBe(200)
    expect((await response.json()).replayed).toBe(false)
    expect(store.read<StoredBatch[]>('batches')).toHaveLength(2)
  })

  it('reports a batch that raced to the same key as a conflict, not a success', async () => {
    const { handler, store } = harness()
    failing.set(MACHINE_COMMANDS.recordBatch, () => {
      throw new DataStoreConstraintError('unique', 'agent_ingest_batch key exists')
    })
    const response = await handler(request(body()))
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/already recorded/)
    expect(store.read<StoredBatch[]>('batches')).toEqual([])
  })
})

describe('the handler: atomicity', () => {
  it('rolls the whole batch back when one collection fails', async () => {
    const { handler, store } = harness()
    failing.set(MACHINE_COMMANDS.upsertMessages, () => {
      throw new Error('deadlock detected')
    })

    const response = await handler(request(body()))
    expect(response.status).toBe(500)
    // Everything the transaction did before the failure is gone: no rows, and
    // above all no batch record, so the agent's retry is a first attempt.
    expect(store.read<Record<string, unknown[]>>('rows')).toEqual({})
    expect(store.read<StoredBatch[]>('batches')).toEqual([])
  })

  it('lets the same key succeed after a rolled-back attempt', async () => {
    const { handler, store } = harness()
    failing.set(MACHINE_COMMANDS.upsertLeads, () => {
      throw new Error('connection reset')
    })
    expect((await handler(request(body()))).status).toBe(500)

    failing.clear()
    const response = await handler(request(body()))
    expect(response.status).toBe(200)
    expect((await response.json()).replayed).toBe(false)
    expect(store.read<StoredBatch[]>('batches')).toHaveLength(1)
  })

  it('reports no driver text in the body of a failure', async () => {
    const { handler } = harness()
    failing.set(MACHINE_COMMANDS.upsertEvents, () => {
      throw new Error('duplicate key value violates unique constraint "events_pkey"')
    })
    const response = await handler(request(body()))
    expect(response.status).toBe(500)
    const answered = await response.json()
    expect(answered).toEqual({ error: 'the batch could not be ingested' })
  })
})

describe('the credential lifecycle', () => {
  function adminHarness(): {
    readonly store: FakeDataStore
    readonly issued: Record<string, unknown>[]
  } {
    const store = new FakeDataStore()
    const issued: Record<string, unknown>[] = []
    store.registerCommand(AGENT_ADMIN_COMMANDS.issueCredential, ({ params }) => {
      const bound = (params ?? {}) as Record<string, unknown>
      issued.push(bound)
      return {
        id: CREDENTIAL_ID,
        tenant_id: String(bound.tenantId),
        instance_id: String(bound.instanceId),
        label: String(bound.label ?? ''),
        created_at: '2026-08-07T10:00:00.000Z',
        expires_at: bound.expiresAt === '' ? null : String(bound.expiresAt),
      }
    })
    store.registerCommand(AGENT_ADMIN_COMMANDS.revokeCredential, ({ params }) => {
      const bound = (params ?? {}) as Record<string, unknown>
      if (bound.credentialId !== CREDENTIAL_ID) return null
      return {
        id: CREDENTIAL_ID,
        instance_id: INSTANCE,
        revoked_at: '2026-08-07T11:00:00.000Z',
        revoked_reason: bound.reason === '' ? null : String(bound.reason),
      }
    })
    store.registerQuery(AGENT_ADMIN_OPERATIONS.credentialDirectory, () => [
      { id: CREDENTIAL_ID, instance_id: INSTANCE, tenant_id: TENANT },
    ])
    return { store, issued }
  }

  it('sends only the hash of a secret it returns exactly once', async () => {
    const { store, issued } = adminHarness()
    const result = await issueAgentCredential(store, ADMIN_ACTOR, {
      tenantId: TENANT,
      instanceId: INSTANCE,
      label: 'Notebook One',
    })

    const parsed = parseAgentToken(result.token)
    expect(parsed?.credentialId).toBe(CREDENTIAL_ID)
    expect(issued[0].secretHash).toBe(hashAgentSecret(String(parsed?.secret)))
    // The secret itself must not appear in anything that was sent.
    expect(JSON.stringify(issued)).not.toContain(String(parsed?.secret))
  })

  it('issues a different secret every time', async () => {
    const { store } = adminHarness()
    const first = await issueAgentCredential(store, ADMIN_ACTOR, {
      tenantId: TENANT,
      instanceId: INSTANCE,
    })
    const second = await issueAgentCredential(store, ADMIN_ACTOR, {
      tenantId: TENANT,
      instanceId: INSTANCE,
    })
    expect(first.token).not.toBe(second.token)
  })

  it('answers null for an id that names no credential', async () => {
    const { store } = adminHarness()
    const revoked = await revokeAgentCredential(
      store,
      ADMIN_ACTOR,
      '9f1b0000-0000-4000-8000-00000000c999',
      '',
    )
    expect(revoked).toBeNull()
  })

  it('passes a revocation reason through and normalizes an empty one', async () => {
    const { store } = adminHarness()
    const revoked = await revokeAgentCredential(store, ADMIN_ACTOR, CREDENTIAL_ID, 'retired')
    expect(revoked?.revoked_reason).toBe('retired')
    const bare = await revokeAgentCredential(store, ADMIN_ACTOR, CREDENTIAL_ID, '')
    expect(bare?.revoked_reason).toBeNull()
  })

  it('lists credentials through the admin projection', async () => {
    const { store } = adminHarness()
    const rows = await listAgentCredentials(store, ADMIN_ACTOR)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(CREDENTIAL_ID)
  })

  it('validates an issue request before it reaches the database', () => {
    expect(() => parseIssueInput({ tenant_id: 'Acme', instance_id: INSTANCE })).toThrow(
      AgentCredentialError,
    )
    expect(() => parseIssueInput({ tenant_id: TENANT, instance_id: '' })).toThrow(
      AgentCredentialError,
    )
    expect(() =>
      parseIssueInput({ tenant_id: TENANT, instance_id: INSTANCE, label: 'x'.repeat(201) }),
    ).toThrow(AgentCredentialError)
    expect(() =>
      parseIssueInput({ tenant_id: TENANT, instance_id: INSTANCE, expires_at: 'never' }),
    ).toThrow(AgentCredentialError)
    expect(() => parseIssueInput([])).toThrow(AgentCredentialError)
  })

  it('normalizes an expiry to UTC and treats an absent one as none', () => {
    expect(
      parseIssueInput({
        tenant_id: TENANT,
        instance_id: INSTANCE,
        expires_at: '2026-09-01T12:00:00+02:00',
      }).expiresAt,
    ).toBe('2026-09-01T10:00:00.000Z')
    expect(
      parseIssueInput({ tenant_id: TENANT, instance_id: INSTANCE }).expiresAt,
    ).toBeNull()
  })

  it('validates a revoke request', () => {
    expect(() => parseRevokeInput({ credential_id: 'nope' })).toThrow(AgentCredentialError)
    expect(parseRevokeInput({ credential_id: CREDENTIAL_ID }).reason).toBe('')
    expect(
      parseRevokeInput({ credential_id: CREDENTIAL_ID, reason: 'r'.repeat(600) }).reason,
    ).toHaveLength(500)
  })
})

/**
 * The driver's own screens on a machine token, exercised without a database.
 *
 * `resolveMachineActor` refuses a malformed credential id, a hash that is not
 * 64 hex characters and a blank tenant **before** it acquires a connection, so
 * these run against a store whose connection string points at nothing. If one of
 * the screens were removed the store would try to connect and the test would
 * fail on the attempt rather than on the assertion — which is exactly the
 * failure that means the screen is gone.
 */
describe('the driver screens a malformed token before it connects', () => {
  const store = new NeonDataStore({
    connectionString: 'postgresql://nobody@127.0.0.1:1/none',
    operations: buildMachineRegistry(),
    localRole: 'app_machine',
    maxConnections: 1,
    applicationName: 'lh2-s21-offline-screen',
  })

  const good = {
    credentialId: CREDENTIAL_ID,
    secretHash: hashAgentSecret(SECRET),
    tenantId: TENANT,
  }

  it('refuses a credential id that is not a uuid', async () => {
    await expect(
      store.resolveMachineActor({ ...good, credentialId: 'not-a-uuid' }),
    ).resolves.toBeNull()
  })

  it('refuses a secret hash that is not 64 hex characters', async () => {
    await expect(
      store.resolveMachineActor({ ...good, secretHash: 'abc' }),
    ).resolves.toBeNull()
    await expect(
      store.resolveMachineActor({ ...good, secretHash: 'z'.repeat(64) }),
    ).resolves.toBeNull()
  })

  it('refuses a blank tenant', async () => {
    await expect(
      store.resolveMachineActor({ ...good, tenantId: '   ' }),
    ).resolves.toBeNull()
  })

  it('refuses a request that is not an object', async () => {
    await expect(
      store.resolveMachineActor(null as unknown as typeof good),
    ).resolves.toBeNull()
  })
})
