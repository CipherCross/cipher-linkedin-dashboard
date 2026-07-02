import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { TriangleAlert, RotateCw } from 'lucide-react'
import { Logo } from './Logo'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

/** Top-level boundary so a render error shows a branded retry screen instead of
 *  white-screening the app. "Try again" clears the error and re-renders; if the
 *  fault is persistent it re-throws and the user can reload. */
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
