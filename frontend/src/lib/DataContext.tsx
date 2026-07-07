import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { supabase } from './supabase'
import type { DashboardData, Lead, Message } from './types'

const EMPTY: DashboardData = {
  instances: [],
  campaigns: [],
  activity: [],
  leads: [],
  syncRuns: [],
  messages: [],
  annotations: [],
  steps: [],
  briefing: null,
  prevBriefing: null,
}

const LEAD_COLUMNS =
  'id,instance_id,campaign_id,profile_url,full_name,headline,company,' +
  'added_at,invited_at,connected_at,first_message_at,replied_at,last_action_at'

// PostgREST caps responses at 1000 rows; page until a short page comes back.
async function fetchAllLeads(): Promise<Lead[]> {
  const page = 1000
  const all: Lead[] = []
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase!
      .from('leads')
      .select(LEAD_COLUMNS)
      .order('id')
      .range(from, from + page - 1)
    if (error) throw error
    all.push(...((data ?? []) as unknown as Lead[]))
    if (!data || data.length < page) break
  }
  return all
}

const MESSAGE_COLUMNS_BASE =
  'id,instance_id,campaign_id,profile_url,direction,body,sent_at,sentiment,reason,classified_at'
// `source` (migration 026: 'sync' | 'manual') may not exist on the live DB yet.
// Requesting a missing column makes PostgREST 400 the whole query, so fetchMessages
// retries once without it (see below) — pre-migration DBs keep loading, and the
// import callout simply renders nothing.
const MESSAGE_COLUMNS = `${MESSAGE_COLUMNS_BASE},source`

// True only for PostgREST's "undefined column" error (Postgres SQLSTATE 42703),
// i.e. the `source` column doesn't exist yet. supabase-js error shapes vary, so
// also accept a message that names the missing column as a fallback.
function isMissingSourceColumn(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null
  if (err?.code === '42703') return true
  return !!err?.message && /column\s+.*source.*\s+does not exist/i.test(err.message)
}

// Inbound replies drive sentiment / positive-reply counts shown beside ALL-TIME
// lead totals, so they must not be windowed — a 90-day / 2000-row cap silently
// undercounts them on busy accounts. Fetch every inbound row (paginated past the
// 1000-row cap); keep outbound to the 90-day window since it's only recent display.
async function fetchMessages(since: string, columns: string = MESSAGE_COLUMNS): Promise<Message[]> {
  const page = 1000
  const all: Message[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pageThrough = async (build: () => any) => {
    for (let from = 0; ; from += page) {
      const { data, error } = await build()
        .order('sent_at', { ascending: false })
        .range(from, from + page - 1)
      if (error) throw error
      all.push(...((data ?? []) as unknown as Message[]))
      if (!data || data.length < page) break
    }
  }
  try {
    await pageThrough(() =>
      supabase!.from('messages').select(columns).eq('direction', 'in'))
    await pageThrough(() =>
      supabase!.from('messages').select(columns).eq('direction', 'out').gte('sent_at', since))
  } catch (e) {
    // Pre-migration DB has no `source` column → PostgREST 400 with code 42703
    // ("undefined column"). Retry once with the base columns so the dashboard
    // still loads (partial `all` is discarded by the retry). Any OTHER error
    // (network, timeout, RLS, …) must propagate — falling back on those would
    // silently hide the callout and mask a real failure.
    if (columns !== MESSAGE_COLUMNS_BASE && isMissingSourceColumn(e))
      return fetchMessages(since, MESSAGE_COLUMNS_BASE)
    throw e
  }
  all.sort((a, b) => (a.sent_at < b.sent_at ? 1 : a.sent_at > b.sent_at ? -1 : 0))
  return all
}

const Ctx = createContext<{
  data: DashboardData | null
  loading: boolean
  refetch: () => void
}>({
  data: null,
  loading: true,
  refetch: () => {},
})

export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  // Only the most recent load() wins, so a manual refetch can't be clobbered by
  // an in-flight interval load (or vice versa).
  const reqId = useRef(0)

  // Surface an error without wiping on-screen data: keep the last successful
  // load and only stamp the error field. First-load failures (prev === null)
  // still fall back to the empty-with-error state.
  const showError = useCallback((message: string) => {
    setData((prev) => (prev ? { ...prev, error: message } : { ...EMPTY, error: message }))
  }, [])

  const load = useCallback(async () => {
    const id = ++reqId.current
    if (!supabase) {
      showError(
        'Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.',
      )
      setLoading(false)
      return
    }
    try {
        const since = new Date(Date.now() - 90 * 86_400_000)
          .toISOString()
          .slice(0, 10)
        const [instances, campaigns, activity, syncRuns, messages, annotations, steps, briefing, leads] =
          await Promise.all([
            supabase
              .from('instances')
              .select('id,label,last_sync_at,agent_version,account_name,account_url,account_avatar,config,config_updated_at')
              .order('id'),
            supabase.from('campaign_metrics').select('*').order('campaign_name'),
            supabase.from('daily_activity').select('*').gte('day', since),
            supabase
              .from('sync_runs')
              .select('id,instance_id,started_at,finished_at,status,rows_upserted,error')
              .order('started_at', { ascending: false })
              .limit(200),
            fetchMessages(since),
            supabase.from('annotations').select('*').order('noted_at'),
            supabase
              .from('campaign_steps')
              .select('*')
              .order('campaign_id')
              .order('step_index'),
            supabase
              .from('briefings')
              .select('*')
              .order('briefing_date', { ascending: false })
              .limit(2),
            fetchAllLeads(),
          ])
        if (id !== reqId.current) return
        const error =
          instances.error ?? campaigns.error ?? activity.error ??
          syncRuns.error ?? annotations.error ?? steps.error ??
          briefing.error
        if (error) {
          // Query-level failure: keep prior data, just flag the error.
          showError(error.message)
        } else {
          // Success replaces everything with fresh data (no error field),
          // which clears any error left by a previous failed refresh.
          setData({
            instances: instances.data ?? [],
            campaigns: campaigns.data ?? [],
            activity: activity.data ?? [],
            syncRuns: syncRuns.data ?? [],
            messages,
            annotations: annotations.data ?? [],
            steps: steps.data ?? [],
            briefing: briefing.data?.[0] ?? null,
            prevBriefing: briefing.data?.[1] ?? null,
            leads,
          })
        }
      } catch (e) {
        if (id === reqId.current)
          showError(e instanceof Error ? e.message : String(e))
      }
      if (id === reqId.current) setLoading(false)
  }, [showError])

  useEffect(() => {
    load()
    const timer = setInterval(load, 5 * 60_000)
    return () => clearInterval(timer)
  }, [load])

  return <Ctx.Provider value={{ data, loading, refetch: load }}>{children}</Ctx.Provider>
}

export const useData = () => useContext(Ctx)
