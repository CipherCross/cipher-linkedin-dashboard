import { Link } from 'react-router-dom'
import { Star } from 'lucide-react'
import type { CampaignMetrics, Instance, Lead } from '../lib/types'
import type { DateRange, ReplyInfo } from '../lib/leads'
import { positiveLeads } from '../lib/leads'
import { ReplyRow } from './ReplyRow'

const MAX = 5

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
  const rows = positiveLeads(leads, latest, range)

  return (
    <div className="card hot-leads">
      <div className="hot-leads-head">
        <h2 className="hot-leads-title">
          <Star size={15} className="hot-leads-star" />
          Hot leads
          <span className="muted small">replied positively · {range.label.toLowerCase()}</span>
        </h2>
        {rows.length > 0 && (
          <Link className="row-link muted small" to="/replies?sentiment=positive">
            View all →
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
            <ReplyRow
              key={lead.id}
              lead={lead}
              reply={reply}
              campaigns={campaigns}
              instances={instances}
            />
          ))}
        </div>
      )}

      {rows.length > MAX && (
        <Link className="row-link muted small hot-leads-more" to="/replies?sentiment=positive">
          +{rows.length - MAX} more positive {rows.length - MAX === 1 ? 'reply' : 'replies'} →
        </Link>
      )}
    </div>
  )
}
