import { useCallback, useEffect, useState } from 'react'
import { useAuth, type AppRole } from '../lib/auth'

// Admin-only member management. Lists users and lets admins create accounts,
// change roles, and remove members via the role-gated /api/members endpoint.
interface Member {
  id: string
  email: string | null
  role: AppRole
  created_at: string
}

const ROLES: AppRole[] = ['viewer', 'member', 'admin']

export function Members() {
  const { token, session } = useAuth()
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)

  // New-member form
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<AppRole>('viewer')
  const [busy, setBusy] = useState(false)

  const api = useCallback(
    (init?: RequestInit) =>
      fetch('/api/members', {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token() ?? ''}`,
          ...(init?.headers ?? {}),
        },
      }),
    [token],
  )

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api()
      const out = await res.json().catch(() => ({}))
      if (res.ok) setMembers(out.members ?? [])
      else setMsg(out.error ?? `Failed to load (${res.status})`)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    reload()
  }, [reload])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await api({ method: 'POST', body: JSON.stringify({ email: email.trim(), password, role }) })
      const out = await res.json().catch(() => ({}))
      if (res.ok) {
        setEmail('')
        setPassword('')
        setRole('viewer')
        setMsg(`Created ${out.email}.`)
        reload()
      } else {
        setMsg(out.error ?? `Create failed (${res.status})`)
      }
    } finally {
      setBusy(false)
    }
  }

  async function changeRole(id: string, next: AppRole) {
    setMsg(null)
    const res = await api({ method: 'PATCH', body: JSON.stringify({ id, role: next }) })
    const out = await res.json().catch(() => ({}))
    if (res.ok) reload()
    else setMsg(out.error ?? `Update failed (${res.status})`)
  }

  async function remove(id: string, label: string) {
    if (!window.confirm(`Remove ${label}? This deletes their login.`)) return
    setMsg(null)
    const res = await api({ method: 'DELETE', body: JSON.stringify({ id }) })
    const out = await res.json().catch(() => ({}))
    if (res.ok) reload()
    else setMsg(out.error ?? `Remove failed (${res.status})`)
  }

  const selfId = session?.user?.id

  return (
    <>
      <header>
        <div>
          <h1>Members</h1>
          <div className="muted small">Manage who can access this team's dashboard.</div>
        </div>
      </header>

      <div className="card">
        <form className="member-form" onSubmit={create}>
          <input
            type="email"
            placeholder="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="temp password (≥8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <select value={role} onChange={(e) => setRole(e.target.value as AppRole)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button className="btn-accent" type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add member'}
          </button>
        </form>
        {msg && <div className="muted small">{msg}</div>}
      </div>

      <div className="card">
        {loading ? (
          <div className="muted">Loading…</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Added</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isSelf = m.id === selfId
                const isOwner = m.role === 'owner'
                return (
                  <tr key={m.id}>
                    <td>{m.email ?? m.id}</td>
                    <td>
                      {isOwner ? (
                        <span className="muted">owner</span>
                      ) : (
                        <select
                          value={m.role}
                          disabled={isSelf}
                          onChange={(e) => changeRole(m.id, e.target.value as AppRole)}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="muted small">{m.created_at?.slice(0, 10)}</td>
                    <td>
                      {!isSelf && !isOwner && (
                        <button className="link-btn" onClick={() => remove(m.id, m.email ?? m.id)}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
