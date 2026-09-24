import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ClipboardCheck, Send } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import {
  accountLabeller, lastWeeks, latestRepliesByLead, presetRanges, rangeFromParam,
  rangeToParam, rangedCampaigns, replyIntentMetrics,
} from '../lib/leads'
import type { DateRange, ReplyIntentMetrics } from '../lib/leads'
import { authPost } from '../lib/api'
import { CohortComparisonTable } from '../components/CohortComparisonTable'
import { TemplateComparison } from '../components/TemplateComparison'
import { SentimentTrendChart } from '../components/SentimentTrendChart'
import { LeadsAddedTable } from '../components/LeadsAddedTable'
import { DateRangePicker } from '../components/DateRangePicker'
import { KpiGrid, KpiTile } from '../components/KpiTile'
import { buildDigest, cohortRows } from '../lib/review'
import type { DigestPayload } from '../lib/review'
import type { Instance } from '../lib/types'
import { num } from '../lib/format'
import {
  Button, LinkButton, PageHeader, Panel, SectionHeader, SegmentedControl, SelectField, Tabs, EmptyState,
} from '../ui'

const WEEK_OPTIONS = [8, 12, 16]
const DEFAULT_WEEKS = 12

const TABS = [
  { id: 'review', label: 'Review' },
  { id: 'leads-added', label: 'Leads Added' },
] as const

/** Manager weekly review: cohort-matured funnel comparison, reply-sentiment trend
 *  and message-template comparison over the already-fetched data. Read-only; the
 *  only write is the admin-guarded "Send to Slack" digest. A second tab breaks out
 *  per-campaign leads added over a chosen date range. */
export function Review() {
  const { data } = useData()
  const [params, setParams] = useSearchParams()
  const [inst, setInst] = useState('all')
  const [weeks, setWeeks] = useState(DEFAULT_WEEKS)

  const RANGES = useMemo(() => presetRanges(), [])
  const tab = params.get('tab') === 'leads-added' ? 'leads-added' : 'review'
  const range = useMemo<DateRange>(
    () =>
      rangeFromParam(params.get('range'), RANGES) ??
      RANGES.find((r) => r.id === '3_months') ??
      RANGES[RANGES.length - 1],
    [params, RANGES],
  )
  const setTab = (id: string) => {
    const next = new URLSearchParams(params)
    next.set('tab', id)
    setParams(next, { replace: true })
  }
  const setRange = (r: DateRange) => {
    const next = new URLSearchParams(params)
    next.set('range', rangeToParam(r))
    setParams(next, { replace: true })
  }

  const latest = useMemo(() => latestRepliesByLead(data?.messages ?? []), [data])

  const leads = useMemo(
    () => (data ? data.leads.filter((l) => inst === 'all' || l.instance_id === inst) : []),
    [data, inst],
  )

  const campaigns = useMemo(
    () => (data ? data.campaigns.filter((c) => inst === 'all' || c.instance_id === inst) : []),
    [data, inst],
  )

  const cohortData = useMemo(
    () => cohortRows(leads, campaigns, latest, weeks),
    [leads, campaigns, latest, weeks],
  )
  const intentOutcomes = useMemo(() => {
    if (!data) return null
    const from = lastWeeks(weeks)[0] ?? null
    const intentRange: DateRange = {
      id: 'review-intent',
      label: `Last ${weeks} weeks`,
      from,
      to: new Date().toISOString().slice(0, 10),
    }
    return replyIntentMetrics(data.leads, data.messages, data.pipelineEvents, intentRange, {
      instanceId: inst === 'all' ? undefined : inst,
      intentRows: data.conversationReplyIntents,
    })
  }, [data, inst, weeks])

  const rangedAdded = useMemo(
    () => (data ? rangedCampaigns(leads, campaigns, range) : []),
    [data, leads, campaigns, range],
  )

  const accountLabel = accountLabeller(data?.instances)
  const scope = inst === 'all' ? 'All accounts' : accountLabel(inst)
  const digest = useMemo(
    () => (data ? buildDigest(cohortData, data.instances, scope) : null),
    [data, cohortData, scope],
  )

  if (!data) return null

  const anyInvited = data.leads.some((l) => l.invited_at)

  return (
    <>
      <ReviewHeader
        instances={data.instances}
        inst={inst}
        setInst={setInst}
        weeks={weeks}
        setWeeks={setWeeks}
        digest={tab === 'review' && anyInvited ? digest : null}
        tab={tab}
        range={range}
        presets={RANGES}
        setRange={setRange}
      />

      <Tabs
        label="Review section"
        value={tab}
        onChange={setTab}
        items={TABS.map((t) => ({ id: t.id, label: t.label }))}
      />

      {tab === 'leads-added' ? (
        <LeadsAddedTable campaigns={rangedAdded} instances={data.instances} />
      ) : !anyInvited ? (
        <Panel>
          <EmptyState
            icon={ClipboardCheck}
            title="Nothing to review yet"
            hint="Cohort comparisons appear here once your accounts have sent invites."
          />
        </Panel>
      ) : (
        <div className="flex flex-col gap-app-xl mb-app-xl [&>*]:mt-0">
          {/* The gap alone spaces the sections; `.ui-panel + .ui-panel` would
              add its own margin on top of it between two adjacent panels. */}
          {intentOutcomes && <P3OutcomeSummary metrics={intentOutcomes} weeks={weeks} />}
          <CohortComparisonTable data={cohortData} instances={data.instances} />
          <TemplateComparison
            campaigns={campaigns}
            leads={leads}
            steps={data.steps}
            latestReplies={latest}
            maturity={cohortData.maturity}
            instances={data.instances}
            weeks={weeks}
          />
          <SentimentTrendChart
            messages={data.messages}
            instanceId={inst === 'all' ? undefined : inst}
            weeks={weeks}
          />
        </div>
      )}
    </>
  )
}

