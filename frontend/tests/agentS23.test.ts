import { generateKeyPairSync, sign } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { formatAgentToken, hashAgentSecret } from '../api/_lib/agent/credentials.js'
import {
  AGENT_CONFIG_OP,
  AGENT_PHOTO_UPLOAD_OP,
  AGENT_PUBLISH_BRANCH_OP,
  AGENT_REFRESH_CANDIDATES_OP,
  AGENT_RELEASE_OP,
  createAgentConfigHandler,
  createAgentRefreshCandidatesHandler,
  createAgentPhotoUploadHandler,
  createAgentPublishHandler,
  createAgentReleaseHandler,
} from '../api/_lib/agent/machineOps.js'
import { authenticateMachine } from '../api/_lib/agent/machineAuth.js'
import { FakeDataStore } from '../api/_lib/data/fake.js'
import { MACHINE_COMMANDS, MACHINE_OPERATIONS } from '../api/_lib/data/operations/agentIngest.js'
import { MACHINE_PUBLISH_COMMANDS } from '../api/_lib/data/operations/sequencePublishing.js'
import { FakeObjectStorageProvider } from '../api/_lib/storage/fakeProvider.js'
import {
  AgentReleaseStore,
  canonicalReleaseManifest,
  parseReleaseManifest,
  readAgentReleaseConfig,
} from '../api/_lib/storage/releaseArtifacts.js'

const TENANT = 'acme'
const INSTANCE = 'notebook-1'
const OTHER_INSTANCE = 'notebook-2'
const CREDENTIAL_ID = '9f1b0000-0000-4000-8000-00000000c001'
const SECRET = 'A'.repeat(43)
const TOKEN = formatAgentToken(CREDENTIAL_ID, SECRET)
const CAMPAIGN = `${INSTANCE}:42`
const PROFILE = 'https://www.linkedin.com/in/alice'

function machineStore() {
  const store = new FakeDataStore()
  store.seedMachineActor(CREDENTIAL_ID, hashAgentSecret(SECRET), TENANT, {
    credentialId: CREDENTIAL_ID,
    instanceId: INSTANCE,
    tenantId: TENANT,
  })
  return store
}

function request(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${TOKEN}`)
  return new Request(`https://dashboard.test/api/import?op=${url}`, {
    ...init,
    headers,
  })
}

describe('S23 machine authorization', () => {
  it('denies a revoked credential before an operation runs', async () => {
    const store = machineStore()
    const first = await authenticateMachine(
      request(AGENT_CONFIG_OP),
      { store, tenantId: TENANT },
      'agent-config',
    )
    expect(first.response).toBeUndefined()
    store.revokeMachineActor(CREDENTIAL_ID, hashAgentSecret(SECRET), TENANT)
    const second = await authenticateMachine(
      request(AGENT_CONFIG_OP),
      { store, tenantId: TENANT },
      'agent-config',
    )
    expect(second.response?.status).toBe(401)
  })
})

describe('S23 authenticated config', () => {
  it('returns only the resolved notebook config and no caller-supplied instance filter', async () => {
    const store = machineStore()
    store.registerQuery(MACHINE_OPERATIONS.instanceConfig, ({ params }) => {
      expect(params).toBeUndefined()
      return [{ id: INSTANCE, config: { ingest_mode: 'shadow' }, config_updated_at: null }]
    })
    const response = await createAgentConfigHandler({ store, tenantId: TENANT })(
      request(AGENT_CONFIG_OP),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      instance_id: INSTANCE,
      config: { ingest_mode: 'shadow' },
      config_updated_at: null,
    })
  })
})

