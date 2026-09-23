import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Command,
  Menu,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  LogOut,
} from 'lucide-react'
import { useData } from '../lib/DataContext'
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
import { Button, IconButton } from '../ui'
import { InlineError } from '../ui/States'

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
  const routeKeepsSnapshot = location.pathname === '/replies' || location.pathname === '/sentiment-analysis'
  const showPageSkeleton = !data || (routeKeepsSnapshot
    ? phase === 'empty'
    : loading || (location.pathname !== '/' && location.pathname !== '/leads' && phase !== 'full'))

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
      <a className="skip-link" href="#main-content">Skip to content</a>

      {/* Mobile-only bar: hamburger toggles the off-canvas sidebar; the rail
          itself is display:none here and only appears ≥900px. */}
      <div className="mobile-topbar hidden [@media(max-width:900px)]:flex" ref={mobileTopbarRef}>
        <IconButton
          ref={mobileToggleRef}
          bordered
          onClick={() => setNavOpen((o) => !o)}
          label={navOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={navOpen}
          icon={navOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
        />
        <Link to="/" className="brand" aria-label="Outreach Deck — home">
          <Logo size={24} className="brand-mark" />
          <span className="brand-name">Outreach Deck</span>
        </Link>
        <div className="appbar-actions ml-auto flex items-center gap-1.5 shrink-0">
          {data && <SyncChip instances={data.instances} />}
        </div>
      </div>

      {/* Backdrop behind the open mobile drawer; tap to dismiss. */}
      <div
        className={`nav-backdrop hidden${navOpen ? ' show [@media(max-width:900px)]:block' : ''}`}
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

      <Button
        ref={desktopRestoreRef}
        variant="secondary"
        size="sm"
        className="desktop-nav-restore"
        icon={<PanelLeftOpen size={18} aria-hidden="true" />}
        onClick={() => {
          setSidebarHidden(false)
          requestAnimationFrame(() => {
            document.querySelector<HTMLElement>('.quick-nav-trigger')?.focus()
          })
        }}
      >
        Show navigation
      </Button>

      <main className="content flex-1 min-w-0" id="main-content" ref={contentRef} tabIndex={-1}>
        <div className="page">
          {data?.error && <ErrorBanner message={data.error} onRetry={refetch} />}

          {showPageSkeleton ? (
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
              <Icon
                size={17}
                className="navlink-icon shrink-0 text-[color-mix(in_srgb,currentColor_82%,transparent)] [.active_&]:text-app-accent"
                aria-hidden="true"
              />
              <span >{label}</span>
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
          <IconButton
            className="side-hide"
            onClick={onHide}
            label="Hide navigation"
            icon={<PanelLeftClose size={20} aria-hidden="true" />}
          />
          <IconButton
            ref={mobileCloseRef}
            className="side-mobile-close"
            onClick={onClose}
            label="Close navigation"
            icon={<X size={20} aria-hidden="true" />}
          />
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
          <div className="w-full min-w-0 flex items-center gap-2 pb-2">
            <span
              className="size-[30px] flex-[0_0_30px] grid place-items-center border border-app-accent-border rounded-full bg-app-accent-subtle text-app-accent text-[length:var(--text-xs)] font-[750]"
              aria-hidden="true"
            >
              {member?.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="side-user-copy">
              <strong>{member?.name}</strong>
              <span>{member?.role}</span>
            </span>
            <IconButton
              label="Sign out"
              icon={<LogOut size={20} aria-hidden="true" />}
              onClick={() => void signOut()}
            />
          </div>
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
 *
 * The server's own wording stays available under Details rather than in the
 * headline: a real failure must never be smoothed away, only explained first.
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
    <InlineError
      title="Could not load the dashboard."
      message="The data on this page may be missing or out of date."
      detail={message}
      onRetry={retry}
      busy={busy}
    />
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
      aria-label={`${label} — open Sync health`}
    >
      <span className="sync-dot size-[8px] rounded-full shrink-0" aria-hidden="true" />
      <span >{label}</span>
    </Link>
  )
}
