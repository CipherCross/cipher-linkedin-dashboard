// Keeps the derived message→campaign-step attribution (ledger step 024) fresh.
// Two callers: the sync agent's post-push ping (/api/notify-replies, POST) runs
// an incremental pass — only messages with no attribution row yet — and the
// daily /api/classify cron runs a full pass, which picks up edited templates.
//
// Best effort by contract: attribution is a cache the AI reads, so a failure
// here is logged by class and never fails the caller's real job (Slack alerts,
// demographics).
import { getAiDataStore, SYSTEM_ACTOR } from './data/aiStore.js'
import { DataStoreContractError } from './data/contracts.js'
import {
  SYSTEM_OPERATIONS,
  firstGuardResult,
  type StepAttributionRefresh,
} from './data/operations/aiSystem.js'

export interface StepAttributionRun {
  readonly full: boolean
  readonly instances: readonly StepAttributionRefresh[]
  readonly failed: number
}

function safeErrorLabel(error: unknown): string {
  if (error instanceof DataStoreContractError) return `${error.name}(${error.code})`
  if (error instanceof Error) return error.name
  return 'UnknownError'
}

export async function refreshStepAttribution(full: boolean): Promise<StepAttributionRun> {
  const store = getAiDataStore()
  let instanceIds: string[]
  try {
    const page = await store.query<unknown[]>(SYSTEM_ACTOR, {
      operation: SYSTEM_OPERATIONS.instanceNames,
      page: { limit: 1 },
    })
    const rows = firstGuardResult(page)
    if (!Array.isArray(rows)) throw new TypeError('instance list is not a guard result')
    instanceIds = (rows as { id?: unknown }[])
      .map((row) => String(row.id ?? ''))
      .filter(Boolean)
  } catch (error) {
    console.error('step attribution: instance list failed:', safeErrorLabel(error))
    return { full, instances: [], failed: 1 }
  }

  const instances: StepAttributionRefresh[] = []
  let failed = 0
  // One instance at a time: each pass is a few seconds of regex work, and the
  // AI pool is small and shared with the caller's own statements.
  for (const instanceId of instanceIds) {
    try {
      const result = await store.transaction(SYSTEM_ACTOR, (transaction) =>
        transaction.execute<StepAttributionRefresh | null>({
          operation: SYSTEM_OPERATIONS.refreshStepAttribution,
          params: { instanceId, full },
        }),
      )
      if (result) instances.push(result)
    } catch (error) {
      failed += 1
      console.error(`step attribution: refresh failed for one instance:`, safeErrorLabel(error))
    }
  }
  return { full, instances, failed }
}
