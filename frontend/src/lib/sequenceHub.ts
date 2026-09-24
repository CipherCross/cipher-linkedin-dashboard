import type { SequenceHubDeployment, SequenceHubItem } from './types'
import { publishStatusLabel } from './sequenceBuilder'

/**
 * Reading the Sequence Hub snapshot the way the Overview needs it.
 *
 * The `sequences.hub` operation returns every managed sequence and every
 * unlinked Linked Helper campaign in one union. The Overview shows a handful of
 * rows, so the ordering has to be a judgement rather than "newest first": a
 * deployment that failed to publish is the thing somebody has to act on, and it
 * can easily be the oldest row in the set.
 */

export type SequenceAttentionLevel = 'alert' | 'watch' | 'ok'

export interface SequenceAttention {
  level: SequenceAttentionLevel
  label: string
}

const OK: SequenceAttention = { level: 'ok', label: 'No attention' }

/** Publish states that stopped short of a live campaign on the notebook. */
const PUBLISH_TROUBLE = new Set(['partial_failure', 'conflict', 'failed'])

/** A notebook syncs every 30 min; a day of silence is a broken agent, not a lull. */
export const SEQUENCE_STALE_SYNC_HOURS = 24

const RANK: Record<SequenceAttentionLevel, number> = { alert: 0, watch: 1, ok: 2 }

/**
 * What, if anything, is wrong with one deployment.
 *
 * Runtime/archive is a separate axis. This helper ranks publish and sync health
 * only; the caller renders the normalized Linked Helper state independently.
 */
export function deploymentAttention(
  deployment: SequenceHubDeployment,
  now = Date.now(),
): SequenceAttention {
  if (deployment.publish_status && PUBLISH_TROUBLE.has(deployment.publish_status)) {
    return { level: 'alert', label: publishStatusLabel(deployment.publish_status) }
  }
  if (deployment.awaiting_sync) return { level: 'watch', label: 'Awaiting sync' }
  const syncedAt = deployment.last_sync_at ? Date.parse(deployment.last_sync_at) : NaN
  if (!Number.isFinite(syncedAt)) return { level: 'watch', label: 'Never synced' }
  if (now - syncedAt > SEQUENCE_STALE_SYNC_HOURS * 3_600_000) {
    return { level: 'watch', label: 'Sync stale' }
  }
  return OK
}

/** The worst state across a sequence's deployments — one broken account is enough. */
export function sequenceAttention(item: SequenceHubItem, now = Date.now()): SequenceAttention {
  let worst = OK
  for (const deployment of item.deployments.filter((candidate) => candidate.is_archived !== true)) {
    const attention = deploymentAttention(deployment, now)
    if (RANK[attention.level] < RANK[worst.level]) worst = attention
    if (worst.level === 'alert') break
  }
  return worst
}
