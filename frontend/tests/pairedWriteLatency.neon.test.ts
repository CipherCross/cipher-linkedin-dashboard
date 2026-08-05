/**
 * The measurement design call 1 asserted but did not take.
 *
 * `pipelineWrites.ts` chose **two operations in one transaction** over one CTE
 * statement doing both writes, and paid an extra round trip inside the
 * transaction for it. The handoff may not claim a latency figure it has not
 * measured, so this file measures it: the same two writes, the same
 * transaction, the same pooled endpoint, once as two `execute` calls and once
 * as a single statement whose CTE chain does exactly what the pair does.
 *
 * ## What is being compared, and what is deliberately not
 *
 * Both arms open a `store.transaction`, so the driver's `BEGIN` and its
 * `set_config` preamble are inside **both** measurements and cancel out. The
 * difference is one client-server round trip. Neither arm includes the
 * handler's pre-read or the actor-name lookup, which are identical either way
 * and would only dilute the ratio.
 *
 * The CTE arm is registered on its own registry rather than in the application
 * one, because it is a measurement instrument and not a vocabulary entry — the
 * whole reason it lost is that it puts two operations' SQL behind one allowlist
 * name.
 *
 * ## Why the assertion is loose
 *
 * A remote region's variance dwarfs the effect being measured, so a strict
 * threshold would be a flake generator. The numbers are printed for the handoff
 * and the assertion only holds the conclusion the design rests on: that the
 * extra round trip is a bounded fraction of one write, not a multiple of it. If
 * that ever stops being true the design call needs revisiting, which is exactly
 * what a failure here should prompt.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  LEAD_IDS,
  dropWriteFixture,
  seedWriteFixture,
} from './support/writeSliceFixture'
import {
  NeonFixtureClient,
  requireNeonTestConnection,
} from './support/neonContractHarness'
import { CONTRACT_ACTORS } from './support/dataStoreContract'

const connection = requireNeonTestConnection()

const { NeonDataStore, NeonOperationRegistry } = await import(
  '../api/_lib/data/neon.js'
)
const { buildApplicationRegistry, PIPELINE_WRITE_COMMANDS } = await import(
  '../api/_lib/data/operations/index.js'
)

const fixtures = new NeonFixtureClient(connection.direct)

/** The measurement's own name, never registered in the application registry. */
const CTE_BOTH = 'measurement.stageAndEventInOneStatement'

/**
 * One statement doing both writes — the rejected alternative, written out so
 * the comparison is against the real thing rather than against an estimate.
 */
const CTE_SQL = `WITH moved AS (
       UPDATE public.leads
          SET pipeline_stage = $2,
              pipeline_stage_changed_at = $3::timestamptz
        WHERE id = $1::uuid
    RETURNING id, pipeline_stage
     )
     INSERT INTO public.pipeline_events
            (lead_id, kind, actor, from_stage, to_stage)
     SELECT moved.id, 'stage', $4, $5, moved.pipeline_stage
       FROM moved
  RETURNING id`

let pairStore: InstanceType<typeof NeonDataStore>
let cteStore: InstanceType<typeof NeonDataStore>

const actor = {
  kind: 'user' as const,
  actorId: CONTRACT_ACTORS.activeMember.actorId,
  tenantId: 'tenant-a',
  role: 'member' as const,
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  )
  return sorted[index] ?? 0
}

beforeAll(async () => {
  await fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, (client) =>
    seedWriteFixture(client),
  )

  pairStore = new NeonDataStore({
    connectionString: connection.pooled,
    operations: buildApplicationRegistry(),
    statementTimeoutMs: 8_000,
    maxConnections: 1,
    applicationName: 's14-latency-pair',
  })

  const cteRegistry = new NeonOperationRegistry()
  cteRegistry.registerCommand(CTE_BOTH, {
    build: ({ params }) => ({
      text: CTE_SQL,
      values: [
        (params as Record<string, unknown>).leadId,
        (params as Record<string, unknown>).stage,
        (params as Record<string, unknown>).changedAt,
        (params as Record<string, unknown>).actor,
        (params as Record<string, unknown>).fromStage,
      ],
    }),
    mapResult: (_rows, rowCount) => ({ rowCount }),
  })
  cteStore = new NeonDataStore({
    connectionString: connection.pooled,
    operations: cteRegistry,
    statementTimeoutMs: 8_000,
    maxConnections: 1,
    applicationName: 's14-latency-cte',
  })
})