describe('the conversation-refresh worklist endpoint', () => {
  const policyRow = {
    instance_id: INSTANCE,
    refresh_after_days: 3,
    profile_url: null,
    priority: 'none',
    last_inbound_at: null,
    last_message_at: null,
    last_requested_at: null,
  }

  function candidateStore(rows: unknown[], seen: { limit?: number } = {}) {
    const store = machineStore()
    store.registerQuery(MACHINE_OPERATIONS.refreshCandidates, ({ params, page }) => {
      expect(params).toBeUndefined()
      seen.limit = page.limit
      return rows
    })
    return store
  }

  const call = (store: FakeDataStore, query = '') =>
    createAgentRefreshCandidatesHandler({ store, tenantId: TENANT })(
      request(`${AGENT_REFRESH_CANDIDATES_OP}${query}`),
    )

  it('is GET only', async () => {
    const store = candidateStore([policyRow])
    const response = await createAgentRefreshCandidatesHandler({ store, tenantId: TENANT })(
      request(AGENT_REFRESH_CANDIDATES_OP, { method: 'POST' }),
    )
    expect(response.status).toBe(405)
    expect(await response.json()).toEqual({ error: 'POST is not allowed' })
  })

  it('refuses a credential that does not resolve', async () => {
    const store = candidateStore([policyRow])
    store.revokeMachineActor(CREDENTIAL_ID, hashAgentSecret(SECRET), TENANT)
    const response = await call(store)
    expect(response.status).toBe(401)
  })

  it('refuses a page whose rows are not this credential\'s notebook', async () => {
    const store = candidateStore([{ ...policyRow, instance_id: OTHER_INSTANCE }])
    expect((await call(store)).status).toBe(401)
    // Zero rows means the credential stopped resolving, not "nothing to do".
    expect((await call(candidateStore([]))).status).toBe(401)
  })

  it('defaults the page size to 25 and refuses anything but 1..100', async () => {
    const seen: { limit?: number } = {}
    expect((await call(candidateStore([policyRow], seen))).status).toBe(200)
    expect(seen.limit).toBe(25)

    const bounded: { limit?: number } = {}
    expect((await call(candidateStore([policyRow], bounded), '&limit=100')).status).toBe(200)
    expect(bounded.limit).toBe(100)

    for (const bad of ['0', '101', '2.5', '-1', 'ten', '1e2', ' 5 x']) {
      const response = await call(candidateStore([policyRow]), `&limit=${encodeURIComponent(bad)}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'limit must be an integer between 1 and 100',
      })
    }
  })

  it('answers the policy row alone as an empty worklist', async () => {
    const response = await call(candidateStore([{ ...policyRow, refresh_after_days: 7 }]))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      instance_id: INSTANCE,
      refresh_after_days: 7,
      candidates: [],
    })
  })

  it('returns the notebook, the window and the candidate rows in order', async () => {
    const rows = [
      {
        instance_id: INSTANCE,
        refresh_after_days: 3,
        profile_url: PROFILE,
        priority: 'p3',
        last_inbound_at: '2026-09-01T10:00:00.000Z',
        last_message_at: '2026-09-01T10:00:00.000Z',
        last_requested_at: null,
      },
      {
        instance_id: INSTANCE,
        refresh_after_days: 3,
        profile_url: 'https://www.linkedin.com/in/bob',
        priority: 'none',
        last_inbound_at: '2026-08-20T09:00:00.000Z',
        last_message_at: '2026-08-21T09:00:00.000Z',
        last_requested_at: '2026-08-25T09:00:00.000Z',
      },
    ]
    const response = await call(candidateStore(rows), '&limit=2')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      instance_id: INSTANCE,
      refresh_after_days: 3,
      candidates: [
        {
          profile_url: PROFILE,
          priority: 'p3',
          last_inbound_at: '2026-09-01T10:00:00.000Z',
          last_message_at: '2026-09-01T10:00:00.000Z',
          last_requested_at: null,
        },
        {
          profile_url: 'https://www.linkedin.com/in/bob',
          priority: 'none',
          last_inbound_at: '2026-08-20T09:00:00.000Z',
          last_message_at: '2026-08-21T09:00:00.000Z',
          last_requested_at: '2026-08-25T09:00:00.000Z',
        },
      ],
    })
  })
})

describe('S23 authenticated photo upload', () => {
  it('derives a tenant-and-instance-isolated key and records the source path', async () => {
    const store = machineStore()
    const executed: Record<string, unknown>[] = []
    store.registerCommand(MACHINE_COMMANDS.upsertLeadPhoto, ({ params }) => {
      executed.push((params ?? {}) as Record<string, unknown>)
      return 1
    })
    const storage = new FakeObjectStorageProvider({ tenantId: TENANT })
    const body = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1,
    ])
    const response = await createAgentPhotoUploadHandler({
      store,
      tenantId: TENANT,
      objectStorage: () => storage,
    })(
      request(AGENT_PHOTO_UPLOAD_OP, {
        method: 'POST',
        headers: {
          'x-agent-campaign-id': CAMPAIGN,
          'x-agent-profile-url': PROFILE,
          'x-agent-photo-path': `${INSTANCE}/alice.jpg`,
          'content-type': 'image/png',
        },
        body,
      }),
    )
    expect(response.status).toBe(200)
    expect((await response.json()).object_key).toBe(
      `t/${TENANT}/lead-photos/${INSTANCE}/alice.jpg`,
    )
    expect(executed[0].photoPath).toBe(`${INSTANCE}/alice.jpg`)
    expect(await storage.statObject(`t/${TENANT}/lead-photos/${INSTANCE}/alice.jpg`)).not.toBeNull()
  })

  it('refuses another notebook before touching object storage', async () => {
    const store = machineStore()
    store.registerCommand(MACHINE_COMMANDS.upsertLeadPhoto, () => 1)
    const storage = new FakeObjectStorageProvider({ tenantId: TENANT })
    const response = await createAgentPhotoUploadHandler({
      store,
      tenantId: TENANT,
      objectStorage: () => storage,
    })(
      request(AGENT_PHOTO_UPLOAD_OP, {
        method: 'POST',
        headers: {
          'x-agent-campaign-id': CAMPAIGN,
          'x-agent-profile-url': PROFILE,
          'x-agent-photo-path': `${OTHER_INSTANCE}/alice.jpg`,
        },
        body: new Uint8Array([1, 2, 3]),
      }),
    )
    expect(response.status).toBe(403)
    expect(storage.objectCount()).toBe(0)
  })
})

describe('S23 signed release artifacts', () => {
  it('covers the version, hash, size and timestamp with an Ed25519 signature', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const manifestFields = {
      version: '1.14.0',
      sha256: 'a'.repeat(64),
      sizeBytes: 12_345,
      releasedAt: '2026-08-07T13:00:00.000Z',
    }
    const signature = sign(
      null,
      Buffer.from(canonicalReleaseManifest(manifestFields)),
      privateKey,
    ).toString('base64')
    const manifest = parseReleaseManifest({
      version: manifestFields.version,
      sha256: manifestFields.sha256,
      size_bytes: manifestFields.sizeBytes,
      released_at: manifestFields.releasedAt,
      signature,
    })
    expect(manifest.signature).toBe(signature)
    expect(canonicalReleaseManifest({ ...manifestFields, sha256: 'b'.repeat(64) })).not.toBe(
      canonicalReleaseManifest(manifestFields),
    )
    expect(publicKey.export({ format: 'der', type: 'spki' })).toHaveLength(44)
  })

  it('keeps release config separate from the lead-photo bucket', () => {
    expect(() =>
      readAgentReleaseConfig({
        AGENT_RELEASE_ENDPOINT: 'https://objects.test',
        AGENT_RELEASE_BUCKET: 'lead-photos',
        AGENT_RELEASE_ACCESS_KEY_ID: 'a',
        AGENT_RELEASE_SECRET_ACCESS_KEY: 'b',
        OBJECT_STORAGE_BUCKET: 'lead-photos',
      }),
    ).toThrow(/two destinations/)
  })

  it('reads the pointer and manifest, then returns a short-lived download URL', async () => {
    const fields = {
      version: '1.14.0',
      sha256: 'a'.repeat(64),
      sizeBytes: 12_345,
      releasedAt: '2026-08-07T13:00:00.000Z',
    }
    const { privateKey } = generateKeyPairSync('ed25519')
    const signature = sign(null, Buffer.from(canonicalReleaseManifest(fields)), privateKey)
      .toString('base64')
    const manifest = {
      version: fields.version,
      sha256: fields.sha256,
      size_bytes: fields.sizeBytes,
      released_at: fields.releasedAt,
      signature,
    }
    const fetched: string[] = []
    const store = new AgentReleaseStore({
      config: {
        endpoint: 'https://objects.test',
        bucket: 'agent-releases',
        region: 'auto',
        credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
      },
      now: () => Date.parse('2026-08-07T13:00:00.000Z'),
      fetchImpl: async (url) => {
        fetched.push(url)
        return new Response(
          url.includes('current.json')
            ? JSON.stringify({ version: fields.version })
            : JSON.stringify(manifest),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    expect((await store.currentVersion())).toBe(fields.version)
    expect((await store.manifest(fields.version)).sha256).toBe(fields.sha256)
    expect(store.downloadUrl(fields.version).url).toContain('agent-releases')
    expect(fetched).toHaveLength(2)

    const response = await createAgentReleaseHandler({
      store: machineStore(),
      tenantId: TENANT,
      releaseStore: {
        currentVersion: async () => fields.version,
        manifest: async () => parseReleaseManifest(manifest),
        downloadUrl: () => ({
          url: 'https://objects.test/download',
          expiresAt: '2026-08-07T13:02:00.000Z',
        }),
      } as unknown as AgentReleaseStore,
    })(request(AGENT_RELEASE_OP))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      version: fields.version,
      download_url: 'https://objects.test/download',
      download_expires_at: '2026-08-07T13:02:00.000Z',
    })
  })
})

describe('machine publish diagnostics', () => {
  it('logs a safe SQLSTATE from a wrapped branch journal failure', async () => {
    const store = machineStore()
    store.registerCommand(MACHINE_PUBLISH_COMMANDS.branchResult, () => {
      const driverError = Object.assign(new Error('driver text must not be logged'), {
        code: '42703',
      })
      throw driverError
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const response = await createAgentPublishHandler(
        { store, tenantId: TENANT },
        AGENT_PUBLISH_BRANCH_OP,
      )(
        request(AGENT_PUBLISH_BRANCH_OP, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            job_id: '9f1b0000-0000-4000-8000-00000000c099',
            claim_generation: 1,
            branch_id: 'branch_a',
            status: 'publishing',
          }),
        }),
      )
      expect(response.status).toBe(502)
      expect(log).toHaveBeenCalledWith(
        'machine agent.publishBranch failed',
        'TRANSACTION_INVALID_SQLSTATE_42703',
      )
    } finally {
      log.mockRestore()
    }
  })
})
