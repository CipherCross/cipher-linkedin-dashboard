import { useMemo, useState } from 'react'
import { Download, CalendarRange } from 'lucide-react'
import type { Instance } from '../lib/types'
import { EmptyState } from './EmptyState'
import { downloadCsv, instanceName, toCsv } from '../lib/leads'
import {
  SMALL_COHORT, cellAcceptRate, cellPositiveShare, cellReplyRate, reviewCsvRows,
} from '../lib/review'
import type { CohortCell, CohortData, CohortRow } from '../lib/review'
import { shortDate } from '../lib/format'

type Metric = 'invites' | 'accept' | 'reply' | 'positive'

const METRICS: Array<{ id: Metric; label: string }> = [
  { id: 'invites', label: 'Invites' },
  { id: 'accept', label: 'Accept %' },
  { id: 'reply', label: 'Reply %' },
  { id: 'positive', label: 'P3 share' },
]

const rateOf = (cell: CohortCell, metric: Metric): number | null => {
  if (metric === 'accept') return cellAcceptRate(cell)
  if (metric === 'reply') return cellReplyRate(cell)
  if (metric === 'positive') return cellPositiveShare(cell)
  return null
}

/** A rate cohort is "matured" for the toggled metric on its own lag: acceptance
 *  matures first, reply / P3 later. */
const isMatured = (cell: CohortCell, metric: Metric): boolean =>
  metric === 'accept' ? cell.acceptMatured : cell.replyMatured

/** Campaigns × invite-week-cohort matrix, grouped under account subheads. The
 *  metric toggle switches the cell body between invite volume and one of three
 *  rates. For a rate metric, a cohort still inside its maturity window shows its
 *  provisional rate greyed (never counted toward deltas); the WoW ▲/▼ chip
 *  compares only consecutive matured cohorts. */
