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

const OK: SequenceAttention = { level: 'ok', label: 'Running' }

/** Publish states that stopped short of a live campaign on the notebook. */
const PUBLISH_TROUBLE = new Set(['partial_failure', 'conflict', 'failed'])

/** A notebook syncs every 30 min; a day of silence is a broken agent, not a lull. */
export const SEQUENCE_STALE_SYNC_HOURS = 24

const RANK: Record<SequenceAttentionLevel, number> = { alert: 0, watch: 1, ok: 2 }

/**
 * What, if anything, is wrong with one deployment.
 *
 * Deliberately blind to `campaign_status`: that column is whatever string the
 * notebook's Linked Helper build wrote, and branching on its spelling would
 * silently mislabel a campaign the day LH2 renames a state.
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
  for (const deployment of item.deployments) {
    const attention = deploymentAttention(deployment, now)
    if (RANK[attention.level] < RANK[worst.level]) worst = attention
    if (worst.level === 'alert') break
  }
  return worst
}

/** Newest signal a card can be sorted by: a reply if there is one, else the edit. */
function recencyOf(item: SequenceHubItem): string {
  return item.latest_reply?.sent_at ?? item.updated_at ?? ''
}

export interface RankedSequence {
  item: SequenceHubItem
  attention: SequenceAttention
}

/**
 * Sequences that are deployed somewhere, worst state first.
 *
 * A managed sequence with no deployment is a draft, not something that is
 * running — it belongs in the "continue a draft" action, not in a list whose
 * heading promises what is live.
 */
export function activeSequences(
  items: readonly SequenceHubItem[],
  now = Date.now(),
): RankedSequence[] {
  return items
    .filter((item) => !item.archived && item.deployment_count > 0)
    .map((item) => ({ item, attention: sequenceAttention(item, now) }))
    .sort((left, right) => {
      const byLevel = RANK[left.attention.level] - RANK[right.attention.level]
      if (byLevel !== 0) return byLevel
      return recencyOf(right.item).localeCompare(recencyOf(left.item))
    })
}

/** Managed sequences nobody has published yet, most recently edited first. */
export function draftSequences(items: readonly SequenceHubItem[]): SequenceHubItem[] {
  return items
    .filter((item) => item.kind === 'managed' && !item.archived && item.deployment_count === 0)
    .sort((left, right) => (right.updated_at ?? '').localeCompare(left.updated_at ?? ''))
}

/** Where a hub card should open. External items have no Builder document yet. */
export function sequenceHref(item: SequenceHubItem): string {
  if (item.sequence_document_id) return `/sequences/${encodeURIComponent(item.sequence_document_id)}`
  const campaign = item.deployments[0]?.campaign_id
  return campaign ? `/campaign/${encodeURIComponent(campaign)}` : '/sequences'
}

/** The accounts a sequence is deployed to, deduped and in card order. */
export function sequenceAccounts(item: SequenceHubItem): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const deployment of item.deployments) {
    if (seen.has(deployment.instance_id)) continue
    seen.add(deployment.instance_id)
    names.push(deployment.account_name ?? deployment.instance_id)
  }
  return names
}
