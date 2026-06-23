import { NavLink, Outlet } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import { useAuth, type AppRole } from '../lib/auth'

// `min` gates a nav link to a role; links without it are visible to everyone
// who is signed in (viewer+).
const LINKS: { to: string; label: string; end?: boolean; min?: AppRole }[] = [
  { to: '/', label: 'Overview', end: true },
  { to: '/leads', label: 'Leads' },
  { to: '/replies', label: 'Replies' },
  { to: '/health', label: 'Health' },
  { to: '/chat', label: 'Chat', min: 'member' },
  { to: '/members', label: 'Members', min: 'admin' },
]

export function Layout() {
  const { data, loading } = useData()
  const { role, hasRole, session, signOut } = useAuth()

  return (
    <div className="page">
      <nav className="topnav">
        <span className="brand">LinkedIn Campaigns</span>
        {LINKS.filter((l) => !l.min || hasRole(l.min)).map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) => (isActive ? 'navlink active' : 'navlink')}
          >
            {l.label}
          </NavLink>
        ))}
        <span className="topnav-spacer" />
        <span className="muted small topnav-user">
          {session?.user?.email} · {role}
        </span>
        <button className="link-btn" onClick={() => signOut()}>
          Sign out
        </button>
      </nav>

      {data?.error && <div className="banner">Supabase error: {data.error}</div>}

      {loading || !data ? <div className="center muted">Loading…</div> : <Outlet />}
    </div>
  )
}
