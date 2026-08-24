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
  it('never redirects API or cron requests away from their authenticated origin', () => {
    expect(manifest.redirects).toContainEqual({
      source: '/:path((?!api/).*)',
      has: [
        {
          type: 'host',
          value: 'cipher-linkedin-dashboard.*\\.vercel\\.app',
        },
      ],
      destination: 'https://ciphercross.dev/:path*',
      permanent: false,
    })
    expect(manifest.crons).toHaveLength(4)
    expect(manifest.crons.every(({ path }) => path.startsWith('/api/'))).toBe(true)
  })
})
