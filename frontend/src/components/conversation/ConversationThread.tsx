import { useLayoutEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, MessageCircle } from 'lucide-react'
import { replyDateKey, replyDayHeading, replyTime, REPLY_TIME_ZONE_LABEL } from '../../lib/replyTime'
import { SENTIMENT_LABELS, type ReplyThreadMessage } from '../../lib/replyReview'
import { SENTIMENT_META } from '../../lib/leads'
import { Badge, Button } from '../../ui'

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
  inboundName?: string
  outboundName?: string
}

export function ConversationThread({
  messages, selectedMessageId, focusMessageId, loading, error, olderCursor, newerCursor,
  onSelectMessage, onLoadOlder, onLoadNewer, inboundName = 'LinkedIn contact', outboundName = 'LinkedIn account',
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
  let previousDay = ''
  return (
    <div className="flex-[1_1_auto] min-h-0 overflow-auto [overscroll-behavior:contain] px-app-xl py-app-lg" aria-label="Conversation" ref={scrollRef}>
      {olderCursor && <div className="flex justify-center mb-app-md">
        <Button variant="ghost" size="sm" icon={<ArrowUp size={14} aria-hidden="true" />} onClick={onLoadOlder} disabled={loading}>Load older messages</Button>
      </div>}
      {messages.map((message) => {
        const day = replyDateKey(message.sent_at)
        const showDay = day !== previousDay
        previousDay = day
        const inbound = message.direction === 'in'
        const selected = message.id === selectedMessageId
        const focused = message.id === focusMessageId
        const review = message.review
        return (
          <div key={message.id}>
            {showDay && <div className="my-app-lg mx-auto text-app-text-muted text-app-meta text-center">{replyDayHeading(message.sent_at)}</div>}
            {/* ui-exception(replies-message-bubble): a message row is the whole
                conversation bubble (sender, timestamp, body, sentiment badge) —
                richer content than Button's fixed contract renders — kept as a
                real, keyboard-operable <button> so Tab/Enter/Space still select
                it for review. verify: Tab through the thread, Enter/Space
                selects a message, and the selected bubble carries
                aria-pressed="true". */}
            <button
              type="button"
              className={`replies-message ${inbound ? 'inbound' : 'outbound'} ${focused ? 'focused' : ''}`}
              data-message-id={message.id}
              onClick={() => onSelectMessage(message)}
              aria-pressed={selected}
              aria-label={`${inbound ? 'Inbound' : 'Outbound'} message ${replyTime(message.sent_at)} (${REPLY_TIME_ZONE_LABEL})`}
            >
              <span className="replies-message-meta"><span>{inbound ? inboundName : outboundName}</span><time dateTime={message.sent_at} title={REPLY_TIME_ZONE_LABEL}>{replyTime(message.sent_at)}</time></span>
              <span className="text-app-table whitespace-pre-wrap [word-break:break-word]">{message.body || '—'}</span>
              {inbound && <span className="replies-message-footer">
                {review?.sentiment ? <Badge tone={SENTIMENT_META[review.sentiment].tone}>{SENTIMENT_LABELS[review.sentiment]}</Badge> : <span className="text-app-warning text-app-meta font-semibold">Unreviewed</span>}
                {review?.reason_ids?.length ? <span className="text-app-text-muted text-app-meta">{review.reason_ids.length === 1 ? '1 reason' : `${review.reason_ids.length} reasons`}</span> : null}
              </span>}
            </button>
          </div>
        )
      })}
      {newerCursor && <div className="flex justify-center mb-app-md">
        <Button variant="ghost" size="sm" icon={<ArrowDown size={14} aria-hidden="true" />} onClick={onLoadNewer} disabled={loading}>Load newer messages</Button>
      </div>}
    </div>
  )
}
