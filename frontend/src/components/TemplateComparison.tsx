import { useMemo, useState } from 'react'
import { LayoutGrid, X } from 'lucide-react'
import type { CampaignMetrics, CampaignStep, Instance, Lead } from '../lib/types'
import { instanceName } from '../lib/leads'
import type { ReplyInfo } from '../lib/leads'
import { pooledMaturedRates } from '../lib/review'
import type { MaturityInfo } from '../lib/review'
import { rate } from '../lib/format'
import { EmptyState, IconButton, Panel, SectionHeader, SelectField } from '../ui'
import { MessageSequence } from './MessageSequence'

const DEFAULT_COLUMNS = 2

/** Side-by-side campaign copy comparison: pick campaigns as chips, each renders a
 *  pooled matured-cohort stat card plus its message sequence. Explicitly a
 *  correlation view — copy is one of many things driving these rates. */
export function TemplateComparison({
  campaigns, leads, steps, latestReplies, maturity, instances, weeks,
}: {
  campaigns: CampaignMetrics[]
  leads: Lead[]
  steps: CampaignStep[]
  latestReplies: Map<string, ReplyInfo>
  maturity: MaturityInfo
  instances: Instance[]
  weeks: number
}) {
  const [selected, setSelected] = useState<string[]>([])

  // Only campaigns in the current account scope are selectable; a stale selection
  // (e.g. after switching accounts) falls back to the top campaigns by invites.
  const available = campaigns
  const availIds = useMemo(() => new Set(available.map((c) => c.campaign_id)), [available])
  const effective = useMemo(() => {
    const kept = selected.filter((id) => availIds.has(id))
    if (kept.length > 0) return kept
    return [...available]
      .sort((a, b) => b.invites_sent - a.invites_sent)
      .slice(0, DEFAULT_COLUMNS)
      .map((c) => c.campaign_id)
  }, [selected, availIds, available])

  const columns = useMemo(
    () =>
      effective
        .map((id) => available.find((c) => c.campaign_id === id))
        .filter((c): c is CampaignMetrics => !!c),
    [effective, available],
  )

  const addable = available.filter((c) => !effective.includes(c.campaign_id))

  return (
    <Panel>
      <SectionHeader
        title="Template comparison"
        actions={addable.length > 0 && (
          <SelectField
            label="Add a campaign to compare"
            labelHidden
            value=""
            onChange={(e) => {
              if (e.target.value) setSelected([...effective, e.target.value])
            }}
          >
            <option value="">Add campaign…</option>
            {addable.map((c) => (
              <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>
            ))}
          </SelectField>
        )}
      />

      {columns.length > 0 ? (
        <div className="flex flex-wrap gap-2 mb-app-lg">
          {columns.map((c) => (
            <span
              className="inline-flex items-center gap-1.5 bg-app-surface border border-app-border rounded-pill py-[5px] px-app-md text-app-body"
              key={c.campaign_id}
            >
              {c.campaign_name}
              {columns.length > 1 && (
                <IconButton
                  label={`Remove ${c.campaign_name}`}
                  icon={<X aria-hidden="true" />}
                  onClick={() => setSelected(effective.filter((x) => x !== c.campaign_id))}
                  className="!w-5 !h-5"
                />
              )}
            </span>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={LayoutGrid}
          title="No campaigns to compare"
          hint="No campaigns in this account scope have data to line up side by side."
        />
      )}

      <div className="grid grid-cols-2 gap-app-lg max-[860px]:grid-cols-1">
        {columns.map((c) => (
          <TemplateColumn
            key={c.campaign_id}
            campaign={c}
            leads={leads.filter((l) => l.campaign_id === c.campaign_id)}
            steps={steps.filter((s) => s.campaign_id === c.campaign_id)}
            latestReplies={latestReplies}
            maturity={maturity}
            instances={instances}
            weeks={weeks}
          />
        ))}
      </div>

      {columns.length > 0 && (
        <p className="text-app-meta text-app-text-muted mt-app-md">
          Side-by-side correlation view — rates reflect audience, timing and account
          as much as copy; not a causal comparison.
        </p>
      )}
    </Panel>
  )
}

function TemplateColumn({
  campaign, leads, steps, latestReplies, maturity, instances, weeks,
}: {
  campaign: CampaignMetrics
  leads: Lead[]
  steps: CampaignStep[]
  latestReplies: Map<string, ReplyInfo>
  maturity: MaturityInfo
  instances: Instance[]
  weeks: number
}) {
  const pooled = useMemo(
    () => pooledMaturedRates(leads, latestReplies, maturity, weeks),
    [leads, latestReplies, maturity, weeks],
  )
  const account = instanceName(instances.find((i) => i.id === campaign.instance_id), campaign.instance_id)

  const stats: Array<{ label: string; value: string; n: number; denom: string }> = [
    { label: 'Accept %', value: rate(pooled.acceptRate), n: pooled.invites, denom: 'invites' },
    { label: 'Reply %', value: rate(pooled.replyRate), n: pooled.accepted, denom: 'accepted' },
    { label: 'P3 share', value: rate(pooled.positiveShare), n: pooled.replied, denom: 'replies' },
  ]

  return (
    <div className="flex flex-col gap-app-lg">
      <Panel>
        <SectionHeader level="subsection" title={campaign.campaign_name} description={account} />
        <div className="grid grid-cols-3 gap-2.5 mt-app-md mb-1 mx-0">
          {stats.map((s) => (
            <div className="bg-app-surface-2 border border-app-border rounded-md p-2.5 text-center" key={s.label}>
              <div className="text-[length:var(--text-2xl)] font-bold tabular-nums">{s.value}</div>
              <div className="text-app-meta text-app-text-muted">{s.label}</div>
              <div className="text-app-text-muted mt-[3px] text-[length:var(--text-2xs)] leading-[1.3]">n={s.n.toLocaleString('en-US')} {s.denom} in matured cohorts</div>
            </div>
          ))}
        </div>
        <div className="text-app-meta text-app-text-muted mt-1">
          Pooled over matured cohorts in the last {weeks} weeks
          {pooled.invites > 0 ? ` · ${pooled.invites.toLocaleString('en-US')} invites` : ' · no matured cohorts yet'}.
        </div>
      </Panel>
      <MessageSequence steps={steps} />
    </div>
  )
}
