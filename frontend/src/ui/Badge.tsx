import type { ReactNode } from 'react'

/**
 * Semantic status marks. Colour always travels with a word (and usually an
 * icon): the audit found whole categories encoded as colour-only micro-chips on
 * Pipeline and Review, which is unreadable for anyone who cannot separate the
 * hues and meaningless in a screen reader.
 */

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'purple'

export function Badge({
  tone = 'neutral', icon, children, title, className = '',
}: {
  tone?: Tone
  icon?: ReactNode
  children: ReactNode
  title?: string
  className?: string
}) {
  return (
    <span className={`ui-badge ui-badge--${tone} ${className}`.trim()} title={title}>
      {icon}
      {children}
    </span>
  )
}

/** Status as plain text — for table cells and inline sentences, where a filled
 *  pill would add a third surface level for no information. */
export function StatusText({
  tone = 'neutral', icon, children, title,
}: {
  tone?: Tone
  icon?: ReactNode
  children: ReactNode
  title?: string
}) {
  return (
    <span className={`ui-status ui-status--${tone}`} title={title}>
      {icon}
      {children}
    </span>
  )
}
