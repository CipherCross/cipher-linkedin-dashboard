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

import { IDENTITY_BASE_URL_ENV } from '../api/_lib/identity/config.js'
import {
  RESET_MAIL_API_KEY_ENV,
  RESET_MAIL_FROM_ENV,
  ResetMailDeliveryError,
  createResetLinkSink,
  readResetMailConfig,
} from '../api/_lib/identity/resetMail.js'

const LINK = {
  email: 'invited@example.test',
  token: 'single-use-token',
  // What the candidate builds: its own server route. This deployment does not
  // serve it — the dispatcher forwards `?op=` operations only — so a link to it
  // lands on the SPA fallback, which is exactly what happened in production.
  url: 'https://tenant.example.test/api/identity/reset-password/single-use-token?callbackURL=x',
}

describe('the sender a deployment carries', () => {
  it('is absent until both values are bound', () => {
    expect(readResetMailConfig({})).toBeNull()
    expect(readResetMailConfig({ [RESET_MAIL_API_KEY_ENV]: 'key' })).toBeNull()
    expect(readResetMailConfig({ [RESET_MAIL_FROM_ENV]: 'a@b.test' })).toBeNull()
    // Without the origin there is no link to send, only a server route this
    // deployment does not serve.
    expect(
      readResetMailConfig({ [RESET_MAIL_API_KEY_ENV]: 'key', [RESET_MAIL_FROM_ENV]: 'a@b.test' }),
    ).toBeNull()
    // Blank is absent, not a sender that fails on the first delivery.
    expect(
      readResetMailConfig({
        [RESET_MAIL_API_KEY_ENV]: '  ',
        [RESET_MAIL_FROM_ENV]: 'a@b.test',
        [IDENTITY_BASE_URL_ENV]: 'https://tenant.example.test',
      }),
    ).toBeNull()
  })

  it('is read from the two bound values', () => {
    expect(
      readResetMailConfig({
        [RESET_MAIL_API_KEY_ENV]: ' key ',
        [RESET_MAIL_FROM_ENV]: ' a@b.test ',
        [IDENTITY_BASE_URL_ENV]: ' https://tenant.example.test ',
      }),
    ).toEqual({ apiKey: 'key', from: 'a@b.test', baseUrl: 'https://tenant.example.test' })
  })
})

describe('delivering the link', () => {
  it('sends the provider\'s own URL to the address that asked', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    try {
      await createResetLinkSink({
        apiKey: 'key',
        from: 'CipherCross <a@b.test>',
        baseUrl: 'https://tenant.example.test',
      })(LINK)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    const body = JSON.parse(String(init.body)) as { to: string[]; from: string; text: string }
    expect(body.to).toEqual([LINK.email])
    expect(body.from).toBe('CipherCross <a@b.test>')
    // The deployment's own reset screen, carrying the token in the hash — not
    // the candidate's server route, which this deployment does not expose and
    // which therefore landed on the SPA fallback with no form on it.
    expect(body.text).toContain(
      `https://tenant.example.test/#/reset-password?token=${LINK.token}`,
    )
    expect(body.text).not.toContain(LINK.url)
  })

  it('fails the request instead of reporting mail it never sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"invited@example.test"}', { status: 422 })))
    try {
      const sink = createResetLinkSink({
        apiKey: 'key',
        from: 'a@b.test',
        baseUrl: 'https://tenant.example.test',
      })
      // The status travels so the refusal is attributable from outside the
      // deployment; the provider's body never does.
      await expect(sink(LINK)).rejects.toThrow(ResetMailDeliveryError)
      await expect(sink(LINK)).rejects.toMatchObject({ status: 422 })
      // The provider's body can quote the recipient back, so only the status
      // travels.
      await expect(sink(LINK)).rejects.not.toThrow(/example\.test/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
