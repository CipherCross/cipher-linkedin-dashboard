import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

// Shared empty state: an icon, one sentence, and an optional next action — used
// in place of the bare one-liners ("No replies…", "No leads match…") scattered
// across the pages.
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className = '',
}: {
  icon: LucideIcon
  title: string
  hint?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={`empty-state ${className}`.trim()}>
      <span className="empty-state-icon">
        <Icon size={22} aria-hidden="true" />
      </span>
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint muted small">{hint}</div>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
