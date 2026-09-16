/**
 * Per-request stage timing for `DataStore` calls.
 *
 * The diagnosis in `specs/2026-09-15-dashboard-loading-performance.md` could not
 * separate "the database was slow" from "the request waited for a connection":
 * the endpoint logged one `query_ms` that covered pool acquisition, `BEGIN`, the
 * preamble round trip, the statement itself and `COMMIT` together. With a pool
 * ceiling of two per function instance and up to five reads behind a single
 * response, that number cannot answer which of them to fix.
 *
 * So the driver records the four stages separately and the endpoint reports
 * them. The sink is an `AsyncLocalStorage` rather than a parameter because the
 * calls that need measuring are several layers below the handler — actor
 * resolution happens inside `resolveApplicationActor`, and the reply reads
 * happen inside `replyReadResponse` — and threading a recorder through every
 * one of them would be a wider change than the measurement is worth.
 *
 * What is recorded is deliberately bounded: an operation name, which is
 * adapter-owned constant text, and durations. Never SQL, parameters, actor ids,
 * tokens, profile URLs or message bodies. A record outside a collection scope
 * costs one `AsyncLocalStorage.getStore()` and is dropped.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** One `DataStore` call, split into the stages that can each be slow. */
export interface DataStoreStageTiming {
  /** The operation name, or `identity.resolveActor` for the pre-actor read. */
  readonly operation: string
  /** Waiting for a pooled connection. Large means the pool is the bottleneck. */
  readonly acquire_ms: number
  /** `BEGIN` plus the one-round-trip preamble. Close to pure network latency. */
  readonly preamble_ms: number
  /** The operation's own statement(s). The only stage PostgreSQL work lands in. */
  readonly execute_ms: number
  /** `COMMIT` (or `ROLLBACK`). Another round trip. */
  readonly commit_ms: number
  /** Acquisition through release, which is what the old `query_ms` measured. */
  readonly total_ms: number
  readonly outcome: 'ok' | 'error'
}

const stageScope = new AsyncLocalStorage<DataStoreStageTiming[]>()

/**
 * Run `work` with a collection sink in scope and hand the sink to it.
 *
 * The array is live: a caller may read it between awaits to attribute stages to
 * a phase it has just finished, which is how the reply endpoint splits its
 * capability / references / inbox / facets phases apart.
 */
export function collectDataStoreStages<T>(
  work: (stages: DataStoreStageTiming[]) => Promise<T>,
): Promise<T> {
  const stages: DataStoreStageTiming[] = []
  return stageScope.run(stages, () => work(stages))
}

/** Record one call. A no-op outside a collection scope. */
export function recordDataStoreStage(timing: DataStoreStageTiming): void {
  stageScope.getStore()?.push(timing)
}

const round = (value: number): number => Math.round(value * 10) / 10

/**
 * The compact form for a log line: one entry per call, in call order.
 *
 * Stages that rounded to zero are omitted so a line stays readable; the totals
 * are always present, so a dropped stage is never a missing fact.
 */
export function summarizeDataStoreStages(
  stages: readonly DataStoreStageTiming[],
): Array<Record<string, unknown>> {
  return stages.map((stage) => ({
    op: stage.operation,
    total: round(stage.total_ms),
    ...(round(stage.acquire_ms) > 0 ? { acquire: round(stage.acquire_ms) } : {}),
    ...(round(stage.preamble_ms) > 0 ? { preamble: round(stage.preamble_ms) } : {}),
    ...(round(stage.execute_ms) > 0 ? { execute: round(stage.execute_ms) } : {}),
    ...(round(stage.commit_ms) > 0 ? { commit: round(stage.commit_ms) } : {}),
    ...(stage.outcome === 'error' ? { outcome: 'error' } : {}),
  }))
}

/** Stage totals across every call in a request, for a `Server-Timing` header. */
export function totalDataStoreStages(
  stages: readonly DataStoreStageTiming[],
): { calls: number; acquire_ms: number; preamble_ms: number; execute_ms: number; commit_ms: number; total_ms: number } {
  const sum = (pick: (stage: DataStoreStageTiming) => number): number =>
    round(stages.reduce((total, stage) => total + pick(stage), 0))
  return {
    calls: stages.length,
    acquire_ms: sum((stage) => stage.acquire_ms),
    preamble_ms: sum((stage) => stage.preamble_ms),
    execute_ms: sum((stage) => stage.execute_ms),
    commit_ms: sum((stage) => stage.commit_ms),
    total_ms: sum((stage) => stage.total_ms),
  }
}
