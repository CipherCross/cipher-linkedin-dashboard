import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { fetchNeonOverviewSummary, resolveReadPath } from '../lib/dashboardReads'
import { ALL_TIME_RANGE, presetRanges, previousRange, rangedCampaigns, rangeTotals } from '../lib/leads'
import type { OverviewSummary } from '../lib/types'

const number = (value: number) => value.toLocaleString()
const rate = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(1)}%`

export function Overview() {
  const { data, phase } = useData()
  // Refresh the day boundary even when this page stays open overnight.
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10))
  useEffect(() => {
    const timer = setInterval(() => setToday(new Date().toISOString().slice(0, 10)), 60_000)
    return () => clearInterval(timer)
  }, [])
  const range = useMemo(() => presetRanges(new Date(`${today}T12:00:00Z`))[0], [today])
  const previous = useMemo(() => previousRange(range)!, [range])
  const [summary, setSummary] = useState<OverviewSummary | null>(null)
  const [legacyPath, setLegacyPath] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setSummary(null)
    setLegacyPath(false)
    ;(async () => {
      try {
        const path = await resolveReadPath()
        if (cancelled) return
        if (path !== 'neon') {
          setLegacyPath(true)
          return
        }
        const next = await fetchNeonOverviewSummary(range)
        if (cancelled) return
        setSummary(next)
        performance.mark('dashboard_overview_useful')
        requestAnimationFrame(() => performance.mark('dashboard_overview_interactive'))
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [range, data?.campaigns, retry])

  const legacy = useMemo(() => {
    if (!legacyPath || !data || phase !== 'full') return null
    const lifetime = new Map(rangedCampaigns(data.leads, data.campaigns, ALL_TIME_RANGE)
      .map(campaign => [campaign.campaign_id, campaign]))
    return {
      totals: rangeTotals(data.leads, range),
      prevTotals: rangeTotals(data.leads, previous),
      campaigns: rangedCampaigns(data.leads, data.campaigns, range).map(campaign => ({
        ...campaign,
        lifetime_acceptance_rate: lifetime.get(campaign.campaign_id)?.acceptance_rate,
        lifetime_reply_rate: lifetime.get(campaign.campaign_id)?.reply_rate,
      })),
    }
  }, [legacyPath, data, phase, range, previous])

  if (!data) return null
  const result = summary ?? legacy
  const accounts = new Map(data.instances.map(account => [account.id, account.account_name || account.label]))
  // Include empty campaigns as well as campaigns with historical activity.
  const campaigns = new Map(data.campaigns.map(campaign => [campaign.campaign_id, {
    ...campaign, invites_sent: 0, lifetime_acceptance_rate: null as number | null | undefined,
    lifetime_reply_rate: null as number | null | undefined,
  }]))
  for (const campaign of result?.campaigns ?? []) campaigns.set(campaign.campaign_id, {
    ...campaign, lifetime_acceptance_rate: campaign.lifetime_acceptance_rate,
    lifetime_reply_rate: campaign.lifetime_reply_rate,
  })
  const rows = [...campaigns.values()].sort((a, b) => b.invites_sent - a.invites_sent || a.campaign_name.localeCompare(b.campaign_name) || a.campaign_id.localeCompare(b.campaign_id))
  const stale = data.instances.filter(account => !account.last_sync_at || Date.parse(account.last_sync_at) < Date.now() - 86_400_000).length

  return <>
    <header>
      <div><h1>Overview</h1><p className="muted">Last 7 days · All {accounts.size} accounts</p></div>
      <Link className="link-btn" to="/sequences">Open sequences</Link>
    </header>
    <p className="muted small">{range.from} – {range.to} vs {previous.from} – {previous.to} · UTC · Today is still in progress</p>
    {stale > 0 && <p className="muted small">{stale} {stale === 1 ? 'account has' : 'accounts have'} not synced in the last 24 hours. <Link to="/health">Check sync health</Link></p>}
    {error ? <div className="card error-state" role="alert"><strong>Overview could not load.</strong><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>Try again</button></div>
      : !result ? <div className="card empty-state"><Loader2 size={20} className="spin" /><span>{loading || legacyPath ? 'Loading weekly results…' : 'Results are not available yet.'}</span></div>
      : <>
        <section className="weekly-summary" aria-label="Last seven days compared with previous seven days">
          {([['invites', 'Invites sent'], ['accepted', 'Connections accepted'], ['replies', 'Leads who replied']] as const).map(([key, label]) => {
            const current = result.totals[key]
            const prior = result.prevTotals?.[key]
            const difference = prior == null ? null : current - prior
            return <div className="card weekly-stat" key={key}>
              <div className="muted small">{label}</div><strong className="weekly-stat-value">{number(current)}</strong>
              <div className="small">{difference == null ? 'Comparison unavailable' : `${difference > 0 ? '+' : ''}${number(difference)} vs previous 7 days`}</div>
              {prior != null && <div className="muted small">Previously {number(prior)}</div>}
            </div>
          })}
        </section>
        <section className="card campaign-performance" aria-labelledby="campaign-performance-title">
          <h2 id="campaign-performance-title">Campaign performance</h2>
          <p className="muted small">Rates cover all time. Invites cover the last 7 days. Recent outreach is still developing.</p>
          {rows.length === 0 ? <p className="muted">No campaigns yet. Synced campaigns will appear here.</p> : <div className="campaign-performance-scroll">
            <table><thead><tr><th scope="col">Campaign</th><th scope="col">Account</th><th scope="col">Acceptance rate <span className="muted small">· All time</span></th><th scope="col">Reply rate <span className="muted small">· All time</span></th><th scope="col">Leads invited <span className="muted small">· 7 days</span></th></tr></thead>
              <tbody>{rows.map(campaign => <tr key={campaign.campaign_id}>
                <td><Link to={`/campaign/${encodeURIComponent(campaign.campaign_id)}`}>{campaign.campaign_name}</Link>{campaign.is_archived === true && <span className="muted small"> · Archived</span>}</td>
                <td>{accounts.get(campaign.instance_id) ?? campaign.instance_id}</td>
                <td>{rate(campaign.lifetime_acceptance_rate)}</td><td>{rate(campaign.lifetime_reply_rate)}</td><td>{number(campaign.invites_sent)}</td>
              </tr>)}</tbody></table>
          </div>}
          <p className="muted small">Acceptance = accepted invitations ÷ invitations sent. Reply rate = connected leads who replied ÷ connected leads. — means no denominator or unavailable data. Replies count each lead’s first reply.</p>
        </section>
      </>}
  </>
}
