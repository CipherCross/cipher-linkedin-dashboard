import { useMemo } from 'react'
import { History } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { blindSpotLeads, instanceName, SENTIMENT_META } from '../lib/leads'
import { useConversation } from '../lib/ConversationContext'

// Show only the top few candidates; the rest collapse into a "+ ще N" note so the
// callout stays a nudge, not a full worklist.
const MAX_VISIBLE = 6

/** Ukrainian short date for a message timestamp (wall-clock, local). */
const dateUk = (ts: string) =>
  new Date(ts).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })

/** A data-completeness nudge on the Overview page: warm replies (positive /
 *  objection / referral) whose thread has no manually-imported history, so what
 *  happened after the reply is invisible. Clicking a row opens the shared
 *  conversation drawer, which holds the "Import history" flow. All copy in
 *  Ukrainian, matching BriefingCard. Renders nothing when there are no
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
      <h2 className="import-callout-title">
        <History size={16} className="import-callout-icon" />
        Імпортуйте історію розмов
      </h2>
      <p className="import-callout-lede">
        Ці теплі відповіді ми бачимо лише з синхронізації — що сталося після відповіді,
        залишається невидимим. Імпортуйте історію діалогу, щоб фоловапи та призначені
        дзвінки з’явилися в дашборді.
      </p>

      <div className="import-callout-list">
        {visible.map(({ lead, reply }) => {
          const meta = reply.sentiment ? SENTIMENT_META[reply.sentiment] : null
          const name =
            lead.full_name || lead.profile_url.replace('https://www.linkedin.com/in/', '')
          const account = instanceName(
            data.instances.find((i) => i.id === lead.instance_id),
            lead.instance_id,
          )
          return (
            <div
              key={lead.id}
              className="import-callout-row row-clickable"
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
              <div className="import-callout-who">
                <span className="import-callout-name">{name}</span>
                {meta && (
                  <span className={`badge senti ${meta.cls}`} title={reply.reason ?? ''}>
                    {meta.label}
                  </span>
                )}
              </div>
              <div className="import-callout-meta muted small">
                {[lead.company, account].filter(Boolean).join(' · ') || '—'}
              </div>
              <div className="import-callout-when muted small">{dateUk(reply.sent_at)}</div>
            </div>
          )
        })}
      </div>

      {extra > 0 && <div className="import-callout-more muted small">+ ще {extra}</div>}
      <div className="import-callout-hint muted small">
        Натисніть, щоб відкрити діалог → Імпорт історії
      </div>
    </div>
  )
}
