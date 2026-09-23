import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { CircleAlert, Loader2 } from 'lucide-react'
import { Button } from './Button'

/**
 * The four load states, kept distinct because conflating them is what made the
 * dashboard lie: an initial load, a refresh of data already on screen, an empty
 * dataset, and a read that failed.
 *
 * A refresh keeps the heading and the controls and marks the old numbers as
 * updating — it never blanks the region, and it never lets the previous scope's
 * content sit under the new scope's name. The refreshing region itself carries
 * `aria-busy`; `UpdatingNote` is the visible and announced half.
 */

export function UpdatingNote({ children = 'Updating…' }: { children?: ReactNode }) {
  return (
    <span className="ui-updating" role="status">
      <Loader2 size={14} aria-hidden="true" className="ui-updating__spinner" />
      {children}
    </span>
  )
}

/** A read that failed. The rest of the workspace stays usable. */
export function InlineError({
  title = 'Could not load this section.',
  message,
  detail,
  onRetry,
  retryLabel = 'Retry',
  busy,
}: {
  title?: ReactNode
  /** Plain-language explanation. */
  message?: ReactNode
  /** Raw server diagnostics — kept, but behind a disclosure. */
  detail?: string
  onRetry?: () => void
  retryLabel?: string
  busy?: boolean
}) {
  return (
    <div className="ui-inline-error" role="alert">
      <CircleAlert size={20} className="ui-inline-error__icon" aria-hidden="true" />
      <div className="ui-inline-error__copy">
        <div className="ui-inline-error__title">{title}</div>
        {message && <div>{message}</div>}
        {detail && (
          <details className="ui-inline-error__detail">
            <summary>Details</summary>
            <pre>{detail}</pre>
          </details>
        )}
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} loading={busy}>
          {retryLabel}
        </Button>
      )}
    </div>
  )
}

export type EmptyStateKind = 'empty' | 'no-match'

/**
 * Nothing to show. `empty` means the dataset itself has no rows; `no-match`
 * means rows exist but the current search or filters exclude them all, so the
 * next action is usually to clear the filters. The two are never worded alike.
 */
export function EmptyState({
  kind = 'empty',
  icon: Icon,
  title,
  hint,
  action,
  className = '',
}: {
  kind?: EmptyStateKind
  icon: LucideIcon
  title: string
  hint?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={`empty-state ${className}`.trim()} data-empty-kind={kind}>
      <span className="inline-flex items-center justify-center w-11 h-11 rounded-lg bg-app-surface-2 text-app-text-muted mb-0.5">
        <Icon size={22} aria-hidden="true" />
      </span>
      <div className="text-[length:var(--text-base)] font-semibold text-app-text">{title}</div>
      {hint && <div className="max-w-[340px] text-app-meta leading-[1.5] text-app-text-muted">{hint}</div>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  )
}

export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

const SAVE_LABELS: Record<SaveState, string> = {
  saved: 'All changes saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  conflict: 'Newer version found',
  error: 'Save failed',
}

// Complete class strings, so Tailwind's source scan and the unknown-class guard see them.
const SAVE_CLASSES: Record<SaveState, string> = {
  saved: 'ui-save-status ui-save-status--saved',
  dirty: 'ui-save-status ui-save-status--dirty',
  saving: 'ui-save-status ui-save-status--saving',
  conflict: 'ui-save-status ui-save-status--conflict',
  error: 'ui-save-status ui-save-status--error',
}

/**
 * Presentation only. The route's existing save state is passed in; this never
 * owns a timer, a draft, a revision or conflict resolution. The dot always
 * travels with a word, so the state is never colour alone.
 */
export function SaveStatus({ state, label, className = '' }: {
  state: SaveState
  /** Replaces the default wording for this state. */
  label?: ReactNode
  className?: string
}) {
  return (
    <span className={`${SAVE_CLASSES[state]} ${className}`.trim()} role="status">
      <span className="ui-save-status__dot" aria-hidden="true" />
      {label ?? SAVE_LABELS[state]}
    </span>
  )
}
