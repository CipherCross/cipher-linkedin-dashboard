import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ConversationDrawer } from '../components/ConversationDrawer'
import type { Lead } from './types'

const Ctx = createContext<{ openConversation: (lead: Lead) => void }>({
  openConversation: () => {},
})

// Matches the 0.15s reverse keyframes in styles.css, with a small margin.
const CLOSE_MS = 160

/** Holds the lead whose conversation is open and renders the single shared
 *  drawer. Mounted inside the router + DataProvider so the drawer can use
 *  router Links and refetch dashboard data after a reclassification. */
export function ConversationProvider({ children }: { children: ReactNode }) {
  const [lead, setLead] = useState<Lead | null>(null)
  // Kept mounted through the close animation, then unmounted after CLOSE_MS.
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()

  const clearTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = undefined
    }
  }

  const openConversation = useCallback((l: Lead) => {
    clearTimer()
    setClosing(false)
    setLead(l)
  }, [])

  const close = useCallback(() => {
    setClosing(true)
    clearTimer()
    closeTimer.current = setTimeout(() => {
      setLead(null)
      setClosing(false)
      closeTimer.current = undefined
    }, CLOSE_MS)
  }, [])

  useEffect(() => () => clearTimer(), [])

  return (
    <Ctx.Provider value={{ openConversation }}>
      {children}
      <ConversationDrawer lead={lead} closing={closing} onClose={close} />
    </Ctx.Provider>
  )
}

export const useConversation = () => useContext(Ctx)
