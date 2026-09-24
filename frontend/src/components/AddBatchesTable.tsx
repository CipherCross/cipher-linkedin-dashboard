import { Calendar } from 'lucide-react'
import type { Lead } from '../lib/types'
import { addedByDay } from '../lib/leads'
import { num, shortDate } from '../lib/format'
import { EmptyState, Panel, SectionHeader, Table, TableFrame } from '../ui'

/** Batch history of when leads were queued into the campaign: one row per
 *  add date with its count, newest first, over the full campaign history. */
export function AddBatchesTable({ leads }: { leads: Lead[] }) {
  const { byDay, undated } = addedByDay(leads)
  const rows = [...byDay.entries()].sort(([a], [b]) => (a < b ? 1 : -1))

  return (
    <Panel>
      <SectionHeader title="Lead add dates" />
      <TableFrame scrollLabel="Lead add dates">
        <Table caption="Lead add dates">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col" className="ui-table__num">Leads added</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([day, added]) => (
              <tr key={day}>
                <td>{shortDate(day)}</td>
                <td className="ui-table__num">{num(added)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={2}>
                  <EmptyState icon={Calendar} title="No add dates yet" />
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </TableFrame>
      {undated > 0 && (
        <p className="text-app-meta text-app-text-muted mt-app-md">
          {num(undated)} lead{undated === 1 ? '' : 's'} with no known add date.
        </p>
      )}
    </Panel>
  )
}
