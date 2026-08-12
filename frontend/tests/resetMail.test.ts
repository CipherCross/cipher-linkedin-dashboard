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
  currentMailPurpose,
  readResetMailConfig,
  withMailPurpose,
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

describe('which letter the link arrives in', () => {
  const sender = { apiKey: 'key', from: 'a@b.test', baseUrl: 'https://tenant.example.test' }

  const sent = async (send: (sink: ReturnType<typeof createResetLinkSink>) => Promise<unknown>) => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    try {
      await send(createResetLinkSink(sender))
    } finally {
      vi.unstubAllGlobals()
    }
    // Same cast the delivery tests above use: the stub takes no declared
    // parameters, so its recorded calls type as an empty tuple.
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][]
    return calls.map(
      ([, init]) => JSON.parse(String(init.body)) as { subject: string; text: string },
    )
  }

  it('tells a person who forgot their password that they asked for it', async () => {
    const [mail] = await sent((sink) => Promise.resolve(sink(LINK)))
    expect(mail.subject).toBe('Reset your dashboard password')
    expect(mail.text).toContain('did not ask for it')
  })

  it('tells an invited person an account was made for them', async () => {
    // The same token and the same screen. Only the words differ — and they have
    // to: "reset your password" reaching somebody who has never had an account
    // reads as an attack on one, and gets deleted.
    const [mail] = await sent((sink) =>
      withMailPurpose('invitation', async () => {
        await sink(LINK)
      }),
    )
    expect(mail.subject).toBe('Your dashboard account is ready')
    expect(mail.text).toContain('created a dashboard account for you')
    expect(mail.text).toContain(`https://tenant.example.test/#/reset-password?token=${LINK.token}`)
  })

  it('keeps two overlapping sends out of each other\'s letters', async () => {
    // Why the purpose is an AsyncLocalStorage and not a module flag. A warm
    // instance serves overlapping requests: with a flag, the reset below —
    // started inside the invite and finished after it — would be sent as an
    // invitation, telling somebody an account had just been created for them.
    let releaseInvite: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseInvite = resolve
    })

    const mails = await sent(async (sink) => {
      const invitation = withMailPurpose('invitation', async () => {
        await gate
        await sink({ ...LINK, token: 'invited' })
      })
      const reset = withMailPurpose('reset', async () => {
        await sink({ ...LINK, token: 'forgot' })
      })
      await reset
      releaseInvite()
      await invitation
    })

    const [first, second] = mails
    expect(first.text).toContain('forgot')
    expect(first.subject).toBe('Reset your dashboard password')
    expect(second.text).toContain('invited')
    expect(second.subject).toBe('Your dashboard account is ready')
  })

  it('treats an unmarked send as a reset', async () => {
    // The default is the flow a caller reaches without going through this
    // module at all, so it is the one that must not need marking.
    expect(currentMailPurpose()).toBe('reset')
  })
})

describe('what the caller is told actually happened', () => {
  const sender = { apiKey: 'key', from: 'a@b.test', baseUrl: 'https://tenant.example.test' }

  it('records a delivery the provider accepted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    try {
      const { attempts } = await withMailPurpose('invitation', async () => {
        await createResetLinkSink(sender)(LINK)
      })
      expect(attempts).toEqual([{ ok: true, status: 200 }])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('records a refusal, so a 200 upstream cannot pass for delivery', async () => {
    // The candidate awaits the sink and swallows what it throws, then answers
    // 200. Without this record there is nothing left anywhere that knows the
    // letter was refused.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 422 })))
    try {
      const { attempts } = await withMailPurpose('invitation', async () => {
        try {
          await createResetLinkSink(sender)(LINK)
        } catch {
          // The refusal is the point; what it recorded is what is asserted.
        }
      })
      expect(attempts).toEqual([{ ok: false, status: 422 }])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('records a provider it could not reach at all', async () => {
    // An unreachable provider is the one thing that must not read as "nothing
    // was attempted": nothing-attempted is how an unknown address looks, and it
    // is deliberately not an error.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }))
    try {
      const { attempts } = await withMailPurpose('reset', async () => {
        try {
          await createResetLinkSink(sender)(LINK)
        } catch {
          // The refusal is the point; what it recorded is what is asserted.
        }
      })
      expect(attempts).toEqual([{ ok: false }])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports no attempt when nothing sent, which is not the same as a failure', async () => {
    const { attempts } = await withMailPurpose('invitation', async () => undefined)
    expect(attempts).toEqual([])
  })
})
