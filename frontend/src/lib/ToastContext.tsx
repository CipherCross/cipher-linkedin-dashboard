import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react'
import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'

// Tiny dependency-free toast system: one context, one fixed viewport. Write
// actions (playbook/config save, import, briefing, classify) call useToast()
// instead of swapping inline status text. Success/info auto-dismiss; errors are
// sticky (manual dismiss) so a failure isn't missed after the user looks away.

type ToastKind = 'success' | 'error' | 'info'

interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  show: (message: string, kind?: ToastKind) => void
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

const noop = () => {}
const Ctx = createContext<ToastApi>({ show: noop, success: noop, error: noop, info: noop })

const AUTO_DISMISS_MS = 5000
const ICON = { success: CircleCheck, error: CircleAlert, info: Info } as const

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
    const timer = timers.current[id]
    if (timer) {
      clearTimeout(timer)
      delete timers.current[id]
    }
  }, [])

  const show = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = nextId.current++
      setToasts((list) => [...list, { id, kind, message }])
      // Errors stay until dismissed; everything else fades on its own.
      if (kind !== 'error') {
        timers.current[id] = setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
      }
    },
    [dismiss],
  )

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (m: string) => show(m, 'success'),
      error: (m: string) => show(m, 'error'),
      info: (m: string) => show(m, 'info'),
    }),
    [show],
  )

  // Clear any pending timers if the provider unmounts.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of Object.values(pending)) clearTimeout(t)
    }
  }, [])

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-viewport" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => {
          const Icon = ICON[t.kind]
          return (
            <div key={t.id} className={`toast ${t.kind}`} role="status">
              <Icon size={16} className="toast-icon" aria-hidden="true" />
              <span className="toast-msg">{t.message}</span>
              <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          )
        })}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
