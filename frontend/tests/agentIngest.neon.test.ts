/**
 * S21 — the machine ingest path against the live Neon project.
 *
 * This is where the three graded properties are proved by Postgres rather than
 * by a fake: the upserts actually collide on the agent's conflict keys, the
 * step-`009` policies actually refuse another notebook and a revoked credential,
 * and the transaction actually rolls back.
 *
 * ## The credential this suite connects with, stated plainly
 *
 * `NEON_MACHINE_DATABASE_URL`. In production that is an `app_machine` login,
 * which does not exist yet: `app_machine` is `NOLOGIN` until the control plane
 * runs `000_machine_ingest_role_bootstrap.sql`, and that artifact is written and
 * unrun. Meanwhile this suite is pointed at a login that is a *member* of
 * `app_machine`, and the driver's unconditional `SET LOCAL ROLE app_machine`
 * makes the two cases identical from the database's side: `current_user` becomes
 * `app_machine` inside every transaction, so the policies below are the ones
 * being exercised, not the connecting role's.
 *
 * The one thing that arrangement does **not** prove is that the production login
 * works, and the handoff records it as a limit rather than letting a green suite
 * imply it.
 *
 * ## The shared-project rule this file obeys
 *
 * Every describe block seeds its OWN instance, campaign and leads under an
 * instance id nothing else uses, and drops them in `afterAll`. Nothing here
 * writes a column onto a row another suite asserts about — `touch_updated_at`
 * would move it into someone else's delta cohort and the failure would surface
 * on their line, days later. `N-S20.md` § "The findings" records the incident
 * that made this rule explicit.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { hashAgentSecret, generateAgentSecret } from '../api/_lib/agent/credentials.js'
import {
  createAgentIngestHandler,
  ingestBatch,
  parseIngestPayload,
  payloadDigest,
  AGENT_INGEST_OP,
} from '../api/_lib/agent/ingest.js'
import { machineActor } from '../api/_lib/data/machineStore.js'
import { NeonDataStore } from '../api/_lib/data/neon.js'
import {
  MACHINE_COMMANDS,
  buildMachineRegistry,
} from '../api/_lib/data/operations/index.js'
import {
  NEON_MACHINE_DATABASE_URL_ENV,
  readNeonDirectConnectionString,
} from '../api/_lib/data/neonConfig.js'
import { NeonFixtureClient } from './support/neonContractHarness'
import { CONTRACT_ACTORS } from './support/dataStoreContract'

const TENANT = 's21-tenant'
const OTHER_TENANT = 's21-other-tenant'
/**
 * A per-run suffix, so two runs on this shared project never touch each other's
 * rows even when one of them was killed before its teardown. Nothing here is
 * asserted by name, so the suffix costs nothing and buys the property the
 * project's shared-fixture incident was about.
 */
const RUN = Math.random().toString(36).slice(2, 8)
const INSTANCE = `s21-ingest-${RUN}`
const OTHER_INSTANCE = `s21-other-${RUN}`
const CAMPAIGN = `${INSTANCE}:1`
const PROFILE_ONE = `https://example.invalid/in/s21-${RUN}-one`
const PROFILE_TWO = `https://example.invalid/in/s21-${RUN}-two`

const machineUrl = (process.env[NEON_MACHINE_DATABASE_URL_ENV] ?? '').trim()
const hasMachineCredential = Boolean(machineUrl)

/**
 * The fixture connection is the ordinary runtime one, acting as the baseline's
 * own active-admin fixture: issuing a credential is an admin operation and this
 * suite exercises it through the same `SECURITY DEFINER` function the endpoint
 * calls, rather than by inserting a row as the owner.
 */
const fixtures = new NeonFixtureClient(readNeonDirectConnectionString())

let store: NeonDataStore
let credentialId: string
let otherInstanceCredentialId: string
let secret: string
let otherSecret: string

