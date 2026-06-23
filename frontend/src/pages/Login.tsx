import { useState } from 'react'
import { useAuth } from '../lib/auth'

// Sign-in screen. Public signup is disabled per project (invite-only), so this is
// password-only; admins create accounts from the Members page.
export function Login() {
  const { signIn, configured } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setErr(null)
    const { error } = await signIn(email.trim(), password)
    if (error) setErr(error)
    setBusy(false)
  }

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <h1 className="login-title">LinkedIn Campaigns</h1>
        <div className="muted small login-sub">Sign in to your team dashboard.</div>

        {!configured && (
          <div className="banner">
            Dashboard not configured — runtime config (Supabase URL + anon key) is missing.
          </div>
        )}

        <label className="login-field">
          <span className="config-label">Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!configured || busy}
            autoFocus
            required
          />
        </label>

        <label className="login-field">
          <span className="config-label">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={!configured || busy}
            required
          />
        </label>

        {err && <div className="banner">{err}</div>}

        <button className="btn-accent login-submit" type="submit" disabled={!configured || busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
