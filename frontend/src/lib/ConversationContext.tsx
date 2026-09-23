import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { ConversationDrawer } from '../components/ConversationDrawer'
import type { Lead } from './types'

export type ConversationMode = 'thread' | 'follow_up' | 'import_history'

const Ctx = createContext<{
  openConversation: (lead: Lead, options?: { mode?: ConversationMode }) => void
}>({
  openConversation: () => {},
})

/** Holds the lead whose conversation is open and renders the single shared
 *  drawer. Mounted inside the router + DataProvider so the drawer can use
 *  router Links and refetch dashboard data after a reclassification. */
export function ConversationProvider({ children }: { children: ReactNode }) {
  const [lead, setLead] = useState<Lead | null>(null)
  const [mode, setMode] = useState<ConversationMode>('thread')

  const openConversation = useCallback((l: Lead, options?: { mode?: ConversationMode }) => {
    setMode(options?.mode ?? 'thread')
    setLead(l)
  }, [])

  /* Closing unmounts the drawer at once. The shared Dialog restores focus to
   * whatever opened it as it unmounts, so the old 160ms reverse-animation
   * delay would only have held a dismissed dialog on screen. */
  const close = useCallback(() => {
    setLead(null)
    setMode('thread')
  }, [])

  // The drawer is modal to the page it was opened from — navigating (browser
  // back, a link inside the drawer, …) must not leave it floating over the new
  // page. Lead is read via ref so opening the drawer doesn't retrigger this.
  const { pathname } = useLocation()
  const leadRef = useRef(lead)
  leadRef.current = lead
  useEffect(() => {
    if (leadRef.current) close()
  }, [pathname, close])

  return (
    <Ctx.Provider value={{ openConversation }}>
      {children}
      {/* Keyed per open, so the drawer's view state starts from `mode` on its
          first frame. Otherwise it renders the thread for one frame, the
          thread takes focus, and switching to the requested view drops it. */}
      <ConversationDrawer key={lead ? `${lead.id}:${mode}` : 'closed'} lead={lead} initialMode={mode} onClose={close} />
    </Ctx.Provider>
  )
}

export const useConversation = () => useContext(Ctx)
