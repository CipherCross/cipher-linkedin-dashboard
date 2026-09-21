import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface RoutingManifest {
  readonly crons: readonly { readonly path: string; readonly schedule: string }[]
  readonly redirects: readonly {
    readonly source: string
    readonly destination: string
    readonly has?: readonly { readonly type: string; readonly value: string }[]
  }[]
}

const manifest = JSON.parse(
  readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
) as RoutingManifest

describe('canonical-host routing', () => {
  it('permanently redirects the old dashboard domain to the public site', () => {
    expect(manifest.redirects).toContainEqual({
      source: '/',
      has: [
        {
          type: 'host',
          value: 'ciphercross.dev',
        },
      ],
      destination: 'https://ciphercross.com/',
      permanent: true,
    })
    expect(manifest.redirects).toContainEqual({
      source: '/:path((?!api/).*)',
      has: [
        {
          type: 'host',
          value: 'ciphercross.dev',
        },
      ],
      destination: 'https://ciphercross.com/:path*',
      permanent: true,
    })
  })

  it('never redirects API or cron requests away from their authenticated origin', () => {
    expect(
      manifest.redirects
        .filter(({ source }) => source !== '/')
        .every(({ source }) => source === '/:path((?!api/).*)'),
    ).toBe(true)
    // The host pattern is EXACT, not `cipher-linkedin-dashboard.*\.vercel\.app`.
    // The wildcard matched every preview deployment as well as the production
    // alias, so opening a preview bounced to production — which is why nothing
    // in this repo could be reviewed before it shipped. Only the default
    // production host is redirected to the canonical domain now; branch and
    // deployment URLs load.
    expect(manifest.redirects).toContainEqual({
      source: '/:path((?!api/).*)',
      has: [
        {
          type: 'host',
          value: 'cipher-linkedin-dashboard\\.vercel\\.app',
        },
      ],
      destination: 'https://app.ciphercross.dev/:path*',
      permanent: false,
    })
    expect(manifest.crons).toHaveLength(4)
    expect(manifest.crons.every(({ path }) => path.startsWith('/api/'))).toBe(true)
  })
})
