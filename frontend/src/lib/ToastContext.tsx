import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { toast as sonner } from 'sonner'
import { Toaster } from '../components/ui/sonner'

/**
 * App-wide transient messages.
 *
 * The queue, the timers, the id counter, the viewport and the dismiss
 * bookkeeping are Sonner's now; this file is the seam that keeps the app's own
 * API, so no call site knows the implementation changed.
 *
 * The one product rule that is NOT Sonner's default is preserved explicitly:
 * **an error stays until it is dismissed**, everything else fades after five
 * seconds. An error the operator never saw is the whole reason this is not
 * just a nicer-looking toast.
 */

type ToastKind = 'success' | 'error' | 'info'

interface ToastApi {
  show: (message: string, kind?: ToastKind) => void
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

const AUTO_DISMISS_MS = 5000

function emit(message: string, kind: ToastKind) {
  if (kind === 'error') {
    sonner.error(message, { duration: Infinity, closeButton: true })
    return
  }
  const fn = kind === 'success' ? sonner.success : sonner.info
  fn(message, { duration: AUTO_DISMISS_MS })
}

/**
 * Kept as a provider even though Sonner needs no context: it is what mounts
 * the viewport, and every call site already renders inside it. Removing it
 * would be a second, unrelated change to App.tsx and eleven consumers.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster position="bottom-right" richColors={false} />
    </>
  )
}

export const useToast = (): ToastApi =>
  useMemo(
    () => ({
      show: (message, kind = 'info') => emit(message, kind),
      success: (message) => emit(message, 'success'),
      error: (message) => emit(message, 'error'),
      info: (message) => emit(message, 'info'),
    }),
    [],
  )
