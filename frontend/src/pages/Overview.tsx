import { useMemo, useState } from 'react'
import { useData } from '../lib/DataContext'
import {
  instanceName, leadsToActivity, presetRanges, rangeTotals, rangedCampaigns,
} from '../lib/leads'
import type { DateRange } from '../lib/leads'
import { KpiCards } from '../components/KpiCards'
import { ActivityChart } from '../components/ActivityChart'
import { CampaignTable } from '../components/CampaignTable'
import { InstancePanel } from '../components/InstancePanel'
import { DateRangePicker } from '../components/DateRangePicker'

export function Overview() {
  const { data } = useData()
  const [instanceFilter, setInstanceFilter] = useState('all')
  const [campaignFilter, setCampaignFilter] = useState('all')
  const RANGES = useMemo(() => presetRanges(), [])
  const [range, setRange] = useState<DateRange>(
    () => RANGES.find((r) => r.id === '3_months') ?? RANGES[RANGES.length - 1],
  )

  const view = useMemo(() => {
    if (!data) return null
    const matchesInst = (id: string) => instanceFilter === 'all' || id === instanceFilter

    // Campaigns selectable for the chosen account; fall back to "all" if the
    // current pick no longer belongs to the selected account.
    const availableCampaigns = data.campaigns.filter((c) => matchesInst(c.instance_id))
    const campaignIds = new Set(availableCampaigns.map((c) => c.campaign_id))
    const campaign = campaignIds.has(campaignFilter) ? campaignFilter : 'all'

    const leads = data.leads.filter(
      (l) => matchesInst(l.instance_id) && (campaign === 'all' || l.campaign_id === campaign),
    )

    const activity = leadsToActivity(leads).filter(
      (a) => (!range.from || a.day >= range.from) && (!range.to || a.day <= range.to),
    )
    const annotations = data.annotations.filter(
      (a) =>
        !a.campaign_id &&
        (!a.instance_id || matchesInst(a.instance_id)) &&
        (!range.from || a.noted_at >= range.from) &&
        (!range.to || a.noted_at <= range.to),
    )

    return {
      availableCampaigns,
      campaign,
      activity,
      annotations,
      totals: rangeTotals(leads, range),
      campaignRows: rangedCampaigns(leads, data.campaigns, range),
    }
  }, [data, instanceFilter, campaignFilter, range])

  if (!data || !view) return null

  return (
    <>
      <header>
        <div>
          <h1>Overview</h1>
          <div className="muted small">
            Team dashboard · {data.instances.length} Linked Helper instances
          </div>
        </div>
        <div className="controls">
          <select
            value={instanceFilter}
            onChange={(e) => {
              setInstanceFilter(e.target.value)
              setCampaignFilter('all')
            }}
          >
            <option value="all">All accounts</option>
            {data.instances.map((i) => (
              <option key={i.id} value={i.id}>{instanceName(i)}</option>
            ))}
          </select>
          <select value={view.campaign} onChange={(e) => setCampaignFilter(e.target.value)}>
            <option value="all">All campaigns</option>
            {view.availableCampaigns.map((c) => (
              <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>
            ))}
          </select>
          <DateRangePicker presets={RANGES} value={range} onChange={setRange} />
        </div>
      </header>

      <KpiCards totals={view.totals} flowLabel={range.label} />

      <div className="main-grid">
        <ActivityChart
          activity={view.activity}
          annotations={view.annotations}
          from={range.from}
          to={range.to}
        />
        <InstancePanel instances={data.instances} />
      </div>

      <CampaignTable campaigns={view.campaignRows} instances={data.instances} />
    </>
  )
}
