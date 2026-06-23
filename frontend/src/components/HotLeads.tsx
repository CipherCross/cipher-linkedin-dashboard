import { Link } from 'react-router-dom'
import type { CampaignMetrics, Instance, Lead } from '../lib/types'
import type { DateRange, ReplyInfo } from '../lib/leads'
import { instanceName, positiveLeads } from '../lib/leads'
import { useConversation } from '../lib/ConversationContext'
import { ago } from './CampaignTable'

const MAX = 12

/** The actionable "who said yes" list for the Overview: leads whose reply in the
 *  current range classified as positive, newest first. Reuses the Replies-page
 *  row + sentiment-badge styling. */
export function HotLeads({
  leads,
  latest,
  range,
  campaigns,
  instances,
}: {
  leads: Lead[]
  latest: Map<string, ReplyInfo>
  range: DateRange
  campaigns: CampaignMetrics[]
  instances: Instance[]
}) {
  const { openConversation } = useConversation()
  const rows = positiveLeads(leads, latest, range)
  const campaignName = (id: string) =>
    campaigns.find((c) => c.campaign_id === id)?.campaign_name ?? id
  const instanceLabel = (id: string) =>
    instanceName(instances.find((i) => i.id === id), id)

  return (
    <div className="card hot-leads">
      <div className="hot-leads-head">
        <h2>★ Hot leads — replied positively · {range.label.toLowerCase()}</h2>
        {rows.length > 0 && (
          <Link className="row-link muted small" to="/replies">
            View all replies →
          </Link>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="muted small">
          No positive replies in this period. Run “Classify new replies” on the
          Replies page if recent replies are still unclassified.
        </div>
      ) : (
        <div className="reply-list">
          {rows.slice(0, MAX).map(({ lead, reply }) => (
            <div
              className="reply-row row-clickable"
              key={lead.id}
              onClick={() => openConversation(lead)}
            >
              <div className="reply-who">
                <a
                  className="row-link"
                  href={lead.profile_url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  {lead.full_name || lead.profile_url.replace('https://www.linkedin.com/in/', '')}
                </a>
                <div className="muted small ellipsis" title={lead.headline ?? ''}>
                  {[lead.headline, lead.company].filter(Boolean).join(' · ') || '—'}
                </div>
                <div className="reply-body">
                  <span className="badge senti pos" title={reply.reason ?? ''}>
                    Positive
                  </span>
                  “{reply.body}”
                </div>
              </div>
              <div className="reply-meta">
                <Link
                  className="row-link muted small"
                  to={`/campaign/${encodeURIComponent(lead.campaign_id)}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {campaignName(lead.campaign_id)}
                </Link>
                <div className="muted small">{instanceLabel(lead.instance_id)}</div>
              </div>
              <div className="reply-when muted small">
                {ago(lead.replied_at)}
                <div>{lead.replied_at!.slice(0, 10)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {rows.length > MAX && (
        <Link className="row-link muted small hot-leads-more" to="/replies">
          +{rows.length - MAX} more positive {rows.length - MAX === 1 ? 'reply' : 'replies'} →
        </Link>
      )}
    </div>
  )
}
