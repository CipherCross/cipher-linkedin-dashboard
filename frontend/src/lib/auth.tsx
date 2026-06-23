import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

// RBAC: viewer < member < admin < owner. The role is read from the `user_role`
// claim stamped into the access token by the Custom Access Token hook
// (migrations/014_auth_rbac.sql), so the UI can gate features without an extra
// request. The server independently re-checks the same claim on every /api call.
export type AppRole = 'owner' | 'admin' | 'member' | 'viewer'

const RANK: Record<AppRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }

function decodeRole(session: Session | null): AppRole {
  if (!session?.access_token) return 'viewer'
  try {
    const [, payload] = session.access_token.split('.')
    // base64url → base64 with padding before atob.
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const claims = JSON.parse(atob(padded))
    const r = claims.user_role
    if (r === 'owner' || r === 'admin' || r === 'member' || r === 'viewer') return r
  } catch {
    /* malformed token → least privilege */
  }
  return 'viewer'
}

interface AuthState {
  session: Session | null
  role: AppRole
  loading: boolean
  configured: boolean
  hasRole: (min: AppRole) => boolean
  token: () => string | null
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthState>({
  session: null,
  role: 'viewer',
  loading: true,
  configured: false,
  hasRole: () => false,
  token: () => null,
  signIn: async () => ({ error: 'not configured' }),
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const configured = supabase != null

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const role = useMemo(() => decodeRole(session), [session])

  const hasRole = useCallback((min: AppRole) => RANK[role] >= RANK[min], [role])
  const token = useCallback(() => session?.access_token ?? null, [session])

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) return { error: 'Supabase is not configured.' }
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error?.message ?? null }
  }, [])

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut()
  }, [])

  const value: AuthState = { session, role, loading, configured, hasRole, token, signIn, signOut }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useAuth = () => useContext(Ctx)
