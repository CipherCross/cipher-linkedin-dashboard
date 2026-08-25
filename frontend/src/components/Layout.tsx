import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Command,
  RotateCw,
  Sun,
  Moon,
  Menu,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  LogOut,
} from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useTheme } from '../lib/ThemeContext'
import { ConversationProvider } from '../lib/ConversationContext'
import type { DashboardData, Instance } from '../lib/types'
import { instanceName } from '../lib/leads'
import { ago } from '../lib/format'
import { freshnessLevel } from '../lib/freshness'
import { useAuth } from '../lib/AuthContext'
import {
  NAVIGATION_SECTIONS,
  navigationItemMatches,
  pageNameForPath,
  skeletonVariantForPath,
  type NavigationSection,
  type NavigationSectionId,
} from '../lib/navigation'
import { Logo } from './Logo'
import { PageSkeleton } from './Skeleton'
import { ErrorBoundary } from './ErrorBoundary'
import { QuickNavigation } from './QuickNavigation'

export function Layout() {
  const { data, loading, phase, refetch } = useData()
  const { isAdmin } = useAuth()
  const location = useLocation()
  const [navOpen, setNavOpen] = useState(false)
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const [quickNavigationOpen, setQuickNavigationOpen] = useState(false)
  const [mobileViewport, setMobileViewport] = useState(
    () => window.matchMedia('(max-width: 900px)').matches,
  )
  const mobileToggleRef = useRef<HTMLButtonElement>(null)
  const mobileTopbarRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLElement>(null)
  const desktopRestoreRef = useRef<HTMLButtonElement>(null)

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

  // The desktop-only hidden state must never leak into the mobile drawer.
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)')
    const resetForMobile = () => {
      setMobileViewport(media.matches)
      if (media.matches) setSidebarHidden(false)
    }
    resetForMobile()
    media.addEventListener('change', resetForMobile)
    return () => media.removeEventListener('change', resetForMobile)
  }, [])

  // While the mobile drawer is open, its visual backdrop is also a real input
  // boundary: page content and the top bar leave the focus order entirely.
  useEffect(() => {
    const targets = [mobileTopbarRef.current, contentRef.current].filter(
      (target): target is HTMLElement => target !== null,
    )
    for (const target of targets) {
      navOpen ? target.setAttribute('inert', '') : target.removeAttribute('inert')
    }
    return () => {
      for (const target of targets) target.removeAttribute('inert')
    }
  }, [navOpen])

  // Document title. Detail routes (campaign/account) title by the entity they
  // show, resolved from data — so this also re-runs when data first arrives on
  // a deep link.
  useEffect(() => {
    let name = pageNameForPath(location.pathname)
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
    <div className={`app${sidebarHidden ? ' nav-hidden' : ''}`}>
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
      <div className="mobile-topbar" ref={mobileTopbarRef}>
        <button
          ref={mobileToggleRef}
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

      <Sidebar
        data={data}
        open={navOpen}
        hidden={sidebarHidden}
        mobile={mobileViewport}
        mobileReturnFocusRef={mobileToggleRef}
        onClose={() => setNavOpen(false)}
        onHide={() => {
          setSidebarHidden(true)
          requestAnimationFrame(() => desktopRestoreRef.current?.focus())
        }}
        onOpenQuickNavigation={() => {
          setNavOpen(false)
          setQuickNavigationOpen(true)
        }}
      />

      <button
        ref={desktopRestoreRef}
        type="button"
        className="desktop-nav-restore"
        onClick={() => {
          setSidebarHidden(false)
          requestAnimationFrame(() => {
            document.querySelector<HTMLElement>('.quick-nav-trigger')?.focus()
          })
        }}
        aria-label="Show navigation"
      >
        <PanelLeftOpen size={18} aria-hidden="true" />
        <span>Show navigation</span>
      </button>

      <main className="content" id="main-content" ref={contentRef} tabIndex={-1}>
        <div className="page">
          {data?.error && <ErrorBanner message={data.error} onRetry={refetch} />}

          {loading || !data || (
            location.pathname !== '/' && location.pathname !== '/leads' && phase !== 'full'
          ) ? (
            <PageSkeleton variant={skeletonVariantForPath(location.pathname)} />
          ) : (
            <ConversationProvider>
              {/* Keyed by pathname so navigating to another page auto-resets a
                  crashed route; a single page fault no longer takes the shell. */}
              <ErrorBoundary variant="inline" key={location.pathname}>
                {/* Pages are lazy-loaded (code-split in App); show the route-shaped
                    skeleton while a chunk streams in. */}
                <Suspense fallback={<PageSkeleton variant={skeletonVariantForPath(location.pathname)} />}>
                  <Outlet />
                </Suspense>
              </ErrorBoundary>
            </ConversationProvider>
          )}
        </div>
      </main>

      <QuickNavigation
        open={quickNavigationOpen}
        data={data}
        isAdmin={isAdmin}
        onOpen={() => setQuickNavigationOpen(true)}
        onClose={() => setQuickNavigationOpen(false)}
      />
    </div>
  )
}

function sidebarFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('hidden') && element.getClientRects().length > 0)
}

/** Stable, page-first navigation. Accounts and campaigns deliberately live only
 * in Quick Navigation and their existing detail routes, never in this rail. */
