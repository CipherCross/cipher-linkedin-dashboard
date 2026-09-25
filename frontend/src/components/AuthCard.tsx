import type { FormEvent, ReactNode } from 'react'
import { Logo } from './Logo'

/**
 * The one surface every pre-session screen renders on: sign-in, recovery,
 * invitation, reset, and the unavailable/unauthorised states. A centred card,
 * one heading, the form, and one primary submit.
 */
export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen grid place-items-center p-app-xl bg-app-bg max-[700px]:p-card">
      <section
        className="w-[min(100%,440px)] p-app-xl border border-app-border rounded-dialog bg-app-surface [box-shadow:var(--shadow-overlay)] max-[700px]:p-card"
        aria-live="polite"
      >
        <div className="flex items-center gap-app-md pb-card mb-card border-b border-app-border">
          <Logo size={34} className="block rounded-[var(--radius-sm)]" />
          <div>
            <div className="text-app-subsection font-semibold">Outreach Deck</div>
            <div className="mt-0.5 text-app-meta text-app-text-muted">Team dashboard</div>
          </div>
        </div>
        {children}
      </section>
    </main>
  )
}

/** Heading plus the sentence under it. */
function AuthIntro({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-app-sm">
      <h1 className="m-0 text-app-page">{title}</h1>
      {children && <p className="m-0 text-app-body text-app-text-muted">{children}</p>}
    </div>
  )
}

/** A state with no form: loading, unavailable, unauthorised, done. */
export function AuthState({ title, children, description }: {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-app-lg">
      <AuthIntro title={title}>{description}</AuthIntro>
      {children}
    </div>
  )
}

/**
 * A pre-session form. `error` renders directly above the fields it concerns,
 * so it is read before the user edits them again.
 */
export function AuthForm({ title, description, error, onSubmit, children }: {
  title: ReactNode
  description?: ReactNode
  error?: ReactNode
  onSubmit: (event: FormEvent) => void
  children: ReactNode
}) {
  return (
    <form className="flex flex-col gap-app-lg" onSubmit={onSubmit}>
      <AuthIntro title={title}>{description}</AuthIntro>
      {error && <AuthMessage tone="danger">{error}</AuthMessage>}
      {children}
    </form>
  )
}

export function AuthMessage({ tone, children }: { tone: 'danger' | 'success'; children: ReactNode }) {
  return (
    <div
      className={tone === 'danger'
        ? 'p-app-md border border-app-danger-border rounded-control bg-app-danger-subtle text-app-danger text-app-table'
        : 'p-app-md border border-app-success-border rounded-control bg-app-success-subtle text-app-success text-app-table'}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      {children}
    </div>
  )
}
