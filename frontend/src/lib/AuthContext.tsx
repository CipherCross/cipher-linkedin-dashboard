/**
 * Who is signed in, on either of the two authenticators.
 *
 * `deploymentAuthPath()` picks one at startup and the choice is a build-time
 * deployment decision — see `authPath.ts` for why the two must coexist rather
 * than one replacing the other in place. Everything below the context sees one
 * `AuthContextValue` and cannot tell which path produced it; that is the whole
 * point, and it is why `user` is a neutral `{id, email}` rather than Supabase's
 * `User`.
 *
 * What genuinely differs between the two, and is not smoothed over:
 *
 * - **Where `role` comes from.** On the identity path it is the resolver's
 *   answer in `session.current`, read from `public.team_members` — never the
 *   cookie, never the roster row the UI happens to be showing. `isAdmin` is
 *   derived from the session for that reason, so a stale or unreadable roster
 *   cannot widen anyone's access.
 * - **`setting_password`.** A Supabase invite/recovery link lands back on the
 *   SPA with `token_hash` in the query string and the person sets a password
 *   there. The identity path has no such callback and no email delivery — SMTP
 *   is the external gate the spec names for this slice — so that state is
 *   unreachable there and `setPassword` says so instead of pretending.
 * - **`unavailable`.** New, and it belongs to both paths conceptually but only
 *   the identity path can currently reach it: the auth service being down is not
 *   the same as being signed out, and rendering it as a sign-in form asks
 *   someone to retype their password at a server that will not answer. On a
 *   revalidation it is softer still — an already-ready session stays ready and
 *   the error is surfaced beside it, because a blip must not evict a working
 *   session.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import type { EmailOtpType, Session } from '@supabase/supabase-js'
import { Logo } from '../components/Logo'
import { deploymentAuthPath, type AuthPath } from './authPath'
import {
  currentSession as fetchCurrentSession,
  findSelf,
  requestPasswordReset as identityRequestReset,
  signIn as identitySignIn,
  signOut as identitySignOut,
  teamRoster,
  toTeamMember,
  type IdentitySession,
} from './identityAuth'
import { leadPhotoUrls } from './leadPhotos'
import { supabase } from './supabase'
import type { TeamMember } from './types'

export type AuthStatus =
  | 'initializing'
  | 'signed_out'
  | 'setting_password'
  | 'unauthorized'
  | 'unavailable'
  | 'ready'

/** Provider-neutral. `id` is the authenticator's own subject — a Supabase auth
 *  uuid on one path, the identity provider's subject on the other — and is
 *  never a canonical `public.users.id`. */
export interface AuthUser {
  readonly id: string
  readonly email: string | null
}

interface AuthContextValue {
  status: AuthStatus
  /** Which authenticator answered. Read by `authFetch` and the Team page. */
  authPath: AuthPath
  user: AuthUser | null
  member: TeamMember | null
  isAdmin: boolean
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
  setPassword: (password: string) => Promise<void>
  signOut: () => Promise<void>
  revalidate: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)
const NEEDS_PASSWORD_KEY = 'outreach-deck-needs-password'

function passwordFlag(): string | null {
  try {
    return localStorage.getItem(NEEDS_PASSWORD_KEY)
  } catch {
    return null
  }
}

function setPasswordFlag(userId: string) {
  try {
    localStorage.setItem(NEEDS_PASSWORD_KEY, userId)
  } catch {
    // The set-password screen still works for this tab without persistence.
  }
}

function clearPasswordFlag() {
  try {
    localStorage.removeItem(NEEDS_PASSWORD_KEY)
  } catch {
    // Restricted storage must not block auth.
  }
}

function callbackParams(): { tokenHash: string; type: EmailOtpType } | null {
  const params = new URLSearchParams(window.location.search)
  const tokenHash = params.get('token_hash')
  const rawType = params.get('type')
  if (
    !tokenHash ||
    (rawType !== 'invite' && rawType !== 'recovery')
  ) {
    return null
  }
  return { tokenHash, type: rawType }
}

function clearCallbackParams() {
  const url = new URL(window.location.href)
  url.searchParams.delete('token_hash')
  url.searchParams.delete('type')
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}

/**
 * Re-check the session every minute and whenever the tab is looked at again.
 *
 * Shared by both providers because the reason is the same on both: membership
 * and role live in the database and can be revoked while a tab sits open, and
 * neither a Supabase JWT nor a session cookie notices that on its own.
 */
