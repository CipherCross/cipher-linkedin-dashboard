import { useMemo, useState } from 'react'
import { useData } from '../lib/DataContext'
import { latestRepliesByLead, presetRanges, rangeTotals } from '../lib/leads'
import type { DateRange } from '../lib/leads'
import { KpiCards } from '../components/KpiCards'
import { AccountCard } from '../components/AccountCard'
import { HotLeads } from '../components/HotLeads'
import { DateRangePicker } from '../components/DateRangePicker'

const STALE_HOURS = 24

export function Overview() {
  const { data } = useData()
  const RANGES = useMemo(() => presetRanges(), [])
  const [range, setRange] = useState<DateRange>(
    () => RANGES.find((r) => r.id === '3_months') ?? RANGES[RANGES.length - 1],
  )

  const view = useMemo(() => {
    if (!data) return null
    const leadsByInstance = new Map<string, typeof data.leads>()
    for (const l of data.leads) {
      const arr = leadsByInstance.get(l.instance_id)
      if (arr) arr.push(l)
      else leadsByInstance.set(l.instance_id, [l])
    }
    // Fresh accounts first, then by pipeline size.
    const staleCutoff = Date.now() - STALE_HOURS * 3_600_000
    const instances = [...data.instances].sort((a, b) => {
      const freshA = a.last_sync_at ? new Date(a.last_sync_at).getTime() > staleCutoff : false
      const freshB = b.last_sync_at ? new Date(b.last_sync_at).getTime() > staleCutoff : false
      if (freshA !== freshB) return freshA ? -1 : 1
      return (leadsByInstance.get(b.id)?.length ?? 0) - (leadsByInstance.get(a.id)?.length ?? 0)
    })
    const latest = latestRepliesByLead(data.messages)
    return { instances, leadsByInstance, latest, totals: rangeTotals(data.leads, range, latest) }
  }, [data, range])

  if (!data || !view) return null

  return (
    <>
      <header>
        <div>
          <h1>Overview</h1>
          <div className="muted small">
            All LinkedIn accounts at a glance · {data.instances.length} Linked Helper instances
          </div>
        </div>
        <div className="controls">
          <DateRangePicker presets={RANGES} value={range} onChange={setRange} />
        </div>
      </header>

      <KpiCards totals={view.totals} flowLabel={range.label} positive={view.totals.positive} />

      <HotLeads
        leads={data.leads}
        latest={view.latest}
        range={range}
        campaigns={data.campaigns}
        instances={data.instances}
      />

      <div className="account-grid">
        {view.instances.map((inst) => (
          <AccountCard
            key={inst.id}
            inst={inst}
            leads={view.leadsByInstance.get(inst.id) ?? []}
            campaignsMeta={data.campaigns}
            range={range}
            latest={view.latest}
          />
        ))}
        {view.instances.length === 0 && (
          <div className="card muted">No instances registered yet.</div>
        )}
      </div>
    </>
  )
}
