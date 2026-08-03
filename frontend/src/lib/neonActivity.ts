/**
 * Client for the S12 Neon slice (`GET /api/activity-daily`).
 *
 * Deliberately standalone: it does not go through `DataContext`, because S12 is
 * one slice beside the existing Supabase path and S13 owns the `DataContext`
 * migration. Nothing here changes what the rest of the dashboard reads.
 */

import { authFetch } from './api'
import type { DailyActivity } from './types'
import type { DateRange } from './leads'

export interface NeonActivityPage {
  activity: DailyActivity[]
  nextCursor: string | null
  hasMore: boolean
}

/** Guard against a server bug turning into an unbounded client loop. */
const MAX_PAGES = 50

/**
 * Fetch one page. `range` uses the same inclusive `[from, to]` UTC day strings
 * as `presetRanges`; the server converts them to a half-open instant range.
 */
export async function fetchNeonActivityPage(
  instanceId: string,
  range: DateRange,
  cursor: string | null = null,
  limit?: number,
): Promise<NeonActivityPage> {
  const params = new URLSearchParams({ instance_id: instanceId })
  if (range.from) params.set('from', range.from)
  if (range.to) params.set('to', range.to)
  if (cursor) params.set('cursor', cursor)
  if (limit !== undefined) params.set('limit', String(limit))

  const res = await authFetch(`/api/activity-daily?${params.toString()}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed (${res.status})`)
  }
  return (await res.json()) as NeonActivityPage
}

/**
 * Walk every page. The daily series exceeds the 1000-row page cap over a long
 * range, so following the cursor is the normal case, not an edge case.
 */
export async function fetchAllNeonActivity(
  instanceId: string,
  range: DateRange,
  limit?: number,
): Promise<{ activity: DailyActivity[]; pages: number }> {
  const activity: DailyActivity[] = []
  let cursor: string | null = null
  let pages = 0

  do {
    const page = await fetchNeonActivityPage(instanceId, range, cursor, limit)
    activity.push(...page.activity)
    cursor = page.hasMore ? page.nextCursor : null
    pages++
  } while (cursor && pages < MAX_PAGES)

  return { activity, pages }
}
