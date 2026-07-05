import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  ClipboardCheck,
  BookOpen,
  Activity,
  Sparkles,
  RotateCw,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { ConversationProvider } from '../lib/ConversationContext'
import type { Instance } from '../lib/types'
import { ago } from '../lib/format'
import { freshnessLevel } from '../lib/freshness'
import { Logo } from './Logo'
import { PageSkeleton } from './Skeleton'
import { ErrorBoundary } from './ErrorBoundary'

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

// Human page name for the current route, derived from the same nav config that
// drives the links. Unlisted routes (campaign/account detail) fall back to null.
function pageName(pathname: string): string | null {
  const link = LINKS.find((l) =>
    l.end ? pathname === l.to : pathname === l.to || pathname.startsWith(`${l.to}/`),
  )
  return link ? link.label : null
}

export function Layout() {
  const { data, loading, refetch } = useData()
  const location = useLocation()

  // Reset scroll + set the document title on every navigation.
  useEffect(() => {
    window.scrollTo(0, 0)
    const name = pageName(location.pathname)
    document.title = name ? `${name} — Outreach Deck` : 'Outreach Deck'
  }, [location.pathname])

  return (
    <div className="app">
      {/* Tier-2 "liquid glass" displacement filter. Referenced from styles.css
          via `backdrop-filter: url(#liquid-glass)` — a Chromium-only path gated
          behind @supports, so Safari/Firefox never reach it. Rendered once,
          zero-size, aria-hidden. Static (no animation): a low-frequency single
          octave of turbulence displaced by a small scale gives a subtle
          refractive edge appropriate for a data dashboard. */}
      <svg
        aria-hidden="true"
        focusable="false"
        width="0"
        height="0"
        style={{ position: 'absolute', width: 0, height: 0 }}
      >
        <filter id="liquid-glass" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.008"
            numOctaves="1"
            seed="7"
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="8"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>

      <a className="skip-link" href="#main-content">Skip to content</a>

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
                aria-label={label}
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

      <div className="page" id="main-content">
        {data?.error && <ErrorBanner message={data.error} onRetry={refetch} />}

        {loading || !data ? (
          <PageSkeleton variant={skeletonVariant(location.pathname)} />
        ) : (
          <ConversationProvider>
            {/* Keyed by pathname so navigating to another page auto-resets a
                crashed route; a single page fault no longer takes the shell. */}
            <ErrorBoundary variant="inline" key={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </ConversationProvider>
        )}
      </div>
    </div>
  )
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    if (busy) return
    setBusy(true)
    try {
      await Promise.resolve(onRetry())
    } finally {
      // Brief busy state; the refresh resolves shortly and clears the banner.
      setTimeout(() => setBusy(false), 600)
    }
  }
  return (
    <div className="banner" role="alert">
      <span>Supabase error: {message}</span>
      <button className="btn sm" onClick={retry} disabled={busy}>
        <RotateCw size={13} />
        {busy ? 'Retrying…' : 'Retry'}
      </button>
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
  const level = freshnessLevel(worstTs)
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