function ReviewHeader({
  instances, inst, setInst, weeks, setWeeks, digest, tab, range, presets, setRange,
}: {
  instances: Instance[]
  inst: string
  setInst: (v: string) => void
  weeks: number
  setWeeks: (v: number) => void
  digest: DigestPayload | null
  tab: string
  range: DateRange
  presets: DateRange[]
  setRange: (r: DateRange) => void
}) {
  const accountLabel = accountLabeller(instances)
  return (
    <PageHeader
      title="Manager review"
      description="Cohort-matured funnel, P1–P3 buying interest and template comparison for the weekly review. Rates for cohorts too fresh to judge are held back."
      actions={<>
        <LinkButton variant="ghost" to="/sentiment-analysis">Sentiment analysis</LinkButton>
        <SelectField
          label="Account"
          labelHidden
          value={inst}
          onChange={(e) => setInst(e.target.value)}
        >
          <option value="all">All accounts</option>
          {instances.map((i) => (
            <option key={i.id} value={i.id}>{accountLabel(i.id)}</option>
          ))}
        </SelectField>
        {tab === 'leads-added' ? (
          <DateRangePicker presets={presets} value={range} onChange={setRange} />
        ) : (
          <>
            {/* A window length, not a section: a segmented control. */}
            <SegmentedControl
              label="Cohort window"
              value={String(weeks)}
              onChange={(value) => setWeeks(Number(value))}
              items={WEEK_OPTIONS.map((w) => ({ id: String(w), label: `${w} weeks` }))}
            />
            <SendToSlackButton digest={digest} />
          </>
        )}
      </>}
    />
  )
}

function P3OutcomeSummary({
  metrics,
  weeks,
}: {
  metrics: ReplyIntentMetrics
  weeks: number
}) {
  /* The same KPI role as Overview and Team: a section heading over plain KPI
     tiles. These three used to be a smaller, differently-shaped stat grid
     nested inside a panel, so the manager's headline numbers read as a lesser
     kind of metric than the ones on every other page. */
  const cells = [
    {
      key: 'p3', label: 'Reached P3', value: num(metrics.p3),
      sub: 'conversations that reached buying intent',
    },
    {
      key: 'booked', label: 'P3 → booked',
      value: metrics.matureP3BookingRate == null ? '—' : `${metrics.matureP3BookingRate.toFixed(1)}%`,
      sub: `${num(metrics.matureP3Booked)} / ${num(metrics.matureP3)} P3 aged 14d+`,
    },
    {
      key: 'ghosted', label: 'P3 ghosted', value: num(metrics.p3Ghosted),
      sub: 'follow-up recorded · 30d silence',
    },
  ]
  return (
    <section>
      <SectionHeader
        title={`P3 outcomes · last ${weeks} weeks`}
        description="Unique conversations · attributed to the first P3"
      />
      <KpiGrid>
        {cells.map((cell) => <KpiTile key={cell.key} label={cell.label} value={cell.value} sub={cell.sub} />)}
      </KpiGrid>
    </section>
  )
}

function SendToSlackButton({ digest }: { digest: DigestPayload | null }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (!digest) return
    setBusy(true)
    try {
      const res = await authPost('/api/review-digest', digest)
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${res.status}`)
      }
      toast.success('Review digest sent to Slack')
    } catch (e) {
      toast.error(`Couldn't send digest: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      variant="secondary"
      icon={<Send size={18} aria-hidden="true" />}
      onClick={send}
      loading={busy}
      loadingLabel="Sending the digest to Slack"
      disabled={!digest}
      title={digest ? 'Post this review to Slack' : 'No matured cohorts to report yet'}
    >
      Send to Slack
    </Button>
  )
}
