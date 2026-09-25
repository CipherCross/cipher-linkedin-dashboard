import { useId } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '../ui'

/**
 * A collapsible band under the conversation thread — the AI coach and the lead
 * notes. Collapsed it is one header row; open, it takes its full height and the
 * drawer body scrolls to it. (A 40%-capped band that scrolled on its own could
 * be clipped below the drawer's edge on a short window, with nothing to scroll.)
 * The thread above keeps its own minimum height, so it never disappears.
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
    <section
      className="shrink-0 border-t border-app-border bg-[var(--surface-sunken)] px-app-lg py-app-sm"
    >
      <div className="flex items-center gap-app-sm">
        <Button
          variant="ghost"
          size="sm"
          className="px-0 text-app-text"
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
      {open && <div id={bodyId} className="mt-app-sm pb-app-sm">{children}</div>}
    </section>
  )
}
