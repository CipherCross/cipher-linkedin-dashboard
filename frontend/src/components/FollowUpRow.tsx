import type { ReactNode } from 'react'
import { ExternalLink, UserRound } from 'lucide-react'
import { Badge, Button, ExternalLinkButton, LinkButton, StatusText } from '../ui'
import type { Tone } from '../ui'

export interface FollowUpRowMessage {
  direction: 'in' | 'out'
  /** Full body, shown on hover. */
  body: string
  snippet: string
  /** ISO timestamp for `<time dateTime>`. */
  sentAt: string
  timeLabel: string
  timeTitle?: string
}

/**
 * One row of the Follow-ups work queue: who, when and whose, the last message,
 * then the actions. Presentation only — the route formats every value and owns
 * the handlers; the Gallery renders the same component with sample values.
 *
 * The four zones sit on one line while they fit and wrap below it otherwise;
 * the text zones truncate and the action cluster never shrinks, so the primary
 * action is never clipped at 1280.
 */
export function FollowUpRow({
  avatar, name, subtitle, dueLabel, dueTone, owner, campaigns, account, message,
  linkedinHref, repliesTo, onOpen,
}: {
  avatar?: ReactNode
  name: string
  subtitle: string
  dueLabel: string
  dueTone: Tone
  owner: string
  campaigns: string
  account: string
  message: FollowUpRowMessage | null
  linkedinHref: string
  repliesTo: string
  onOpen: () => void
}) {
  return (
    <article className="flex flex-wrap items-center gap-app-lg p-app-md border-b border-app-border last:border-b-0">
      <Button
        variant="ghost"
        onClick={onOpen}
        aria-label={`Open follow-up for ${name}`}
        className="justify-start text-left whitespace-normal h-auto py-app-xs px-app-sm gap-app-md min-w-0 flex-1 basis-[240px]"
      >
        {avatar}
        <span className="flex flex-col gap-0.5 min-w-0">
          <span className="text-app-table font-semibold leading-snug line-clamp-2 [overflow-wrap:anywhere] text-app-text">
            {name}
          </span>
          <span className="text-app-meta font-normal text-app-text-muted truncate">{subtitle}</span>
        </span>
      </Button>
      <div className="flex flex-col gap-0.5 min-w-0 flex-1 basis-[180px]">
        <Badge tone={dueTone} className="self-start">{dueLabel}</Badge>
        <span className="inline-flex items-center gap-app-xs text-app-meta text-app-text-muted">
          <UserRound size={13} aria-hidden="true" />
          {owner}
        </span>
        <span className="text-app-meta text-app-text-muted truncate" title={campaigns}>{campaigns}</span>
        <span className="text-app-meta text-app-text-muted">{account}</span>
      </div>
      <div className="flex items-center gap-app-sm min-w-0 flex-1 basis-[220px]">
        {message ? (
          <>
            <StatusText tone={message.direction === 'in' ? 'accent' : 'neutral'}>
              {message.direction === 'in' ? 'Them' : 'Us'}
            </StatusText>
            <span className="truncate min-w-0" title={message.body}>{message.snippet}</span>
            <time
              className="text-app-meta text-app-text-muted shrink-0 whitespace-nowrap"
              dateTime={message.sentAt}
              title={message.timeTitle}
            >
              {message.timeLabel}
            </time>
          </>
        ) : (
          <span className="text-app-meta text-app-text-muted">No message history</span>
        )}
      </div>
      {/* One primary action per row; the two rarer links sit beside it as
          quiet links, not as competing buttons. */}
      <div className="flex items-center gap-app-sm shrink-0 flex-wrap justify-end ml-auto">
        <ExternalLinkButton
          variant="ghost"
          size="sm"
          href={linkedinHref}
          target="_blank"
          rel="noreferrer"
          icon={<ExternalLink aria-hidden="true" />}
        >
          LinkedIn
        </ExternalLinkButton>
        <LinkButton variant="ghost" size="sm" to={repliesTo}>Review in Replies</LinkButton>
        {/* The row's one primary action keeps the full control height; the
            dense variant is for the quiet links beside it, not for this. */}
        <Button variant="primary" onClick={onOpen}>Open follow-up</Button>
      </div>
    </article>
  )
}