function Sidebar({
  data,
  open,
  hidden,
  mobile,
  mobileReturnFocusRef,
  onClose,
  onHide,
  onOpenQuickNavigation,
}: {
  data: DashboardData | null
  open: boolean
  hidden: boolean
  mobile: boolean
  mobileReturnFocusRef: RefObject<HTMLButtonElement>
  onClose: () => void
  onHide: () => void
  onOpenQuickNavigation: () => void
}) {
  const { member, isAdmin, signOut } = useAuth()
  const location = useLocation()
  const asideRef = useRef<HTMLElement>(null)
  const mobileCloseRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)
  const activePageSection = useMemo(
    () => NAVIGATION_SECTIONS.find(
      (section) => section.collapsible &&
        section.items.some((item) => navigationItemMatches(location.pathname, item)),
    )?.id ?? null,
    [location.pathname],
  )
  const [openPageSection, setOpenPageSection] = useState<NavigationSectionId | null>(
    () => activePageSection,
  )

  // Secondary page groups behave as an accordion, but navigating to a page
  // always reveals the group that owns it.
  useEffect(() => {
    if (activePageSection) setOpenPageSection(activePageSection)
  }, [activePageSection])

  useEffect(() => {
    const aside = asideRef.current
    if (!aside) return
    const shouldBeInert = hidden || (mobile && !open)
    shouldBeInert ? aside.setAttribute('inert', '') : aside.removeAttribute('inert')
    return () => aside.removeAttribute('inert')
  }, [hidden, mobile, open])

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      requestAnimationFrame(() => mobileCloseRef.current?.focus())
      return
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false
      requestAnimationFrame(() => mobileReturnFocusRef.current?.focus())
    }
  }, [mobileReturnFocusRef, open])

  const renderSection = (section: NavigationSection) => {
    const links = section.items.filter((item) => !item.adminOnly || isAdmin)
    if (links.length === 0) return null
    const hasActiveItem = links.some((item) => navigationItemMatches(location.pathname, item))
    const isOpen = !section.collapsible || openPageSection === section.id
    const linksId = `nav-section-links-${section.id}`

    return (
      <div
        className={`nav-section${section.id === 'primary' ? ' primary' : ''}`}
        key={section.id}
      >
        {section.collapsible ? (
          <button
            type="button"
            className={`nav-section-trigger${isOpen ? ' open' : ''}${hasActiveItem ? ' active' : ''}`}
            onClick={() => setOpenPageSection(
              (current) => current === section.id ? null : section.id,
            )}
            aria-expanded={isOpen}
            aria-controls={linksId}
          >
            <span className="nav-section-title">{section.label}</span>
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        ) : section.label ? (
          <div className="nav-section-title">{section.label}</div>
        ) : null}
        <div className={`nav-section-links${isOpen ? '' : ' collapsed'}`} id={linksId}>
          {links.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => (isActive ? 'navlink active' : 'navlink')}
            >
              <Icon size={17} className="navlink-icon" aria-hidden="true" />
              <span className="navlink-label">{label}</span>
            </NavLink>
          ))}
        </div>
      </div>
    )
  }

  return (
    <aside
      ref={asideRef}
      className={`sidebar${open ? ' open' : ''}`}
      aria-label="Primary"
      aria-hidden={(hidden || (mobile && !open)) || undefined}
      onKeyDown={(event) => {
        if (!open || !asideRef.current) return
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          return
        }
        if (event.key !== 'Tab') return
        const focusable = sidebarFocusableElements(asideRef.current)
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}
    >
      <div className="sidebar-inner">
        <div className="side-head">
          <Link to="/" className="brand" aria-label="Outreach Deck — home">
            <Logo size={26} className="brand-mark" />
            <span className="brand-name">Outreach Deck</span>
          </Link>
          <button
            type="button"
            className="side-hide"
            onClick={onHide}
            aria-label="Hide navigation"
            title="Hide navigation"
          >
            <PanelLeftClose size={18} aria-hidden="true" />
          </button>
          <button
            ref={mobileCloseRef}
            type="button"
            className="side-mobile-close"
            onClick={onClose}
            aria-label="Close navigation"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </div>

        <button type="button" className="quick-nav-trigger" onClick={onOpenQuickNavigation}>
          <Command size={16} aria-hidden="true" />
          <span>Go to…</span>
          <kbd>⌘K</kbd>
        </button>

        <nav className="side-nav side-main-nav" aria-label="Pages">
          {NAVIGATION_SECTIONS.filter((section) => section.placement === 'main').map(renderSection)}
        </nav>

        <nav className="side-nav side-secondary-nav" aria-label="Administration">
          {NAVIGATION_SECTIONS.filter((section) => section.placement === 'footer').map(renderSection)}
        </nav>

        <div className="side-footer">
          <div className="side-user">
            <span className="side-user-avatar" aria-hidden="true">
              {member?.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="side-user-copy">
              <strong>{member?.name}</strong>
              <span>{member?.role}</span>
            </span>
            <button
              className="icon-btn"
              type="button"
              title="Sign out"
              aria-label="Sign out"
              onClick={() => void signOut()}
            >
              <LogOut size={16} />
            </button>
          </div>
          <ThemeToggle />
          {data && <SyncChip instances={data.instances} />}
        </div>
      </div>
    </aside>
  )
}

/**
 * The dashboard's one failure surface.
 *
 * **It names no provider, and that is the point.** It used to read
 * `Supabase error: {message}`, on every deployment and for every failure
 * whatever produced it — so a tenant that has never had Supabase reported a
 * Neon read failure under a Supabase headline, and no alert this dashboard
 * raised could be trusted about its own cause. The message already carries the
 * operation that failed and the reason the server gave; the banner's job is to
 * say that the load failed and offer the retry, not to guess at a database.
 */
export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
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
      <span>Couldn’t load the dashboard: {message}</span>
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
      aria-label={`${label} — open Sync health`}
    >
      <span className="sync-dot" aria-hidden="true" />
      <span className="sync-chip-label">{label}</span>
    </Link>
  )
}