async function issueCredential(
  tenantId: string,
  instanceId: string,
  plainSecret: string,
  expiresAt: string | null = null,
): Promise<string> {
  return fixtures.asActor(CONTRACT_ACTORS.activeAdmin.actorId, async (client) => {
    const result = await client.query(
      'SELECT id::text AS id FROM public.agent_credential_issue($1, $2, $3, $4, $5::timestamptz)',
      [tenantId, instanceId, 's21 fixture', hashAgentSecret(plainSecret), expiresAt],
    )
    return String(result.rows[0].id)
  })
}

async function countRows(sql: string, values: unknown[] = []): Promise<number> {
  return fixtures.asActor(CONTRACT_ACTORS.activeAdmin.actorId, async (client) => {
    const result = await client.query(sql, values)
    return Number(result.rows[0]?.n ?? 0)
  })
}

function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance_id: INSTANCE,
    idempotency_key: 's21-batch-000001',
    agent_version: '2.0.0-s21',
    instance: { label: 'S21 ingest fixture' },
    campaigns: [
      { id: CAMPAIGN, lh_campaign_id: '1', name: 'S21 ingest', status: 'active' },
    ],
    campaign_steps: [
      { campaign_id: CAMPAIGN, step_index: 0, step_label: 'Invite', sent_count: 2 },
    ],
    leads: [
      {
        campaign_id: CAMPAIGN,
        profile_url: PROFILE_ONE,
        full_name: 'S21 One',
        invited_at: '2026-08-01T10:00:00Z',
      },
      {
        campaign_id: CAMPAIGN,
        profile_url: PROFILE_TWO,
        full_name: 'S21 Two',
        invited_at: '2026-08-02T10:00:00Z',
      },
    ],
    messages: [
      {
        campaign_id: CAMPAIGN,
        profile_url: PROFILE_ONE,
        direction: 'in',
        body: 'S21 inbound',
        sent_at: '2026-08-03T10:00:00Z',
        content_hash: 's21hash',
      },
    ],
    events: [
      {
        campaign_id: CAMPAIGN,
        profile_url: PROFILE_ONE,
        event_type: 'invited',
        occurred_at: '2026-08-01T10:00:00Z',
      },
    ],
    sync_run: { status: 'ok' },
    ...overrides,
  }
}

/**
 * Business rows only, and as the ordinary runtime actor.
 *
 * `agent_credential` and `agent_ingest_batch` are deliberately NOT dropped here:
 * step 009 grants no role a `DELETE` on either, because a removed credential
 * takes its batch history with it. So every run leaves both tables' rows behind
 * and the residue only ever grows — which means an assertion about either table
 * MUST be scoped to this run's credential id. The idempotency keys are fixed
 * literals and are NOT run-scoped: `(credential_id, idempotency_key)` is the
 * unique key, so counting by the key alone counts every previous run too. The
 * first run of this file passed on an empty table and the second did not; that
 * is the whole failure, and the credential predicate is the whole fix.
 */
async function dropFixture(): Promise<void> {
  await fixtures.asActor(CONTRACT_ACTORS.activeAdmin.actorId, async (client) => {
    await client.query('DELETE FROM public.messages WHERE instance_id = ANY($1)', [
      [INSTANCE, OTHER_INSTANCE],
    ])
    await client.query('DELETE FROM public.events WHERE instance_id = ANY($1)', [
      [INSTANCE, OTHER_INSTANCE],
    ])
    await client.query('DELETE FROM public.leads WHERE instance_id = ANY($1)', [
      [INSTANCE, OTHER_INSTANCE],
    ])
    await client.query(
      'DELETE FROM public.campaign_steps WHERE campaign_id IN (SELECT id FROM public.campaigns WHERE instance_id = ANY($1))',
      [[INSTANCE, OTHER_INSTANCE]],
    )
    await client.query('DELETE FROM public.campaigns WHERE instance_id = ANY($1)', [
      [INSTANCE, OTHER_INSTANCE],
    ])
    await client.query('DELETE FROM public.sync_runs WHERE instance_id = ANY($1)', [
      [INSTANCE, OTHER_INSTANCE],
    ])
    await client.query('DELETE FROM public.instances WHERE id = ANY($1)', [
      [INSTANCE, OTHER_INSTANCE],
    ])
  })
}

