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

/** The reply's reviewed sentiment and the highest intent reached, as badges.
 *  Rendered beside the name by default, or in its own table column. */
export function LeadReplyBadges({
  reply,
  highestIntent,
}: {
  reply?: ReplyPreviewLike | null
  highestIntent?: ReplyIntent | null
}) {
  const sentiment = reply?.sentiment ? SENTIMENT_META[reply.sentiment] : null
  const intent = highestIntent ? INTENT_META[highestIntent] : null
  return (
    <>
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
    </>
  )
}

export function LeadReplyIdentity({
  lead,
  reply,
  highestIntent,
  showSnippet = true,
  showBadges = true,
}: {
  lead: Lead
  reply?: ReplyPreviewLike | null
  highestIntent?: ReplyIntent | null
  showSnippet?: boolean
  /** false = name and company only (the badges live in another column). */
  showBadges?: boolean
}) {
  // Name and company only: one identity row, each line kept to a single line.
  const compact = !showBadges && !showSnippet
  return (
    <div className={`flex gap-app-sm ${compact ? 'items-center' : 'items-start'}`}>
      <LeadAvatar lead={lead} size={32} />
      <div className={compact ? 'min-w-0 max-w-[260px]' : 'min-w-0'}>
        <div className="flex flex-wrap items-center gap-x-app-sm gap-y-app-xs">
          <a
            className={`relative z-10 text-app-text no-underline hover:text-app-accent hover:underline${compact ? ' whitespace-nowrap' : ''}`}
            href={lead.profile_url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {lead.full_name || lead.profile_url.replace('https://www.linkedin.com/in/', '')}
          </a>
          {showBadges && <LeadReplyBadges reply={reply} highestIntent={highestIntent} />}
        </div>
        {lead.company && <div className="truncate text-app-meta text-app-text-muted">{lead.company}</div>}
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
