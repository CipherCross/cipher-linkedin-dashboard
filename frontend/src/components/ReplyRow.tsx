import { Link } from 'react-router-dom'
import type { CampaignMetrics, Instance, Lead } from '../lib/types'
import type { ReplyInfo } from '../lib/leads'
import { SENTIMENT_META, instanceName } from '../lib/leads'
import { useConversation } from '../lib/ConversationContext'
import { ago, shortDate } from '../lib/format'
import { InitialsAvatar } from './Avatar'

/** One reply row — the lead, their latest inbound message + sentiment badge, the
 *  campaign/account, and when they replied. Shared by the Replies page, Hot
 *  leads, and the Overview replies panel. Clicking opens the conversation; the
 *  body is only shown when a latest inbound message is known. */
export function ReplyRow({
  lead,
  reply,
  campaigns,
  instances,
  isNew = false,
}: {
  lead: Lead
  reply: ReplyInfo | undefined
  campaigns: CampaignMetrics[]
  instances: Instance[]
  isNew?: boolean
}) {
  const { openConversation } = useConversation()
  const meta = reply?.sentiment ? SENTIMENT_META[reply.sentiment] : null
  const campaignName =
    campaigns.find((c) => c.campaign_id === lead.campaign_id)?.campaign_name ?? lead.campaign_id
  const instanceLabel = instanceName(
    instances.find((i) => i.id === lead.instance_id),
    lead.instance_id,
  )

  const name = lead.full_name || lead.profile_url.replace('https://www.linkedin.com/in/', '')

  return (
    <div
      className="reply-row row-clickable"
      role="button"
      tabIndex={0}
      onClick={() => openConversation(lead)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openConversation(lead)
        }
      }}
    >
      <InitialsAvatar name={name} size={34} />
      <div className="reply-who">
        <div className="reply-who-top">
          {isNew && <span className="reply-new" title="New since your last visit" />}
          <a
            className="row-link"
            href={lead.profile_url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {name}
          </a>
          {meta && (
            <span className={`badge senti ${meta.cls}`} title={reply?.reason ?? ''}>
              {meta.label}
            </span>
          )}
        </div>
        <div className="muted small ellipsis" title={lead.headline ?? ''}>
          {[lead.headline, lead.company].filter(Boolean).join(' · ') || '—'}
        </div>
        {reply && <div className="reply-body">“{reply.body}”</div>}
      </div>
      <div className="reply-meta">
        <Link
          className="row-link muted small"
          to={`/campaign/${encodeURIComponent(lead.campaign_id)}`}
          onClick={(e) => e.stopPropagation()}
        >
          {campaignName}
        </Link>
        <div className="muted small">{instanceLabel}</div>
      </div>
      <div className="reply-when muted small">
        {ago(lead.replied_at)}
        <div>{shortDate(lead.replied_at)}</div>
      </div>
    </div>
  )
}
