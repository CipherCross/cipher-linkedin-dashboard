import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/**
 * `createClient` throws on a malformed URL, and this module is imported at
 * startup, so a placeholder value took the whole app down before any error
 * banner could render. Every consumer already handles a null client, which is
 * the documented behaviour for an unconfigured browser environment — so treat
 * an unusable value the same way a missing one is treated.
 */
const isHttpUrl = (value: string | undefined): value is string => {
  if (!value) return false
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export const supabase: SupabaseClient | null =
  isHttpUrl(url) && anonKey ? createClient(url, anonKey) : null
