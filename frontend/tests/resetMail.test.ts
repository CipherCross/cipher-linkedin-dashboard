/**
 * Reset-link delivery.
 *
 * The flow this covers was dead in production and nothing failed: the provider's
 * default sink discards the link, so an invited account — created with a
 * passphrase nobody knows — had no route in at all. These assert the sink is
 * built only when a deployment has a sender, that it delivers, and that a
 * refusal is not reported as delivery.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  RESET_MAIL_API_KEY_ENV,
  RESET_MAIL_FROM_ENV,
  createResetLinkSink,
  readResetMailConfig,
} from '../api/_lib/identity/resetMail.js'

const LINK = {
  email: 'invited@example.test',
  token: 'single-use-token',
  url: 'https://tenant.example.test/#/reset-password?token=single-use-token',
}

describe('the sender a deployment carries', () => {
  it('is absent until both values are bound', () => {
    expect(readResetMailConfig({})).toBeNull()
    expect(readResetMailConfig({ [RESET_MAIL_API_KEY_ENV]: 'key' })).toBeNull()
    expect(readResetMailConfig({ [RESET_MAIL_FROM_ENV]: 'a@b.test' })).toBeNull()
    // Blank is absent, not a sender that fails on the first delivery.
    expect(
      readResetMailConfig({ [RESET_MAIL_API_KEY_ENV]: '  ', [RESET_MAIL_FROM_ENV]: 'a@b.test' }),
    ).toBeNull()
  })

  it('is read from the two bound values', () => {
    expect(
      readResetMailConfig({ [RESET_MAIL_API_KEY_ENV]: ' key ', [RESET_MAIL_FROM_ENV]: ' a@b.test ' }),
    ).toEqual({ apiKey: 'key', from: 'a@b.test' })
  })
})

describe('delivering the link', () => {
  it('sends the provider\'s own URL to the address that asked', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    try {
      await createResetLinkSink({ apiKey: 'key', from: 'CipherCross <a@b.test>' })(LINK)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    const body = JSON.parse(String(init.body)) as { to: string[]; from: string; text: string }
    expect(body.to).toEqual([LINK.email])
    expect(body.from).toBe('CipherCross <a@b.test>')
    // The link is passed through exactly as built; a rewritten one would point
    // at a host the token was not issued for.
    expect(body.text).toContain(LINK.url)
  })

  it('fails the request instead of reporting mail it never sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"invited@example.test"}', { status: 422 })))
    try {
      const sink = createResetLinkSink({ apiKey: 'key', from: 'a@b.test' })
      await expect(sink(LINK)).rejects.toThrow(/422/)
      // The provider's body can quote the recipient back, so only the status
      // travels.
      await expect(sink(LINK)).rejects.not.toThrow(/example\.test/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
