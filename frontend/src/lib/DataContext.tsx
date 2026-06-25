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
  'invited_at,connected_at,first_message_at,replied_at,last_action_at'

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

const MESSAGE_COLUMNS =
  'id,instance_id,campaign_id,profile_url,direction,body,sent_at,sentiment,reason,classified_at'

// Inbound replies drive sentiment / positive-reply counts shown beside ALL-TIME
// lead totals, so they must not be windowed — a 90-day / 2000-row cap silently
// undercounts them on busy accounts. Fetch every inbound row (paginated past the
// 1000-row cap); keep outbound to the 90-day window since it's only recent display.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchMessages(since: string): Promise<Message[]> {
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
  await pageThrough(() =>
    supabase!.from('messages').select(MESSAGE_COLUMNS).eq('direction', 'in'))
  await pageThrough(() =>
    supabase!.from('messages').select(MESSAGE_COLUMNS).eq('direction', 'out').gte('sent_at', since))
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

  const load = useCallback(async () => {
    const id = ++reqId.current
    if (!supabase) {
      setData({
        ...EMPTY,
        error:
          'Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.',
      })
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
        setData(
          error
            ? { ...EMPTY, error: error.message }
            : {
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
              },
        )
      } catch (e) {
        if (id === reqId.current)
          setData({ ...EMPTY, error: e instanceof Error ? e.message : String(e) })
      }
      if (id === reqId.current) setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 5 * 60_000)
    return () => clearInterval(timer)
  }, [load])

  return <Ctx.Provider value={{ data, loading, refetch: load }}>{children}</Ctx.Provider>
}

export const useData = () => useContext(Ctx)
