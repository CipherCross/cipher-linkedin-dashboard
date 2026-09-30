import { useLayoutEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, MessageCircle } from 'lucide-react'
import { replyDayHeading, replyTime, REPLY_TIME_ZONE_LABEL } from '../../lib/replyTime'
import { groupMessages } from '../../lib/messageGroups'
import { SENTIMENT_LABELS, type ReplyThreadMessage } from '../../lib/replyReview'
import { SENTIMENT_META } from '../../lib/leads'
import { Badge, Button } from '../../ui'
import { MessageBubble } from './MessageBubble'

export interface ConversationThreadProps {
  messages: ReplyThreadMessage[]
  selectedMessageId: number | null
  focusMessageId?: number | null
  loading?: boolean
  error?: string | null
  olderCursor?: string | null
  newerCursor?: string | null
  onSelectMessage: (message: ReplyThreadMessage) => void
  onLoadOlder?: () => void
  onLoadNewer?: () => void
}

export function ConversationThread({
  messages, selectedMessageId, focusMessageId, loading, error, olderCursor, newerCursor,
  onSelectMessage, onLoadOlder, onLoadNewer,
}: ConversationThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastFirstId = useRef<number | null>(null)
  const lastHeight = useRef(0)
  const lastFocus = useRef<number | null>(null)
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const first = messages[0]?.id ?? null
    if (first !== lastFirstId.current && lastFirstId.current != null && messages.some((message) => message.id === lastFirstId.current)) {
      box.scrollTop += box.scrollHeight - lastHeight.current
    } else if (focusMessageId != null && focusMessageId !== lastFocus.current) {
      const focused = box.querySelector<HTMLElement>(`[data-message-id="${focusMessageId}"]`)
      focused?.scrollIntoView({ block: 'nearest' })
      if (focused) lastFocus.current = focusMessageId
    }
    lastFirstId.current = first
    lastHeight.current = box.scrollHeight
    if (focusMessageId == null) lastFocus.current = null
  }, [messages, focusMessageId])
  if (loading && !messages.length) return <div className="replies-thread-status" aria-busy="true">Loading the conversation…</div>
  if (error && !messages.length) return <div className="replies-thread-status text-app-danger">{error}</div>
  if (!messages.length) return <div className="replies-thread-status"><MessageCircle size={20} aria-hidden="true" /> No messages in this window.</div>
  const groups = groupMessages(messages)
  return (
    <div className="replies-thread-scroll" aria-label="Conversation" ref={scrollRef}>
      {olderCursor && <div className="flex justify-center mb-app-md">
        <Button variant="ghost" size="sm" icon={<ArrowUp aria-hidden="true" />} onClick={onLoadOlder} disabled={loading}>Load older messages</Button>
      </div>}
      {groups.map((group) => {
        const inbound = group.direction === 'in'
        const last = group.messages[group.messages.length - 1]
        return (
          <div key={group.key} className={inbound ? 'replies-group replies-group--in' : 'replies-group replies-group--out'}>
            {group.startsDay && <div className="replies-day">{replyDayHeading(last.sent_at)}</div>}
            {group.messages.map((message, index) => {
              const selected = message.id === selectedMessageId
              const focused = message.id === focusMessageId
              const review = message.review
              const exact = `${replyTime(message.sent_at, true)} · ${REPLY_TIME_ZONE_LABEL}`
              const imported = message.source === 'manual'
              return (
                <div key={message.id} className="replies-group-item">
                  {/* ui-exception(replies-message-bubble): a message is the whole
                      chat bubble (body, and under it the review state), richer
                      content than Button's fixed contract renders — kept as a
                      real, keyboard-operable <button> around the purely visual
                      MessageBubble so Tab/Enter/Space still select it for
                      review. verify: Tab through the thread, Enter/Space
                      selects a message, and the selected bubble carries
                      aria-pressed="true". */}
                  <button
                    type="button"
                    className={`replies-message ${inbound ? 'inbound' : 'outbound'}${focused ? ' focused' : ''}`}
                    data-message-id={message.id}
                    onClick={() => onSelectMessage(message)}
                    aria-pressed={selected}
                    aria-label={`${inbound ? 'Inbound' : 'Outbound'} message ${exact}${imported ? ', imported' : ''}`}
                  >
                    <MessageBubble direction={group.direction} body={message.body} tail={index === group.messages.length - 1} title={exact} />
                  </button>
                  {(inbound || imported) && <span className="replies-message-footer">
                    {inbound && (review?.sentiment ? <Badge tone={SENTIMENT_META[review.sentiment].tone}>{SENTIMENT_LABELS[review.sentiment]}</Badge> : <Badge tone="warning">Unreviewed</Badge>)}
                    {inbound && review?.reason_ids?.length ? <span>{review.reason_ids.length === 1 ? '1 reason' : `${review.reason_ids.length} reasons`}</span> : null}
                    {imported && <span>Imported</span>}
                  </span>}
                </div>
              )
            })}
            <time className="replies-group-time" dateTime={last.sent_at} title={REPLY_TIME_ZONE_LABEL}>{replyTime(last.sent_at)}</time>
          </div>
        )
      })}
      {newerCursor && <div className="flex justify-center mb-app-md">
        <Button variant="ghost" size="sm" icon={<ArrowDown aria-hidden="true" />} onClick={onLoadNewer} disabled={loading}>Load newer messages</Button>
      </div>}
    </div>
  )
}
