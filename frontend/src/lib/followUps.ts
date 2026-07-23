import type {
  ConversationLatestMessage,
  FollowUpState,
  Lead,
  TeamMember,
} from './types'

export const FOLLOW_UP_TIME_ZONE = 'Europe/Madrid'

export type FollowUpBucket = 'overdue' | 'today' | 'upcoming' | 'unscheduled'

export interface FollowUpWorkItem {
  key: string
  state: FollowUpState
  leads: Lead[]
  representative: Lead
}

export const followUpKey = (instanceId: string, profileUrl: string) =>
  `${instanceId}|${profileUrl}`

export function businessDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: FOLLOW_UP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function dateOrdinal(value: string): number {
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day) / 86_400_000
}

export function activeFollowUp(state: FollowUpState | null | undefined): boolean {
  return !!state?.next_follow_up_date && !state.archived_at
}

export function followUpBucket(
  state: FollowUpState | null | undefined,
  today = businessDateKey(),
): FollowUpBucket {
  if (!activeFollowUp(state)) return 'unscheduled'
  const due = state!.next_follow_up_date!
  if (due < today) return 'overdue'
  if (due === today) return 'today'
  return 'upcoming'
}

export function formatCalendarDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: year === Number(businessDateKey().slice(0, 4)) ? undefined : 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}

export function followUpDueLabel(
  state: FollowUpState | null | undefined,
  today = businessDateKey(),
): string {
  if (!activeFollowUp(state)) return 'No follow-up'
  const due = state!.next_follow_up_date!
  const diff = dateOrdinal(due) - dateOrdinal(today)
  if (diff === 0) return 'Today'
  if (diff === -1) return '1 day overdue'
  if (diff < 0) return `${Math.abs(diff)} days overdue`
  if (diff === 1) return 'Tomorrow'
  return formatCalendarDate(due)
}

export function followUpStateMap(states: FollowUpState[]): Map<string, FollowUpState> {
  return new Map(states.map((state) => [followUpKey(state.instance_id, state.profile_url), state]))
}

export function latestConversationMessageMap(
  rows: ConversationLatestMessage[],
): Map<string, ConversationLatestMessage> {
  return new Map(rows.map((row) => [followUpKey(row.instance_id, row.profile_url), row]))
}

function activityTimestamp(lead: Lead): string {
  const timestamps = [
    lead.added_at,
    lead.invited_at,
    lead.connected_at,
    lead.first_message_at,
    lead.replied_at,
    lead.last_action_at,
  ]
    .filter((value): value is string => !!value)
    .sort()
  return timestamps[timestamps.length - 1] ?? ''
}

function compareRepresentative(a: Lead, b: Lead, ownerId: number | null): number {
  const aOwner = a.assigned_to === ownerId ? 1 : 0
  const bOwner = b.assigned_to === ownerId ? 1 : 0
  if (aOwner !== bOwner) return bOwner - aOwner
  const activity = activityTimestamp(b).localeCompare(activityTimestamp(a))
  if (activity) return activity
  const campaign = a.campaign_id.localeCompare(b.campaign_id)
  return campaign || a.id.localeCompare(b.id)
}

/** Deduplicate active tasks by LinkedIn conversation while keeping a stable lead
 *  representative for identity/campaign metadata. */
export function buildFollowUpWorkItems(
  leads: Lead[],
  states: FollowUpState[],
): FollowUpWorkItem[] {
  const leadsByConversation = new Map<string, Lead[]>()
  for (const lead of leads) {
    const key = followUpKey(lead.instance_id, lead.profile_url)
    const rows = leadsByConversation.get(key)
    if (rows) rows.push(lead)
    else leadsByConversation.set(key, [lead])
  }

  const items: FollowUpWorkItem[] = []
  for (const state of states) {
    if (!activeFollowUp(state)) continue
    const key = followUpKey(state.instance_id, state.profile_url)
    const matching = leadsByConversation.get(key)
    if (!matching?.length) continue
    const ordered = [...matching].sort((a, b) => compareRepresentative(a, b, state.owner_id))
    items.push({ key, state, leads: ordered, representative: ordered[0] })
  }
  return items
}

export function actorMember(actor: string, members: TeamMember[]): TeamMember | undefined {
  const normalized = actor.trim().toLocaleLowerCase()
  return normalized
    ? members.find((member) => member.name.trim().toLocaleLowerCase() === normalized)
    : undefined
}

export function campaignSummary(
  leads: Lead[],
  campaignName: (campaignId: string) => string,
): string {
  const campaigns = [...new Set(leads.map((lead) => lead.campaign_id))]
    .map((id) => ({ id, name: campaignName(id) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  if (campaigns.length <= 2) return campaigns.map((campaign) => campaign.name).join(' · ')
  return `${campaigns.slice(0, 2).map((campaign) => campaign.name).join(' · ')} · +${campaigns.length - 2}`
}

export function messageSnippet(body: string | null | undefined, max = 120): string {
  const normalized = (body ?? '').replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}
