import { useEffect, useMemo, useState } from 'react'
import { SA_NOTE } from '../components/reply-analysis/classes'
import type { ReactNode } from 'react'
import { BarChart3, Clock3, Filter, RefreshCw, TrendingUp } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { authFetch } from '../lib/api'
import { useData } from '../lib/DataContext'
import { accountLabeller } from '../lib/leads'
import { REASON_LABELS, SENTIMENT_LABELS, type ReplyReviewSentiment } from '../lib/replyReview'
import { ComparisonTable, type ComparisonRow } from '../components/reply-analysis/ComparisonTable'
import { MetricCard, type AnalyticsMetric } from '../components/reply-analysis/MetricCard'
import { ReasonBars } from '../components/reply-analysis/ReasonBars'
import { DistributionChart } from '../components/reply-analysis/SentimentDistributionChart'
import { WeeklyTrendChart, type WeeklyTrendMode, type WeeklyTrendRow } from '../components/reply-analysis/WeeklyTrendChart'
import { WorkflowBuckets } from '../components/reply-analysis/WorkflowBuckets'
import {
  Button, Dialog, InlineError, LinkButton, PageHeader, Panel, SectionHeader,
  SegmentedControl, SelectField, TextField, UpdatingNote,
} from '../ui'
import { COPY } from '../ui/labels'
import { UI_LOCALE } from '../ui/datetime'

export interface SentimentAnalyticsResponse {
  coverage: Readonly<Record<string, AnalyticsMetric>>
  sentiment: Readonly<Record<string, AnalyticsMetric>>
  reasons: Readonly<Record<string, AnalyticsMetric>>
  weekly_trend: readonly WeeklyTrendRow[]
  workflow: Readonly<Record<string, AnalyticsMetric>>
  comparison: readonly ComparisonRow[]
  dataset_at: string
}

export interface SentimentAnalyticsFilters {
  from: string
  to: string
  account: string | null
  campaign: string | null
  owner: string | null
}

interface ComparisonTopReason { id: string; label?: string | null; numerator?: number }

const SENTIMENT_KEYS: Array<ReplyReviewSentiment | 'latest_unreviewed' | 'only_auto'> = ['positive', 'neutral', 'negative', 'objection', 'referral', 'auto', 'latest_unreviewed', 'only_auto']
const SENTIMENT_DISPLAY: Record<string, string> = { ...SENTIMENT_LABELS, latest_unreviewed: 'Latest reply not reviewed', only_auto: 'Automated replies only' }
const REASON_DISPLAY: Record<string, string> = { ...REASON_LABELS, missing_reason: 'No reason recorded' }

/** The browser URL uses UTC calendar days; the dispatcher turns them into the
 * half-open interval [start-of-from, start-of-day-after-to). */
export function defaultAnalyticsBounds(now = new Date()): { from: string; to: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 29)
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }
}

export function dateInputValue(iso: string): string {
  return iso.slice(0, 10)
}

export function nextUtcDay(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`)
  day.setUTCDate(day.getUTCDate() + 1)
  return day.toISOString().slice(0, 10)
}

export function addUtcDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00.000Z`)
  day.setUTCDate(day.getUTCDate() + days)
  return day.toISOString().slice(0, 10)
}

