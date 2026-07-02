import type { Lead } from '../lib/types'
import { addedByDay } from '../lib/leads'

/** Batch history of when leads were queued into the campaign: one row per
 *  add date with its count, newest first, over the full campaign history. */
export function AddBatchesTable({ leads }: { leads: Lead[] }) {
  const { byDay, undated } = addedByDay(leads)
  const rows = [...byDay.entries()].sort(([a], [b]) => (a < b ? 1 : -1))

  return (
    <div className="card">
      <h2>Lead add dates</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Leads added</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([day, added]) => (
              <tr key={day}>
                <td>{day}</td>
                <td className="num">{added}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={2} className="muted">No add dates yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {undated > 0 && (
        <div className="muted small">
          {undated.toLocaleString('en-US')} lead{undated === 1 ? '' : 's'} with no known add date.
        </div>
      )}
    </div>
  )
}
