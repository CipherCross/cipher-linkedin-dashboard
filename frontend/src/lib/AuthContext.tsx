/**
 * Who is signed in.
 *
 * The self-hosted identity provider (`/api/identity`, an HttpOnly session
 * cookie) is the only authenticator. Nothing is held in the browser: the
 * session is read from the server, and so is the authority.
 *
 * - **Where `role` comes from.** The resolver's answer in `session.current`,
 *   read from `public.team_members` — never the cookie, never the roster row
 *   the UI happens to be showing. `isAdmin` is derived from the session for
 *   that reason, so a stale or unreadable roster cannot widen anyone's access.
 * - **Password setting.** Invitation and recovery links carry a one-time token
 *   in the hash and are answered by the `/reset-password` screen, which spends
 *   the token directly — before this gate, with no session involved.
 * - **`unavailable`.** The auth service being down is not the same as being
 *   signed out, and rendering it as a sign-in form asks someone to retype
 *   their password at a server that will not answer. On a revalidation it is
 *   softer still — an already-ready session stays ready and the error is
 *   surfaced beside it, because a blip must not evict a working session.
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
import { AuthCard, AuthForm, AuthMessage, AuthState } from '../components/AuthCard'
import { Button, TextField } from '../ui'
import { useVisibleInterval } from './useVisibleInterval'
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
import type { TeamMember } from './types'

export type AuthStatus =
  | 'initializing'
  | 'signed_out'
  | 'unauthorized'
  | 'unavailable'
  | 'ready'

/** `id` is the identity provider's subject, never a canonical
 *  `public.users.id`. */
export interface AuthUser {
  readonly id: string
  readonly email: string | null
}

export interface AuthContextValue {
  status: AuthStatus
  user: AuthUser | null
  member: TeamMember | null
  isAdmin: boolean
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
  signOut: () => Promise<void>
  revalidate: () => Promise<void>
}

/** Exported so rendering tests can supply a fixed session state. */
export const AuthContext = createContext<AuthContextValue | null>(null)
/**
 * Re-check the session every minute and whenever the tab is looked at again.
 *
 * Membership and role live in the database and can be revoked while a tab sits
 * open, and a session cookie does not notice that on its own.
 */
function useSessionHeartbeat(status: AuthStatus, revalidate: () => Promise<void>) {
  useVisibleInterval(revalidate, status === 'ready' ? 60_000 : null)
}

export function AuthProvider({ children }: { children: ReactNode }) {
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
      user: session ? { id: session.subject, email: null } : null,
      member,
      // From the session, never from `member`: the roster is display data and
      // may be stale or absent, while this is the resolver's own answer.
      isAdmin: session?.role === 'admin',
      error,
      signIn,
      requestPasswordReset,
      signOut,
      revalidate,
    }),
    [
      error,
      member,
      requestPasswordReset,
      revalidate,
      session,
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

  return (
    <AuthCard>
      {auth.status === 'initializing' && (
        <AuthState title="Checking your session…">
          <div className="w-7 h-7 border-[3px] border-app-border border-t-app-accent rounded-full animate-[auth-spin_0.8s_linear_infinite]" aria-hidden="true" />
        </AuthState>
      )}

      {auth.status === 'unavailable' && (
        <AuthState
          title="Sign-in is unavailable"
          description="We couldn’t check your session. See the details below, then try again once the service is available."
        >
          {auth.error && <AuthMessage tone="danger">{auth.error}</AuthMessage>}
          <Button block onClick={() => void auth.revalidate()}>Try again</Button>
        </AuthState>
      )}

      {auth.status === 'unauthorized' && (
        <AuthState
          title="Access isn’t active"
          description={auth.error ??
            'Your login is not linked to an active teammate. Ask an admin to update your access.'}
        >
          {auth.user?.email && <div className="w-fit px-app-md py-app-sm rounded-control bg-app-surface-2 text-app-text-secondary text-app-table">{auth.user.email}</div>}
          <Button block onClick={() => void auth.signOut()}>Sign out</Button>
        </AuthState>
      )}

      {auth.status === 'signed_out' && mode === 'login' && (
        <AuthForm
          title="Sign in"
          description="Use the email address your admin invited."
          error={localError ?? auth.error}
          onSubmit={submitLogin}
        >
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPasswordValue(event.target.value)}
            required
          />
          <Button variant="primary" block type="submit" loading={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <Button
            variant="ghost"
            className="self-center"
            onClick={() => {
              setMode('forgot')
              setLocalError(null)
            }}
          >
            Forgot password?
          </Button>
        </AuthForm>
      )}

      {auth.status === 'signed_out' && mode === 'forgot' && (
        <AuthForm
          title="Reset password"
          description="We’ll email a one-time recovery link if your invitation exists."
          error={localError}
          onSubmit={submitReset}
        >
          {message && <AuthMessage tone="success">{message}</AuthMessage>}
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <Button variant="primary" block type="submit" loading={busy}>
            {busy ? 'Sending…' : 'Send recovery link'}
          </Button>
          <Button
            variant="ghost"
            className="self-center"
            onClick={() => {
              setMode('login')
              setMessage(null)
              setLocalError(null)
            }}
          >
            Back to sign in
          </Button>
        </AuthForm>
      )}
    </AuthCard>
  )
}
