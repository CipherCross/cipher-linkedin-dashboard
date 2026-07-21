import { Suspense, useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  KanbanSquare,
  ClipboardCheck,
  BookOpen,
  Search,
  Target,
  FlaskConical,
  Activity,
  Sparkles,
  RotateCw,
  Sun,
  Moon,
  Menu,
  ChevronRight,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useTheme } from '../lib/ThemeContext'
import { ConversationProvider } from '../lib/ConversationContext'
import type { DashboardData, Instance } from '../lib/types'
import { instanceName } from '../lib/leads'
import { ago } from '../lib/format'
import { freshnessLevel } from '../lib/freshness'
import { Avatar } from './Avatar'
import { Logo } from './Logo'
import { PageSkeleton } from './Skeleton'
import { ErrorBoundary } from './ErrorBoundary'

const LINKS: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/leads', label: 'Leads', icon: Users },
  { to: '/pipeline', label: 'Pipeline', icon: KanbanSquare },
  { to: '/review', label: 'Review', icon: ClipboardCheck },
  { to: '/playbook', label: 'Playbook', icon: BookOpen },
  { to: '/searches', label: 'Searches', icon: Search },
  { to: '/icp', label: 'ICPs', icon: Target },
  { to: '/hypotheses', label: 'Hypotheses', icon: FlaskConical },
  { to: '/health', label: 'Health', icon: Activity },
  { to: '/chat', label: 'Chat', icon: Sparkles },
]

// Which loading skeleton best matches the route the user landed on (deep links
// can open any page first). Keeps the first paint shaped like the real page.
function skeletonVariant(pathname: string): 'overview' | 'table' | 'list' | 'simple' {
  if (pathname.startsWith('/leads') || pathname.startsWith('/health') || pathname.startsWith('/review') || pathname.startsWith('/pipeline')) return 'table'
  if (
    pathname.startsWith('/playbook') || pathname.startsWith('/chat') ||
    pathname.startsWith('/searches') || pathname.startsWith('/icp') ||
    pathname.startsWith('/hypotheses')
  ) return 'simple'
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
  // Mobile off-canvas drawer state. On desktop the sidebar is always visible and
  // this is ignored; on narrow viewports the hamburger toggles it.
  const [navOpen, setNavOpen] = useState(false)

  // Reset scroll on every navigation. Separate from the title effect below,
  // which also depends on `data` — the periodic refetch must not yank the
  // user's scroll position back to the top.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

  // Close the mobile drawer whenever the route changes (a nav link was tapped).
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

  // Document title. Detail routes (campaign/account) title by the entity they
  // show, resolved from data — so this also re-runs when data first arrives on
  // a deep link.
  useEffect(() => {
    let name = pageName(location.pathname)
    if (!name && data) {
      const m = location.pathname.match(/^\/(campaign|account)\/(.+)$/)
      if (m) {
        const id = decodeURIComponent(m[2])
        name =
          m[1] === 'campaign'
            ? data.campaigns.find((c) => c.campaign_id === id)?.campaign_name ?? null
            : instanceName(data.instances.find((i) => i.id === id), id)
      }
    }
    document.title = name ? `${name} — Outreach Deck` : 'Outreach Deck'
  }, [location.pathname, data])

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

      {/* Mobile-only bar: hamburger toggles the off-canvas sidebar; the rail
          itself is display:none here and only appears ≥900px. */}
      <div className="mobile-topbar">
        <button
          type="button"
          className="nav-toggle"
          onClick={() => setNavOpen((o) => !o)}
          aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={navOpen}
        >
          {navOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <Link to="/" className="brand" aria-label="Outreach Deck — home">
          <Logo size={24} className="brand-mark" />
          <span className="brand-name">Outreach Deck</span>
        </Link>
        <div className="appbar-actions">
          <ThemeToggle />
          {data && <SyncChip instances={data.instances} />}
        </div>
      </div>

      {/* Backdrop behind the open mobile drawer; tap to dismiss. */}
      <div
        className={`nav-backdrop${navOpen ? ' show' : ''}`}
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />

      <Sidebar data={data} open={navOpen} />

      <div className="content">
        <div className="page" id="main-content">
          {data?.error && <ErrorBanner message={data.error} onRetry={refetch} />}

          {loading || !data ? (
            <PageSkeleton variant={skeletonVariant(location.pathname)} />
          ) : (
            <ConversationProvider>
              {/* Keyed by pathname so navigating to another page auto-resets a
                  crashed route; a single page fault no longer takes the shell. */}
              <ErrorBoundary variant="inline" key={location.pathname}>
                {/* Pages are lazy-loaded (code-split in App); show the route-shaped
                    skeleton while a chunk streams in. */}
                <Suspense fallback={<PageSkeleton variant={skeletonVariant(location.pathname)} />}>
                  <Outlet />
                </Suspense>
              </ErrorBoundary>
            </ConversationProvider>
          )}
        </div>
      </div>
    </div>
  )
}

/** Left navigation rail: brand, the fixed page links, then a filterable tree of
 *  every account with its campaigns nested beneath — for jumping straight to any
 *  detail page. On desktop it's a sticky always-on column; on mobile it becomes
 *  an off-canvas drawer driven by `open`. */
