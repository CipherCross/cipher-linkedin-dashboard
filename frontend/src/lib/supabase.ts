import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Per-team config is injected at RUNTIME (not baked into the build) so one
// container image can serve any team. The Hono server serves /config.js, which
// sets window.__APP_CONFIG__ before the app boots; in `vite dev` a small plugin
// (see vite.config.ts) serves the same shape from the .env file. We fall back to
// build-time VITE_* vars so a plain `vite build`/`dev` still works locally.
interface AppConfig {
  supabaseUrl?: string
  supabaseAnonKey?: string
}

const runtime: AppConfig =
  (typeof window !== 'undefined' &&
    (window as unknown as { __APP_CONFIG__?: AppConfig }).__APP_CONFIG__) ||
  {}

const url = runtime.supabaseUrl || (import.meta.env.VITE_SUPABASE_URL as string | undefined)
const anonKey =
  runtime.supabaseAnonKey || (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)

export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null
