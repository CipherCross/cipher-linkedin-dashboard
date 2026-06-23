import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import { ConversationDrawer } from '../components/ConversationDrawer'
import type { Lead } from './types'

const Ctx = createContext<{ openConversation: (lead: Lead) => void }>({
  openConversation: () => {},
})

/** Holds the lead whose conversation is open and renders the single shared
 *  drawer. Mounted inside the router + DataProvider so the drawer can use
 *  router Links and refetch dashboard data after a reclassification. */
export function ConversationProvider({ children }: { children: ReactNode }) {
  const [lead, setLead] = useState<Lead | null>(null)
  const openConversation = useCallback((l: Lead) => setLead(l), [])
  return (
    <Ctx.Provider value={{ openConversation }}>
      {children}
      <ConversationDrawer lead={lead} onClose={() => setLead(null)} />
    </Ctx.Provider>
  )
}

export const useConversation = () => useContext(Ctx)
