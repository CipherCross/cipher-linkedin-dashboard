import { useMemo, useState } from 'react'
import { SearchX } from 'lucide-react'
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
  activeFollowUp, followUpBucket, followUpDueLabel, followUpKey, followUpStateMap,
} from '../../lib/followUps'
import type { FollowUpBucket } from '../../lib/followUps'
import { replyDate, REPLY_TIME_ZONE_LABEL } from '../../lib/replyTime'
import {
  AccountIdentity, Badge, Button, EmptyState, Table, TableFrame, TableToolbar, Tabs, TextField,
} from '../../ui'
import type { Tone } from '../../ui'
import { RowOpenButton } from '../RowOpenButton'
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

/* Due-date urgency, in the same words and tones as Leads and Follow-ups. */
const FOLLOW_UP_TONE: Record<FollowUpBucket, Tone> = {
  overdue: 'danger',
  today: 'warning',
  upcoming: 'accent',
  unscheduled: 'neutral',
}

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

  const clearFilters = () => {
    setQueryInput('')
    const next = new URLSearchParams(params)
    next.delete('people')
    next.delete('q')
    setParams(next, { replace: true })
  }

  return (
    <section>
      {/* The segments narrow the same list, so they are tabs, not a mode switch. */}
      <div className="flex items-end justify-between gap-app-md flex-wrap mb-app-lg">
        <Tabs
          label="Filter campaign leads"
          value={filter}
          onChange={(id) => setParam('people', id)}
          items={FILTERS.map((item) => ({ id: item.id, label: item.label, count: counts[item.id] }))}
        />
        <TextField
          className="min-w-[280px]"
          label="Search campaign leads"
          labelHidden
          type="search"
          value={queryInput}
          placeholder="Search name, company, headline…"
          onChange={(event) => setQueryInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setParam('q', queryInput.trim() || null)
          }}
          onBlur={() => setParam('q', queryInput.trim() || null)}
        />
      </div>

      <TableFrame
        scrollLabel="Campaign leads"
        toolbar={<TableToolbar count={`${rows.length} of ${leads.length} leads · newest replies first`} />}
        hint={rows.length > 100 ? 'Showing the 100 most recent matches.' : undefined}
      >
        <Table caption="Campaign leads and their latest replies">
          <thead>
            <tr>
              <th scope="col">Lead &amp; latest reply</th>
              <th scope="col">Milestone</th>
              <th scope="col">Reply</th>
              <th scope="col">Intent</th>
              <th scope="col">Follow-up</th>
              <th scope="col">Sender &amp; campaign</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map(({ lead, reply, highestIntent, followUp, needsFollowUp }) => (
              <tr
                key={lead.id}
                data-leads-replies="row"
                className="relative cursor-pointer"
                // The pointer path; the keyboard path is the row's button.
                onClick={() => openConversation(lead)}
              >
                <td>
                  <RowOpenButton
                    label={`Open conversation with ${lead.full_name || 'lead'}`}
                    onOpen={() => openConversation(lead)}
                  />
                  <LeadReplyIdentity lead={lead} reply={reply} highestIntent={highestIntent} />
                </td>
                <td><LeadMilestoneBadge lead={lead} /></td>
                <td className="whitespace-nowrap text-app-meta text-app-text-muted">
                  {reply
                    ? <time dateTime={reply.sent_at} title={REPLY_TIME_ZONE_LABEL}>{replyDate(reply.sent_at)}</time>
                    : 'No reply yet'}
                </td>
                <td>{highestIntent ? <IntentBadge intent={highestIntent} /> : <span className="text-app-text-muted">—</span>}</td>
                <td className="whitespace-nowrap">
                  {activeFollowUp(followUp)
                    ? <Badge tone={FOLLOW_UP_TONE[followUpBucket(followUp)]}>{followUpDueLabel(followUp)}</Badge>
                    : needsFollowUp
                      ? <Badge tone="danger">Needs response</Badge>
                      : <span className="text-app-text-muted">—</span>}
                </td>
                <td>
                  <AccountIdentity
                    name={instanceNames.get(lead.instance_id) ?? lead.instance_id}
                    secondary={campaignNames.get(lead.campaign_id) ?? lead.campaign_id}
                  />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6}>
                <EmptyState
                  kind={leads.length ? 'no-match' : 'empty'}
                  icon={SearchX}
                  title={leads.length ? 'No leads match this view' : 'No leads in this campaign yet'}
                  hint={leads.length ? 'Choose another segment or clear the search.' : 'Leads appear here once the campaign syncs.'}
                  action={leads.length ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
                />
              </td></tr>
            )}
          </tbody>
        </Table>
      </TableFrame>
    </section>
  )
}

function IntentBadge({ intent }: { intent: ReplyIntent }) {
  const meta = INTENT_META[intent]
  return <span className={`badge senti ${meta.cls}`}>{meta.short} · {meta.label}</span>
}
