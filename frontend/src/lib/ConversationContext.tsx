import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { ConversationDrawer } from '../components/ConversationDrawer'
import type { Lead } from './types'

export type ConversationMode = 'thread' | 'follow_up'

const Ctx = createContext<{
  openConversation: (lead: Lead, options?: { mode?: ConversationMode }) => void
}>({
  openConversation: () => {},
})

// Matches the 0.15s reverse keyframes in styles.css, with a small margin.
const CLOSE_MS = 160

/** Holds the lead whose conversation is open and renders the single shared
 *  drawer. Mounted inside the router + DataProvider so the drawer can use
 *  router Links and refetch dashboard data after a reclassification. */
export function ConversationProvider({ children }: { children: ReactNode }) {
  const [lead, setLead] = useState<Lead | null>(null)
  const [mode, setMode] = useState<ConversationMode>('thread')
  // Kept mounted through the close animation, then unmounted after CLOSE_MS.
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()

  const clearTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = undefined
    }
  }

  const openConversation = useCallback((l: Lead, options?: { mode?: ConversationMode }) => {
    clearTimer()
    setClosing(false)
    setMode(options?.mode ?? 'thread')
    setLead(l)
  }, [])

  const close = useCallback(() => {
    setClosing(true)
    clearTimer()
    closeTimer.current = setTimeout(() => {
      setLead(null)
      setMode('thread')
      setClosing(false)
      closeTimer.current = undefined
    }, CLOSE_MS)
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

  useEffect(() => () => clearTimer(), [])

  return (
    <Ctx.Provider value={{ openConversation }}>
      {children}
      <ConversationDrawer lead={lead} initialMode={mode} closing={closing} onClose={close} />
    </Ctx.Provider>
  )
}

export const useConversation = () => useContext(Ctx)
