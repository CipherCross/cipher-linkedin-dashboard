import type { DailyActivity, Lead, OverviewAnalytics, OverviewAnalyticsAccount, OverviewAnalyticsTotals } from './types'
import { previousRange, tsInRange, type DateRange } from './leads'

type Person = {
  instance_id: string
  profile_url: string
  added_at: string | null
  invited_at: string | null
  connected_at: string | null
  first_message_at: string | null
  replied_at: string | null
}

const utc = (value: string | null): string | null => value ? new Date(value).toISOString() : null

const earliest = (values: Array<string | null>): string | null => {
  const present = values.filter((value): value is string => Boolean(value))
  return present.length
    ? utc(present.reduce((best, value) => new Date(value).getTime() < new Date(best).getTime() ? value : best))
    : null
}

function peopleFromLeads(leads: Lead[]): Person[] {
  const byKey = new Map<string, Person>()
  for (const lead of leads) {
    const key = `${lead.instance_id}|${lead.profile_url}`
    const previous = byKey.get(key)
    if (!previous) {
      byKey.set(key, {
        instance_id: lead.instance_id,
        profile_url: lead.profile_url,
        added_at: utc(lead.added_at),
        invited_at: utc(lead.invited_at),
        connected_at: utc(lead.connected_at),
        first_message_at: utc(lead.first_message_at),
        replied_at: utc(lead.replied_at),
      })
      continue
    }
    previous.added_at = earliest([previous.added_at, lead.added_at])
    previous.invited_at = earliest([previous.invited_at, lead.invited_at])
    previous.connected_at = earliest([previous.connected_at, lead.connected_at])
    previous.first_message_at = earliest([previous.first_message_at, lead.first_message_at])
    previous.replied_at = earliest([previous.replied_at, lead.replied_at])
  }
  return [...byKey.values()]
}

const effectiveAddedAt = (person: Person): string | null =>
  person.added_at ?? earliest([
    person.invited_at,
    person.connected_at,
    person.first_message_at,
    person.replied_at,
  ])

function totalsFor(people: Person[], range: DateRange | null): OverviewAnalyticsTotals {
  const inPeriod = (ts: string | null) => Boolean(ts) && (range === null || tsInRange(ts, range))
  const allTime = range === null || (range.from === null && range.to === null)
  const included = allTime
    ? people
    : people.filter((person) => inPeriod(effectiveAddedAt(person)))
  let invited = 0, connected = 0, messaged = 0, replied = 0
  let acceptedOfInvited = 0, repliedOfConnected = 0
  // Milestone activity uses each person's earliest recorded timestamp.
  // Only the leads-added count is scoped by effective added date.
  for (const person of people) {
    if (inPeriod(person.invited_at)) invited++
    if (inPeriod(person.connected_at)) {
      connected++
      if (person.invited_at) acceptedOfInvited++
    }
    if (inPeriod(person.first_message_at)) messaged++
    if (inPeriod(person.replied_at)) {
      replied++
      if (person.connected_at) repliedOfConnected++
    }
  }
  return { leads: included.length, invited, connected, messaged, replied, acceptedOfInvited, repliedOfConnected }
}

function activityFor(people: Person[], range: DateRange): DailyActivity[] {
  const rows = new Map<string, DailyActivity>()
  const add = (person: Person, timestamp: string | null, event_type: string) => {
    if (!timestamp || !tsInRange(timestamp, range)) return
    const day = new Date(timestamp).toISOString().slice(0, 10)
    const key = `${day}|${person.instance_id}|${event_type}`
    const row = rows.get(key) ?? { day, instance_id: person.instance_id, event_type, cnt: 0 }
    row.cnt++
    rows.set(key, row)
  }
  for (const person of people) {
    add(person, person.invited_at, 'invited')
    add(person, person.connected_at, 'connected')
    add(person, person.replied_at, 'replied')
  }
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.instance_id.localeCompare(b.instance_id) || a.event_type.localeCompare(b.event_type))
}

export function buildOverviewAnalytics(leads: Lead[], range: DateRange): OverviewAnalytics {
  const people = peopleFromLeads(leads)
  const previous = previousRange(range)
  const accounts = [...new Set(people.map((person) => person.instance_id))].sort().map((instance_id): OverviewAnalyticsAccount => {
    const scoped = people.filter((person) => person.instance_id === instance_id)
    return {
      instance_id,
      totals: totalsFor(scoped, range),
      previous: previous ? totalsFor(scoped, previous) : null,
      lifetime: totalsFor(scoped, null),
    }
  })
  return {
    totals: totalsFor(people, range),
    previous: previous ? totalsFor(people, previous) : null,
    lifetime: totalsFor(people, null),
    accounts,
    activity: activityFor(people, range),
  }
}
