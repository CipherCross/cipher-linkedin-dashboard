import { LeadAvatar } from '../Avatar'
import type { Lead, ReplyIntent, Sentiment } from '../../lib/types'
import {
  INTENT_META, RISK_LABEL, SENTIMENT_META, riskOf, stageMeta, stageOf,
} from '../../lib/leads'

export interface ReplyPreviewLike {
  body: string | null
  sentiment: Sentiment | null
  reason?: string | null
}

export function LeadReplyIdentity({
  lead,
  reply,
  highestIntent,
  showSnippet = true,
}: {
  lead: Lead
  reply?: ReplyPreviewLike | null
  highestIntent?: ReplyIntent | null
  showSnippet?: boolean
}) {
  const sentiment = reply?.sentiment ? SENTIMENT_META[reply.sentiment] : null
  const intent = highestIntent ? INTENT_META[highestIntent] : null
  return (
    <div className="lead-cell">
      <LeadAvatar lead={lead} size={30} />
      <div className="lead-cell-main">
        <a
          className="row-link"
          href={lead.profile_url}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
        >
          {lead.full_name || lead.profile_url.replace('https://www.linkedin.com/in/', '')}
        </a>
        {sentiment && (
          <span className={`badge senti ${sentiment.cls}`} title={reply?.reason ?? ''}>
            {sentiment.label}
          </span>
        )}
        {intent && (
          <span className={`badge senti ${intent.cls}`} title="Highest intent reached">
            {intent.short} · {intent.label}
          </span>
        )}
        {lead.company && <div className="muted small">{lead.company}</div>}
        {showSnippet && reply?.body && <div className="reply-body">“{reply.body}”</div>}
      </div>
    </div>
  )
}

export function LeadMilestoneBadge({ lead }: { lead: Lead }) {
  const stage = stageMeta(stageOf(lead))
  const risk = riskOf(lead)
  return (
    <>
      <span className={`badge stage-${stage.id}`}>{stage.label}</span>
      {risk && <span className="badge risk">{RISK_LABEL[risk]}</span>}
    </>
  )
}
