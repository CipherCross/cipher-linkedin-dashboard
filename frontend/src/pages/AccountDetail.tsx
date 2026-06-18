import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import { instanceName, latestRepliesByLead, leadKey } from '../lib/leads'
import { KpiCards } from '../components/KpiCards'
import { WarmupChart } from '../components/WarmupChart'
import { Heatmap } from '../components/Heatmap'
import { CampaignTable, ago } from '../components/CampaignTable'
import { Avatar } from '../components/Avatar'

export function AccountDetail() {
  const { id } = useParams<{ id: string }>()
  const { data } = useData()

  const leads = useMemo(
    () => data?.leads.filter((l) => l.instance_id === id) ?? [],
    [data, id],
  )
  // Positive replies on this account, from the latest inbound message per lead.
  const positive = useMemo(() => {
    if (!data) return 0
    const latest = latestRepliesByLead(data.messages)
    return leads.filter(
      (l) => latest.get(leadKey(l.instance_id, l.profile_url))?.sentiment === 'positive',
    ).length
  }, [data, leads])

  if (!data) return null
  const inst = data.instances.find((i) => i.id === id)
  if (!inst) {
    return (
      <div className="card">
        Instance not found. <Link to="/">Back to overview</Link>
      </div>
    )
  }
  const campaigns = data.campaigns.filter((c) => c.instance_id === inst.id)

  return (
    <>
      <header>
        <div className="account-head">
          <Avatar inst={inst} size={52} />
          <div>
            <div className="breadcrumb muted small">
              <Link to="/">Overview</Link> / account
            </div>
            <h1>{instanceName(inst)}</h1>
            <div className="muted small">
              {inst.account_url && (
                <>
                  <a className="row-link muted" href={inst.account_url} target="_blank" rel="noreferrer">
                    LinkedIn profile ↗
                  </a>
                  {' · '}
                </>
              )}
              {inst.account_name && inst.label && `${inst.label} · `}
              {inst.last_sync_at ? `synced ${ago(inst.last_sync_at)}` : 'never synced'} ·{' '}
              {campaigns.length} campaigns · {leads.length.toLocaleString('en-US')} leads
            </div>
          </div>
        </div>
      </header>

      <KpiCards campaigns={campaigns} positive={positive} />

      <div className="stack">
        <WarmupChart leads={leads} />
        <Heatmap leads={leads} />
        <CampaignTable
          campaigns={campaigns}
          instances={data.instances}
          title="Campaigns on this instance"
        />
      </div>
    </>
  )
}
