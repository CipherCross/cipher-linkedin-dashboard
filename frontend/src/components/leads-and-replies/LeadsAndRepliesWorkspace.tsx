import { useMemo, useState } from 'react'
import { Search, SearchX } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useConversation } from '../../lib/ConversationContext'
import type {
  CampaignMetrics, ConversationLatestMessage, ConversationReplyIntent, FollowUpState,
  Instance, Lead, Message, ReplyIntent,
} from '../../lib/types'
import {
  INTENT_META, highestIntentByLead, instanceName, latestRepliesByLead, leadKey,
} from '../../lib/leads'
import {
  activeFollowUp, followUpDueLabel, followUpKey, followUpStateMap,
} from '../../lib/followUps'
import { replyDate, REPLY_TIME_ZONE_LABEL } from '../../lib/replyTime'
import { EmptyState } from '../EmptyState'
import { LeadMilestoneBadge, LeadReplyIdentity } from './LeadReplyIdentity'

export type LeadsReplyFilter = 'all' | 'replied' | 'p3' | 'needs-follow-up' | 'no-reply'

const FILTERS: Array<{ id: LeadsReplyFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'replied', label: 'Replied' },
  { id: 'p3', label: 'P3' },
  { id: 'needs-follow-up', label: 'Needs follow-up' },
  { id: 'no-reply', label: 'No reply' },
]

const FILTER_IDS = new Set(FILTERS.map((filter) => filter.id))

