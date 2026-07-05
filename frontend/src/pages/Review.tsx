import { useMemo, useState } from 'react'
import { ClipboardCheck, Loader2, Send } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import { instanceName, latestRepliesByLead } from '../lib/leads'
import { adminPost } from '../lib/admin'
import { EmptyState } from '../components/EmptyState'
import { CohortComparisonTable } from '../components/CohortComparisonTable'
import { TemplateComparison } from '../components/TemplateComparison'
import { SentimentTrendChart } from '../components/SentimentTrendChart'
import { buildDigest, cohortRows } from '../lib/review'
import type { DigestPayload } from '../lib/review'
import type { Instance } from '../lib/types'

const WEEK_OPTIONS = [8, 12, 16]
const DEFAULT_WEEKS = 12

/** Manager weekly review: cohort-matured funnel comparison, reply-sentiment trend
 *  and message-template comparison over the already-fetched data. Read-only; the
 *  only write is the admin-guarded "Send to Slack" digest. */
export function Review() {
  const { data } = useData()
  const [inst, setInst] = useState('all')
  const [weeks, setWeeks] = useState(DEFAULT_WEEKS)

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

  const scope = inst === 'all' ? 'All accounts' : instanceName(data?.instances.find((i) => i.id === inst), inst)
  const digest = useMemo(
    () => (data ? buildDigest(cohortData, data.instances, scope) : null),
    [data, cohortData, scope],
  )

  if (!data) return null

  const anyInvited = data.leads.some((l) => l.invited_at)
  if (!anyInvited) {
    return (
      <>
        <ReviewHeader
          instances={data.instances}
          inst={inst}
          setInst={setInst}
          weeks={weeks}
          setWeeks={setWeeks}
          digest={null}
        />
        <div className="card">
          <EmptyState
            icon={ClipboardCheck}
            title="Nothing to review yet"
            hint="Cohort comparisons appear here once your accounts have sent invites."
          />
        </div>
      </>
    )
  }

  return (
    <>
      <ReviewHeader
        instances={data.instances}
        inst={inst}
        setInst={setInst}
        weeks={weeks}
        setWeeks={setWeeks}
        digest={digest}
      />

      <div className="stack">
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
    </>
  )
}

function ReviewHeader({
  instances, inst, setInst, weeks, setWeeks, digest,
}: {
  instances: Instance[]
  inst: string
  setInst: (v: string) => void
  weeks: number
  setWeeks: (v: number) => void
  digest: DigestPayload | null
}) {
  return (
    <header>
      <div>
        <h1>Manager Review</h1>
        <div className="muted small">
          Cohort-matured funnel, reply sentiment and template comparison for the
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
        <div className="range-group">
          {WEEK_OPTIONS.map((w) => (
            <button key={w} className={w === weeks ? 'active' : ''} onClick={() => setWeeks(w)}>
              {w}w
            </button>
          ))}
        </div>
        <SendToSlackButton digest={digest} />
      </div>
    </header>
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