function Sidebar({ data, open }: { data: DashboardData | null; open: boolean }) {
  const location = useLocation()
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // The account whose detail page — or one of whose campaigns — is currently
  // open. Used to auto-reveal the relevant group so the active item is visible.
  const activeInstance = useMemo(() => {
    const acct = location.pathname.match(/^\/account\/(.+)$/)
    if (acct) return decodeURIComponent(acct[1])
    const camp = location.pathname.match(/^\/campaign\/(.+)$/)
    if (camp && data) {
      const id = decodeURIComponent(camp[1])
      return data.campaigns.find((c) => c.campaign_id === id)?.instance_id ?? null
    }
    return null
  }, [location.pathname, data])

  useEffect(() => {
    if (!activeInstance) return
    setExpanded((prev) => (prev.has(activeInstance) ? prev : new Set(prev).add(activeInstance)))
  }, [activeInstance])

  // Each account paired with its campaigns (sorted by name), in account order.
  const groups = useMemo(() => {
    if (!data) return []
    const byInstance = new Map<string, typeof data.campaigns>()
    for (const c of data.campaigns) {
      const arr = byInstance.get(c.instance_id) ?? []
      arr.push(c)
      byInstance.set(c.instance_id, arr)
    }
    return data.instances.map((inst) => ({
      inst,
      campaigns: (byInstance.get(inst.id) ?? [])
        .slice()
        .sort((a, b) => a.campaign_name.localeCompare(b.campaign_name)),
    }))
  }, [data])

  const q = filter.trim().toLowerCase()
  // While filtering, keep only groups that match on the account name or have a
  // matching campaign; a group matched by name keeps all its campaigns.
  const visibleGroups = useMemo(() => {
    if (!q) return groups
    return groups
      .map(({ inst, campaigns }) => {
        const acctHit = instanceName(inst).toLowerCase().includes(q)
        const camps = acctHit
          ? campaigns
          : campaigns.filter((c) => c.campaign_name.toLowerCase().includes(q))
        return acctHit || camps.length > 0 ? { inst, campaigns: camps } : null
      })
      .filter((g): g is { inst: Instance; campaigns: typeof groups[number]['campaigns'] } => g !== null)
  }, [groups, q])

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Primary">
      <div className="sidebar-inner">
        <Link to="/" className="brand" aria-label="Outreach Deck — home">
          <Logo size={26} className="brand-mark" />
          <span className="brand-name">Outreach Deck</span>
        </Link>

        <nav className="side-nav" aria-label="Pages">
          {LINKS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => (isActive ? 'navlink active' : 'navlink')}
            >
              <Icon size={16} className="navlink-icon" aria-hidden="true" />
              <span className="navlink-label">{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="side-scroll">
          <div className="side-section-head">Accounts &amp; campaigns</div>
          {data && data.instances.length > 3 && (
            <input
              className="side-filter"
              type="search"
              placeholder="Filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter accounts and campaigns"
            />
          )}

          {visibleGroups.map(({ inst, campaigns }) => {
            const isOpen = !!q || expanded.has(inst.id)
            const fresh = inst.last_sync_at
              ? Date.now() - new Date(inst.last_sync_at).getTime() < 24 * 3_600_000
              : false
            return (
              <div className="side-group" key={inst.id}>
                <div className="side-acct-row">
                  <button
                    type="button"
                    className={`side-acct-toggle${isOpen ? ' open' : ''}`}
                    onClick={() => toggle(inst.id)}
                    aria-label={isOpen ? 'Collapse campaigns' : 'Expand campaigns'}
                    aria-expanded={isOpen}
                    disabled={!!q}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                  <NavLink
                    to={`/account/${encodeURIComponent(inst.id)}`}
                    className={({ isActive }) => (isActive ? 'side-acct active' : 'side-acct')}
                  >
                    <Avatar inst={inst} size={22} />
                    <span className="side-acct-name">{instanceName(inst)}</span>
                    <span className={`side-dot ${fresh ? 'ok' : 'stale'}`} aria-hidden="true" />
                  </NavLink>
                </div>
                {isOpen &&
                  campaigns.map((c) => (
                    <NavLink
                      key={c.campaign_id}
                      to={`/campaign/${encodeURIComponent(c.campaign_id)}`}
                      className={({ isActive }) =>
                        isActive ? 'side-campaign active' : 'side-campaign'
                      }
                      title={c.campaign_name}
                    >
                      {c.campaign_name}
                    </NavLink>
                  ))}
                {isOpen && campaigns.length === 0 && (
                  <div className="side-empty">No campaigns</div>
                )}
              </div>
            )
          })}
          {data && visibleGroups.length === 0 && (
            <div className="side-empty">{q ? 'No matches' : 'No accounts synced'}</div>
          )}
        </div>

        <div className="side-footer">
          <ThemeToggle />
          {data && <SyncChip instances={data.instances} />}
        </div>
      </div>
    </aside>
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

/** Header light/dark switch. Seeds from OS preference on first visit, then
 *  persists the user's manual choice (see lib/ThemeContext). Shows the icon of
 *  the theme it will switch TO. */
function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
    >
      {theme === 'dark' ? (
        <Sun size={16} aria-hidden="true" />
      ) : (
        <Moon size={16} aria-hidden="true" />
      )}
    </button>
  )
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
