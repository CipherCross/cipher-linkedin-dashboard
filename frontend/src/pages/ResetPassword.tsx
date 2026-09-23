import { useState, type FormEvent } from 'react'
import { AuthCard, AuthForm, AuthState } from '../components/AuthCard'
import { Button, TextField } from '../ui'
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
    <AuthCard>
      {done ? (
        <AuthState title="Password set" description="You can sign in with it now.">
          <Button variant="primary" block onClick={goToSignIn}>Go to sign in</Button>
        </AuthState>
      ) : (
        <AuthForm
          title="Choose a password"
          description={`This link works once. Use at least ${MINIMUM_LENGTH} characters, then sign in with your new password.`}
          error={error}
          onSubmit={submit}
        >
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            minLength={MINIMUM_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            required
          />
          <TextField
            label="Repeat it"
            type="password"
            autoComplete="new-password"
            minLength={MINIMUM_LENGTH}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={busy}
            required
          />
          <Button variant="primary" block type="submit" loading={busy}>
            {busy ? 'Setting…' : 'Set password'}
          </Button>
        </AuthForm>
      )}
    </AuthCard>
  )
}