export function CohortComparisonTable({
  data, instances,
}: { data: CohortData; instances: Instance[] }) {
  const [metric, setMetric] = useState<Metric>('accept')

  // Group rows under their account, accounts ordered by name.
  const groups = useMemo(() => {
    const byAccount = new Map<string, CohortRow[]>()
    for (const row of data.rows) {
      const list = byAccount.get(row.instanceId) ?? []
      list.push(row)
      byAccount.set(row.instanceId, list)
    }
    const list = [...byAccount.entries()].map(([instanceId, rows]) => ({
      instanceId,
      account: instanceName(instances.find((i) => i.id === instanceId), instanceId),
      rows,
    }))
    // Two instances can share one owner name (e.g. the same person on two
    // notebooks) — suffix the instance id so the repeated subheads stay tellable
    // apart instead of reading as an accidental duplicate.
    const nameCount = new Map<string, number>()
    for (const g of list) nameCount.set(g.account, (nameCount.get(g.account) ?? 0) + 1)
    return list
      .map((g) =>
        (nameCount.get(g.account) ?? 0) > 1
          ? { ...g, account: `${g.account} · ${g.instanceId}` }
          : g,
      )
      .sort((a, b) => a.account.localeCompare(b.account))
  }, [data.rows, instances])

  const exportCsv = () =>
    downloadCsv(
      `review-cohorts-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(reviewCsvRows(data, instances)),
    )

  const { maturity } = data
  const colSpan = data.weeks.length + 1

  return (
    <div className="card">
      <div className="card-head">
        <h2>Cohort comparison — by invite week</h2>
        <div className="table-toolbar-actions">
          <div className="segmented" role="tablist" aria-label="Metric">
            {METRICS.map((m) => (
              <button
                key={m.id}
                className={`segmented-item ${metric === m.id ? 'active' : ''}`}
                role="tab"
                aria-selected={metric === m.id}
                onClick={() => setMetric(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <button className="btn sm" onClick={exportCsv} disabled={data.rows.length === 0}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      <div className="cohort-scroll">
        <table className="cohort-table">
          <thead>
            <tr>
              <th className="cohort-camp-col">Campaign</th>
              {data.weeks.map((w) => (
                <th key={w} className="num">{shortDate(w)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <SubGroup key={g.instanceId} account={g.account} rows={g.rows} weeks={data.weeks} metric={metric} colSpan={colSpan} />
            ))}
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={colSpan}>
                  <EmptyState
                    icon={CalendarRange}
                    title="No invites in this window"
                    hint="Widen the week range or wait for accounts to send invites."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="muted small cohort-foot">
        Cohort = the week the invite went out. A cohort's rates stay greyed as
        “still maturing” until {maturity.acceptWeeks}w (accept) / {maturity.replyWeeks}w
        (reply) after its Monday; WoW ▲/▼ (percentage points) compare only matured
        cohorts. ⚠ = under {SMALL_COHORT} invites, rate is noisy.{' '}
        {maturity.thin
          ? 'Lag sample too thin — using fixed 2w / 4w thresholds.'
          : `Observed p90 lag: accept ${fmtDays(maturity.p90Accept)}, reply ${fmtDays(maturity.p90Reply)} (last 90 days).`}
      </div>
    </div>
  )
}

function SubGroup({
  account, rows, weeks, metric, colSpan,
}: {
  account: string
  rows: CohortRow[]
  weeks: string[]
  metric: Metric
  colSpan: number
}) {
  return (
    <>
      <tr className="cohort-subhead">
        <td colSpan={colSpan}>
          {/* Sticky so the group label stays readable while the matrix is
              scrolled horizontally (the full-width td itself can't be pinned). */}
          <span className="cohort-subhead-label">{account}</span>
        </td>
      </tr>
      {rows.map((row) => (
        <tr key={row.campaignId}>
          <td className="cohort-camp-col" title={row.campaignName}>{row.campaignName}</td>
          {weeks.map((w) => (
            <Cell key={w} cell={row.cells.get(w)} prevRate={prevMaturedRate(row, weeks, w, metric)} metric={metric} />
          ))}
        </tr>
      ))}
    </>
  )
}

/** The most recent matured rate strictly BEFORE `week` for this campaign / metric —
 *  the baseline for the WoW delta. Maturing cohorts are skipped entirely. */
function prevMaturedRate(row: CohortRow, weeks: string[], week: string, metric: Metric): number | null {
  if (metric === 'invites') return null
  const idx = weeks.indexOf(week)
  for (let i = idx - 1; i >= 0; i--) {
    const c = row.cells.get(weeks[i])
    if (c && c.invites > 0 && isMatured(c, metric)) return rateOf(c, metric)
  }
  return null
}

function Cell({
  cell, prevRate, metric,
}: { cell: CohortCell | undefined; prevRate: number | null; metric: Metric }) {
  if (!cell || cell.invites === 0) return <td className="num muted">—</td>

  if (metric === 'invites') {
    return <td className="num">{cell.invites.toLocaleString('en-US')}</td>
  }

  const rate = rateOf(cell, metric)
  if (rate == null) return <td className="num muted">—</td>

  const matured = isMatured(cell, metric)
  const small = cell.invites < SMALL_COHORT
  const delta = matured && prevRate != null ? Math.round((rate - prevRate) * 10) / 10 : null

  return (
    <td className="num">
      <span className={matured ? 'cohort-rate' : 'cohort-rate maturing'} title={maturingTitle(matured)}>
        {rate.toFixed(1)}%
        {small && <span className="cmp-warn" title={`Only ${cell.invites} invites — rate is noisy`}> ⚠</span>}
      </span>
      {delta != null && delta !== 0 && (
        <span className={`kpi-delta ${delta > 0 ? 'up' : 'down'} cohort-d`} title="vs prior matured cohort (pct points)">
          {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}
        </span>
      )}
    </td>
  )
}

const maturingTitle = (matured: boolean) =>
  matured ? undefined : 'Still maturing — too few of this cohort have had the chance to convert yet'

const fmtDays = (d: number | null) => (d == null ? '—' : `${d.toFixed(1)}d`)
