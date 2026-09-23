import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { UserRoundPlus } from 'lucide-react'
import type { CampaignMetrics, Instance } from '../lib/types'
import { instanceName } from '../lib/leads'
import {
  EmptyState, Panel, SectionHeader, Table, TableFrame, TableToolbar,
} from '../ui'

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
    <Panel>
      <SectionHeader title="Leads added by campaign" />
      <TableFrame
        scrollLabel="Leads added by campaign"
        toolbar={<TableToolbar count={`${total.toLocaleString('en-US')} in range`} />}
      >
        <Table caption="Leads added by campaign">
          <thead>
            <tr>
              <th scope="col">Campaign</th>
              <th scope="col">Account</th>
              <th scope="col" className="ui-table__num">Leads added</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.campaign_id}>
                <td>
                  <Link
                    className="text-app-text no-underline transition-colors hover:text-app-accent hover:underline"
                    to={`/campaign/${encodeURIComponent(c.campaign_id)}`}
                  >
                    {c.campaign_name}
                  </Link>
                </td>
                <td className="text-app-text-muted">{instanceName(instances.find((i) => i.id === c.instance_id), c.instance_id)}</td>
                <td className="ui-table__num">{(c.leads_added ?? 0).toLocaleString('en-US')}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3}>
                  <EmptyState
                    icon={UserRoundPlus}
                    title="No leads were added in the selected range."
                  />
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr className="[&>td]:border-t [&>td]:border-app-border [&>td]:text-app-text-muted [&>td]:font-semibold">
                <td>Total</td>
                <td />
                <td className="ui-table__num">{total.toLocaleString('en-US')}</td>
              </tr>
            </tfoot>
          )}
        </Table>
      </TableFrame>
    </Panel>
  )
}