afterAll(async () => {
  await fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, (client) =>
    dropWriteFixture(client),
  )
  await pairStore.close()
  await cteStore.close()
  await fixtures.end()
})

describe('the cost of two operations instead of one', () => {
  it('measures the pair against the CTE and prints both', async () => {
    const RUNS = 15
    const WARMUP = 3

    const stages = ['interested', 'call_booked']
    const now = () => new Date().toISOString()

    const pair = async (index: number) => {
      const stage = stages[index % stages.length] as string
      await pairStore.transaction(actor, async (transaction) => {
        await transaction.execute({
          operation: PIPELINE_WRITE_COMMANDS.setStage,
          params: {
            leadId: LEAD_IDS.stage,
            stage,
            substatus: null,
            lostReason: null,
            changedAtMode: 'set',
            changedAt: now(),
          },
        })
        await transaction.execute({
          operation: PIPELINE_WRITE_COMMANDS.appendStageEvent,
          params: {
            leadId: LEAD_IDS.stage,
            actor: 'latency harness',
            fromStage: null,
            toStage: stage,
            fromSubstatus: null,
            toSubstatus: null,
            lostReason: null,
          },
        })
      })
    }

    const cte = async (index: number) => {
      const stage = stages[index % stages.length] as string
      await cteStore.transaction(actor, (transaction) =>
        transaction.execute({
          operation: CTE_BOTH,
          params: {
            leadId: LEAD_IDS.stage,
            stage,
            changedAt: now(),
            actor: 'latency harness',
            fromStage: null,
          },
        }),
      )
    }

    const time = async (run: (index: number) => Promise<void>) => {
      for (let index = 0; index < WARMUP; index += 1) await run(index)
      const samples: number[] = []
      for (let index = 0; index < RUNS; index += 1) {
        const started = performance.now()
        await run(index)
        samples.push(performance.now() - started)
      }
      return samples
    }

    // Interleaved arms would be fairer still, but the two use different pools
    // and alternating them would measure pool contention. Warmed separately,
    // run back to back, same region, same minute.
    const pairSamples = await time(pair)
    const cteSamples = await time(cte)

    const report = {
      runs: RUNS,
      pair_p50_ms: Number(percentile(pairSamples, 0.5).toFixed(1)),
      pair_p90_ms: Number(percentile(pairSamples, 0.9).toFixed(1)),
      cte_p50_ms: Number(percentile(cteSamples, 0.5).toFixed(1)),
      cte_p90_ms: Number(percentile(cteSamples, 0.9).toFixed(1)),
    }
    const overhead = report.pair_p50_ms - report.cte_p50_ms
    // eslint-disable-next-line no-console
    console.log(
      `[S14 paired-write latency] ${JSON.stringify({
        ...report,
        extra_round_trip_ms: Number(overhead.toFixed(1)),
        ratio: Number((report.pair_p50_ms / report.cte_p50_ms).toFixed(2)),
      })}`,
    )

    // Both arms did the work.
    expect(
      await fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, async (client) => {
        const result = await client.query(
          `SELECT count(*)::int AS n FROM public.pipeline_events WHERE lead_id = $1`,
          [LEAD_IDS.stage],
        )
        return result.rows[0]?.n as number
      }),
    ).toBe(2 * (RUNS + WARMUP))

    // The conclusion the design rests on: one extra round trip, not a second
    // transaction's worth of work. Loose on purpose — see the file header.
    expect(report.pair_p50_ms).toBeLessThan(report.cte_p50_ms * 2)
  }, 120_000)
})
