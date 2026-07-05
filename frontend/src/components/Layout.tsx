import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  ClipboardCheck,
  BookOpen,
  Activity,
  Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { ConversationProvider } from '../lib/ConversationContext'
import type { Instance } from '../lib/types'
import { ago } from '../lib/format'
import { Logo } from './Logo'
import { PageSkeleton } from './Skeleton'

const LINKS: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/leads', label: 'Leads', icon: Users },
  { to: '/replies', label: 'Replies', icon: MessageSquare },
  { to: '/review', label: 'Review', icon: ClipboardCheck },
  { to: '/playbook', label: 'Playbook', icon: BookOpen },
  { to: '/health', label: 'Health', icon: Activity },
  { to: '/chat', label: 'Chat', icon: Sparkles },
]

// Which loading skeleton best matches the route the user landed on (deep links
// can open any page first). Keeps the first paint shaped like the real page.
function skeletonVariant(pathname: string): 'overview' | 'table' | 'list' | 'simple' {
  if (pathname.startsWith('/leads') || pathname.startsWith('/health') || pathname.startsWith('/review')) return 'table'
  if (pathname.startsWith('/replies')) return 'list'
  if (pathname.startsWith('/playbook') || pathname.startsWith('/chat')) return 'simple'
  return 'overview'
}

export function Layout() {
  const { data, loading } = useData()
  const location = useLocation()

  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar-inner">
          <Link to="/" className="brand" aria-label="Outreach Deck — home">
            <Logo size={26} className="brand-mark" />
            <span className="brand-name">Outreach Deck</span>
          </Link>

          <nav className="topnav" aria-label="Primary">
            {LINKS.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                title={label}
                className={({ isActive }) => (isActive ? 'navlink active' : 'navlink')}
              >
                <Icon size={16} className="navlink-icon" aria-hidden="true" />
                <span className="navlink-label">{label}</span>
              </NavLink>
            ))}
          </nav>

          {data && <SyncChip instances={data.instances} />}
        </div>
      </header>

      <div className="page">
        {data?.error && <div className="banner">Supabase error: {data.error}</div>}

        {loading || !data ? (
          <PageSkeleton variant={skeletonVariant(location.pathname)} />
        ) : (
          <ConversationProvider>
            <Outlet />
          </ConversationProvider>
        )}
      </div>
    </div>
  )
}

/** Worst-case (least fresh) instance decides the header status. Tiers mirror the
 *  Health page: agents run every ~30 min, so <2h is healthy, <24h is aging,
 *  ≥24h (or never synced) is stale. */
function worstFreshness(
  instances: Instance[],
): { level: 'ok' | 'warn' | 'stale'; label: string } {
  if (instances.length === 0) return { level: 'stale', label: 'No accounts' }
  let worstAge = -1
  let worstTs: string | null = null
  let hasNever = false
  for (const i of instances) {
    if (!i.last_sync_at) {
      hasNever = true
      continue
    }
    const age = Date.now() - new Date(i.last_sync_at).getTime()
    if (age > worstAge) {
      worstAge = age
      worstTs = i.last_sync_at
    }
  }
  if (hasNever) return { level: 'stale', label: 'Sync stale' }
  const hours = worstAge / 3_600_000
  const level = hours >= 24 ? 'stale' : hours >= 2 ? 'warn' : 'ok'
  return { level, label: `Synced ${ago(worstTs)}` }
}

function SyncChip({ instances }: { instances: Instance[] }) {
  const { level, label } = worstFreshness(instances)
  return (
    <Link
      to="/health"
      className={`sync-chip ${level}`}
      title="Data freshness — open Sync health"
    >
      <span className="sync-dot" aria-hidden="true" />
      <span className="sync-chip-label">{label}</span>
    </Link>
  )
}
