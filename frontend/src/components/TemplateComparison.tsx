import { useMemo, useState } from 'react'
import type { CampaignMetrics, CampaignStep, Instance, Lead } from '../lib/types'
import { instanceName } from '../lib/leads'
import type { ReplyInfo } from '../lib/leads'
import { pooledMaturedRates } from '../lib/review'
import type { MaturityInfo } from '../lib/review'
import { rate } from '../lib/format'
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
    return available.slice(0, DEFAULT_COLUMNS).map((c) => c.campaign_id)
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
    <div className="card">
      <div className="card-head">
        <h2>Template comparison</h2>
        {addable.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) setSelected([...effective, e.target.value])
            }}
          >
            <option value="">Add campaign…</option>
            {addable.map((c) => (
              <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>
            ))}
          </select>
        )}
      </div>

      {columns.length > 0 ? (
        <div className="cmp-chips">
          {columns.map((c) => (
            <span className="cmp-chip" key={c.campaign_id}>
              {c.campaign_name}
              {columns.length > 1 && (
                <button
                  aria-label={`Remove ${c.campaign_name}`}
                  onClick={() => setSelected(effective.filter((x) => x !== c.campaign_id))}
                >×</button>
              )}
            </span>
          ))}
        </div>
      ) : (
        <div className="muted small">No campaigns in this account scope to compare.</div>
      )}

      <div className="compare-grid">
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
        <div className="muted small" style={{ marginTop: 12 }}>
          Side-by-side correlation view — rates reflect audience, timing and account
          as much as copy; not a causal comparison.
        </div>
      )}
    </div>
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
    { label: 'Positive share', value: rate(pooled.positiveShare), n: pooled.replied, denom: 'replies' },
  ]

  return (
    <div className="stack">
      <div className="card tmpl-stat">
        <h2>{campaign.campaign_name}</h2>
        <div className="muted small">{account}</div>
        <div className="tmpl-stat-grid">
          {stats.map((s) => (
            <div className="tmpl-stat-cell" key={s.label}>
              <div className="tmpl-stat-val">{s.value}</div>
              <div className="muted small">{s.label}</div>
              <div className="muted tmpl-stat-n">n={s.n.toLocaleString('en-US')} {s.denom} in matured cohorts</div>
            </div>
          ))}
        </div>
        <div className="muted small tmpl-stat-note">
          Pooled over matured cohorts in the last {weeks} weeks
          {pooled.invites > 0 ? ` · ${pooled.invites.toLocaleString('en-US')} invites` : ' · no matured cohorts yet'}.
        </div>
      </div>
      <MessageSequence steps={steps} />
    </div>
  )
}
