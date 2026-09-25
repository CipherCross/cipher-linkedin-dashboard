import { LeadAvatar } from '../Avatar'
import { Badge } from '../../ui'
import type { Lead, ReplyIntent, Sentiment } from '../../lib/types'
import {
  INTENT_META, RISK_LABEL, SENTIMENT_META, STAGE_TONE, riskOf, stageMeta, stageOf,
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
    <div className="flex items-start gap-app-sm">
      <LeadAvatar lead={lead} size={30} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-app-sm gap-y-app-xs">
          <a
            className="relative z-10 text-app-text no-underline hover:text-app-accent hover:underline"
            href={lead.profile_url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {lead.full_name || lead.profile_url.replace('https://www.linkedin.com/in/', '')}
          </a>
          {sentiment && (
            <Badge tone={sentiment.tone} title={reply?.reason ?? ''}>
              {sentiment.label}
            </Badge>
          )}
          {intent && (
            <Badge tone={intent.tone} title="Highest intent reached">
              {intent.short} · {intent.label}
            </Badge>
          )}
        </div>
        {lead.company && <div className="text-app-meta text-app-text-muted">{lead.company}</div>}
        {showSnippet && reply?.body && (
          <div className="mt-app-xs px-app-sm py-app-xs bg-app-surface-2 border-l-2 border-app-border-strong rounded-r-sm text-app-table text-app-text-secondary line-clamp-2">
            “{reply.body}”
          </div>
        )}
      </div>
    </div>
  )
}

export function LeadMilestoneBadge({ lead }: { lead: Lead }) {
  const stage = stageMeta(stageOf(lead))
  const risk = riskOf(lead)
  return (
    <>
      <Badge tone={STAGE_TONE[stage.id]}>{stage.label}</Badge>
      {risk && <Badge tone="danger" className="ml-app-xs">{RISK_LABEL[risk]}</Badge>}
    </>
  )
}
