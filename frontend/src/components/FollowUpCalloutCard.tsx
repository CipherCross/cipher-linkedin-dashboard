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
    <section className="card mb-app-xl">
      <div className="flex justify-between items-start gap-app-md [&_h2]:flex [&_h2]:items-center [&_h2]:gap-[7px] [&_h2]:mt-0 [&_h2]:mx-0 [&_h2]:mb-[3px] [&_h2]:text-[length:var(--text-md)] [&_h2_svg]:text-app-accent">
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
      <div className="grid grid-cols-2 max-[700px]:grid-cols-1 gap-x-app-md gap-y-[6px] mt-app-md">
        {urgent.slice(0, 6).map((item) => {
          const lead = item.representative
          const name = lead.full_name ?? lead.profile_url.replace('https://www.linkedin.com/in/', '')
          const bucket = followUpBucket(item.state)
          return (
            <button
              type="button"
              className="min-w-0 flex items-center gap-app-sm px-app-sm py-[7px] border border-transparent rounded-sm bg-app-surface-2 text-app-text cursor-pointer text-left hover:border-app-border-strong"
              key={item.key}
              onClick={() => openConversation(lead, { mode: 'follow_up' })}
            >
              <LeadAvatar lead={lead} size={28} />
              <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">{name}</span>
              <span className={`follow-due ${bucket}`}>{followUpDueLabel(item.state)}</span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </section>
  )
}
