import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Megaphone, Search, UserRound } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { DashboardData } from '../lib/types'
import {
  buildQuickNavigationDestinations,
  filterQuickNavigationDestinations,
  type QuickNavigationDestination,
} from '../lib/navigation'
import { Dialog } from '../ui'
import {
  Command, CommandEmpty, CommandInput, CommandItem, CommandList,
} from './ui/command'

/**
 * Jump to any page, account or campaign. Opened with Cmd/Ctrl+K.
 *
 * The modal shell is the shared `Dialog`, so focus trapping, the scroll lock,
 * Escape, outside press and focus restoration are the same Base UI behaviour
 * every other overlay in the app gets — this component used to carry its own
 * copy of all of it, including a second hand-rolled Tab cycle.
 *
 * The list is `cmdk`, which owns arrow-key movement, the active descendant and
 * Enter-to-select. Filtering is NOT delegated to it: `shouldFilter={false}`
 * keeps `filterQuickNavigationDestinations`, which ranks and caps results and
 * matches on the meta line as well as the label, so what the palette finds is
 * unchanged from before.
 */
export function QuickNavigation({
  open,
  data,
  isAdmin,
  onOpen,
  onClose,
}: {
  open: boolean
  data: DashboardData | null
  isAdmin: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  const destinations = useMemo(
    () => buildQuickNavigationDestinations(data, isAdmin),
    [data, isAdmin],
  )
  const results = useMemo(
    () => filterQuickNavigationDestinations(destinations, query),
    [destinations, query],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        open ? onClose() : onOpen()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, onOpen, open])

  // A fresh query each time it opens: the palette is a jump, not a session.
  useEffect(() => { if (open) setQuery('') }, [open])

  if (!open) return null

  const choose = (destination: QuickNavigationDestination) => {
    navigate(destination.to)
    onClose()
  }

  return (
    <Dialog
      title="Go to"
      description="Search pages, accounts, or campaigns."
      onRequestClose={onClose}
      closeLabel="Close quick navigation"
      className="quick-nav"
    >
      {/* cmdk points the input's `aria-labelledby` at its own hidden label, and
        * `aria-labelledby` beats `aria-label` in name computation — so the name
        * has to be set through cmdk's `label`, not on the input. */}
      <Command shouldFilter={false} loop label="Search destinations">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search pages, accounts, or campaigns"
        />
        <CommandList>
          <CommandEmpty>
            <Search size={20} aria-hidden="true" />
            <strong>No destinations found</strong>
            <span>Try a page, account, or campaign name.</span>
          </CommandEmpty>
          {results.map((destination) => {
            const Icon = destination.icon ?? (
              destination.kind === 'account' ? UserRound : Megaphone
            )
            return (
              <CommandItem
                key={destination.id}
                value={destination.id}
                onSelect={() => choose(destination)}
              >
                <span className="quick-nav-result-icon" aria-hidden="true">
                  <Icon size={17} />
                </span>
                <span className="quick-nav-result-copy">
                  <strong>{destination.label}</strong>
                  <span>{destination.meta}</span>
                </span>
                <ArrowRight size={15} aria-hidden="true" />
              </CommandItem>
            )
          })}
        </CommandList>
      </Command>
    </Dialog>
  )
}
