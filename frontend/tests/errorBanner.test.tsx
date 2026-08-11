// @vitest-environment jsdom
/**
 * The banner names no provider.
 *
 * This is the test the original defect did not have. `Layout.tsx` hardcoded
 * `Supabase error:` in front of every failure the dashboard reported, so a
 * tenant whose deployment binds no Supabase value at all announced a Neon read
 * failure as a Supabase one — and the owner's first S27 alert was that sentence.
 * Nothing asserted the banner's text, which is why a literal that was wrong on
 * every tenant survived the whole migration.
 *
 * The assertion is deliberately about the *absence* of a provider name rather
 * than about the exact wording: the wording may be edited, but a banner that
 * names a database it cannot know about is the bug, and it must stay caught.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorBanner } from '../src/components/Layout'

afterEach(cleanup)

/** Every provider this codebase has ever spoken to. */
const PROVIDER_NAMES = [/supabase/i, /neon/i, /postgres/i, /vercel/i]

describe('the dashboard error banner', () => {
  it('reports the failure without attributing it to a provider', () => {
    render(
      <ErrorBanner
        message="hypotheses.campaigns: Could not verify team access"
        onRetry={vi.fn()}
      />,
    )

    const alert = screen.getByRole('alert')
    // The message the server gave survives intact — the operation that failed is
    // the only part of this line that identifies anything.
    expect(alert.textContent).toContain(
      'hypotheses.campaigns: Could not verify team access',
    )
    for (const provider of PROVIDER_NAMES) {
      expect(alert.textContent).not.toMatch(provider)
    }
  })

  it('carries no provider name for a message that has none either', () => {
    render(
      <ErrorBanner
        message="The dashboard database is not accepting connections right now — retry in a moment (DATASTORE_CONNECT_FAILED)"
        onRetry={vi.fn()}
      />,
    )

    const alert = screen.getByRole('alert')
    // The code an operator needs is in the message and must reach the screen.
    expect(alert.textContent).toContain('DATASTORE_CONNECT_FAILED')
    for (const provider of PROVIDER_NAMES) {
      expect(alert.textContent).not.toMatch(provider)
    }
  })

  it('still offers the retry the banner exists to offer', () => {
    render(<ErrorBanner message="anything" onRetry={vi.fn()} />)
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()
  })
})
