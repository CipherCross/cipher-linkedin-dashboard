// @vitest-environment jsdom
/**
 * The shell and access surfaces after Phase 2 of the component redesign:
 * every pre-session state renders on one card with one primary submit, form
 * errors sit above the fields they concern, the admin gate still refuses a
 * member, and hiding/showing the sidebar moves focus to the control that
 * brings it back.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { AuthContext, AuthGate, type AuthContextValue } from '../src/lib/AuthContext'

vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({ data: { instances: [], campaigns: [], error: null }, loading: false, phase: 'full', refetch: vi.fn() }),
}))
vi.mock('../src/lib/ConversationContext', () => ({
  ConversationProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

function auth(overrides: Partial<AuthContextValue>): AuthContextValue {
  return {
    status: 'signed_out',
    authPath: 'identity',
    user: null,
    member: null,
    isAdmin: false,
    error: null,
    signIn: vi.fn(async () => {}),
    requestPasswordReset: vi.fn(async () => {}),
    setPassword: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    ...overrides,
  } as AuthContextValue
}

function renderGate(value: AuthContextValue) {
  return render(
    <AuthContext.Provider value={value}>
      <AuthGate><p>Signed-in app</p></AuthGate>
    </AuthContext.Provider>,
  )
}

const primaryButtons = () => document.querySelectorAll('.ui-btn--primary')
const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })

describe('pre-session screens', () => {
  it('signs in through one primary submit and shows the error above the fields', async () => {
    const value = auth({ error: 'Invalid email or password.' })
    renderGate(value)
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeTruthy()
    expect(primaryButtons()).toHaveLength(1)

    const alert = screen.getByRole('alert')
    const email = screen.getByLabelText(/^Email/)
    expect(alert.textContent).toBe('Invalid email or password.')
    expect(alert.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.change(email, { target: { value: 'a@b.test' } })
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'secret' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })) })
    expect(value.signIn).toHaveBeenCalledWith('a@b.test', 'secret')
    expect(screen.queryByText('Signed-in app')).toBeNull()
  })

  it('switches to recovery and back without leaving the card', async () => {
    const value = auth({})
    renderGate(value)
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Reset password' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'a@b.test' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send recovery link' })) })
    expect(value.requestPasswordReset).toHaveBeenCalledWith('a@b.test')
    expect(screen.getByRole('status').textContent).toContain('recovery link is on its way')
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeTruthy()
  })

  it('refuses mismatched passwords before calling the server', () => {
    const value = auth({ status: 'setting_password' })
    renderGate(value)
    fireEvent.change(screen.getByLabelText(/^New password/), { target: { value: 'aaaaaaaaaaaa' } })
    fireEvent.change(screen.getByLabelText(/^Confirm password/), { target: { value: 'bbbbbbbbbbbb' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save password' }))
    expect(screen.getByRole('alert').textContent).toBe('Passwords do not match.')
    expect(value.setPassword).not.toHaveBeenCalled()
  })

  it('offers a retry when the session cannot be checked, and sign-out when access is inactive', () => {
    const unavailable = auth({ status: 'unavailable', error: 'Identity service timed out' })
    renderGate(unavailable)
    expect(screen.getByRole('alert').textContent).toBe('Identity service timed out')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(unavailable.revalidate).toHaveBeenCalledTimes(1)
    cleanup()

    const inactive = auth({ status: 'unauthorized', user: { id: 'u1', email: 'old@b.test' } })
    renderGate(inactive)
    expect(screen.getByRole('heading', { level: 1, name: 'Access isn’t active' })).toBeTruthy()
    expect(screen.getByText('old@b.test')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(inactive.signOut).toHaveBeenCalledTimes(1)
  })

  it('shows the session check while initializing and the app once ready', () => {
    renderGate(auth({ status: 'initializing' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Checking your session…' })).toBeTruthy()
    cleanup()
    renderGate(auth({ status: 'ready' }))
    expect(screen.getByText('Signed-in app')).toBeTruthy()
  })
})

describe('admin gate', () => {
  it('refuses a member and admits an admin', async () => {
    const { AdminOnly } = await import('../src/App')
    const view = (isAdmin: boolean) => (
      <AuthContext.Provider value={auth({ status: 'ready', isAdmin })}>
        <AdminOnly><p>Importer</p></AdminOnly>
      </AuthContext.Provider>
    )
    const { rerender } = render(view(false))
    expect(screen.getByRole('heading', { level: 1, name: 'Admin access required' })).toBeTruthy()
    expect(screen.queryByText('Importer')).toBeNull()
    rerender(view(true))
    expect(screen.getByText('Importer')).toBeTruthy()
  })
})

describe('sidebar', () => {
  async function renderLayout(isAdmin: boolean) {
    const { Layout } = await import('../src/components/Layout')
    return render(
      <AuthContext.Provider value={auth({ status: 'ready', isAdmin, member: { id: 1, name: 'Fixture', role: isAdmin ? 'admin' : 'member' } as never })}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<h1>Overview</h1>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )
  }

  it('moves focus to Show navigation on hide and back to Go to… on show', async () => {
    await renderLayout(true)
    const sidebar = screen.getByRole('complementary', { name: 'Primary' })
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Hide navigation' }))
    await frame()
    expect(sidebar.getAttribute('aria-hidden')).toBe('true')
    const show = screen.getByRole('button', { name: 'Show navigation' })
    expect(document.activeElement).toBe(show)

    fireEvent.click(show)
    await frame()
    expect(sidebar.getAttribute('aria-hidden')).toBeNull()
    expect(document.activeElement?.textContent).toContain('Go to…')
  })

  it('toggles a navigation group through its disclosure button', async () => {
    await renderLayout(true)
    const sidebar = screen.getByRole('complementary', { name: 'Primary' })
    const trigger = within(sidebar).getAllByRole('button', { expanded: false })
      .find((button) => button.getAttribute('aria-controls')?.startsWith('nav-section-links-'))!
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toBeTruthy()
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('hides admin-only destinations from a member', async () => {
    const admin = await renderLayout(true)
    const adminLinks = within(screen.getByRole('complementary', { name: 'Primary' })).getAllByRole('link').map((link) => link.textContent)
    admin.unmount()
    await renderLayout(false)
    const memberLinks = within(screen.getByRole('complementary', { name: 'Primary' })).getAllByRole('link').map((link) => link.textContent)
    expect(adminLinks).toContain('CSV Import')
    expect(memberLinks).not.toContain('CSV Import')
  })
})

describe('route error boundary', () => {
  it('replaces a crashed route with an alert and recovers on Try again', async () => {
    const { ErrorBoundary } = await import('../src/components/ErrorBoundary')
    const crash = { on: true }
    function Route() {
      if (crash.on) throw new Error('render exploded')
      return <p>Route content</p>
    }
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary variant="inline"><Route /></ErrorBoundary>)
    const alert = screen.getByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'This page failed to load' })).toBeTruthy()
    expect(within(alert).getByText('render exploded')).toBeTruthy()
    crash.on = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('Route content')).toBeTruthy()
    quiet.mockRestore()
  })
})
