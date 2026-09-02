import type { CampaignRuntimeStatus, SequenceHubDeployment } from './types'

export const CAMPAIGN_RUNTIME_STATUSES: readonly CampaignRuntimeStatus[] = [
  'draft', 'running', 'queued', 'sleeping', 'stopped', 'completed',
]

export const CAMPAIGN_RUNTIME_LABELS: Readonly<Record<CampaignRuntimeStatus, string>> = {
  draft: 'Draft',
  running: 'Running',
  queued: 'Queued',
  sleeping: 'Sleeping',
  stopped: 'Stopped',
  completed: 'Completed',
}

const KNOWN = new Set<string>(CAMPAIGN_RUNTIME_STATUSES)
const OPERATIONAL = new Set<CampaignRuntimeStatus>(['running', 'queued', 'sleeping'])

/** Two expected 30-minute sync intervals. Queries never refresh this clock. */
export const CAMPAIGN_STATUS_STALE_MINUTES = 60

export type CampaignObservationHealth =
  | 'awaiting_first_sync'
  | 'fresh'
  | 'stale'
  | 'unsupported'

export interface CampaignRuntimeObservation {
  runtime_status: CampaignRuntimeStatus | string | null | undefined
  is_archived: boolean | null | undefined
  status_observed_at: string | null | undefined
  status_source?: string | null
}

export function parseCampaignRuntimeStatus(value: unknown): CampaignRuntimeStatus | null {
  return typeof value === 'string' && KNOWN.has(value)
    ? value as CampaignRuntimeStatus
    : null
}

export function campaignRuntimeLabel(value: unknown): string {
  const status = parseCampaignRuntimeStatus(value)
  return status ? CAMPAIGN_RUNTIME_LABELS[status] : 'Unknown'
}

export function campaignObservationHealth(
  campaign: CampaignRuntimeObservation,
  now = Date.now(),
): CampaignObservationHealth {
  const observedAt = campaign.status_observed_at
    ? Date.parse(campaign.status_observed_at)
    : NaN
  if (!Number.isFinite(observedAt)) return 'awaiting_first_sync'
  if (
    parseCampaignRuntimeStatus(campaign.runtime_status) === null ||
    campaign.is_archived === null || campaign.is_archived === undefined ||
    campaign.status_source?.startsWith('unsupported:')
  ) return 'unsupported'
  return now - observedAt > CAMPAIGN_STATUS_STALE_MINUTES * 60_000 ? 'stale' : 'fresh'
}

export function isOperationalCampaign(campaign: CampaignRuntimeObservation): boolean {
  const status = parseCampaignRuntimeStatus(campaign.runtime_status)
  return campaign.is_archived === false && status !== null && OPERATIONAL.has(status)
}

export function campaignStatusSummary(
  deployments: readonly CampaignRuntimeObservation[],
): string {
  const counts = new Map<string, number>()
  for (const deployment of deployments) {
    if (deployment.is_archived === true) {
      counts.set('Archived', (counts.get('Archived') ?? 0) + 1)
      continue
    }
    const label = campaignRuntimeLabel(deployment.runtime_status)
    counts.set(label, (counts.get(label) ?? 0) + 1)
    if (deployment.is_archived == null) {
      counts.set('Archive unknown', (counts.get('Archive unknown') ?? 0) + 1)
    }
  }
  return [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(' · ')
}

export function sequenceHasOperationalDeployment(
  deployments: readonly SequenceHubDeployment[],
): boolean {
  return deployments.some(isOperationalCampaign)
}

export function newestStatusObservation(
  deployments: readonly CampaignRuntimeObservation[],
): string | null {
  let newest: string | null = null
  let newestMs = -Infinity
  for (const deployment of deployments) {
    const value = deployment.status_observed_at
    const ms = value ? Date.parse(value) : NaN
    if (Number.isFinite(ms) && ms > newestMs) {
      newest = value!
      newestMs = ms
    }
  }
  return newest
}

export function statusHealthCounts(
  deployments: readonly CampaignRuntimeObservation[],
  now = Date.now(),
): Record<CampaignObservationHealth, number> {
  const counts: Record<CampaignObservationHealth, number> = {
    awaiting_first_sync: 0, fresh: 0, stale: 0, unsupported: 0,
  }
  for (const deployment of deployments) counts[campaignObservationHealth(deployment, now)] += 1
  return counts
}
