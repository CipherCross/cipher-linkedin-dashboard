import { useEffect } from 'react'

/** Poll only while visible, and refresh immediately when the user returns. */
export function useVisibleInterval(callback: () => void, delay: number | null): void {
  useEffect(() => {
    if (delay === null) return
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') callback()
    }
    const timer = window.setInterval(refreshVisible, delay)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [callback, delay])
}
