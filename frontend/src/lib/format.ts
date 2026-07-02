// Single source of truth for date / number / percent display across the UI.
// Milestone day-strings are treated as UTC calendar dates (matching leads.ts and
// the SQL day-slices), so a lead's "Invited" day never shifts by the viewer's
// timezone. Wall-clock timestamps (message/thread times) render in local time.

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** "Jun 25" in the current year, "Jun 25 '24" across years, "—" when null.
 *  Formatted from the YYYY-MM-DD prefix so the calendar day matches the way
 *  milestones are day-sliced everywhere else (no timezone drift). */
export function shortDate(ts: string | null | undefined): string {
  if (!ts) return '—'
  const [y, m, d] = ts.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return '—'
  const label = `${MONTHS[m - 1]} ${d}`
  return y === new Date().getUTCFullYear() ? label : `${label} '${String(y).slice(2)}`
}

/** Relative time: "just now" / "5m ago" / "3h ago" / "2d ago". "—" when null. */
export function ago(ts: string | null | undefined): string {
  if (!ts) return '—'
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

/** "Jun 25, 2:04 PM" in the viewer's local timezone — for message/thread times
 *  (LinkedIn message clocks are meaningful in the reader's own timezone). */
export function dateTime(ts: string): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

/** Integer with thousands separators. */
export function num(n: number): string {
  return n.toLocaleString('en-US')
}

/** a / b as a one-decimal percent, or "—" when b is 0. */
export function pct(a: number, b: number): string {
  return b > 0 ? ((100 * a) / b).toFixed(1) + '%' : '—'
}

/** An already-computed percentage number, one decimal; "—" when null. */
export function rate(r: number | null | undefined): string {
  return r == null ? '—' : r.toFixed(1) + '%'
}
