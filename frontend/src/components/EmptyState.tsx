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
      <span className="inline-flex items-center justify-center w-11 h-11 rounded-lg bg-app-surface-2 text-app-text-muted mb-0.5">
        <Icon size={22} aria-hidden="true" />
      </span>
      <div className="text-[length:var(--text-base)] font-semibold text-app-text">{title}</div>
      {hint && <div className="max-w-[340px] leading-[1.5] muted small">{hint}</div>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  )
}