export function buildRepliesDrilldownHref(filters: SentimentAnalyticsFilters, metric: AnalyticsMetric, key: string): string | null {
  const params = new URLSearchParams()
  // Analytics links must not inherit the inbox's new/unreviewed defaults.
  params.set('view', 'all'); params.set('scope', 'all'); params.set('from', filters.from); params.set('to', filters.to)
  if (filters.account) params.set('account', filters.account)
  if (filters.campaign) params.set('campaign', filters.campaign)
  if (filters.owner) params.set('owner', filters.owner)
  const comparisonScope = /^(account|campaign):(.+)$/.exec(key)
  if (comparisonScope) {
    const [, comparisonKind, comparisonId] = comparisonScope
    // `campaign_id IS NULL` cannot be represented by ReplyFilter: null means
    // no campaign predicate. Avoid presenting a link that would show all
    // campaigns for the "No campaign" comparison row.
    if (comparisonKind === 'campaign' && comparisonId === '__none__') return null
    params.set(comparisonKind === 'account' ? 'account' : 'campaign', comparisonId)
    return `/replies?${params.toString()}`
  }
  const serverScope = metric.drilldown && typeof metric.drilldown === 'object' ? metric.drilldown as { kind?: unknown; value?: unknown } : {}
  const rawKind = typeof serverScope.kind === 'string' ? serverScope.kind : key === 'latest_unreviewed' || key === 'only_auto' ? 'coverage' : key
  const value = typeof serverScope.value === 'string' ? serverScope.value : key
  // The inbox's exact latest/only-auto predicates live in its coverage scope;
  // using the analytics response's sentiment label would also add an invalid
  // `rr.sentiment = latest_unreviewed` predicate before that branch runs.
  const kind = rawKind === 'sentiment' && (value === 'latest_unreviewed' || value === 'only_auto') ? 'coverage' : rawKind
  if (!['coverage', 'sentiment', 'reason', 'workflow', 'account', 'campaign'].includes(kind)) return null
  // Replies is a conversation list, so only server-declared scopes that its
  // inbox SQL can represent exactly may be links. Message-level coverage and
  // weekly-message metrics remain visibly non-clickable; the server exposes
  // the dialogue-level legacy/intent scopes as exact predicates.
  if (kind === 'coverage' && !['dialogues', 'full_dialogues', 'unreviewed_dialogues', 'latest_unreviewed', 'only_auto', 'weekly_volume', 'unreviewed_intent', 'legacy_ai'].includes(value)) return null
  if (kind === 'account') params.set('account', value)
  if (kind === 'campaign') params.set('campaign', value === '__none__' ? '' : value)
  if (!(kind === 'coverage' && (value === 'dialogues' || value === 'weekly_volume'))) params.set('metric_scope', `${kind}:${value}`)
  // The combined business rate is a typed union predicate in the inbox SQL,
  // not a member of the sentiment enum.
  if (kind === 'sentiment' && value !== 'latest_unreviewed' && value !== 'only_auto' && value !== 'business_rate' && value !== 'negative_objection') params.set('sentiment', value)
  if (kind === 'reason') params.set('reason', value)
  // The workflow metric scope already expresses the exact SQL bucket. Extra
  // inbox filters intersect it and can silently drop matching dialogues.
  return `/replies?${params.toString()}`
}

function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : Number(value ?? 0) || 0 }
function metric(value: unknown): AnalyticsMetric {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const numerator = number(row.numerator); const denominator = number(row.denominator)
  const rate = row.rate == null ? (denominator ? numerator / denominator : null) : Number(row.rate)
  return { numerator, denominator, rate: Number.isFinite(rate) ? rate : null, drilldown: row.drilldown as AnalyticsMetric['drilldown'] }
}
export function parseAnalytics(value: unknown): SentimentAnalyticsResponse {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {}
  const trends = Array.isArray(row.weekly_trend) ? row.weekly_trend : []
  return {
    coverage: Object.fromEntries(Object.entries(record(row.coverage)).map(([k, v]) => [k, metric(v)])),
    sentiment: Object.fromEntries(Object.entries(record(row.sentiment)).map(([k, v]) => [k, metric(v)])),
    reasons: Object.fromEntries(Object.entries(record(row.reasons)).map(([k, v]) => [k, metric(v)])),
    weekly_trend: trends.map((v) => { const t = record(v); const coverageMetric = t.coverage && typeof t.coverage === 'object' ? metric(t.coverage) : undefined; const volumeMetric = t.volume && typeof t.volume === 'object' ? metric(t.volume) : undefined; return { ...t, week: String(t.week ?? ''), messages: number(t.messages), reviewed: number(t.reviewed ?? coverageMetric?.numerator), coverage: coverageMetric ? coverageMetric.rate : t.coverage == null ? null : Number(t.coverage), metric: t.metric ? metric(t.metric) : volumeMetric } }),
    workflow: Object.fromEntries(Object.entries(record(row.workflow)).map(([k, v]) => [k, metric(v)])),
    comparison: (Array.isArray(row.comparison) ? row.comparison : []).map((v) => { const c = record(v); const coverageMetric = c.coverage && typeof c.coverage === 'object' ? metric(c.coverage) : undefined; const negativeMetric = c.neg_objection && typeof c.neg_objection === 'object' ? metric(c.neg_objection) : undefined; const topReasons = (Array.isArray(c.top_reasons) ? c.top_reasons : c.top_reason ? [c.top_reason] : []).map((reason) => { const r = record(reason); const id = String(r.id ?? r.reason_id ?? ''); return { id, label: r.label == null ? (REASON_LABELS as Record<string, string>)[id] ?? null : String(r.label), numerator: number(r.numerator ?? r.count) } }) as ComparisonTopReason[]; return { kind: c.kind === 'campaign' ? 'campaign' : 'account', id: String(c.id ?? ''), name: c.name == null ? null : String(c.name), numerator: number(c.volume ?? c.numerator), denominator: number(c.volume ?? c.denominator), rate: negativeMetric ? negativeMetric.rate : (c.negative_objection_rate == null ? null : Number(c.negative_objection_rate)), negative: negativeMetric, coverage: coverageMetric?.rate ?? (c.coverage == null ? null : Number(c.coverage)), top_reasons: topReasons, drilldown: c.drilldown as AnalyticsMetric['drilldown'] } }),
    dataset_at: typeof row.dataset_at === 'string' ? row.dataset_at : new Date(0).toISOString(),
  }
}

