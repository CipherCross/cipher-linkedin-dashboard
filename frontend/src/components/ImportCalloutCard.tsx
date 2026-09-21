import { useMemo } from 'react'
import { History } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { blindSpotLeads, instanceName, INTENT_META, SENTIMENT_META } from '../lib/leads'
import { useConversation } from '../lib/ConversationContext'
import { businessDate } from '../ui/datetime'

// Show only the top few candidates; the rest collapse into a "+ N more" note so the
// callout stays a nudge, not a full worklist.
const MAX_VISIBLE = 6

/** Short business date for a reply — the same Madrid clock the rest of the
 *  reply surfaces use, so a row here and the same row in Replies agree. */
const replyDate = (ts: string) => businessDate(ts)

/** A data-completeness nudge on the Overview page: P2/P3 and other actionable
 *  replies whose thread has no manually-imported history, so what
 *  happened after the reply is invisible. Clicking a row opens the shared
 *  conversation drawer, which holds the "Import history" flow. Renders
 *  nothing when there are no
 *  candidates — or when `messages.source` is unavailable (pre-migration DB,
 *  where fetchMessages stripped the column and every thread looks sync-only). */
export function ImportCalloutCard() {
  const { data } = useData()
  const { openConversation } = useConversation()

  const candidates = useMemo(
    () => (data ? blindSpotLeads(data.leads, data.messages) : []),
    [data],
  )

  // If NO message carries a defined `source`, the retry stripped the column —
  // treat that as "unknown" rather than "every warm thread is sync-only".
  const sourceAvailable = useMemo(
    () => !!data && data.messages.some((m) => m.source !== undefined),
    [data],
  )

  if (!data || !sourceAvailable || candidates.length === 0) return null

  const visible = candidates.slice(0, MAX_VISIBLE)
  const extra = candidates.length - visible.length

  return (
    <div className="card import-callout">
      <h2 className="inline-flex items-center gap-app-sm mt-0 mx-0 mb-0.5 text-app-text text-[length:var(--text-md)]">
        <History size={16} className="text-app-warning shrink-0" />
        Import conversation history
      </h2>
      <p className="mt-app-sm mx-0 mb-0 leading-[1.55] text-app-text-secondary">
        These warm replies are only visible through the sync — whatever happened
        after the reply stays invisible. Import the conversation history so that
        follow-ups and booked calls show up in the dashboard.
      </p>

      <div className="mt-[14px] flex flex-col max-w-[760px]">
        {visible.map(({ lead, reply }) => {
          const meta = reply.sentiment ? SENTIMENT_META[reply.sentiment] : null
          const intentMeta = reply.highest_intent ? INTENT_META[reply.highest_intent] : null
          const name =
            lead.full_name || lead.profile_url.replace('https://www.linkedin.com/in/', '')
          const account = instanceName(
            data.instances.find((i) => i.id === lead.instance_id),
            lead.instance_id,
          )
          return (
            <div
              key={lead.id}
              className="grid grid-cols-[1fr_auto] items-center gap-x-app-md gap-y-0.5 px-app-sm py-2.5 border-b border-app-border last:border-b-0 rounded-sm row-clickable"
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
              <div className="col-start-1 row-start-1 flex items-center gap-app-sm flex-wrap min-w-0">
                <span className="font-semibold">{name}</span>
                {meta && (
                  <span className={`badge senti ${meta.cls}`} title={reply.reason ?? ''}>
                    {meta.label}
                  </span>
                )}
                {intentMeta && (
                  <span className={`badge senti ${intentMeta.cls}`} title="Highest buying-interest level">
                    {intentMeta.short} · {intentMeta.label}
                  </span>
                )}
              </div>
              <div className="col-start-1 row-start-2 min-w-0 muted small">
                {[lead.company, account].filter(Boolean).join(' · ') || '—'}
              </div>
              <div className="col-start-2 row-start-1 row-end-3 text-right whitespace-nowrap muted small">{replyDate(reply.sent_at)}</div>
            </div>
          )
        })}
      </div>

      {extra > 0 && <div className="mt-app-sm muted small">+ {extra} more</div>}
      <div className="mt-app-md muted small">
        Select a row to open the conversation → Import history
      </div>
    </div>
  )
}