function useSessionHeartbeat(status: AuthStatus, revalidate: () => Promise<void>) {
  useEffect(() => {
    if (status !== 'ready') return
    const interval = window.setInterval(() => {
      void revalidate()
    }, 60_000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void revalidate()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [revalidate, status])
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Read once per mount: the flag is a build-time constant, and re-reading it
  // per render would only invite the two providers to swap under a live session.
  const [path] = useState<AuthPath>(() => deploymentAuthPath())
  return path === 'identity' ? (
    <IdentityAuthProvider>{children}</IdentityAuthProvider>
  ) : (
    <SupabaseAuthProvider>{children}</SupabaseAuthProvider>
  )
}

// ---------------------------------------------------------------------------
// The identity path — `/api/identity`, an HttpOnly cookie, nothing held here.
// ---------------------------------------------------------------------------

function IdentityAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('initializing')
  const [session, setSession] = useState<IdentitySession | null>(null)
  const [member, setMember] = useState<TeamMember | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const statusRef = useRef<AuthStatus>('initializing')
  const subjectRef = useRef<string | null>(null)

  /**
   * Which hydration is current.
   *
   * Two things make a stale answer possible, and both are ordinary rather than
   * exotic: the heartbeat and the visibility handler can overlap, and — the one
   * that matters — a sign-out can land while a revalidation issued *before* the
   * cookie was cleared is still in flight. That request returns 200, and
   * without this it would re-ready a UI the person has just left. Every write
   * below checks that its own run is still the current one.
   */
  const generation = useRef(0)

  const applyStatus = useCallback((next: AuthStatus) => {
    statusRef.current = next
    setStatus(next)
  }, [])

  const hydrate = useCallback(async () => {
    const run = ++generation.current
    const outcome = await fetchCurrentSession()
    if (!mounted.current || run !== generation.current) return

    if (outcome.kind === 'unavailable') {
      // A live session is not evicted by a service blip; only a first load,
      // which has no session to protect, renders the fault as its own state.
      setError(outcome.message)
      if (statusRef.current !== 'ready') applyStatus('unavailable')
      return
    }

    if (outcome.kind === 'anonymous' || outcome.kind === 'removed') {
      if (subjectRef.current !== null) leadPhotoUrls.clear()
      subjectRef.current = null
      setSession(null)
      setMember(null)
      setError(outcome.kind === 'removed' ? outcome.message : null)
      applyStatus(outcome.kind === 'removed' ? 'unauthorized' : 'signed_out')
      return
    }

    const next = outcome.session
    // A different person in the same tab must not inherit the previous one's
    // signed photo URLs.
    if (subjectRef.current !== null && subjectRef.current !== next.subject) {
      leadPhotoUrls.clear()
      setMember(null)
    }
    subjectRef.current = next.subject
    setSession(next)
    setError(null)
    applyStatus('ready')

    // The roster carries the display name; the session carries the authority.
    // A roster failure therefore costs a name in the sidebar and nothing else,
    // so it is reported rather than escalated into a sign-out.
    const roster = await teamRoster()
    if (!mounted.current || run !== generation.current) return
    if (roster.kind === 'error') {
      setError(`Signed in, but the team directory could not be read: ${roster.message}`)
      return
    }
    const self = findSelf(roster.members, next.actorId)
    setMember(self ? toTeamMember(self) : null)
  }, [applyStatus])

  useEffect(() => {
    mounted.current = true
    void hydrate()
    return () => {
      mounted.current = false
    }
  }, [hydrate])

  const revalidate = useCallback(async () => {
    await hydrate()
  }, [hydrate])

  useSessionHeartbeat(status, revalidate)

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null)
      const result = await identitySignIn(email, password)
      if (result.kind === 'refused') throw new Error(result.message)
      await hydrate()
    },
    [hydrate],
  )

  const requestPasswordReset = useCallback(async (email: string) => {
    const result = await identityRequestReset(email, window.location.origin)
    if (result.kind === 'refused') throw new Error(result.message)
  }, [])

  const setPassword = useCallback(async (_password: string) => {
    void _password
    // Not a stub: there is no recovery session to set a password against on
    // this path, because there is no delivered link to create one. Saying so is
    // the honest surface; silently resolving would look like it had worked.
    throw new Error(
      'Setting a password from a link needs email delivery, which this deployment does not have yet.',
    )
  }, [])

  const signOut = useCallback(async () => {
    // Abandons any hydration already in flight — see `generation`.
    generation.current += 1
    leadPhotoUrls.clear()
    subjectRef.current = null
    setSession(null)
    setMember(null)
    setError(null)
    applyStatus('signed_out')
    await identitySignOut()
  }, [applyStatus])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      authPath: 'identity',
      user: session ? { id: session.subject, email: null } : null,
      member,
      // From the session, never from `member`: the roster is display data and
      // may be stale or absent, while this is the resolver's own answer.
      isAdmin: session?.role === 'admin',
      error,
      signIn,
      requestPasswordReset,
      setPassword,
      signOut,
      revalidate,
    }),
    [
      error,
      member,
      requestPasswordReset,
      revalidate,
      session,
      setPassword,
      signIn,
      signOut,
      status,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// ---------------------------------------------------------------------------
// The Supabase path — unchanged behaviour, and the default everywhere today.
// ---------------------------------------------------------------------------

function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('initializing')
  const [session, setSession] = useState<Session | null>(null)
  const [member, setMember] = useState<TeamMember | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const needsPasswordUser = useRef<string | null>(passwordFlag())
  const sessionUserId = useRef<string | null>(null)

  const hydrate = useCallback(async (nextSession: Session | null) => {
    if (!mounted.current) return
    const changedUser =
      nextSession != null &&
      sessionUserId.current != null &&
      sessionUserId.current !== nextSession.user.id
    sessionUserId.current = nextSession?.user.id ?? null
    setSession(nextSession)
    if (!nextSession || changedUser) {
      setMember(null)
      leadPhotoUrls.clear()
    }
    setError(null)

    if (!nextSession || !supabase) {
      setStatus('signed_out')
      return
    }

    const { data: claimsData, error: claimsError } =
      await supabase.auth.getClaims(nextSession.access_token)
    if (claimsError || claimsData?.claims?.sub !== nextSession.user.id) {
      leadPhotoUrls.clear()
      await supabase.auth.signOut({ scope: 'local' })
      if (!mounted.current) return
      setSession(null)
      setStatus('signed_out')
      setError('Your session expired. Please sign in again.')
      return
    }

    if (
      needsPasswordUser.current === nextSession.user.id ||
      passwordFlag() === nextSession.user.id
    ) {
      leadPhotoUrls.clear()
      setMember(null)
      setStatus('setting_password')
      return
    }

    const { data, error: memberError } = await supabase
      .from('team_members')
      .select('id,name,active,created_at,email,role,auth_user_id')
      .eq('auth_user_id', nextSession.user.id)
      .maybeSingle()

    if (!mounted.current) return
    if (memberError) {
      leadPhotoUrls.clear()
      setMember(null)
      setStatus('unauthorized')
      setError(`Could not verify team access: ${memberError.message}`)
      return
    }
    if (
      !data ||
      data.active !== true ||
      (data.role !== 'member' && data.role !== 'admin')
    ) {
      leadPhotoUrls.clear()
      setMember(null)
      setStatus('unauthorized')
      return
    }

    setMember(data as TeamMember)
    setStatus('ready')
  }, [])

  useEffect(() => {
    mounted.current = true
    if (!supabase) {
      setStatus('signed_out')
      setError(
        'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
      )
      return () => {
        mounted.current = false
      }
    }

    const client = supabase
    const boot = async () => {
      const callback = callbackParams()
      if (callback) {
        const { data, error: verifyError } = await client.auth.verifyOtp({
          token_hash: callback.tokenHash,
          type: callback.type,
        })
        clearCallbackParams()
        if (verifyError || !data.session) {
          if (!mounted.current) return
          setStatus('signed_out')
          setError(
            verifyError?.message ??
              'This invitation or recovery link is invalid or expired.',
          )
          return
        }
        needsPasswordUser.current = data.session.user.id
        setPasswordFlag(data.session.user.id)
        if (!mounted.current) return
        setSession(data.session)
        setStatus('setting_password')
        return
      }

      const { data, error: sessionError } = await client.auth.getSession()
      if (sessionError) {
        if (!mounted.current) return
        setStatus('signed_out')
        setError(sessionError.message)
        return
      }
      await hydrate(data.session)
    }

    void boot()
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY' && nextSession) {
        needsPasswordUser.current = nextSession.user.id
        setPasswordFlag(nextSession.user.id)
      }
      window.setTimeout(() => {
        void hydrate(nextSession)
      }, 0)
    })

    return () => {
      mounted.current = false
      subscription.unsubscribe()
    }
  }, [hydrate])

  const revalidate = useCallback(async () => {
    if (!session) return
    await hydrate(session)
  }, [hydrate, session])

  useSessionHeartbeat(status, revalidate)

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!supabase) throw new Error('Supabase is not configured')
      setError(null)
      const { data, error: signInError } =
        await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (signInError) throw signInError
      await hydrate(data.session)
    },
    [hydrate],
  )

  const requestPasswordReset = useCallback(async (email: string) => {
    if (!supabase) throw new Error('Supabase is not configured')
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
      { redirectTo: `${window.location.origin}/` },
    )
    if (resetError) throw resetError
  }, [])

  const setPassword = useCallback(
    async (password: string) => {
      if (!supabase || !session) throw new Error('No recovery session is active')
      if (password.length < 12) {
        throw new Error('Use at least 12 characters.')
      }
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) throw updateError
      clearPasswordFlag()
      needsPasswordUser.current = null
      const { data } = await supabase.auth.getSession()
      await hydrate(data.session)
    },
    [hydrate, session],
  )

  const signOut = useCallback(async () => {
    clearPasswordFlag()
    needsPasswordUser.current = null
    setMember(null)
    setSession(null)
    setStatus('signed_out')
    if (supabase) await supabase.auth.signOut({ scope: 'global' })
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      authPath: 'supabase',
      user: session?.user
        ? { id: session.user.id, email: session.user.email ?? null }
        : null,
      member,
      isAdmin: member?.role === 'admin',
      error,
      signIn,
      requestPasswordReset,
      setPassword,
      signOut,
      revalidate,
    }),
    [
      error,
      member,
      requestPasswordReset,
      revalidate,
      session?.user,
      setPassword,
      signIn,
      signOut,
      status,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth()
  if (auth.status === 'ready') return <>{children}</>
  return <AuthScreen />
}

