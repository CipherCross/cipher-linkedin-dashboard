import { generateKeyPairSync, sign } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { formatAgentToken, hashAgentSecret } from '../api/_lib/agent/credentials.js'
import {
  AGENT_CONFIG_OP,
  AGENT_PHOTO_UPLOAD_OP,
  AGENT_RELEASE_OP,
  createAgentConfigHandler,
  createAgentPhotoUploadHandler,
  createAgentReleaseHandler,
} from '../api/_lib/agent/machineOps.js'
import { authenticateMachine } from '../api/_lib/agent/machineAuth.js'
import { FakeDataStore } from '../api/_lib/data/fake.js'
import { MACHINE_COMMANDS, MACHINE_OPERATIONS } from '../api/_lib/data/operations/agentIngest.js'
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
