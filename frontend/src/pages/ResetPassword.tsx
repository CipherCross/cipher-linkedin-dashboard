import { useState, type FormEvent } from 'react'
import { Logo } from '../components/Logo'
import { completePasswordReset } from '../lib/identityAuth'

/** What the recovery link carries, and the route that renders this screen. */
export const RESET_PASSWORD_ROUTE = '/reset-password'
export const RESET_TOKEN_PARAM = 'token'

/**
 * Reads the one-time token out of a hash route like
 * `#/reset-password?token=…`.
 *
 * The hash, not the query string: this is a `HashRouter` deployment, and a
 * token placed before the `#` would be sent to the server on every request for
 * the page — including to any proxy in front of it.
 */
export function resetTokenFromHash(hash: string): string | null {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash
  const [path, query] = withoutHash.split('?')
  if ((path ?? '').replace(/\/+$/, '') !== RESET_PASSWORD_ROUTE) return null
  const token = new URLSearchParams(query ?? '').get(RESET_TOKEN_PARAM)
  return token === null || token.trim() === '' ? null : token
}

/** The product's own floor, matching the invitation screen in `AuthContext`. */
const MINIMUM_LENGTH = 12

/**
 * Leaves the reset screen for the sign-in one.
 *
 * A plain `href="#/"` does nothing here, and the reason is structural: this
 * screen is chosen in `App` from the hash at first render, deliberately ahead of
 * the auth gate, so changing the hash alone re-renders nothing. The document is
 * reloaded so that decision is taken again.
 */
function goToSignIn() {
  window.location.hash = '#/'
  window.location.reload()
}

/**
 * The screen a recovery link opens.
 *
 * It renders *outside* the auth gate, because nobody arriving here can sign in
 * yet — that is the entire point of the link. Every account this platform
 * creates starts with a passphrase nobody knows, so this screen is the only
 * route into a new account, and it did not exist: the invitation pointed at a
 * page the app never had.
 */
export function ResetPassword({ token }: { token: string }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (password.length < MINIMUM_LENGTH) {
      setError(`Use at least ${MINIMUM_LENGTH} characters.`)
      return
    }
    if (password !== confirmation) {
      setError('The two passwords do not match.')
      return
    }
    setBusy(true)
    setError(null)
    const outcome = await completePasswordReset(token, password)
    setBusy(false)
    if (outcome.kind === 'ok') {
      setDone(true)
      return
    }
    setError(outcome.message)
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

        {done ? (
          <div className="auth-state">
            <h1>Password set</h1>
            <p>You can sign in with it now.</p>
            <button className="btn accent" type="button" onClick={goToSignIn}>
              Go to sign in
            </button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <div>
              <h1>Choose a password</h1>
              <p>
                This link works once. Use at least {MINIMUM_LENGTH} characters,
                then sign in with your new password.
              </p>
            </div>
            <label>
              New password
              <input
                type="password"
                autoComplete="new-password"
                minLength={MINIMUM_LENGTH}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                required
              />
            </label>
            <label>
              Repeat it
              <input
                type="password"
                autoComplete="new-password"
                minLength={MINIMUM_LENGTH}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={busy}
                required
              />
            </label>
            {error && (
              <div className="auth-error" role="alert">
                {error}
              </div>
            )}
            <button className="btn accent" disabled={busy} type="submit">
              {busy ? 'Setting…' : 'Set password'}
            </button>
          </form>
        )}
      </section>
    </main>
  )
}
