import { Fragment } from 'react'
import { Scissors } from 'lucide-react'
import { ORIGIN_LABEL, type MessageOrigin, type TrainingMessage } from '../../lib/coachTraining'
import { replyDayHeading, replyTime, REPLY_TIME_ZONE_LABEL } from '../../lib/replyTime'
import { Badge, Button } from '../../ui'
import type { Tone } from '../../ui'
import { MessageBubble } from '../conversation/MessageBubble'

const ORIGIN_TONE: Record<MessageOrigin, Tone> = {
  sequence: 'neutral',
  template: 'neutral',
  manual: 'accent',
  unverified: 'warning',
}

function originText(m: TrainingMessage): string | null {
  if (!m.origin) return null
  if (m.origin === 'sequence') {
    if (m.step_type === 'InvitePerson') return 'Sequence · connection note'
    return m.message_ordinal ? `Sequence · message ${m.message_ordinal}` : 'Sequence'
  }
  return ORIGIN_LABEL[m.origin]
}

/**
 * The conversation as the coach reads it: every outbound message tagged with
 * what produced it, and an optional cut — the coach then sees only the
 * messages up to it. The first message after a cut is what was actually sent
 * next, shown for reference and never given to the AI as a target.
 */
export function CaseThread({
  thread,
  cutAfterMessageId,
  onCut,
  cutting,
}: {
  thread: TrainingMessage[]
  cutAfterMessageId: number | null
  onCut: (messageId: number | null) => void
  cutting: boolean
}) {
  const cutIndex = cutAfterMessageId === null ? -1 : thread.findIndex((m) => m.id === cutAfterMessageId)
  let lastDay = ''

  return (
    <ol className="list-none m-0 p-0 flex flex-col gap-group" aria-label="Messages">
      {thread.map((m, index) => {
        const day = replyDayHeading(m.sent_at)
        const startsDay = day !== lastDay
        lastDay = day
        const inbound = m.direction === 'in'
        const after = cutIndex >= 0 && index > cutIndex
        const origin = originText(m)
        return (
          <Fragment key={m.id ?? `${m.sent_at}-${index}`}>
            {startsDay && (
              <li aria-hidden="true" className="flex items-center gap-app-sm text-app-text-muted before:content-[''] before:flex-1 before:h-px before:bg-app-border after:content-[''] after:flex-1 after:h-px after:bg-app-border">
                <span className="text-app-meta font-semibold uppercase tracking-[var(--tracking-caps)] whitespace-nowrap">{day}</span>
              </li>
            )}
            <li
              className={`flex flex-col gap-app-xs max-w-[min(85%,520px)] ${inbound ? 'self-start items-start' : 'self-end items-end'} ${after ? 'opacity-50' : ''}`}
              data-after-cut={after ? 'true' : undefined}
            >
              {after && index === cutIndex + 1 && (
                <span className="text-app-meta font-semibold text-app-text-secondary">What was actually sent next — not shown to the coach</span>
              )}
              <MessageBubble direction={inbound ? 'in' : 'out'} tail title={`${replyTime(m.sent_at, true)} · ${REPLY_TIME_ZONE_LABEL}`}>
                <span className="message-bubble__body">{m.body || <span className="opacity-70">(empty)</span>}</span>
              </MessageBubble>
              <span className={`flex items-center gap-app-xs ${inbound ? '' : 'flex-row-reverse'}`}>
                {origin && m.origin && <Badge tone={ORIGIN_TONE[m.origin]}>{origin}</Badge>}
                <time className="text-app-meta text-app-text-muted" dateTime={m.sent_at} title={REPLY_TIME_ZONE_LABEL}>{replyTime(m.sent_at)}</time>
                {m.id !== null && index < thread.length - 1 && index !== cutIndex && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Scissors aria-hidden="true" />}
                    disabled={cutting}
                    aria-label={`Coach as of this message (${replyTime(m.sent_at, true)})`}
                    onClick={() => onCut(m.id)}
                  >
                    Cut here
                  </Button>
                )}
              </span>
            </li>
            {index === cutIndex && (
              <li className="coach-training-cut" role="separator" aria-label="Cut point">
                <span>The coach reads up to here</span>
                <Button variant="ghost" size="sm" disabled={cutting} onClick={() => onCut(null)}>Remove cut</Button>
              </li>
            )}
          </Fragment>
        )
      })}
    </ol>
  )
}