async function readAnalytics(filters: SentimentAnalyticsFilters, signal?: AbortSignal): Promise<SentimentAnalyticsResponse> {
  const params = new URLSearchParams({ op: 'replies.analytics', from: filters.from, to: filters.to })
  if (filters.account) params.set('instance_id', filters.account)
  if (filters.campaign) params.set('campaign_id', filters.campaign)
  if (filters.owner) params.set('owner_id', filters.owner)
  const response = await authFetch(`/api/activity-daily?${params.toString()}`, { signal })
  let body: unknown = null
  try { body = await response.json() } catch { /* status below */ }
  if (!response.ok) throw new Error(body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `Could not load the analytics (${response.status})`)
  // activity-daily is the shared read dispatcher: singleton operations are
  // still returned as the first row in its paginated `items` envelope.
  const envelope = body && typeof body === 'object' ? body as { items?: unknown[] } : null
  return parseAnalytics(envelope?.items?.[0] ?? body)
}

function Section({ title, subtitle, icon, children }: { title: string; subtitle?: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <Panel className="sa-section min-w-0 mb-app-xl">
      <SectionHeader title={<>{icon}{title}</>} description={subtitle} />
      {children}
    </Panel>
  )
}

export function SentimentAnalysis({ reader = readAnalytics }: { reader?: typeof readAnalytics } = {}) {
  const { data } = useData()
  const [params, setParams] = useSearchParams()
  const defaults = useMemo(() => defaultAnalyticsBounds(), [])
  const filters: SentimentAnalyticsFilters = { from: dateInputValue(params.get('from') ?? defaults.from), to: dateInputValue(params.get('to') ?? defaults.to), account: params.get('account'), campaign: params.get('campaign'), owner: params.get('owner') }
  const [result, setResult] = useState<SentimentAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [trendMode, setTrendMode] = useState<WeeklyTrendMode>('sentiment')
  const [comparisonKind, setComparisonKind] = useState<'account' | 'campaign'>('account')
  const [moreFilters, setMoreFilters] = useState(false)
  const [showAllReasons, setShowAllReasons] = useState(false)
  const [resultKey, setResultKey] = useState('')
  const [refresh, setRefresh] = useState(0)
  const filterKey = JSON.stringify(filters)

  useEffect(() => {
    const controller = new AbortController(); let cancelled = false
    setLoading(true); setError(null)
    reader(filters, controller.signal).then((value) => { if (!cancelled) { setResult(value); setResultKey(filterKey); setStale(false); setLoading(false) } }).catch((reason: unknown) => { if (cancelled || (reason instanceof DOMException && reason.name === 'AbortError')) return; if (!cancelled) { setError(reason instanceof Error ? reason.message : 'Unknown error'); setStale(result !== null && resultKey === filterKey); setLoading(false) } })
    return () => { cancelled = true; controller.abort() }
    // `result` is intentionally a stale fallback, not a request dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, refresh, reader])

  const setFilter = (key: keyof SentimentAnalyticsFilters, value: string) => { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); setParams(next, { replace: true }) }
  const setBounds = (from: string, to: string) => { const next = new URLSearchParams(params); next.set('from', from); next.set('to', to); setParams(next, { replace: true }) }
  const drill = (m: AnalyticsMetric, key: string) => buildRepliesDrilldownHref(filters, m, key)
  const campaignRows = data?.campaigns ?? []
  const owners = data?.teamMembers.filter((member) => member.active) ?? []
  const accountLabel = accountLabeller(data?.instances)
  const visibleResult = resultKey === filterKey ? result : null
  const comparison = visibleResult?.comparison ?? []
  const labelForComparison = (row: ComparisonRow) => row.name || (row.kind === 'account' ? accountLabel(row.id) : row.id === '__none__' ? 'No campaign' : campaignRows.find((c) => c.campaign_id === row.id)?.campaign_name ?? row.id)

  const today = new Date()
  const seven = addUtcDays(defaults.to, -6)
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10)
  const activePreset = filters.to === defaults.to && filters.from === seven ? '7'
    : filters.to === defaults.to && filters.from === defaults.from ? '30'
    : filters.to === defaults.to && filters.from === monthStart ? 'month' : 'custom'
  const dialogues = visibleResult?.coverage.dialogues
  const reviewed = visibleResult?.coverage.messages
  const pending = visibleResult?.coverage.unreviewed_dialogues
  const needsStep = visibleResult?.workflow.needs_confirmation
  const hasDialogues = (dialogues?.numerator ?? 0) > 0
  const hasReviews = (reviewed?.numerator ?? 0) > 0
  const businessRate = visibleResult?.sentiment.business_rate
  const reasonsPresent = Object.values(visibleResult?.reasons ?? {}).some((value) => value.numerator > 0)
  const displayAccount = accountLabel
  const reasonRows = visibleResult?.reasons ?? {}
  const pendingHref = pending ? drill(pending, 'unreviewed_dialogues') : null
  return <div className="min-w-0">
    <PageHeader
      title="Sentiment analysis"
      description="Manual review of replies, the reasons behind them, and the conversations still open."
      context={<span className="text-app-text-muted text-app-meta">Period is sliced in UTC · reminders run on Madrid time</span>}
      actions={<Button variant="secondary" icon={<RefreshCw aria-hidden="true" />} onClick={() => setRefresh((value) => value + 1)} loading={loading} loadingLabel="Refreshing analytics">{COPY.refresh}</Button>}
    />

    <Panel className="flex items-end flex-wrap gap-app-lg mb-app-lg [&_.ui-field]:min-w-[220px]" aria-label="Analytics filters">
      <SegmentedControl
        label="Reply period"
        value={activePreset as '7' | '30' | 'month' | 'custom'}
        onChange={(key) => { if (key === '7') setBounds(seven, defaults.to); if (key === '30') setBounds(defaults.from, defaults.to); if (key === 'month') setBounds(monthStart, defaults.to); if (key === 'custom') setMoreFilters(true) }}
        items={[{ id: '7', label: 'Last 7 days' }, { id: '30', label: 'Last 30 days' }, { id: 'month', label: 'This month' }, { id: 'custom', label: 'Custom' }]}
      />
      <SelectField
        label="Account"
        value={filters.account ?? ''}
        onChange={(event) => { const next = new URLSearchParams(params); if (event.target.value) next.set('account', event.target.value); else next.delete('account'); next.delete('campaign'); setParams(next, { replace: true }) }}
      >
        <option value="">All accounts</option>
        {(data?.instances ?? []).map((item) => <option value={item.id} key={item.id}>{displayAccount(item.id)}</option>)}
      </SelectField>
      <Button variant="ghost"  icon={<Filter aria-hidden="true" />} aria-expanded={moreFilters} onClick={() => setMoreFilters(true)}>More filters</Button>
    </Panel>

    {moreFilters && <Dialog
      title="More filters"
      description="Interval bounds are UTC calendar days, matching how the views slice the data."
      onRequestClose={() => setMoreFilters(false)}
      footer={<Button variant="primary" onClick={() => setMoreFilters(false)}>Done</Button>}
    >
      <div className="grid gap-app-lg grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
        <TextField label="From · UTC" type="date" value={dateInputValue(filters.from)} onChange={(event) => setFilter('from', event.target.value)} />
        <TextField label="To · UTC" type="date" value={dateInputValue(filters.to)} onChange={(event) => setFilter('to', event.target.value)} />
        <SelectField label="Campaign" value={filters.campaign ?? ''} onChange={(event) => setFilter('campaign', event.target.value)}>
          <option value="">All campaigns</option>
          {campaignRows.filter((campaign) => !filters.account || campaign.instance_id === filters.account).map((campaign) => <option value={campaign.campaign_id ?? ''} key={campaign.campaign_id}>{campaign.campaign_name} · {displayAccount(campaign.instance_id)}</option>)}
        </SelectField>
        <SelectField label={COPY.conversationOwner} value={filters.owner ?? ''} onChange={(event) => setFilter('owner', event.target.value)}>
          <option value="">All owners</option>
          {owners.map((owner) => <option value={owner.id} key={owner.id}>{owner.name}{owners.filter((item) => item.name === owner.name).length > 1 && owner.email ? ' · ' + owner.email : ''}</option>)}
        </SelectField>
      </div>
    </Dialog>}

    {loading && !visibleResult && <Panel className="flex flex-col items-center justify-center gap-app-md min-h-[220px] text-center" role="status" aria-busy="true"><span className="w-5 h-5 border-2 border-app-border border-t-app-accent rounded-full animate-[sa-spin_.9s_linear_infinite]" aria-hidden="true" /> Loading the analytics…</Panel>}
    {error && <InlineError
      title="Could not load the analytics."
      message={stale ? 'The figures below are the last data that loaded for this period.' : undefined}
      detail={error}
      onRetry={() => setRefresh((value) => value + 1)}
    />}
    {visibleResult && <div aria-busy={loading || undefined}>
      <div className="mt-0 mx-0 mb-app-lg text-app-text-muted text-app-meta flex items-center gap-app-sm flex-wrap">
        <span>{reviewed?.numerator ?? 0} of {reviewed?.denominator ?? 0} replies reviewed · snapshot {new Date(visibleResult.dataset_at).toLocaleString(UI_LOCALE)}{stale && ' · this data may be out of date'}</span>
        {loading && <UpdatingNote>Refreshing the analytics…</UpdatingNote>}
      </div>
      <div className="grid gap-app-lg grid-cols-[repeat(auto-fit,minmax(220px,1fr))] mb-app-lg">
        <MetricCard label="Conversations with a reply" metric={dialogues} href={dialogues ? drill(dialogues, 'dialogues') : null} hint="conversations in this period" showRate={false} />
        <MetricCard label="Replies reviewed" metric={reviewed} href={null} hint="messages, reviewed by hand" />
        <MetricCard label="Waiting for review" metric={pending} href={pendingHref} hint="conversations with an unreviewed reply" />
        <MetricCard label="Needs a next step" metric={needsStep} href={needsStep ? drill(needsStep, 'needs_confirmation') : null} hint="conversations" />
      </div>
      <details className="mt-0 mx-0 mb-app-xl text-app-text-muted text-app-meta [&_summary]:min-h-control-sm [&_summary]:text-app-accent [&_summary]:font-semibold [&_summary]:cursor-pointer [&_p]:my-app-xs [&_p]:mx-0">
        <summary>What counts as reviewed</summary>
        <p>Reviewing is done by hand. Earlier AI labelling still needs a human pass and does not count as a reviewed reply. Buying interest is assessed separately.</p>
        <p>The analytical period is sliced in UTC; follow-up reminders run on Madrid time.</p>
      </details>
      {!hasDialogues ? <Panel className="flex flex-col items-center justify-center gap-app-md min-h-[220px] text-center"><BarChart3 size={24} aria-hidden="true" /><strong>No inbound replies in this period</strong><span className="text-app-text-muted">Change the period or the filters.</span></Panel>
        : !hasReviews ? <Panel className="flex flex-col items-center justify-center gap-app-md min-h-[220px] text-center"><BarChart3 size={24} aria-hidden="true" /><strong>No replies reviewed yet</strong><span className="text-app-text-muted">Review some replies to see reasons and the sentiment split.</span>{pendingHref && <LinkButton variant="primary" to={pendingHref}>Go to the review queue</LinkButton>}</Panel>
          : <>
            <div className="grid gap-app-xl grid-cols-2 max-[1100px]:grid-cols-1 mb-app-xl [&_.sa-section]:mb-0">
              <Section title="Sentiment" subtitle="The latest inbound reply of each conversation in this period.">
                <DistributionChart rows={Object.fromEntries(SENTIMENT_KEYS.map((key) => [key, visibleResult.sentiment[key] ?? { numerator: 0, denominator: visibleResult.sentiment.positive?.denominator ?? 0, rate: null }]))} labels={SENTIMENT_DISPLAY} linkFor={drill} />
                <div className={`${SA_NOTE} text-app-text-muted text-app-meta`}>Declines and objections among the substantive replies reviewed by hand: {businessRate ? businessRate.numerator + ' / ' + businessRate.denominator + ' · ' + (businessRate.rate == null ? 'Not reviewed yet' : (businessRate.rate * 100).toFixed(1) + '%') : 'Not reviewed yet'}{businessRate && businessRate.numerator > 0 && drill(businessRate, 'business_rate') && <Link to={drill(businessRate, 'business_rate')!}> Show those conversations</Link>}</div>
              </Section>
              <Section title="Decline and objection reasons" subtitle="Reasons recorded on reviewed replies in this period.">
                {reasonsPresent ? <>
                  <ReasonBars rows={reasonRows} labels={REASON_DISPLAY} linkFor={drill} />
                  <Button variant="ghost" size="sm" className="mt-app-md" onClick={() => setShowAllReasons((value) => !value)}>{showAllReasons ? 'Hide the full list' : 'Show every reason'}</Button>
                  {showAllReasons && <ReasonBars rows={reasonRows} labels={REASON_DISPLAY} linkFor={drill} showZero />}
                  <p className={`${SA_NOTE} text-app-text-muted text-app-meta`}>One conversation can carry several reasons, so these shares can add up to more than 100%.</p>
                </> : <p className="text-app-text-muted">No declines or objections among the reviewed replies.</p>}
              </Section>
            </div>
            <Section title="Weekly trend" subtitle="Weeks start on Monday, UTC; one conversation can appear in more than one week." icon={<TrendingUp size={18} aria-hidden="true" />}>
              <SegmentedControl
                label="Trend mode"
                value={trendMode}
                onChange={setTrendMode}
                items={[{ id: 'sentiment', label: COPY.sentiment }, { id: 'reasons', label: COPY.reasons }, { id: 'coverage', label: 'Coverage' }] as Array<{ id: WeeklyTrendMode; label: string }>}
              />
              <WeeklyTrendChart rows={visibleResult.weekly_trend} mode={trendMode} linkFor={(row) => row.metric ? buildRepliesDrilldownHref({ ...filters, from: row.week, to: addUtcDays(row.week, 6) }, row.metric, 'week') : null} />
            </Section>
            <Section title="Comparison" subtitle="Reply volume and coverage; the decline share is out of the conversations that were reviewed.">
              <SegmentedControl
                label="Compare by"
                value={comparisonKind}
                onChange={setComparisonKind}
                items={[{ id: 'account', label: 'Accounts' }, { id: 'campaign', label: 'Campaigns' }] as Array<{ id: 'account' | 'campaign'; label: string }>}
              />
              <ComparisonTable rows={comparison.filter((row) => row.kind === comparisonKind).sort((a, b) => b.denominator - a.denominator)} labelFor={(row) => row.kind === 'account' ? displayAccount(row.id) : labelForComparison(row)} linkFor={(row) => buildRepliesDrilldownHref(filters, row, row.kind + ':' + row.id)} />
            </Section>
          </>}
      <Section title="Work still open" subtitle="The current state of this cohort's conversations, not their state on a past date." icon={<Clock3 size={18} aria-hidden="true" />}>
        <WorkflowBuckets rows={visibleResult.workflow} linkFor={drill} showZero={false} />
      </Section>
    </div>}
  </div>
}

export default SentimentAnalysis
