import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ClipboardCheck, Loader2, Send } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import {
  instanceName, lastWeeks, latestRepliesByLead, presetRanges, rangeFromParam,
  rangeToParam, rangedCampaigns, replyIntentMetrics,
} from '../lib/leads'
import type { DateRange, ReplyIntentMetrics } from '../lib/leads'
import { adminPost } from '../lib/admin'
import { EmptyState } from '../components/EmptyState'
import { CohortComparisonTable } from '../components/CohortComparisonTable'
import { TemplateComparison } from '../components/TemplateComparison'
import { SentimentTrendChart } from '../components/SentimentTrendChart'
import { LeadsAddedTable } from '../components/LeadsAddedTable'
import { DateRangePicker } from '../components/DateRangePicker'
import { buildDigest, cohortRows } from '../lib/review'
import type { DigestPayload } from '../lib/review'
import type { Instance } from '../lib/types'
import { num } from '../lib/format'

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

  const scope = inst === 'all' ? 'All accounts' : instanceName(data?.instances.find((i) => i.id === inst), inst)
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

      <div className="segmented review-tabs" role="tablist" aria-label="Review section">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`segmented-item ${tab === t.id ? 'active' : ''}`}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'leads-added' ? (
        <LeadsAddedTable campaigns={rangedAdded} instances={data.instances} />
      ) : !anyInvited ? (
        <div className="card">
          <EmptyState
            icon={ClipboardCheck}
            title="Nothing to review yet"
            hint="Cohort comparisons appear here once your accounts have sent invites."
          />
        </div>
      ) : (
        <div className="stack">
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
  return (
    <header>
      <div>
        <h1>Manager Review</h1>
        <div className="muted small">
          Cohort-matured funnel, P1–P3 intent and template comparison for the
          weekly review. Rates for cohorts too fresh to judge are held back.
        </div>
      </div>
      <div className="controls">
        <select value={inst} onChange={(e) => setInst(e.target.value)}>
          <option value="all">All accounts</option>
          {instances.map((i) => (
            <option key={i.id} value={i.id}>{instanceName(i)}</option>
          ))}
        </select>
        {tab === 'leads-added' ? (
          <DateRangePicker presets={presets} value={range} onChange={setRange} />
        ) : (
          <>
            <div className="range-group">
              {WEEK_OPTIONS.map((w) => (
                <button key={w} className={w === weeks ? 'active' : ''} onClick={() => setWeeks(w)}>
                  {w}w
                </button>
              ))}
            </div>
            <SendToSlackButton digest={digest} />
          </>
        )}
      </div>
    </header>
  )
}

function P3OutcomeSummary({
  metrics,
  weeks,
}: {
  metrics: ReplyIntentMetrics
  weeks: number
}) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>P3 outcomes · last {weeks} weeks</h2>
        <span className="muted small">unique conversations · first P3 attribution</span>
      </div>
      <div className="tmpl-stat-grid">
        <div className="tmpl-stat-cell">
          <div className="tmpl-stat-val">{num(metrics.p3)}</div>
          <div className="muted small">Reached P3</div>
        </div>
        <div className="tmpl-stat-cell">
          <div className="tmpl-stat-val">
            {metrics.matureP3BookingRate == null ? '—' : `${metrics.matureP3BookingRate.toFixed(1)}%`}
          </div>
          <div className="muted small">P3 → booked</div>
          <div className="muted tmpl-stat-n">
            {num(metrics.matureP3Booked)} / {num(metrics.matureP3)} P3 aged 14d+
          </div>
        </div>
        <div className="tmpl-stat-cell">
          <div className="tmpl-stat-val">{num(metrics.p3Ghosted)}</div>
          <div className="muted small">P3 ghosted</div>
          <div className="muted tmpl-stat-n">follow-up recorded · 30d silence</div>
        </div>
      </div>
    </div>
  )
}

function SendToSlackButton({ digest }: { digest: DigestPayload | null }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (!digest) return
    setBusy(true)
    try {
      const res = await adminPost('/api/review-digest', digest)
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
    <button
      className="btn-accent icon-btn"
      onClick={send}
      disabled={busy || !digest}
      title={digest ? 'Post this review to Slack' : 'No matured cohorts to report yet'}
    >
      {busy ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
      {busy ? 'Sending…' : 'Send to Slack'}
    </button>
  )
}