function AuthScreen() {
  const auth = useAuth()
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [password, setPasswordValue] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setLocalError(null)
    try {
      await auth.signIn(email, password)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const submitReset = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setLocalError(null)
    try {
      await auth.requestPasswordReset(email)
      setMessage(
        'If that address belongs to an invited teammate, a recovery link is on its way.',
      )
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault()
    setLocalError(null)
    if (password !== confirm) {
      setLocalError('Passwords do not match.')
      return
    }
    setBusy(true)
    try {
      await auth.setPassword(password)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-live="polite">
        <div className="auth-brand">
          <Logo size={34} className="brand-mark" />
          <div>
            <div className="auth-product">Outreach Deck</div>
            <div className="auth-kicker">Team dashboard</div>
          </div>
        </div>

        {auth.status === 'initializing' && (
          <div className="auth-state">
            <div className="auth-spinner" aria-hidden="true" />
            <h1>Checking your session…</h1>
          </div>
        )}

        {auth.status === 'unavailable' && (
          <div className="auth-state">
            <h1>Sign-in is unavailable</h1>
            <p>
              The service that verifies your session could not be reached, so we
              can’t tell whether you are signed in. Nothing has changed about
              your access — try again in a moment.
            </p>
            {auth.error && <div className="auth-error" role="alert">{auth.error}</div>}
            <button className="btn" type="button" onClick={() => void auth.revalidate()}>
              Try again
            </button>
          </div>
        )}

        {auth.status === 'unauthorized' && (
          <div className="auth-state">
            <h1>Access isn’t active</h1>
            <p>
              {auth.error ??
                'Your login is not linked to an active teammate. Ask an admin to update your access.'}
            </p>
            {auth.user?.email && <div className="auth-email">{auth.user.email}</div>}
            <button className="btn" type="button" onClick={() => void auth.signOut()}>
              Sign out
            </button>
          </div>
        )}

        {auth.status === 'setting_password' && (
          <form className="auth-form" onSubmit={submitPassword}>
            <div>
              <h1>Set your password</h1>
              <p>Use at least 12 characters. This finishes your invitation or recovery.</p>
            </div>
            <label>
              New password
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={password}
                onChange={(event) => setPasswordValue(event.target.value)}
                required
              />
            </label>
            <label>
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
              />
            </label>
            {localError && <div className="auth-error" role="alert">{localError}</div>}
            <button className="btn accent" disabled={busy} type="submit">
              {busy ? 'Saving…' : 'Save password'}
            </button>
          </form>
        )}

        {auth.status === 'signed_out' && mode === 'login' && (
          <form className="auth-form" onSubmit={submitLogin}>
            <div>
              <h1>Sign in</h1>
              <p>Use the email address your admin invited.</p>
            </div>
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPasswordValue(event.target.value)}
                required
              />
            </label>
            {(localError || auth.error) && (
              <div className="auth-error" role="alert">{localError ?? auth.error}</div>
            )}
            <button className="btn accent" disabled={busy} type="submit">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button
              className="auth-link"
              type="button"
              onClick={() => {
                setMode('forgot')
                setLocalError(null)
              }}
            >
              Forgot password?
            </button>
          </form>
        )}

        {auth.status === 'signed_out' && mode === 'forgot' && (
          <form className="auth-form" onSubmit={submitReset}>
            <div>
              <h1>Reset password</h1>
              <p>We’ll email a one-time recovery link if your invitation exists.</p>
            </div>
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            {message && <div className="auth-success">{message}</div>}
            {localError && <div className="auth-error" role="alert">{localError}</div>}
            <button className="btn accent" disabled={busy} type="submit">
              {busy ? 'Sending…' : 'Send recovery link'}
            </button>
            <button
              className="auth-link"
              type="button"
              onClick={() => {
                setMode('login')
                setMessage(null)
                setLocalError(null)
              }}
            >
              Back to sign in
            </button>
          </form>
        )}
      </section>
    </main>
  )
}
