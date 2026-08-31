/**
 * The browser client must never take the app down at import time. A malformed
 * `VITE_SUPABASE_URL` — a placeholder, or a redacted value from `vercel env
 * pull` — used to throw inside `createClient` while this module was being
 * imported, which meant a blank page instead of the configuration banner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadClient(url: string | undefined, anonKey: string | undefined) {
  vi.resetModules()
  if (url === undefined) vi.stubEnv('VITE_SUPABASE_URL', '')
  else vi.stubEnv('VITE_SUPABASE_URL', url)
  if (anonKey === undefined) vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
  else vi.stubEnv('VITE_SUPABASE_ANON_KEY', anonKey)
  return (await import('../src/lib/supabase')).supabase
}

describe('Supabase browser client', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('is built when both values are usable', async () => {
    await expect(loadClient('https://example.supabase.co', 'anon-key')).resolves.not.toBeNull()
  })

  it('is null rather than fatal for an unusable URL', async () => {
    for (const url of ['[SENSITIVE]', 'YOUR-PROJECT', 'not a url', '', 'ftp://example.com']) {
      await expect(loadClient(url, 'anon-key')).resolves.toBeNull()
    }
  })

  it('is null when either value is missing', async () => {
    await expect(loadClient(undefined, 'anon-key')).resolves.toBeNull()
    await expect(loadClient('https://example.supabase.co', undefined)).resolves.toBeNull()
  })
})
