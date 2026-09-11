import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, MessageCircle } from 'lucide-react'
import { dayHeading } from '../../lib/format'
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
}

function time(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(value))
}

export function ConversationThread({
  messages, selectedMessageId, focusMessageId, loading, error, olderCursor, newerCursor,
  onSelectMessage, onLoadOlder, onLoadNewer,
}: ConversationThreadProps) {
  if (loading && !messages.length) return <div className="replies-thread-status" aria-busy="true">Загружаем переписку…</div>
  if (error && !messages.length) return <div className="replies-thread-status error">{error}</div>
  if (!messages.length) return <div className="replies-thread-status"><MessageCircle size={20} aria-hidden="true" /> Нет сообщений в этом окне.</div>
  let previousDay = ''
  return (
    <div className="replies-thread" aria-label="Переписка">
      {olderCursor && <button className="replies-thread-more" type="button" onClick={onLoadOlder} disabled={loading}><ArrowUp size={14} /> Загрузить старые сообщения</button>}
      {messages.map((message) => {
        const day = dayHeading(message.sent_at)
        const showDay = day !== previousDay
        previousDay = day
        const inbound = message.direction === 'in'
        const selected = message.id === selectedMessageId
        const focused = message.id === focusMessageId
        const review = message.review
        return (
          <div key={message.id}>
            {showDay && <div className="replies-thread-day">{day}</div>}
            <button
              type="button"
              className={`replies-message ${inbound ? 'inbound' : 'outbound'} ${selected ? 'selected' : ''} ${focused ? 'focused' : ''}`}
              onClick={() => onSelectMessage(message)}
              aria-pressed={selected}
              aria-label={`${inbound ? 'Входящее' : 'Исходящее'} сообщение ${time(message.sent_at)}`}
            >
              <span className="replies-message-meta"><span>{inbound ? 'Лид' : 'Вы'}</span><time dateTime={message.sent_at}>{time(message.sent_at)}</time></span>
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
