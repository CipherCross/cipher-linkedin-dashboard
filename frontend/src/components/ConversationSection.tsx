import { useId } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '../ui'

/**
 * A collapsible section of the conversation workspace's context column (the
 * lead notes). Collapsed it is one header row; open, it takes its full height
 * and the column scrolls to it.
 *
 * The toggle is a disclosure button (`aria-expanded` / `aria-controls`); the
 * route-owned `actions` and `badges` sit beside it, never inside it.
 */
export function ConversationSection({
  title, open, onToggle, badges, actions, children,
}: {
  title: string
  open: boolean
  onToggle: () => void
  badges?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  const bodyId = useId()
  return (
    <section className="flex flex-col gap-stack">
      <div className="flex items-center gap-app-sm">
        <Button
          variant="ghost"
          size="sm"
          className="px-0 text-app-text-muted uppercase tracking-[var(--tracking-caps)] text-app-meta"
          aria-expanded={open}
          aria-controls={bodyId}
          icon={open
            ? <ChevronDown size={16} className="text-app-text-muted" aria-hidden="true" />
            : <ChevronRight size={16} className="text-app-text-muted" aria-hidden="true" />}
          onClick={onToggle}
        >
          {title}
        </Button>
        {badges}
        {actions && <div className="ml-auto flex items-center gap-app-sm">{actions}</div>}
      </div>
      {open && <div id={bodyId}>{children}</div>}
    </section>
  )
}