describe.skipIf(!hasMachineCredential)(
  `the machine ingest path (${
    hasMachineCredential
      ? NEON_MACHINE_DATABASE_URL_ENV
      : `${NEON_MACHINE_DATABASE_URL_ENV} absent — no login can enter app_machine`
  })`,
  () => {
    beforeAll(async () => {
      await dropFixture()
      secret = generateAgentSecret()
      otherSecret = generateAgentSecret()
      credentialId = await issueCredential(TENANT, INSTANCE, secret)
      otherInstanceCredentialId = await issueCredential(
        TENANT,
        OTHER_INSTANCE,
        otherSecret,
      )
      store = new NeonDataStore({
        connectionString: machineUrl,
        operations: buildMachineRegistry(),
        localRole: 'app_machine',
        statementTimeoutMs: 25_000,
        maxConnections: 2,
        applicationName: 'lh2-s21-ingest-suite',
      })
    })

    afterAll(async () => {
      await store?.close()
      await dropFixture()
      await fixtures.end()
    })

    beforeEach(async () => {
      await dropFixture()
    })

    // -----------------------------------------------------------------------
    // Establishing the actor.
    // -----------------------------------------------------------------------

    it('resolves a live credential and reports its notebook', async () => {
      const resolved = await store.resolveMachineActor({
        credentialId,
        secretHash: hashAgentSecret(secret),
        tenantId: TENANT,
      })
      expect(resolved).toEqual({
        credentialId,
        instanceId: INSTANCE,
        tenantId: TENANT,
      })
    })

    it('refuses the same credential presented against another tenant', async () => {
      const resolved = await store.resolveMachineActor({
        credentialId,
        secretHash: hashAgentSecret(secret),
        tenantId: OTHER_TENANT,
      })
      expect(resolved).toBeNull()
    })

    it('refuses the right credential with the wrong secret', async () => {
      const resolved = await store.resolveMachineActor({
        credentialId,
        secretHash: hashAgentSecret(generateAgentSecret()),
        tenantId: TENANT,
      })
      expect(resolved).toBeNull()
    })

    it('refuses an expired credential', async () => {
      const expiredSecret = generateAgentSecret()
      const expiredId = await issueCredential(
        TENANT,
        INSTANCE,
        expiredSecret,
        '2020-01-01T00:00:00Z',
      )
      const resolved = await store.resolveMachineActor({
        credentialId: expiredId,
        secretHash: hashAgentSecret(expiredSecret),
        tenantId: TENANT,
      })
      expect(resolved).toBeNull()
    })

    it('refuses a revoked credential, through the revoke function', async () => {
      const doomedSecret = generateAgentSecret()
      const doomedId = await issueCredential(TENANT, INSTANCE, doomedSecret)
      expect(
        await store.resolveMachineActor({
          credentialId: doomedId,
          secretHash: hashAgentSecret(doomedSecret),
          tenantId: TENANT,
        }),
      ).not.toBeNull()

      await fixtures.asActor(CONTRACT_ACTORS.activeAdmin.actorId, (client) =>
        client.query('SELECT public.agent_credential_revoke($1::uuid, $2)', [
          doomedId,
          'retired by the suite',
        ]),
      )

      expect(
        await store.resolveMachineActor({
          credentialId: doomedId,
          secretHash: hashAgentSecret(doomedSecret),
          tenantId: TENANT,
        }),
      ).toBeNull()
    })

    it('refuses to mint a credential for a non-admin actor', async () => {
      await expect(
        fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, (client) =>
          client.query(
            'SELECT public.agent_credential_issue($1, $2, $3, $4)',
            [TENANT, INSTANCE, 'should not exist', hashAgentSecret('x')],
          ),
        ),
      ).rejects.toThrow(/insufficient_privilege|admin/i)
    })

    // -----------------------------------------------------------------------
    // The write.
    // -----------------------------------------------------------------------

    it('writes every collection in one transaction', async () => {
      const payload = parseIngestPayload(batch())
      const actor = machineActor(credentialId, TENANT)
      const result = await ingestBatch(store, actor, payload, payloadDigest(payload))

      expect(result.replayed).toBe(false)
      expect(result.rowCounts.leads).toBe(2)
      expect(result.rowCounts.messages).toBe(1)
      expect(result.rowCounts.events).toBe(1)
      expect(result.rowCounts.campaigns).toBe(1)
      expect(result.rowCounts.campaign_steps).toBe(1)

      expect(
        await countRows('SELECT count(*)::int AS n FROM public.leads WHERE instance_id = $1', [
          INSTANCE,
        ]),
      ).toBe(2)
      expect(
        await countRows(
          'SELECT count(*)::int AS n FROM public.messages WHERE instance_id = $1',
          [INSTANCE],
        ),
      ).toBe(1)
      expect(
        await countRows(
          'SELECT count(*)::int AS n FROM public.agent_ingest_batch WHERE credential_id = $1::uuid AND idempotency_key = $2',
          [credentialId, 's21-batch-000001'],
        ),
      ).toBe(1)
    })

    it('is idempotent on the agent conflict keys, not only on the batch key', async () => {
      const first = parseIngestPayload(batch({ idempotency_key: 's21-batch-000010' }))
      const second = parseIngestPayload(batch({ idempotency_key: 's21-batch-000011' }))
      const actor = machineActor(credentialId, TENANT)

      await ingestBatch(store, actor, first, payloadDigest(first))
      await ingestBatch(store, actor, second, payloadDigest(second))

      // Two accepted batches carrying the same rows. The conflict keys are what
      // stop the second from duplicating them — the idempotency key cannot,
      // because these are different keys.
      expect(
        await countRows('SELECT count(*)::int AS n FROM public.leads WHERE instance_id = $1', [
          INSTANCE,
        ]),
      ).toBe(2)
      expect(
        await countRows(
          'SELECT count(*)::int AS n FROM public.messages WHERE instance_id = $1',
          [INSTANCE],
        ),
      ).toBe(1)
      expect(
        await countRows('SELECT count(*)::int AS n FROM public.events WHERE instance_id = $1', [
          INSTANCE,
        ]),
      ).toBe(1)
    })

    it('answers a repeated payload from the stored batch without writing', async () => {
      const payload = parseIngestPayload(batch({ idempotency_key: 's21-batch-000020' }))
      const actor = machineActor(credentialId, TENANT)
      const digest = payloadDigest(payload)

      const first = await ingestBatch(store, actor, payload, digest)
      const second = await ingestBatch(store, actor, payload, digest)

      expect(first.replayed).toBe(false)
      expect(second.replayed).toBe(true)
      expect(second.rowCounts).toEqual(first.rowCounts)
      expect(
        await countRows(
          'SELECT count(*)::int AS n FROM public.agent_ingest_batch WHERE credential_id = $1::uuid AND idempotency_key = $2',
          [credentialId, 's21-batch-000020'],
        ),
      ).toBe(1)
      expect(
        await countRows(
          'SELECT count(*)::int AS n FROM public.sync_runs WHERE instance_id = $1',
          [INSTANCE],
        ),
      ).toBe(1)
    })

    it('refuses the same key carrying different data', async () => {
      const payload = parseIngestPayload(batch({ idempotency_key: 's21-batch-000030' }))
      const actor = machineActor(credentialId, TENANT)
      await ingestBatch(store, actor, payload, payloadDigest(payload))

      const changed = parseIngestPayload(
        batch({
          idempotency_key: 's21-batch-000030',
          leads: [{ campaign_id: CAMPAIGN, profile_url: PROFILE_ONE, full_name: 'Renamed' }],
        }),
      )
      await expect(
        ingestBatch(store, actor, changed, payloadDigest(changed)),
      ).rejects.toThrow(/different payload/)
    })

    it('stamps last_used_at inside the batch transaction', async () => {
      const payload = parseIngestPayload(batch({ idempotency_key: 's21-batch-000040' }))
      await ingestBatch(store, machineActor(credentialId, TENANT), payload, payloadDigest(payload))
      const stamped = await countRows(
        'SELECT count(*)::int AS n FROM public.agent_credential WHERE id = $1::uuid AND last_used_at IS NOT NULL',
        [credentialId],
      )
      expect(stamped).toBe(1)
    })

    // -----------------------------------------------------------------------
    // What the database refuses on its own.
    // -----------------------------------------------------------------------

    it('refuses a write scoped to another notebook, by policy', async () => {
      // The handler's 403 never runs here: this is the actor of one credential
      // writing rows the payload claims belong to another notebook. The policy
      // is the only thing in the way.
      const actor = machineActor(credentialId, TENANT)
      await expect(
        store.transaction(actor, (transaction) =>
          transaction.execute({
            operation: MACHINE_COMMANDS.upsertInstance,
            params: {
              instanceId: OTHER_INSTANCE,
              label: 'should not be written',
              agentVersion: '',
              accountName: '',
              accountUrl: '',
              accountAvatar: '',
            },
          }),
        ),
      ).rejects.toThrow()

      expect(
        await countRows('SELECT count(*)::int AS n FROM public.instances WHERE id = $1', [
          OTHER_INSTANCE,
        ]),
      ).toBe(0)
    })

    it('writes nothing for a credential whose leads name another notebook', async () => {
      // Same statement, the other credential: the rows are refused by the WHERE
      // the policy adds, so the batch commits having written zero leads rather
      // than writing somebody else's.
      const actor = machineActor(otherInstanceCredentialId, TENANT)
      await store.transaction(actor, (transaction) =>
        transaction.execute({
          operation: MACHINE_COMMANDS.upsertInstance,
          params: {
            instanceId: OTHER_INSTANCE,
            label: 'the other notebook',
            agentVersion: '',
            accountName: '',
            accountUrl: '',
            accountAvatar: '',
          },
        }),
      )

      await expect(
        store.transaction(actor, (transaction) =>
          transaction.execute({
            operation: MACHINE_COMMANDS.upsertLeads,
            params: {
              instanceId: INSTANCE,
              rows: JSON.stringify([
                { campaign_id: CAMPAIGN, profile_url: 'https://example.invalid/in/s21-stolen' },
              ]),
            },
          }),
        ),
      ).rejects.toThrow()

      expect(
        await countRows(
          'SELECT count(*)::int AS n FROM public.leads WHERE profile_url = $1',
          ['https://example.invalid/in/s21-stolen'],
        ),
      ).toBe(0)
    })

    it('refuses a revoked credential mid-transaction, not only at resolution', async () => {
      const doomedSecret = generateAgentSecret()
      const doomedId = await issueCredential(TENANT, INSTANCE, doomedSecret)
      await fixtures.asActor(CONTRACT_ACTORS.activeAdmin.actorId, (client) =>
        client.query('SELECT public.agent_credential_revoke($1::uuid, $2)', [
          doomedId,
          'revoked before the write',
        ]),
      )

      // The actor is constructed directly, as if resolution had happened before
      // the revocation. Every policy re-derives the credential per statement, so
      // the write is refused anyway.
      const actor = machineActor(doomedId, TENANT)
      await expect(
        store.transaction(actor, (transaction) =>
          transaction.execute({
            operation: MACHINE_COMMANDS.upsertInstance,
            params: {
              instanceId: INSTANCE,
              label: 'written by a revoked credential',
              agentVersion: '',
              accountName: '',
              accountUrl: '',
              accountAvatar: '',
            },
          }),
        ),
      ).rejects.toThrow()
    })

    it('cannot revoke or extend itself', async () => {
      const actor = machineActor(credentialId, TENANT)
      await expect(
        store.transaction(actor, (transaction) =>
          transaction.execute({
            // A statement no registry entry provides — asserted through the
            // registry rather than by composing SQL, because the point is that
            // the vocabulary has no such operation.
            operation: 'agent.revokeSelf',
            params: {},
          }),
        ),
      ).rejects.toThrow(/not allowlisted/)
    })

    // -----------------------------------------------------------------------
    // Atomicity, in Postgres.
    // -----------------------------------------------------------------------

    it('rolls the whole batch back when a later statement fails', async () => {
      const actor = machineActor(credentialId, TENANT)
      const payload = parseIngestPayload(batch({ idempotency_key: 's21-batch-000050' }))

      await expect(
        store.transaction(actor, async (transaction) => {
          await transaction.execute({
            operation: MACHINE_COMMANDS.upsertInstance,
            params: {
              instanceId: INSTANCE,
              label: 'S21 ingest fixture',
              agentVersion: '',
              accountName: '',
              accountUrl: '',
              accountAvatar: '',
            },
          })
          await transaction.execute({
            operation: MACHINE_COMMANDS.upsertCampaigns,
            params: {
              instanceId: INSTANCE,
              rows: JSON.stringify(payload.campaigns),
            },
          })
          await transaction.execute({
            operation: MACHINE_COMMANDS.upsertLeads,
            params: { instanceId: INSTANCE, rows: JSON.stringify(payload.leads) },
          })
          // The injected failure: a batch row whose credential does not exist.
          // The foreign key is the database's, and it fires after three
          // collections have already been written in this transaction.
          await transaction.execute({
            operation: MACHINE_COMMANDS.recordBatch,
            params: {
              credentialId: '00000000-0000-4000-8000-00000000dead',
              instanceId: INSTANCE,
              idempotencyKey: 's21-batch-000050',
              payloadDigest: 'f'.repeat(64),
              rowCounts: '{}',
              rowsWritten: 0,
            },
          })
          return null
        }),
      ).rejects.toThrow()

      expect(
        await countRows('SELECT count(*)::int AS n FROM public.leads WHERE instance_id = $1', [
          INSTANCE,
        ]),
      ).toBe(0)
      expect(
        await countRows('SELECT count(*)::int AS n FROM public.campaigns WHERE instance_id = $1', [
          INSTANCE,
        ]),
      ).toBe(0)
      expect(
        await countRows('SELECT count(*)::int AS n FROM public.instances WHERE id = $1', [
          INSTANCE,
        ]),
      ).toBe(0)
    })

    it('lets the same key succeed after a rolled-back attempt', async () => {
      const actor = machineActor(credentialId, TENANT)
      const payload = parseIngestPayload(batch({ idempotency_key: 's21-batch-000050' }))
      const result = await ingestBatch(store, actor, payload, payloadDigest(payload))
      expect(result.replayed).toBe(false)
      expect(
        await countRows('SELECT count(*)::int AS n FROM public.leads WHERE instance_id = $1', [
          INSTANCE,
        ]),
      ).toBe(2)
    })

    // -----------------------------------------------------------------------
    // The handler, end to end.
    // -----------------------------------------------------------------------

    it('serves an accepted batch through the endpoint handler', async () => {
      const handler = createAgentIngestHandler({ store, tenantId: TENANT })
      const response = await handler(
        new Request(`https://dashboard.invalid/api/import?op=${AGENT_INGEST_OP}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer lha.${credentialId}.${secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(batch({ idempotency_key: 's21-batch-000060' })),
        }),
      )
      expect(response.status).toBe(200)
      const answered = await response.json()
      expect(answered.ok).toBe(true)
      expect(answered.instance_id).toBe(INSTANCE)
      expect(answered.rows_written).toBeGreaterThan(0)
    })

    it('refuses a batch whose instance is not the credential’s, through the handler', async () => {
      const handler = createAgentIngestHandler({ store, tenantId: TENANT })
      const response = await handler(
        new Request(`https://dashboard.invalid/api/import?op=${AGENT_INGEST_OP}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer lha.${credentialId}.${secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(
            batch({ instance_id: OTHER_INSTANCE, idempotency_key: 's21-batch-000070' }),
          ),
        }),
      )
      expect(response.status).toBe(403)
    })
  },
)
