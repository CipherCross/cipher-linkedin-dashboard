import { useMemo, useState } from 'react'
import { CalendarCheck2 } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { LeadAvatar } from '../components/Avatar'
import { FollowUpRow } from '../components/FollowUpRow'
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
import { accountLabeller } from '../lib/leads'
import { replyDate, REPLY_TIME_ZONE_LABEL } from '../lib/replyTime'
import { useFollowUpActions } from '../lib/useFollowUpActions'
import { Badge, EmptyState, PageHeader, Panel, SectionHeader, SelectField, TextField, Toolbar } from '../ui'
import type { Tone } from '../ui'
import type { FollowUpBucket, FollowUpWorkItem } from '../lib/followUps'

const GROUPS: Array<{ id: Exclude<FollowUpBucket, 'unscheduled'>; label: string; tone: Tone }> = [
  { id: 'overdue', label: 'Overdue', tone: 'danger' },
  { id: 'today', label: 'Today', tone: 'warning' },
  { id: 'upcoming', label: 'Upcoming', tone: 'accent' },
]

/** Open the full manual-review surface without changing the follow-up state. */
export function followUpRepliesHref(
  instanceId: string,
  profileUrl: string,
  focusMessageId: number | null = null,
): string {
  const params = new URLSearchParams({
    view: 'all',
    scope: 'all',
    thread: `${instanceId}|${profileUrl}`,
    instance_id: instanceId,
    profile_url: profileUrl,
  })
  if (focusMessageId != null && Number.isSafeInteger(focusMessageId) && focusMessageId > 0) {
    params.set('focus', String(focusMessageId))
  }
  return `/replies?${params.toString()}`
}

export function FollowUps() {
  const { data } = useData()
  const { openConversation } = useConversation()
  const { actor, members } = useFollowUpActions()
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
    // With no owner parameter the queue defaults to the authenticated teammate.
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
  /* Two accounts and two teammates can share a display name. Where they do,
   * the label carries what tells them apart — one shared formatter for the
   * accounts, so this page and the dropdowns elsewhere agree. */
  const accountLabel = accountLabeller(data.instances)
  const ownerOptionLabel = (member: { id: number; name: string }) =>
    members.filter((candidate) => candidate.name === member.name).length > 1
      ? `${member.name} · #${member.id}`
      : member.name

  return (
    <>
      <PageHeader
        title="Follow-ups"
        description="One daily queue per LinkedIn conversation. Due dates are Madrid business days."
        actions={
          <span className="text-app-meta text-app-text-muted" title="Audit identity comes from your login">
            Working as <strong className="text-app-text font-semibold">{actor}</strong>
          </span>
        }
      />

      {!data.followUpsAvailable ? (
        <Panel>
          <EmptyState
            icon={CalendarCheck2}
            title="Follow-ups need a database upgrade"
            hint="Apply migration 046, then refresh this page. The rest of the dashboard remains available."
          />
        </Panel>
      ) : (
        <>
          {/* Search plus the owner scope stay on the page; account and campaign
              are the only two left, so they stay beside them rather than
              earning a sheet of their own. */}
          <Toolbar className="mb-app-xl">
            <TextField
              className="ui-toolbar__search"
              label="Search follow-ups"
              labelHidden
              type="search"
              value={query}
              placeholder="Name, headline, company…"
              onChange={(event) => setQuery(event.target.value)}
            />
            <SelectField label="Task owner" labelHidden value={owner} onChange={(event) => setFilter('owner', event.target.value)}>
              <option value="all">All owners</option>
              <option value="unassigned">Unassigned</option>
              {members.map((member) => (
                <option key={member.id} value={String(member.id)}>{ownerOptionLabel(member)}</option>
              ))}
            </SelectField>
            <SelectField label="Account" labelHidden value={inst} onChange={(event) => setFilter('inst', event.target.value)}>
              <option value="all">All accounts</option>
              {data.instances.map((instance) => (
                <option key={instance.id} value={instance.id}>{accountLabel(instance.id)}</option>
              ))}
            </SelectField>
            <SelectField label="Campaign" labelHidden value={camp} onChange={(event) => setFilter('camp', event.target.value)}>
              <option value="all">All campaigns</option>
              {campaignOptions.map((campaign) => (
                <option key={campaign.campaign_id} value={campaign.campaign_id}>
                  {campaign.campaign_name}
                </option>
              ))}
            </SelectField>
          </Toolbar>

          {visible.length === 0 ? (
            <Panel>
              <EmptyState
                kind={items.length ? 'no-match' : 'empty'}
                icon={CalendarCheck2}
                title={items.length ? 'No follow-ups match these filters' : 'No follow-ups scheduled'}
                hint={
                  items.length
                    ? 'Try another owner, account, campaign, or search.'
                    : 'Open a lead conversation and schedule its first follow-up.'
                }
              />
            </Panel>
          ) : (
            <div className="flex flex-col gap-app-2xl">
              {GROUPS.map((group) => {
                const rows = grouped.get(group.id) ?? []
                if (!rows.length) return null
                return (
                  <section key={group.id}>
                    <SectionHeader
                      title={group.label}
                      actions={<Badge>{rows.length}</Badge>}
                    />
                    <Panel as="div" className="p-0 overflow-hidden">
                      {rows.map((item) => {
                        const lead = item.representative
                        const message = latest.get(item.key)
                        const name =
                          lead.full_name ??
                          lead.profile_url.replace('https://www.linkedin.com/in/', '')
                        return (
                          <FollowUpRow
                            key={item.key}
                            avatar={<LeadAvatar lead={lead} size={40} />}
                            name={name}
                            subtitle={[lead.headline, lead.company].filter(Boolean).join(' · ') || '—'}
                            dueLabel={followUpDueLabel(item.state)}
                            dueTone={group.tone}
                            owner={ownerName(item.state.owner_id)}
                            campaigns={campaignSummary(item.leads, campaignName)}
                            account={accountLabel(item.state.instance_id)}
                            message={message ? {
                              direction: message.direction === 'in' ? 'in' : 'out',
                              body: message.body,
                              snippet: messageSnippet(message.body),
                              sentAt: message.sent_at,
                              timeLabel: replyDate(message.sent_at),
                              timeTitle: REPLY_TIME_ZONE_LABEL,
                            } : null}
                            linkedinHref={lead.profile_url}
                            repliesTo={followUpRepliesHref(
                              item.state.instance_id,
                              item.state.profile_url,
                              message?.direction === 'in' ? message.message_id : null,
                            )}
                            onOpen={() => openConversation(lead, { mode: 'follow_up' })}
                          />
                        )
                      })}
                    </Panel>
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
