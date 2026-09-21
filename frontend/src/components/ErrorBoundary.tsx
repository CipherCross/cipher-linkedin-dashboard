import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { TriangleAlert, RotateCw } from 'lucide-react'
import { Logo } from './Logo'

interface Props {
  children: ReactNode
  /** 'screen' (default) white-screens into a branded full-page retry; 'inline'
   *  renders a card-styled message that leaves the surrounding shell intact. */
  variant?: 'screen' | 'inline'
}
interface State {
  error: Error | null
}

/** Render-error boundary. As the top-level fallback ('screen') it shows a
 *  branded retry page instead of white-screening the app; wrapped tighter
 *  around routed content ('inline') it contains a single page crash so the app
 *  bar and nav stay usable. "Try again" clears the error and re-renders; if the
 *  fault is persistent it re-throws (or the user can navigate/reload). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    if (this.props.variant === 'inline') {
      return (
        <div className="card flex flex-col gap-2.5 items-start" role="alert">
          <div className="flex items-center gap-2.5 text-app-danger">
            <TriangleAlert size={18} />
            <h2 className="mt-1 mx-0 mb-0 text-[length:var(--text-lg)]">This page failed to load</h2>
          </div>
          <p className="m-0 text-app-text-secondary leading-[1.5]">
            Something went wrong while rendering this view. The rest of the
            dashboard is still available from the navigation above.
          </p>
          {error.message && <pre className="w-full text-left bg-[var(--code-bg)] border border-app-border rounded-md px-app-md py-2.5 font-mono text-[length:var(--text-xs)] text-app-danger whitespace-pre-wrap [word-break:break-word] max-h-40 overflow-y-auto m-0">{error.message}</pre>}
          <div className="flex gap-2.5 mt-0.5">
            <button className="btn accent" onClick={() => this.setState({ error: null })}>
              <RotateCw size={15} />
              Try again
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="min-h-screen flex items-center justify-center p-app-xl">
        <div className="w-full max-w-[440px] flex flex-col items-center gap-app-md text-center bg-app-surface border border-app-border rounded-lg shadow-[var(--shadow-overlay)] px-7 py-8">
          <Logo size={40} />
          <h1 className="mt-1 mx-0 mb-0 text-[length:var(--text-xl)]">Something went wrong</h1>
          <p className="m-0 text-app-text-secondary leading-[1.5]">
            The dashboard hit an unexpected error while rendering this view.
          </p>
          {error.message && <pre className="w-full text-left bg-[var(--code-bg)] border border-app-border rounded-md px-app-md py-2.5 font-mono text-[length:var(--text-xs)] text-app-danger whitespace-pre-wrap [word-break:break-word] max-h-40 overflow-y-auto m-0">{error.message}</pre>}
          <div className="flex gap-2.5 mt-0.5">
            <button className="btn accent" onClick={() => this.setState({ error: null })}>
              <RotateCw size={15} />
              Try again
            </button>
            <button className="btn" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
          <div className="inline-flex items-center gap-1.5 mt-1 muted small">
            <TriangleAlert size={13} />
            If this keeps happening, check the browser console and Sync health.
          </div>
        </div>
      </div>
    )
  }
}
