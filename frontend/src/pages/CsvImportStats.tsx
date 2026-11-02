import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, RefreshCw, Settings2 } from 'lucide-react'
import { KpiGrid, KpiTile } from '../components/KpiTile'
import { DateRangePicker } from '../components/DateRangePicker'
import { Skeleton } from '../components/Skeleton'
import { AIRTABLE_BASES, airtableBaseLabel } from '../lib/airtableBases'
import type { AirtableBaseId } from '../lib/airtableBases'
import { num } from '../lib/format'
import { fetchImportStats } from '../lib/importApi'
import { teamStatsRanges, type DateRange } from '../lib/leads'
import {
  MAX_TEAM_STATS_DAYS, METRIC_LABEL, TEAM_STATS_BLOCKS, blockTable, teamStatsColumns,
  type BlockTable, type CellMetric, type ConfiguredTeamStats, type StatsColumn, type TeamStatsBlock,
  type TeamStatsResponse, type TeamStatsTable,
} from '../lib/teamStats'
import {
  Button, EmptyState, InlineError, Panel, SectionHeader, SegmentedControl, Table, TableFrame, UpdatingNote,
} from '../ui'
import { Notice, messageOf } from './CsvImportShared'

// Team stats: who added how many companies and leads to Airtable, and how many
// are approved now. It reads, never writes. The base is the one picked in the
// page header; "All bases" sums every configured base. Each base is its own
// request, run one after another, so two bases never share one function's time
// budget or one process's Airtable rate gate.

type Scope = 'base' | 'all'

interface Entry {
  loading: boolean
  data?: TeamStatsResponse
  error?: string
}

const MUTED = 'text-app-text-muted text-app-meta'
const METRICS: CellMetric[] = ['all', 'new', 'approve', 'reject']
const METRIC_ITEMS = METRICS.map((id) => ({ id, label: METRIC_LABEL[id] }))
const DEFAULT_RANGE_ID = '14_days'

const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' })
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const utcDate = (day: string) => new Date(`${day}T00:00:00Z`)

const entryKey = (base: AirtableBaseId, from: string, to: string) => `${base}|${from}|${to}`

/** The selected base first, then the rest in registry order. */
const basesFor = (scope: Scope, base: AirtableBaseId): AirtableBaseId[] =>
  scope === 'base' ? [base] : [base, ...AIRTABLE_BASES.map((item) => item.id).filter((id) => id !== base)]

function ColumnHeader({ column }: { column: StatsColumn }) {
  const top = column.kind === 'week' ? 'Week' : weekday.format(utcDate(column.from))
  const title = column.kind === 'week'
    ? `${dayMonth.format(utcDate(column.from))} – ${dayMonth.format(utcDate(column.to))} · UTC`
    : undefined
  return (
    <span className="inline-flex flex-col items-end" title={title}>
      <span>{top}</span>
      <span className={MUTED}>{dayMonth.format(utcDate(column.from))}</span>
    </span>
  )
}

/** What each status choice of `table` counts as, across the bases shown. */
function statusLegend(stats: ConfiguredTeamStats[], table: TeamStatsTable): string {
  const groups = new Map<string, Set<string>>()
  for (const base of stats) {
    for (const status of base.tables[table].statuses) {
      const names = groups.get(status.group) ?? new Set<string>()
      names.add(status.name)
      groups.set(status.group, names)
    }
  }
  const part = (group: string, label: string) => {
    const names = [...(groups.get(group) ?? [])]
    return names.length ? `${label}: ${names.join(', ')}` : ''
  }
  return [
    part('approve', 'Approve'),
    part('reject', 'Reject'),
    `New: ${[...(groups.get('new') ?? []), 'blank', 'any other value'].join(', ')}`,
    part('excluded', 'Not counted'),
  ].filter(Boolean).join(' · ')
}

