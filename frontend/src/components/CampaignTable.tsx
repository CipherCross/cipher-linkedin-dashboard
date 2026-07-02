import { Link } from 'react-router-dom'
import type { CampaignMetrics, Instance } from '../lib/types'
import { instanceName } from '../lib/leads'
import { ago, rate } from '../lib/format'

interface Props {
  campaigns: CampaignMetrics[]
  instances: Instance[]
  title?: string
}

export function CampaignTable({ campaigns, instances, title = 'Campaigns' }: Props) {
  const label = (id: string) => instanceName(instances.find((i) => i.id === id), id)

  return (
    <div className="card">
      <h2>{title}</h2>
      <table>
        <thead>
          <tr>
            <th>Campaign</th>
            <th>Account</th>
            <th className="num">Leads</th>
            <th className="num">Invites</th>
            <th className="num">Accepted</th>
            <th className="num">Accept %</th>
            <th className="num">Replies</th>
            <th className="num">Reply %</th>
            <th>Last activity</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.campaign_id}>
              <td>
                <Link className="row-link" to={`/campaign/${encodeURIComponent(c.campaign_id)}`}>
                  {c.campaign_name}
                </Link>
              </td>
              <td className="muted">
                <Link className="row-link muted" to={`/account/${encodeURIComponent(c.instance_id)}`}>
                  {label(c.instance_id)}
                </Link>
              </td>
              <td className="num">{c.total_leads}</td>
              <td className="num">{c.invites_sent}</td>
              <td className="num">{c.accepted}</td>
              <td className="num">{rate(c.acceptance_rate)}</td>
              <td className="num">{c.replies}</td>
              <td className="num">{rate(c.reply_rate)}</td>
              <td className="muted">{ago(c.last_activity_at)}</td>
            </tr>
          ))}
          {campaigns.length === 0 && (
            <tr><td colSpan={9} className="muted">No campaigns synced yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
