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

/** The candidate's own floor. Stated here so the refusal is immediate. */
const MINIMUM_LENGTH = 8

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
    <div className="auth-screen">
      <div className="card auth-card">
        <Logo />
        {done ? (
          <>
            <h1>Password set</h1>
            <p className="muted">You can sign in with it now.</p>
            <a className="button" href="#/">
              Go to sign in
            </a>
          </>
        ) : (
          <form onSubmit={submit}>
            <h1>Choose a password</h1>
            <p className="muted">
              This link works once. Set a password and use it to sign in.
            </p>
            <label htmlFor="reset-password">New password</label>
            <input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              required
            />
            <label htmlFor="reset-password-confirm">Repeat it</label>
            <input
              id="reset-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy}
              required
            />
            {error === null ? null : (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy}>
              {busy ? 'Setting…' : 'Set password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
