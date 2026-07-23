import { useMemo } from 'react'
import { CalendarCheck2, ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useConversation } from '../lib/ConversationContext'
import { useData } from '../lib/DataContext'
import {
  buildFollowUpWorkItems,
  businessDateKey,
  followUpBucket,
  followUpDueLabel,
} from '../lib/followUps'
import { LeadAvatar } from './Avatar'

export function FollowUpCalloutCard() {
  const { data } = useData()
  const { openConversation } = useConversation()
  const urgent = useMemo(() => {
    if (!data?.followUpsAvailable) return []
    const today = businessDateKey()
    return buildFollowUpWorkItems(data.leads, data.followUpStates)
      .filter((item) => {
        const bucket = followUpBucket(item.state, today)
        return bucket === 'overdue' || bucket === 'today'
      })
      .sort((a, b) =>
        (a.state.next_follow_up_date ?? '').localeCompare(b.state.next_follow_up_date ?? ''),
      )
  }, [data?.followUpsAvailable, data?.followUpStates, data?.leads])

  if (!data?.followUpsAvailable || urgent.length === 0) return null
  const overdue = urgent.filter((item) => followUpBucket(item.state) === 'overdue').length
  const today = urgent.length - overdue

  return (
    <section className="card follow-callout">
      <div className="follow-callout-head">
        <div>
          <h2><CalendarCheck2 size={17} /> Follow-ups</h2>
          <div className="muted small">
            {overdue ? `${overdue} overdue` : 'Nothing overdue'}
            {' · '}
            {today} due today
          </div>
        </div>
        <Link className="link-btn" to="/follow-ups">
          Open queue <ChevronRight size={14} />
        </Link>
      </div>
      <div className="follow-callout-list">
        {urgent.slice(0, 6).map((item) => {
          const lead = item.representative
          const name = lead.full_name ?? lead.profile_url.replace('https://www.linkedin.com/in/', '')
          const bucket = followUpBucket(item.state)
          return (
            <button
              type="button"
              className="follow-callout-row"
              key={item.key}
              onClick={() => openConversation(lead, { mode: 'follow_up' })}
            >
              <LeadAvatar lead={lead} size={28} />
              <span className="follow-callout-name">{name}</span>
              <span className={`follow-due ${bucket}`}>{followUpDueLabel(item.state)}</span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </section>
  )
}
