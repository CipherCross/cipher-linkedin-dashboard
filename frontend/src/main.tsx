import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter/opsz.css'
import App from './App'
import './styles.css'

/** A tab can keep the previous deployment's entry bundle open while Vercel
 * replaces its hashed lazy-route chunks. Vite emits this event when navigation
 * then requests a chunk that no longer exists. Reload once for that exact
 * failure so the tab picks up the current index and asset manifest.
 *
 * Keep the failed message in session storage: if the current deployment really
 * is broken, the same error reaches the boundary after one retry instead of
 * creating a reload loop. A later deployment has different hashed asset URLs,
 * so it gets its own recovery attempt. */
const PRELOAD_RETRY_KEY = 'vite-preload-retry'

window.addEventListener('vite:preloadError', (event) => {
  const payload = (event as Event & { payload?: unknown }).payload
  const failure =
    payload instanceof Error
      ? payload.message
      : typeof payload === 'string'
        ? payload
        : 'unknown preload failure'

  try {
    if (sessionStorage.getItem(PRELOAD_RETRY_KEY) === failure) return
    sessionStorage.setItem(PRELOAD_RETRY_KEY, failure)
  } catch {
    // Without durable per-tab state, an automatic retry could reload forever.
    return
  }

  event.preventDefault()
  window.location.reload()
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
