import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { supabase } from './supabase'
import type { DashboardData, Lead } from './types'

const EMPTY: DashboardData = {
  instances: [],
  campaigns: [],
  activity: [],
  leads: [],
  syncRuns: [],
  messages: [],
  annotations: [],
  steps: [],
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

const Ctx = createContext<{ data: DashboardData | null; loading: boolean }>({
  data: null,
  loading: true,
})

export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
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
        const [instances, campaigns, activity, syncRuns, messages, annotations, steps, leads] =
          await Promise.all([
            supabase
              .from('instances')
              .select('id,label,last_sync_at,agent_version,account_name,account_url,account_avatar')
              .order('id'),
            supabase.from('campaign_metrics').select('*').order('campaign_name'),
            supabase.from('daily_activity').select('*').gte('day', since),
            supabase
              .from('sync_runs')
              .select('id,instance_id,started_at,finished_at,status,rows_upserted,error')
              .order('started_at', { ascending: false })
              .limit(200),
            supabase
              .from('messages')
              .select('id,instance_id,campaign_id,profile_url,direction,body,sent_at')
              .gte('sent_at', since)
              .order('sent_at', { ascending: false })
              .limit(2000),
            supabase.from('annotations').select('*').order('noted_at'),
            supabase
              .from('campaign_steps')
              .select('*')
              .order('campaign_id')
              .order('step_index'),
            fetchAllLeads(),
          ])
        if (cancelled) return
        const error =
          instances.error ?? campaigns.error ?? activity.error ??
          syncRuns.error ?? messages.error ?? annotations.error ?? steps.error
        setData(
          error
            ? { ...EMPTY, error: error.message }
            : {
                instances: instances.data ?? [],
                campaigns: campaigns.data ?? [],
                activity: activity.data ?? [],
                syncRuns: syncRuns.data ?? [],
                messages: messages.data ?? [],
                annotations: annotations.data ?? [],
                steps: steps.data ?? [],
                leads,
              },
        )
      } catch (e) {
        if (!cancelled)
          setData({ ...EMPTY, error: e instanceof Error ? e.message : String(e) })
      }
      setLoading(false)
    }
    load()
    const timer = setInterval(load, 5 * 60_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return <Ctx.Provider value={{ data, loading }}>{children}</Ctx.Provider>
}

export const useData = () => useContext(Ctx)
