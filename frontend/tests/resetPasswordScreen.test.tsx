// @vitest-environment jsdom
/**
 * The screen a recovery link opens.
 *
 * It is the only route into a new account on this platform — every account is
 * created with a passphrase nobody knows — and it did not exist: the invitation
 * pointed at `/#/reset-password`, the SPA had no such route, and the link
 * therefore opened the ordinary app with no form on it. These cover the two
 * halves that failure was made of: reading the token out of the hash, and
 * actually sending it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ResetPassword,
  resetTokenFromHash,
} from '../src/pages/ResetPassword'
import * as identityAuth from '../src/lib/identityAuth'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('reading the token out of the link', () => {
  it('accepts only the reset route, and only with a token', () => {
    expect(resetTokenFromHash('#/reset-password?token=abc')).toBe('abc')
    expect(resetTokenFromHash('#/reset-password/?token=abc')).toBe('abc')
    expect(resetTokenFromHash('#/reset-password')).toBeNull()
    expect(resetTokenFromHash('#/reset-password?token=')).toBeNull()
    // Any other route must fall through to the gated app; a screen that
    // rendered for `#/leads` would put an unauthenticated form over the whole
    // dashboard.
    expect(resetTokenFromHash('#/leads?token=abc')).toBeNull()
    expect(resetTokenFromHash('')).toBeNull()
  })
})

describe('setting the password', () => {
  function fill(password: string, confirmation = password) {
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } })
    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: confirmation } })
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }))
  }

  it('sends the token from the link with the new password', async () => {
    const complete = vi
      .spyOn(identityAuth, 'completePasswordReset')
      .mockResolvedValue({ kind: 'ok' })
    render(<ResetPassword token="link-token" />)
    fill('a-long-enough-password')
    await waitFor(() => expect(complete).toHaveBeenCalledWith('link-token', 'a-long-enough-password'))
    expect(await screen.findByText('Password set')).toBeTruthy()
  })

  it('refuses a mismatch and a short password without calling the server', () => {
    const complete = vi.spyOn(identityAuth, 'completePasswordReset').mockResolvedValue({ kind: 'ok' })
    render(<ResetPassword token="link-token" />)
    fill('a-long-enough-password', 'something-else')
    expect(screen.getByRole('alert').textContent).toContain('do not match')
    fill('short')
    expect(screen.getByRole('alert').textContent).toContain('at least 8')
    expect(complete).not.toHaveBeenCalled()
  })

  it('shows the refusal instead of claiming the password was set', async () => {
    vi.spyOn(identityAuth, 'completePasswordReset').mockResolvedValue({
      kind: 'refused',
      message: 'This link has expired.',
    })
    render(<ResetPassword token="stale-token" />)
    fill('a-long-enough-password')
    expect((await screen.findByRole('alert')).textContent).toContain('This link has expired.')
    expect(screen.queryByText('Password set')).toBeNull()
  })
})
