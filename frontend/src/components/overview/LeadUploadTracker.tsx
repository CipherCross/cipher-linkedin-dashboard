import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { UserRoundPlus } from 'lucide-react'
import { accountLabeller } from '../../lib/leads'
import { num } from '../../lib/format'
import type { Instance, OverviewLeadUploads } from '../../lib/types'
import { Skeleton } from '../Skeleton'
import {
  EmptyState, InlineError, Panel, SectionHeader, Table, TableFrame, UpdatingNote,
} from '../../ui'
import { AccountCell } from './OverviewAnalytics'

const MUTED = 'text-app-text-muted text-app-meta'

const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' })
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** The `days` UTC calendar days ending on `today` (inclusive), oldest first. */
export function uploadTrackerDays(today: string, days = 7): string[] {
  const end = new Date(`${today}T00:00:00Z`).getTime()
  return Array.from({ length: days }, (_, index) =>
    new Date(end - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10))
}

/**
 * Leads queued into each account's campaigns on each of the last seven UTC
 * days, so the SDR can see which account was fed and which was missed. One row
 * per rostered account — an account with no uploads stays visible as a row of
 * zeros, because a missing upload is the thing this block exists to show.
 */
export function LeadUploadTracker({
  uploads, instances, days, loading, error, onRetry,
}: {
  uploads: OverviewLeadUploads | null
  instances: Instance[]
  /** `YYYY-MM-DD` columns, oldest first; the last one is today. */
  days: string[]
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  const accountLabel = useMemo(() => accountLabeller(instances), [instances])
  const counts = useMemo(() => {
    const byKey = new Map<string, number>()
    for (const row of uploads?.days ?? []) byKey.set(`${row.instance_id}|${row.day}`, row.leads)
    return byKey
  }, [uploads])
  const rows = useMemo(() => instances.map((instance) => {
    const perDay = days.map((day) => counts.get(`${instance.id}|${day}`) ?? 0)
    return { instance, perDay, total: perDay.reduce((sum, value) => sum + value, 0) }
  }).sort((a, b) => b.total - a.total || accountLabel(a.instance.id).localeCompare(accountLabel(b.instance.id))),
  [instances, days, counts, accountLabel])
  const dayTotals = days.map((_, index) => rows.reduce((sum, row) => sum + row.perDay[index], 0))
  const grandTotal = dayTotals.reduce((sum, value) => sum + value, 0)
  const today = days[days.length - 1]

  return (
    <Panel aria-labelledby="overview-uploads-title" aria-busy={loading}>
      <SectionHeader
        id="overview-uploads-title"
        title="Lead uploads"
        description="Leads added to each account's campaigns · Last 7 days · UTC · Today is in progress"
        actions={loading && uploads ? <UpdatingNote /> : undefined}
      />
      {loading && !uploads ? (
        <div className="flex flex-col gap-stack" role="status" aria-label="Loading lead uploads">
          {Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} width="100%" height={32} />)}
        </div>
      ) : error ? (
        <InlineError title="Lead uploads could not load." detail={error} onRetry={onRetry} />
      ) : instances.length === 0 ? (
        <EmptyState icon={UserRoundPlus} title="No accounts yet" hint="Accounts appear here once a notebook syncs." />
      ) : (
        <TableFrame className="ov-uploads-frame" scrollLabel="Lead uploads by account and day">
          <Table caption="Lead uploads by account and day">
            <thead>
              <tr>
                <th scope="col">Account</th>
                {days.map((day) => (
                  <th key={day} scope="col" className="ui-table__num">
                    <span className="ov-upload-day">
                      <span>{day === today ? 'Today' : weekday.format(new Date(`${day}T00:00:00Z`))}</span>
                      <span className={MUTED}>{dayMonth.format(new Date(`${day}T00:00:00Z`))}</span>
                    </span>
                  </th>
                ))}
                <th scope="col" className="ui-table__num">7 days</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ instance, perDay, total }) => (
                <tr key={instance.id} className="ui-table__row--identity">
                  <td>
                    <Link
                      className="text-app-text no-underline hover:text-app-accent"
                      to={`/account/${encodeURIComponent(instance.id)}`}
                    >
                      <AccountCell instance={instance} fallback={accountLabel(instance.id)} />
                    </Link>
                  </td>
                  {perDay.map((value, index) => (
                    <td key={days[index]} className={`ui-table__num${value === 0 ? ' text-app-text-muted' : ''}`}>
                      {value === 0 ? '—' : num(value)}
                    </td>
                  ))}
                  <td className="ui-table__num font-semibold">{num(total)}</td>
                </tr>
              ))}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <tr>
                  <th scope="row">All accounts</th>
                  {dayTotals.map((value, index) => (
                    <td key={days[index]} className="ui-table__num font-semibold">{num(value)}</td>
                  ))}
                  <td className="ui-table__num font-semibold">{num(grandTotal)}</td>
                </tr>
              </tfoot>
            )}
          </Table>
        </TableFrame>
      )}
    </Panel>
  )
}
