import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { Badge, IconButton } from '../ui'

/**
 * The card library shared by Searches, ICPs and Hypotheses: a platform/group
 * heading over a grid of cards, each with a title, row actions and a quiet
 * footer. Presentation only — every list, filter, handler and draft stays in
 * its route.
 */

export function LibraryGroup({ title, count, children }: {
  title: ReactNode
  count: number
  children: ReactNode
}) {
  return (
    <section className="mb-app-xl">
      <h2 className="mt-0 mb-app-md text-app-section">
        {title} <span className="text-app-meta font-normal text-app-text-muted">· {count}</span>
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-app-lg">{children}</div>
    </section>
  )
}

/**
 * One library card. When `onOpen` is given the title becomes the card's
 * button and stretches over the whole card, so a click anywhere opens it —
 * while the row actions stay separate, focusable buttons above that layer
 * instead of interactive elements nested inside another button.
 */
export function LibraryCard({
  title, openLabel, onOpen, archived, badges, actions, children, footer,
}: {
  title: string
  /** Accessible name for the open action, e.g. "Open ICP Fintech". */
  openLabel?: string
  onOpen?: () => void
  archived?: boolean
  badges?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  footer?: ReactNode
}) {
  return (
    <article
      className={[
        'relative flex flex-col gap-2.5 p-4 border border-app-border rounded-card bg-app-surface',
        onOpen ? 'hover:border-app-border-strong has-[[data-card-open]:focus-visible]:outline-2 has-[[data-card-open]:focus-visible]:outline-app-accent has-[[data-card-open]:focus-visible]:outline-offset-2' : '',
        archived ? 'opacity-60' : '',
      ].filter(Boolean).join(' ')}
    >
      <div className="flex items-start justify-between gap-app-sm">
        <div className="flex items-center gap-app-sm flex-wrap min-w-0">
          {onOpen ? (
            /* ui-exception(library-card-open): the title button stretched over the card; verify: searchLibraryPage */
            <button
              type="button"
              data-card-open=""
              className="p-0 border-0 bg-transparent text-left font-semibold text-app-text cursor-pointer focus-visible:outline-none after:absolute after:inset-0 after:content-['']"
              onClick={onOpen}
              aria-label={openLabel}
            >
              {title}
            </button>
          ) : (
            <span className="font-semibold">{title}</span>
          )}
          {archived && <Badge>Archived</Badge>}
          {badges}
        </div>
        {actions && <div className="relative z-10 flex gap-0.5 shrink-0">{actions}</div>}
      </div>
      {children}
      {footer && (
        <div className="border-t border-app-border pt-app-sm mt-auto text-app-meta text-app-text-muted">{footer}</div>
      )}
    </article>
  )
}

const CHIP_CLASS = {
  include: 'inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-pill border bg-app-surface-2 text-app-meta text-app-text-secondary border-[color-mix(in_srgb,var(--accent)_45%,var(--border))]',
  exclude: 'inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-pill border bg-app-surface-2 text-app-meta text-app-text-secondary border-[color-mix(in_srgb,var(--danger)_45%,var(--border))]',
} as const

/** A keyword or value chip. `exclude` is prefixed with a minus so the meaning
 *  never depends on the border colour alone. */
export function Chip({ tone = 'include', children, onRemove, removeLabel }: {
  tone?: 'include' | 'exclude'
  children: ReactNode
  onRemove?: () => void
  removeLabel?: string
}) {
  return (
    <span className={CHIP_CLASS[tone]}>
      {tone === 'exclude' && '−'}
      {children}
      {onRemove && (
        <IconButton
          className="size-4 border-0 rounded-sm text-app-text-muted hover:text-app-text"
          label={removeLabel ?? 'Remove'}
          icon={<X size={12} aria-hidden="true" />}
          onClick={onRemove}
        />
      )}
    </span>
  )
}

export function KeywordChips({ include = [], exclude = [] }: { include?: string[]; exclude?: string[] }) {
  if (include.length === 0 && exclude.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {include.map((keyword) => <Chip key={`i-${keyword}`}>{keyword}</Chip>)}
      {exclude.map((keyword) => <Chip key={`e-${keyword}`} tone="exclude">{keyword}</Chip>)}
    </div>
  )
}