export function LeadsAndRepliesWorkspace({
  leads,
  messages,
  intentRows,
  followUpStates,
  latestMessages,
  instances,
  campaigns,
}: {
  leads: Lead[]
  messages: Message[]
  intentRows: ConversationReplyIntent[]
  followUpStates: FollowUpState[]
  latestMessages: ConversationLatestMessage[]
  instances: Instance[]
  campaigns: CampaignMetrics[]
}) {
  const { openConversation } = useConversation()
  const [params, setParams] = useSearchParams()
  const requestedFilter = params.get('people') as LeadsReplyFilter | null
  const filter: LeadsReplyFilter = requestedFilter && FILTER_IDS.has(requestedFilter)
    ? requestedFilter
    : 'all'
  const [queryInput, setQueryInput] = useState(params.get('q') ?? '')

  const replies = useMemo(() => latestRepliesByLead(messages), [messages])
  const messageIntents = useMemo(() => highestIntentByLead(messages), [messages])
  const durableIntents = useMemo(() => new Map(
    intentRows.map((row) => [leadKey(row.instance_id, row.profile_url), row.highest_intent]),
  ), [intentRows])
  const followUps = useMemo(() => followUpStateMap(followUpStates), [followUpStates])
  const latestByThread = useMemo(() => new Map(
    latestMessages.map((message) => [leadKey(message.instance_id, message.profile_url), message]),
  ), [latestMessages])
  const campaignNames = useMemo(() => new Map(
    campaigns.map((campaign) => [campaign.campaign_id, campaign.campaign_name]),
  ), [campaigns])
  const instanceNames = useMemo(() => new Map(
    instances.map((instance) => [instance.id, instanceName(instance, instance.id)]),
  ), [instances])

  const rowMeta = useMemo(() => leads.map((lead) => {
    const key = leadKey(lead.instance_id, lead.profile_url)
    const reply = replies.get(key) ?? null
    const highestIntent = durableIntents.get(key)
      ?? messageIntents.get(key)?.highest
      ?? null
    const followUp = followUps.get(followUpKey(lead.instance_id, lead.profile_url)) ?? null
    const latestMessage = latestByThread.get(key)
    const needsFollowUp = activeFollowUp(followUp)
      || lead.pipeline_stage === 'following_up'
      || latestMessage?.direction === 'in'
    return { lead, reply, highestIntent, followUp, needsFollowUp }
  }), [leads, replies, durableIntents, messageIntents, followUps, latestByThread])

  const counts = useMemo(() => {
    const result: Record<LeadsReplyFilter, number> = {
      all: rowMeta.length,
      replied: 0,
      p3: 0,
      'needs-follow-up': 0,
      'no-reply': 0,
    }
    for (const row of rowMeta) {
      if (row.lead.replied_at) result.replied += 1
      else result['no-reply'] += 1
      if (row.highestIntent === 'p3') result.p3 += 1
      if (row.needsFollowUp) result['needs-follow-up'] += 1
    }
    return result
  }, [rowMeta])

  const rows = useMemo(() => {
    const needle = (params.get('q') ?? '').trim().toLowerCase()
    return rowMeta
      .filter((row) => {
        if (filter === 'replied' && !row.lead.replied_at) return false
        if (filter === 'p3' && row.highestIntent !== 'p3') return false
        if (filter === 'needs-follow-up' && !row.needsFollowUp) return false
        if (filter === 'no-reply' && row.lead.replied_at) return false
        if (!needle) return true
        return `${row.lead.full_name ?? ''} ${row.lead.company ?? ''} ${row.lead.headline ?? ''}`
          .toLowerCase()
          .includes(needle)
      })
      .sort((left, right) => {
        const leftAt = left.reply?.sent_at ?? left.lead.last_action_at ?? ''
        const rightAt = right.reply?.sent_at ?? right.lead.last_action_at ?? ''
        return rightAt.localeCompare(leftAt)
      })
  }, [rowMeta, filter, params])

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (!value || value === 'all') next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }

  return (
    <section >
      <div className="flex items-center justify-between gap-app-md flex-wrap mb-app-lg max-[700px]:items-stretch">
        <div className="segmented flex-wrap" role="tablist" aria-label="Filter campaign leads">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`segmented-item ${filter === item.id ? 'active' : ''}`}
              role="tab"
              aria-selected={filter === item.id}
              onClick={() => setParam('people', item.id)}
            >
              {item.label} <span className="tabular-nums text-app-text-muted text-[length:var(--text-xs)]">{counts[item.id]}</span>
            </button>
          ))}
        </div>
        <label className="flex items-center gap-[7px] min-w-[240px] max-[700px]:min-w-0 border border-app-border rounded-md px-2.5 bg-app-surface text-app-text-muted [&_input]:border-0 [&_input]:bg-transparent [&_input]:text-app-text [&_input]:py-app-sm [&_input]:px-0 [&_input]:font-[inherit] [&_input]:flex-1 [&_input]:min-w-0 [&_input:focus]:outline-none">
          <Search size={15} />
          <input
            type="search"
            value={queryInput}
            placeholder="Search name, company, headline…"
            onChange={(event) => setQueryInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setParam('q', queryInput.trim() || null)
            }}
            onBlur={() => setParam('q', queryInput.trim() || null)}
          />
        </label>
      </div>

      <div className="card pt-app-md">
        <div className="mb-[9px] muted small">
          {rows.length} of {leads.length} leads · newest replies first
        </div>
        <div className="table-scroll">
          <table data-leads-replies="table" className="w-full border-collapse [&_th]:text-left [&_th]:text-[length:var(--text-2xs)] [&_th]:uppercase [&_th]:tracking-[.04em] [&_th]:text-app-text-muted [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:border-b [&_th]:border-app-border [&_th]:whitespace-nowrap [&_td]:px-2.5 [&_td]:py-[9px] [&_td]:border-b [&_td]:border-app-border [&_td]:align-top [&_tbody_tr:last-child_td]:border-b-0">
            <thead>
              <tr>
                <th>Lead & latest reply</th>
                <th>Milestone</th>
                <th>Reply</th>
                <th>Intent</th>
                <th>Follow-up</th>
                <th>Sender & campaign</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 100).map(({ lead, reply, highestIntent, followUp, needsFollowUp }) => (
                <tr
                  key={lead.id}
                  className="row-clickable"
                  tabIndex={0}
                  role="button"
                  aria-label={`Open conversation with ${lead.full_name || 'lead'}`}
                  onClick={() => openConversation(lead)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      openConversation(lead)
                    }
                  }}
                >
                  <td><LeadReplyIdentity lead={lead} reply={reply} highestIntent={highestIntent} /></td>
                  <td><LeadMilestoneBadge lead={lead} /></td>
                  <td className="muted small">
                    {reply
                      ? <time dateTime={reply.sent_at} title={REPLY_TIME_ZONE_LABEL}>{replyDate(reply.sent_at)}</time>
                      : 'No reply yet'}
                  </td>
                  <td>{highestIntent ? <IntentBadge intent={highestIntent} /> : <span className="muted">—</span>}</td>
                  <td>
                    {activeFollowUp(followUp)
                      ? <span className="follow-due">{followUpDueLabel(followUp)}</span>
                      : needsFollowUp
                        ? <span className="badge risk">Needs response</span>
                        : <span className="muted">—</span>}
                  </td>
                  <td>
                    <div>{instanceNames.get(lead.instance_id) ?? lead.instance_id}</div>
                    <div className="muted small">{campaignNames.get(lead.campaign_id) ?? lead.campaign_id}</div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6}>
                  <EmptyState
                    icon={SearchX}
                    title="No leads match this view"
                    hint="Choose another segment or clear the search."
                    action={<button className="link-btn" onClick={() => {
                      setQueryInput('')
                      const next = new URLSearchParams(params)
                      next.delete('people')
                      next.delete('q')
                      setParams(next, { replace: true })
                    }}>Clear filters</button>}
                  />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {rows.length > 100 && <div className="muted small mt-[9px]">Showing the 100 most recent matches.</div>}
      </div>
    </section>
  )
}

function IntentBadge({ intent }: { intent: ReplyIntent }) {
  const meta = INTENT_META[intent]
  return <span className={`badge senti ${meta.cls}`}>{meta.short} · {meta.label}</span>
}
