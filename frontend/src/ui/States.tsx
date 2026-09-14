import type { ReactNode } from 'react'
import { CircleAlert, Loader2 } from 'lucide-react'
import { Button } from './Button'

/**
 * The four load states, kept distinct because conflating them is what made the
 * dashboard lie: an initial load, a refresh of data already on screen, an empty
 * dataset, and a read that failed.
 *
 * A refresh keeps the heading and the controls and marks the old numbers as
 * updating — it never blanks the region, and it never lets the previous scope's
 * content sit under the new scope's name.
 */

export function UpdatingNote({ children = 'Updating…' }: { children?: ReactNode }) {
  return (
    <span className="ui-updating" role="status">
      <Loader2 size={14} aria-hidden="true" className="ui-updating__spinner" />
      {children}
    </span>
  )
}

/**
 * Wraps a region whose data is being replaced. `scopeLabel` is mandatory when
 * the scope itself changed: the user must be told which account/range the
 * visible numbers still belong to.
 */
export function RefreshingRegion({
  updating, scopeLabel, children,
}: {
  updating: boolean
  scopeLabel?: string
  children: ReactNode
}) {
  return (
    <div aria-busy={updating || undefined} className={updating ? 'ui-stale' : undefined}>
      {updating && scopeLabel && (
        <UpdatingNote>Showing {scopeLabel} while the new selection loads…</UpdatingNote>
      )}
      {children}
    </div>
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
