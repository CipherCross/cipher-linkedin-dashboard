import type { ElementType, ReactNode } from 'react'

/**
 * A grouping surface. `surface` draws the white card (border + 12px radius, no
 * shadow); `plain` groups without drawing anything. Nesting is capped at two
 * visible levels by `ui.css` — a surface panel inside a surface panel loses its
 * own frame, which is what stops the "rows inside cards inside cards" stacking
 * the audit found on Pipeline and the Sequence hub.
 */
export function Panel({
  as: Tag = 'section',
  variant = 'surface',
  className = '',
  children,
  ...rest
}: {
  as?: ElementType
  variant?: 'surface' | 'plain'
  className?: string
  children: ReactNode
} & Record<string, unknown>) {
  return (
    <Tag
      className={['ui-panel', variant === 'surface' ? 'ui-panel--surface' : '', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </Tag>
  )
}

export function SectionHeader({
  title,
  description,
  actions,
  level = 'section',
  id,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** `section` = 20/28, `subsection` = 16/24. There is no third option. */
  level?: 'section' | 'subsection'
  id?: string
}) {
  const Heading = (level === 'section' ? 'h2' : 'h3') as ElementType
  return (
    <div className={`ui-section-header${level === 'subsection' ? ' ui-section-header--sub' : ''}`}>
      <div className="ui-section-header__copy">
        <Heading className="ui-section-header__title" id={id}>{title}</Heading>
        {description && <p className="ui-section-header__description">{description}</p>}
      </div>
      {actions && <div className="ui-section-header__actions">{actions}</div>}
    </div>
  )
}
