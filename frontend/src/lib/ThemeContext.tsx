import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

// Dependency-free light/dark theme. The actual DOM decision (which `data-theme`
// to paint) is made by an inline boot script in index.html BEFORE this bundle
// runs, so there's no flash of the wrong theme. This provider just mirrors that
// decision into React state and owns the toggle + persistence from then on.

type Theme = 'light' | 'dark'

const STORAGE_KEY = 'theme'
// Must match the page background token per theme — used to keep the mobile
// browser chrome (`<meta name="theme-color">`) in step with the UI.
const BG: Record<Theme, string> = { dark: '#0b1120', light: '#f4f6fb' }

interface ThemeApi {
  theme: Theme
  toggle: () => void
}

const Ctx = createContext<ThemeApi>({ theme: 'dark', toggle: () => {} })

/** Resolve the current theme. Prefer the attribute the boot script already set
 *  (keeps React in sync with the painted DOM); fall back to localStorage, then
 *  the OS preference, then dark. */
function readInitialTheme(): Theme {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme')
    if (attr === 'light' || attr === 'dark') return attr
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    /* localStorage may be unavailable (private mode) — fall through */
  }
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  ) {
    return 'light'
  }
  return 'dark'
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', BG[theme])
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readInitialTheme)

  // Keep the DOM (and browser chrome colour) in step with state on every change.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem(STORAGE_KEY, next)
      } catch {
        /* ignore write failures — the choice just won't persist */
      }
      return next
    })
  }, [])

  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>
}

export const useTheme = () => useContext(Ctx)
