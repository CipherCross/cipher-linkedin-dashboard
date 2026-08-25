import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Megaphone, Search, UserRound, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { DashboardData } from '../lib/types'
import {
  buildQuickNavigationDestinations,
  filterQuickNavigationDestinations,
  type QuickNavigationDestination,
} from '../lib/navigation'

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('hidden') && element.getClientRects().length > 0)
}

export function QuickNavigation({
  open,
  data,
  isAdmin,
  onOpen,
  onClose,
}: {
  open: boolean
  data: DashboardData | null
  isAdmin: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listId = useId()
  const destinations = useMemo(
    () => buildQuickNavigationDestinations(data, isAdmin),
    [data, isAdmin],
  )
  const results = useMemo(
    () => filterQuickNavigationDestinations(destinations, query),
    [destinations, query],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        open ? onClose() : onOpen()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, onOpen, open])

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousOverflow = document.body.style.overflow
    const app = document.querySelector<HTMLElement>('.app')
    document.body.style.overflow = 'hidden'
    app?.setAttribute('inert', '')
    setQuery('')
    setActiveIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())

    return () => {
      document.body.style.overflow = previousOverflow
      app?.removeAttribute('inert')
      requestAnimationFrame(() => previousFocusRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  const choose = (destination: QuickNavigationDestination) => {
    navigate(destination.to)
    onClose()
  }

  if (!open) return null

  const resolvedActiveIndex = Math.min(activeIndex, Math.max(0, results.length - 1))
  const active = results[resolvedActiveIndex]
  const activeId = active ? `${listId}-${active.id.replace(/[^a-zA-Z0-9_-]/g, '-')}` : undefined

  return createPortal(
    <div
      className="quick-nav-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="quick-nav-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${listId}-title`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key !== 'Tab' || !dialogRef.current) return
          const focusable = focusableElements(dialogRef.current)
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
        <div className="quick-nav-head">
          <div>
            <span className="quick-nav-eyebrow">Quick navigation</span>
            <h2 id={`${listId}-title`}>Go to</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close quick navigation">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="quick-nav-search">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages, accounts, or campaigns"
            aria-label="Search destinations"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-expanded="true"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((current) => results.length ? (current + 1) % results.length : 0)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((current) => results.length
                  ? (current - 1 + results.length) % results.length
                  : 0)
              } else if (event.key === 'Enter' && active) {
                event.preventDefault()
                choose(active)
              }
            }}
          />
          <kbd>esc</kbd>
        </div>

        <div className="quick-nav-results" id={listId} role="listbox" aria-label="Destinations">
          {results.map((destination, index) => {
            const Icon = destination.icon ?? (
              destination.kind === 'account' ? UserRound : Megaphone
            )
            const optionId = `${listId}-${destination.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
            return (
              <button
                key={destination.id}
                id={optionId}
                type="button"
                role="option"
                aria-selected={index === resolvedActiveIndex}
                tabIndex={-1}
                className={`quick-nav-result${index === resolvedActiveIndex ? ' active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(destination)}
              >
                <span className="quick-nav-result-icon" aria-hidden="true">
                  <Icon size={17} />
                </span>
                <span className="quick-nav-result-copy">
                  <strong>{destination.label}</strong>
                  <span>{destination.meta}</span>
                </span>
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            )
          })}
          {results.length === 0 && (
            <div className="quick-nav-empty">
              <Search size={20} aria-hidden="true" />
              <strong>No destinations found</strong>
              <span>Try a page, account, or campaign name.</span>
            </div>
          )}
        </div>

        <div className="quick-nav-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>⌘</kbd><kbd>K</kbd> Toggle</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
