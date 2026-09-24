import {
  campaignObservationHealth,
  campaignRuntimeLabel,
  parseCampaignRuntimeStatus,
  type CampaignObservationHealth,
  type CampaignRuntimeObservation,
} from '../lib/campaignRuntime'
import { ago } from '../lib/format'
import { Badge } from '../ui'
import type { Tone } from '../ui'

/** `unsupported` and `awaiting_first_sync` are the two health states the old
 *  stylesheet actually tinted (warning); `stale` rendered as a plain neutral
 *  badge, which this keeps rather than inventing a new distinction. */
function healthTone(health: CampaignObservationHealth): Tone {
  return health === 'unsupported' || health === 'awaiting_first_sync' ? 'warning' : 'neutral'
}

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
    <div className="flex flex-col items-start gap-app-xs min-w-0" data-compact={compact || undefined} aria-label={aria}>
      <div className="flex flex-wrap items-center gap-[5px]">
        <Badge tone={runtime === null ? 'warning' : 'neutral'}>{label}</Badge>
        {showArchive && campaign.is_archived === true && (
          <Badge tone="accent">Archived</Badge>
        )}
        {showArchive && campaign.is_archived == null && (
          <Badge tone="warning">Archive unknown</Badge>
        )}
        {healthLabel && <Badge tone={healthTone(health)}>{healthLabel}</Badge>}
      </div>
      <span className="text-app-text-muted text-app-meta whitespace-normal" title={campaign.status_source ?? undefined}>
        {observed}
      </span>
    </div>
  )
}
