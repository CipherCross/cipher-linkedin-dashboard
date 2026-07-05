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
        <div className="card crash-inline" role="alert">
          <div className="crash-inline-head">
            <TriangleAlert size={18} />
            <h2 className="crash-title">This page failed to load</h2>
          </div>
          <p className="crash-sub">
            Something went wrong while rendering this view. The rest of the
            dashboard is still available from the navigation above.
          </p>
          {error.message && <pre className="crash-detail">{error.message}</pre>}
          <div className="crash-actions">
            <button className="btn accent" onClick={() => this.setState({ error: null })}>
              <RotateCw size={15} />
              Try again
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="crash">
        <div className="crash-card">
          <Logo size={40} />
          <h1 className="crash-title">Something went wrong</h1>
          <p className="crash-sub">
            The dashboard hit an unexpected error while rendering this view.
          </p>
          {error.message && <pre className="crash-detail">{error.message}</pre>}
          <div className="crash-actions">
            <button className="btn accent" onClick={() => this.setState({ error: null })}>
              <RotateCw size={15} />
              Try again
            </button>
            <button className="btn" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
          <div className="crash-hint muted small">
            <TriangleAlert size={13} />
            If this keeps happening, check the browser console and Sync health.
          </div>
        </div>
      </div>
    )
  }
}
