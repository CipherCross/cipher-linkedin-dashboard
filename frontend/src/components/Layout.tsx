import { NavLink, Outlet } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import { ConversationProvider } from '../lib/ConversationContext'

const LINKS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/leads', label: 'Leads' },
  { to: '/replies', label: 'Replies' },
  { to: '/playbook', label: 'Playbook' },
  { to: '/health', label: 'Health' },
  { to: '/chat', label: 'Chat' },
]

export function Layout() {
  const { data, loading } = useData()

  return (
    <div className="page">
      <nav className="topnav">
        <span className="brand">LinkedIn Campaigns</span>
        {LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) => (isActive ? 'navlink active' : 'navlink')}
          >
            {l.label}
          </NavLink>
        ))}
      </nav>

      {data?.error && <div className="banner">Supabase error: {data.error}</div>}

      {loading || !data ? (
        <div className="center muted">Loading…</div>
      ) : (
        <ConversationProvider>
          <Outlet />
        </ConversationProvider>
      )}
    </div>
  )
}
