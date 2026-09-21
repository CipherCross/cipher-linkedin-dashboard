import type { CampaignRuntimeStatus } from '../lib/types'
import {
  campaignObservationHealth,
  campaignRuntimeLabel,
  parseCampaignRuntimeStatus,
  type CampaignRuntimeObservation,
} from '../lib/campaignRuntime'
import { ago } from '../lib/format'

export function CampaignRuntimeStatusView({
  campaign,
  compact = false,
  showArchive = true,
}: {
  campaign: CampaignRuntimeObservation
  compact?: boolean
  showArchive?: boolean
}) {
  const runtime = parseCampaignRuntimeStatus(campaign.runtime_status)
  const health = campaignObservationHealth(campaign)
  const label = campaignRuntimeLabel(runtime)
  const healthLabel = health === 'stale'
    ? 'Stale'
    : health === 'unsupported'
      ? 'Unsupported'
      : health === 'awaiting_first_sync'
        ? 'Awaiting first compatible sync'
        : null
  const observed = campaign.status_observed_at
    ? `Observed ${ago(campaign.status_observed_at)}`
    : 'Not observed yet'
  const aria = [
    `Linked Helper runtime ${label}`,
    showArchive
      ? campaign.is_archived === true
        ? 'Archived'
        : campaign.is_archived === false
          ? 'Not archived'
          : 'Archive state unknown'
      : null,
    healthLabel,
    observed,
  ].filter(Boolean).join(', ')

  return (
    <div className={`flex flex-col items-start gap-app-xs min-w-0 ${compact ? 'compact' : ''}`} aria-label={aria}>
      <div className="flex flex-wrap items-center gap-[5px]">
        <span className={`badge runtime-${runtime ?? 'unknown'}`}>{label}</span>
        {showArchive && campaign.is_archived === true && (
          <span className="badge archive-yes">Archived</span>
        )}
        {showArchive && campaign.is_archived == null && (
          <span className="badge archive-unknown">Archive unknown</span>
        )}
        {healthLabel && <span className={`badge observation-${health}`}>{healthLabel}</span>}
      </div>
      <span className="muted small whitespace-normal" title={campaign.status_source ?? undefined}>
        {observed}
      </span>
    </div>
  )
}

export function runtimeStatusOptionLabel(status: CampaignRuntimeStatus | 'unknown'): string {
  return status === 'unknown' ? 'Unknown' : campaignRuntimeLabel(status)
}
