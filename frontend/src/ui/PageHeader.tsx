import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'

/**
 * The one page header. Exactly one `<h1>` per route, one primary action, and a
 * single 28/36 title size on every route — the audit measured 20px on the shell
 * default, 22px on Replies, 24–32px on Overview and a larger one again on the
 * Sequence hub, all from a global `header { … }` rule reaching nested semantic
 * headers. That rule is gone; this component replaced it.
 */

export interface Crumb {
  label: string
  to?: string
}

export function PageHeader({
  title,
  breadcrumb,
  description,
  context,
  actions,
  titleId,
}: {
  title: ReactNode
  breadcrumb?: Crumb[]
  /** One sentence. Longer explanation belongs in the section it explains. */
  description?: ReactNode
  /** Scope chips — date range, account, freshness. Never actions. */
  context?: ReactNode
  /** One primary action; anything further belongs in a menu. */
  actions?: ReactNode
  titleId?: string
}) {
  return (
    <div className="ui-page-header">
      <div className="ui-page-header__copy">
        {breadcrumb && breadcrumb.length > 0 && (
          <nav className="ui-page-header__breadcrumb" aria-label="Breadcrumb">
            {breadcrumb.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} style={{ display: 'contents' }}>
                {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
                {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span>{crumb.label}</span>}
              </span>
            ))}
          </nav>
        )}
        <h1 id={titleId}>{title}</h1>
        {description && <p className="ui-page-header__description">{description}</p>}
        {context && <div className="ui-page-header__context">{context}</div>}
      </div>
      {actions && <div className="ui-page-header__actions">{actions}</div>}
    </div>
  )
}
