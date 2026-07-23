import { useMemo, useState } from 'react'
import { CalendarCheck2, ExternalLink, Search, UserRound } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { LeadAvatar } from '../components/Avatar'
import { EmptyState } from '../components/EmptyState'
import { useConversation } from '../lib/ConversationContext'
import { useData } from '../lib/DataContext'
import {
  actorMember,
  buildFollowUpWorkItems,
  businessDateKey,
  campaignSummary,
  followUpBucket,
  followUpDueLabel,
  latestConversationMessageMap,
  messageSnippet,
} from '../lib/followUps'
import { instanceName } from '../lib/leads'
import { shortDate } from '../lib/format'
import { useFollowUpActions } from '../lib/useFollowUpActions'
import type { FollowUpBucket, FollowUpWorkItem } from '../lib/followUps'

const GROUPS: Array<{ id: Exclude<FollowUpBucket, 'unscheduled'>; label: string }> = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'upcoming', label: 'Upcoming' },
]

export function FollowUps() {
  const { data } = useData()
  const { openConversation } = useConversation()
  const { actor, setActor, members } = useFollowUpActions()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState(params.get('q') ?? '')

  const me = actorMember(actor, members)
  const owner = params.get('owner') ?? (me ? String(me.id) : 'all')
  const inst = params.get('inst') ?? 'all'
  const camp = params.get('camp') ?? 'all'

  const items = useMemo(
    () => buildFollowUpWorkItems(data?.leads ?? [], data?.followUpStates ?? []),
    [data?.leads, data?.followUpStates],
  )
  const latest = useMemo(
    () => latestConversationMessageMap(data?.latestConversationMessages ?? []),
    [data?.latestConversationMessages],
  )

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    // With no owner parameter the queue defaults to the selected "Who am I".
    // Preserve an explicit `owner=all` so the user can actually override that
    // default and inspect the whole team's work.
    if (key === 'owner' && value === 'all') next.set(key, value)
    else if (value === 'all' || !value) next.delete(key)
    else next.set(key, value)
    if (key === 'inst') next.delete('camp')
    setParams(next, { replace: true })
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return items.filter((item) => {
      if (owner === 'unassigned') {
        if (item.state.owner_id != null) return false
      } else if (owner !== 'all' && String(item.state.owner_id) !== owner) return false
      if (inst !== 'all' && item.state.instance_id !== inst) return false
      if (camp !== 'all' && !item.leads.some((lead) => lead.campaign_id === camp)) return false
      if (needle) {
        const lead = item.representative
        const haystack = `${lead.full_name ?? ''} ${lead.headline ?? ''} ${lead.company ?? ''}`.toLocaleLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })
  }, [items, owner, inst, camp, query])

  const grouped = useMemo(() => {
    const today = businessDateKey()
    const result = new Map<Exclude<FollowUpBucket, 'unscheduled'>, FollowUpWorkItem[]>()
    for (const group of GROUPS) result.set(group.id, [])
    for (const item of visible) {
      const bucket = followUpBucket(item.state, today)
      if (bucket !== 'unscheduled') result.get(bucket)!.push(item)
    }
    for (const rows of result.values()) {
      rows.sort((a, b) => {
        const due = (a.state.next_follow_up_date ?? '').localeCompare(
          b.state.next_follow_up_date ?? '',
        )
        if (due) return due
        return (a.representative.full_name ?? '').localeCompare(
          b.representative.full_name ?? '',
        )
      })
    }
    return result
  }, [visible])

  if (!data) return null

  const campaignName = (id: string) =>
    data.campaigns.find((campaign) => campaign.campaign_id === id)?.campaign_name ?? id
  const ownerName = (id: number | null) =>
    id == null ? 'Unassigned' : members.find((member) => member.id === id)?.name ?? 'Unassigned'
  const campaignOptions = data.campaigns.filter(
    (campaign) => inst === 'all' || campaign.instance_id === inst,
  )

  return (
    <>
      <header>
        <div>
          <h1>Follow-ups</h1>
          <div className="muted small">
            One daily queue per LinkedIn conversation · Europe/Madrid business dates
          </div>
        </div>
        <label className="filter-field">
          <span className="filter-label">Who am I</span>
          <select value={actor} onChange={(event) => setActor(event.target.value)}>
            <option value="">— pick —</option>
            {members.filter((member) => member.active).map((member) => (
              <option key={member.id} value={member.name}>{member.name}</option>
            ))}
          </select>
        </label>
      </header>

      {!data.followUpsAvailable ? (
        <EmptyState
          className="card"
          icon={CalendarCheck2}
          title="Follow-ups need a database upgrade"
          hint="Apply migration 046, then refresh this page. The rest of the dashboard remains available."
        />
      ) : (
        <>
          <div className="filter-bar card follow-filter-bar">
            <label className="filter-field filter-field-grow">
              <span className="filter-label">Search</span>
              <span className="follow-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  placeholder="Name, headline, company…"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </span>
            </label>
            <label className="filter-field">
              <span className="filter-label">Task owner</span>
              <select value={owner} onChange={(event) => setFilter('owner', event.target.value)}>
                <option value="all">All owners</option>
                <option value="unassigned">Unassigned</option>
                {members.map((member) => (
                  <option key={member.id} value={String(member.id)}>{member.name}</option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span className="filter-label">Account</span>
              <select value={inst} onChange={(event) => setFilter('inst', event.target.value)}>
                <option value="all">All accounts</option>
                {data.instances.map((instance) => (
                  <option key={instance.id} value={instance.id}>{instanceName(instance)}</option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span className="filter-label">Campaign</span>
              <select value={camp} onChange={(event) => setFilter('camp', event.target.value)}>
                <option value="all">All campaigns</option>
                {campaignOptions.map((campaign) => (
                  <option key={campaign.campaign_id} value={campaign.campaign_id}>
                    {campaign.campaign_name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              className="card"
              icon={CalendarCheck2}
              title={items.length ? 'No follow-ups match these filters' : 'No follow-ups scheduled'}
              hint={
                items.length
                  ? 'Try another owner, account, campaign, or search.'
                  : 'Open a lead conversation and schedule its first follow-up.'
              }
            />
          ) : (
            <div className="follow-groups">
              {GROUPS.map((group) => {
                const rows = grouped.get(group.id) ?? []
                if (!rows.length) return null
                return (
                  <section className={`follow-group ${group.id}`} key={group.id}>
                    <div className="follow-group-head">
                      <h2>{group.label}</h2>
                      <span className="follow-count">{rows.length}</span>
                    </div>
                    <div className="follow-list">
                      {rows.map((item) => {
                        const lead = item.representative
                        const message = latest.get(item.key)
                        const name =
                          lead.full_name ??
                          lead.profile_url.replace('https://www.linkedin.com/in/', '')
                        return (
                          <article className="card follow-item" key={item.key}>
                            <button
                              type="button"
                              className="follow-item-open"
                              onClick={() => openConversation(lead, { mode: 'follow_up' })}
                              aria-label={`Open follow-up for ${name}`}
                            >
                              <LeadAvatar lead={lead} size={38} />
                              <span className="follow-item-main">
                                <span className="follow-item-name">{name}</span>
                                <span className="muted small ellipsis">
                                  {[lead.headline, lead.company].filter(Boolean).join(' · ') || '—'}
                                </span>
                              </span>
                            </button>
                            <div className="follow-item-context">
                              <span className={`follow-due ${group.id}`}>
                                {followUpDueLabel(item.state)}
                              </span>
                              <span className="follow-owner">
                                <UserRound size={13} aria-hidden="true" />
                                {ownerName(item.state.owner_id)}
                              </span>
                              <span className="muted small ellipsis" title={campaignSummary(item.leads, campaignName)}>
                                {campaignSummary(item.leads, campaignName)}
                              </span>
                              <span className="muted small">
                                {instanceName(
                                  data.instances.find((instance) => instance.id === item.state.instance_id),
                                  item.state.instance_id,
                                )}
                              </span>
                            </div>
                            <div className="follow-item-message">
                              {message ? (
                                <>
                                  <span className={`follow-direction ${message.direction}`}>
                                    {message.direction === 'in' ? 'Them' : 'Us'}
                                  </span>
                                  <span className="ellipsis" title={message.body}>
                                    {messageSnippet(message.body)}
                                  </span>
                                  <span className="muted small">{shortDate(message.sent_at)}</span>
                                </>
                              ) : (
                                <span className="muted small">No message history</span>
                              )}
                            </div>
                            <div className="follow-item-actions">
                              <a
                                className="link-btn"
                                href={lead.profile_url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                LinkedIn <ExternalLink size={12} />
                              </a>
                              <button
                                className="btn accent sm"
                                onClick={() => openConversation(lead, { mode: 'follow_up' })}
                              >
                                Open follow-up
                              </button>
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
            </div>
          )}
        </>
      )}
    </>
  )
}
