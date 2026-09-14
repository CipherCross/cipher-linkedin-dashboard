import { useLayoutEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, MessageCircle } from 'lucide-react'
import { replyDateKey, replyDayHeading, replyTime, REPLY_TIME_ZONE_LABEL } from '../../lib/replyTime'
import { SENTIMENT_LABELS, type ReplyThreadMessage } from '../../lib/replyReview'

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
  onSelectMessage, onLoadOlder, onLoadNewer, inboundName = 'Контакт LinkedIn', outboundName = 'Аккаунт LinkedIn',
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
  if (loading && !messages.length) return <div className="replies-thread-status" aria-busy="true">Загружаем переписку…</div>
  if (error && !messages.length) return <div className="replies-thread-status error">{error}</div>
  if (!messages.length) return <div className="replies-thread-status"><MessageCircle size={20} aria-hidden="true" /> Нет сообщений в этом окне.</div>
  let previousDay = ''
  return (
    <div className="replies-thread" aria-label="Переписка" ref={scrollRef}>
      {olderCursor && <button className="replies-thread-more" type="button" onClick={onLoadOlder} disabled={loading}><ArrowUp size={14} /> Загрузить старые сообщения</button>}
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
            {showDay && <div className="replies-thread-day">{replyDayHeading(message.sent_at)}</div>}
            <button
              type="button"
              className={`replies-message ${inbound ? 'inbound' : 'outbound'} ${selected ? 'selected' : ''} ${focused ? 'focused' : ''}`}
              data-message-id={message.id}
              onClick={() => onSelectMessage(message)}
              aria-pressed={selected}
              aria-label={`${inbound ? 'Входящее' : 'Исходящее'} сообщение ${replyTime(message.sent_at)} (${REPLY_TIME_ZONE_LABEL})`}
            >
              <span className="replies-message-meta"><span>{inbound ? inboundName : outboundName}</span><time dateTime={message.sent_at} title={REPLY_TIME_ZONE_LABEL}>{replyTime(message.sent_at)}</time></span>
              <span className="replies-message-body">{message.body || '—'}</span>
              {inbound && <span className="replies-message-footer">
                {review?.sentiment ? <span className={`replies-chip sentiment-${review.sentiment}`}>{SENTIMENT_LABELS[review.sentiment]}</span> : <span className="replies-unreviewed">Не разобрано</span>}
                {review?.reason_ids?.length ? <span className="muted small">{review.reason_ids.length} причин</span> : null}
              </span>}
            </button>
          </div>
        )
      })}
      {newerCursor && <button className="replies-thread-more" type="button" onClick={onLoadNewer} disabled={loading}><ArrowDown size={14} /> Загрузить новые сообщения</button>}
    </div>
  )
}

export function ThreadScrollHint({ older, newer, onOlder, onNewer }: { older: boolean; newer: boolean; onOlder: () => void; onNewer: () => void }) {
  return <div className="replies-thread-hints">{older && <button type="button" onClick={onOlder}><ChevronUp size={14} /> Старше</button>}{newer && <button type="button" onClick={onNewer}><ChevronDown size={14} /> Новее</button>}</div>
}