function StatsBlock({ block, table, columns, stats, scopeLabel }: {
  block: TeamStatsBlock
  table: BlockTable
  columns: StatsColumn[]
  stats: ConfiguredTeamStats[]
  scopeLabel: string
}) {
  const [metric, setMetric] = useState<CellMetric>(block.defaultMetric)
  const titleId = `team-stats-${block.id}`
  const caption = `${block.title} by person and ${columns[0]?.kind === 'week' ? 'week' : 'day'} · ${scopeLabel}`
  return (
    <Panel className="mb-section" aria-labelledby={titleId}>
      <SectionHeader
        id={titleId}
        title={block.title}
        description={block.description}
        actions={<SegmentedControl label={`${block.title}: cells show`} items={METRIC_ITEMS} value={metric} onChange={setMetric} />}
      />
      <TableFrame scrollLabel={caption} hint={statusLegend(stats, block.table)}>
        <Table caption={caption} className="team-stats-table">
          <thead>
            <tr>
              <th scope="col">Added by</th>
              {columns.map((column) => (
                <th key={column.key} scope="col" className="ui-table__num"><ColumnHeader column={column} /></th>
              ))}
              {METRICS.map((key, index) => (
                <th key={key} scope="col" className={`ui-table__num${index === 0 ? ' team-stats-split' : ''}`}>
                  {METRIC_LABEL[key]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.person || '(not set)'} data-person={row.person}>
                <td className={row.person ? undefined : 'text-app-text-muted'}>{row.label}</td>
                {row.perColumn.map((counts, index) => (
                  <td key={columns[index].key} className={`ui-table__num${counts[metric] === 0 ? ' text-app-text-muted' : ''}`}>
                    {num(counts[metric])}
                  </td>
                ))}
                {METRICS.map((key, index) => (
                  <td
                    key={key}
                    className={`ui-table__num${index === 0 ? ' team-stats-split font-semibold' : ''}${row.totals[key] === 0 ? ' text-app-text-muted' : ''}`}
                  >
                    {num(row.totals[key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">All people</th>
              {table.columnTotals.map((counts, index) => (
                <td key={columns[index].key} className="ui-table__num font-semibold">{num(counts[metric])}</td>
              ))}
              {METRICS.map((key, index) => (
                <td key={key} className={`ui-table__num font-semibold${index === 0 ? ' team-stats-split' : ''}`}>
                  {num(table.totals[key])}
                </td>
              ))}
            </tr>
          </tfoot>
        </Table>
      </TableFrame>
    </Panel>
  )
}

export function TeamStats({ base }: { base: AirtableBaseId }) {
  const presets = useMemo(() => teamStatsRanges(), [])
  const [range, setRange] = useState<DateRange>(
    () => presets.find((preset) => preset.id === DEFAULT_RANGE_ID) ?? presets[0],
  )
  const [scope, setScope] = useState<Scope>('base')
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const requested = useRef(new Set<string>())
  const from = range.from ?? ''
  const to = range.to ?? ''

  const load = useCallback(async (bases: AirtableBaseId[], force: boolean) => {
    for (const id of bases) {
      const key = entryKey(id, from, to)
      if (requested.current.has(key) && !force) continue
      requested.current.add(key)
      setEntries((current) => ({ ...current, [key]: { ...current[key], loading: true, error: undefined } }))
      try {
        const data = await fetchImportStats(id, from, to, { force })
        setEntries((current) => ({ ...current, [key]: { loading: false, data } }))
      } catch (reason) {
        // Forget the request, so coming back to this base and period tries again.
        requested.current.delete(key)
        setEntries((current) => ({ ...current, [key]: { ...current[key], loading: false, error: messageOf(reason) } }))
      }
    }
  }, [from, to])

  useEffect(() => {
    if (from && to) void load(basesFor(scope, base), false)
  }, [load, scope, base, from, to])

  const shown = useMemo(
    () => basesFor(scope, base).map((id) => ({ id, entry: entries[entryKey(id, from, to)] as Entry | undefined })),
    [entries, scope, base, from, to],
  )
  const stats = useMemo(
    () => shown.flatMap(({ entry }) => (entry?.data?.configured ? [entry.data] : [])),
    [shown],
  )
  const loading = shown.some(({ entry }) => !entry || entry.loading)
  const columns = useMemo(() => (from && to ? teamStatsColumns(from, to) : []), [from, to])
  const tables = useMemo(
    () => TEAM_STATS_BLOCKS.map((block) => blockTable(stats, block.table, columns)),
    [stats, columns],
  )
  // A refresh that failed over numbers already on screen keeps the numbers.
  const refreshError = shown.find(({ entry }) => entry?.error && entry.data)?.entry?.error

  const scopeLabel = scope === 'base' ? airtableBaseLabel(base) : 'All bases'
  const notIncluded = shown.flatMap(({ id, entry }) => {
    if (entry?.data && !entry.data.configured) return [`${airtableBaseLabel(id)} (not configured)`]
    if (entry?.error && !entry.data) return [`${airtableBaseLabel(id)} (could not load)`]
    return []
  })
  const single = scope === 'base' ? shown[0]?.entry : undefined
  const failed = scope === 'base' ? (single?.error && !single.data ? single.error : null) : null
  const notConfigured = scope === 'base' && single?.data?.configured === false
  const nothingYet = stats.length === 0 && loading
  const allFailed = scope === 'all' && !loading && stats.length === 0

  const [companyAdds, leadAdds] = tables

  return (
    <div aria-busy={loading}>
      <div className="flex items-center gap-inline flex-wrap mb-section">
        <SegmentedControl
          label="Stats scope"
          items={[{ id: 'base' as const, label: airtableBaseLabel(base) }, { id: 'all' as const, label: 'All bases' }]}
          value={scope}
          onChange={setScope}
        />
        <DateRangePicker
          ariaLabel="Team stats period"
          presets={presets}
          value={range}
          onChange={setRange}
          maxDays={MAX_TEAM_STATS_DAYS}
        />
        <Button
          variant="secondary"
          icon={<RefreshCw aria-hidden="true" />}
          disabled={loading}
          onClick={() => void load(basesFor(scope, base), true)}
        >
          Refresh
        </Button>
        {loading && !nothingYet && <UpdatingNote />}
        <span className={`${MUTED} ml-auto`}>
          By the day each record was created · UTC · statuses as they are now · Old records are not counted
        </span>
      </div>

      {refreshError && (
        <InlineError title="Refresh failed; showing the last numbers loaded." message={refreshError} />
      )}
      {scope === 'all' && notIncluded.length > 0 && !allFailed && (
        <Notice>Not included in All bases: {notIncluded.join(', ')}.</Notice>
      )}

      {notConfigured ? (
        <Panel>
          <EmptyState
            icon={Settings2}
            title={`${airtableBaseLabel(base)} is not configured`}
            hint="Its Airtable base ID is not set on the server, so there is nothing to count. The other bases still work."
          />
        </Panel>
      ) : failed ? (
        <InlineError
          title={`Team stats for ${airtableBaseLabel(base)} could not load.`}
          message={failed}
          onRetry={() => void load([base], true)}
        />
      ) : allFailed ? (
        <Panel>
          <EmptyState
            icon={BarChart3}
            title="No base could be counted"
            hint={`Not included: ${notIncluded.join(', ')}.`}
            action={<Button variant="secondary" onClick={() => void load(basesFor('all', base), true)}>Try again</Button>}
          />
        </Panel>
      ) : nothingYet ? (
        <div className="flex flex-col gap-stack" role="status" aria-label="Loading team stats">
          <Skeleton width="100%" height={96} />
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} width="100%" height={32} />)}
        </div>
      ) : (
        <>
          <KpiGrid>
            <KpiTile
              label="Companies added"
              value={num(companyAdds.totals.all)}
              sub={`${num(companyAdds.totals.approve)} approve · ${num(companyAdds.totals.reject)} reject · ${num(companyAdds.totals.new)} new`}
            />
            <KpiTile
              label="Leads added"
              value={num(leadAdds.totals.all)}
              sub={`${num(leadAdds.totals.approve)} approve · ${num(leadAdds.totals.reject)} reject · ${num(leadAdds.totals.new)} new`}
            />
          </KpiGrid>
          {TEAM_STATS_BLOCKS.map((block, index) => (
            <StatsBlock
              key={`${scope}|${block.id}`}
              block={block}
              table={tables[index]}
              columns={columns}
              stats={stats}
              scopeLabel={scopeLabel}
            />
          ))}
        </>
      )}
    </div>
  )
}
