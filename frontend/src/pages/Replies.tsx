import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import { instanceName } from '../lib/leads'
import { ago } from '../components/CampaignTable'

const RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 },
]

/** Operational view: everyone who replied recently, newest first — the
 *  follow-up worklist for the team. */
export function Replies() {
  const { data } = useData()
  const [rangeDays, setRangeDays] = useState(30)

  const replies = useMemo(() => {
    if (!data) return []
    const since = rangeDays > 0 ? Date.now() - rangeDays * 86_400_000 : 0
    return data.leads
      .filter((l) => l.replied_at && new Date(l.replied_at).getTime() >= since)
      .sort((a, b) => b.replied_at!.localeCompare(a.replied_at!))
  }, [data, rangeDays])

  // Latest inbound message text per lead (messages arrive sorted desc).
  const snippets = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of data?.messages ?? []) {
      if (m.direction !== 'in' || !m.body) continue
      const key = `${m.instance_id}|${m.profile_url}`
      if (!map.has(key)) map.set(key, m.body)
    }
    return map
  }, [data])

  if (!data) return null

  const campaignName = (id: string) =>
    data.campaigns.find((c) => c.campaign_id === id)?.campaign_name ?? id
  const instanceLabel = (id: string) =>
    instanceName(data.instances.find((i) => i.id === id), id)

  return (
    <>
      <header>
        <div>
          <h1>Replies</h1>
          <div className="muted small">
            {replies.length.toLocaleString('en-US')} replies
            {rangeDays > 0 ? ` in the last ${rangeDays} days` : ' total'} — newest
            first. Open the profile to continue the conversation.
          </div>
        </div>
        <div className="controls">
          <div className="range-group">
            {RANGES.map((r) => (
              <button
                key={r.label}
                className={r.days === rangeDays ? 'active' : ''}
                onClick={() => setRangeDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="card">
        <div className="reply-list">
          {replies.map((l) => (
            <div className="reply-row" key={l.id}>
              <div className="reply-who">
                <a className="row-link" href={l.profile_url} target="_blank" rel="noreferrer">
                  {l.full_name || l.profile_url.replace('https://www.linkedin.com/in/', '')}
                </a>
                <div className="muted small ellipsis" title={l.headline ?? ''}>
                  {[l.headline, l.company].filter(Boolean).join(' · ') || '—'}
                </div>
                {snippets.has(`${l.instance_id}|${l.profile_url}`) && (
                  <div className="reply-body">
                    “{snippets.get(`${l.instance_id}|${l.profile_url}`)}”
                  </div>
                )}
              </div>
              <div className="reply-meta">
                <Link className="row-link muted small" to={`/campaign/${encodeURIComponent(l.campaign_id)}`}>
                  {campaignName(l.campaign_id)}
                </Link>
                <div className="muted small">{instanceLabel(l.instance_id)}</div>
              </div>
              <div className="reply-when muted small">
                {ago(l.replied_at)}
                <div>{l.replied_at!.slice(0, 10)}</div>
              </div>
            </div>
          ))}
          {replies.length === 0 && (
            <div className="muted">No replies in this period.</div>
          )}
        </div>
      </div>
    </>
  )
}
