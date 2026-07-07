import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { CampaignMetrics, Instance } from '../lib/types'
import { instanceName } from '../lib/leads'

/** Per-campaign count of leads added within the selected range. Rows with no
 *  added leads are dropped; sorted by count desc. */
export function LeadsAddedTable({
  campaigns, instances,
}: { campaigns: CampaignMetrics[]; instances: Instance[] }) {
  const rows = useMemo(
    () =>
      campaigns
        .filter((c) => (c.leads_added ?? 0) > 0)
        .sort(
          (a, b) =>
            (b.leads_added ?? 0) - (a.leads_added ?? 0) ||
            a.campaign_name.localeCompare(b.campaign_name),
        ),
    [campaigns],
  )

  const total = rows.reduce((s, c) => s + (c.leads_added ?? 0), 0)

  return (
    <div className="card">
      <div className="card-head">
        <h2>Leads added by campaign</h2>
        <div className="muted small">{total.toLocaleString('en-US')} in range</div>
      </div>
      {rows.length === 0 ? (
        <div className="muted small">No leads were added in the selected range.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Account</th>
              <th className="num">Leads added</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.campaign_id}>
                <td>
                  <Link className="row-link" to={`/campaign/${encodeURIComponent(c.campaign_id)}`}>
                    {c.campaign_name}
                  </Link>
                </td>
                <td className="muted">{instanceName(instances.find((i) => i.id === c.instance_id), c.instance_id)}</td>
                <td className="num">{(c.leads_added ?? 0).toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr className="cmp-avg">
                <td>Total</td>
                <td />
                <td className="num">{total.toLocaleString('en-US')}</td>
              </tr>
            </tfoot>
          )}
        </table>
      )}
    </div>
  )
}
