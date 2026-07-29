import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  LEAD_PHOTO_SIGNED_URL_TTL_SECONDS,
  createLeadPhotoUrlLoader,
  normalizeLeadPhotoPath,
} from '../src/lib/leadPhotos'

function clientWith(
  createSignedUrl: (path: string, expiresIn: number) => Promise<{
    data: { signedUrl: string } | null
    error: Error | null
  }>,
): SupabaseClient {
  return {
    storage: {
      from: vi.fn(() => ({ createSignedUrl })),
    },
  } as unknown as SupabaseClient
}

describe('private lead photo delivery', () => {
  it('rejects public URLs and traversal-shaped object paths', () => {
    expect(normalizeLeadPhotoPath('notebook-1/alice.jpg')).toBe('notebook-1/alice.jpg')
    expect(normalizeLeadPhotoPath('/notebook-1/alice.jpg')).toBeNull()
    expect(normalizeLeadPhotoPath('notebook-1/../alice.jpg')).toBeNull()
    expect(normalizeLeadPhotoPath('https://example.test/alice.jpg')).toBeNull()
  })

  it('mints a five-minute signed URL and shares it across concurrent callers', async () => {
    const createSignedUrl = vi.fn(async () => ({
      data: { signedUrl: 'https://storage.test/signed/avatar' },
      error: null,
    }))
    const loader = createLeadPhotoUrlLoader(clientWith(createSignedUrl))

    const [first, second] = await Promise.all([
      loader.get('notebook-1/alice.jpg'),
      loader.get('notebook-1/alice.jpg'),
    ])

    expect(first).toBe('https://storage.test/signed/avatar')
    expect(second).toBe(first)
    expect(createSignedUrl).toHaveBeenCalledOnce()
    expect(createSignedUrl).toHaveBeenCalledWith(
      'notebook-1/alice.jpg',
      LEAD_PHOTO_SIGNED_URL_TTL_SECONDS,
    )
  })

  it('refreshes the cached URL shortly before expiry', async () => {
    let now = 1_000_000
    const createSignedUrl = vi
      .fn()
      .mockResolvedValueOnce({ data: { signedUrl: 'signed-1' }, error: null })
      .mockResolvedValueOnce({ data: { signedUrl: 'signed-2' }, error: null })
    const loader = createLeadPhotoUrlLoader(clientWith(createSignedUrl), () => now)

    expect(await loader.get('notebook-1/alice.jpg')).toBe('signed-1')
    now += (LEAD_PHOTO_SIGNED_URL_TTL_SECONDS - 31) * 1000
    expect(await loader.get('notebook-1/alice.jpg')).toBe('signed-1')
    now += 2_000
    expect(await loader.get('notebook-1/alice.jpg')).toBe('signed-2')
  })

  it('falls back cleanly when signing is unavailable or denied', async () => {
    const loader = createLeadPhotoUrlLoader(
      clientWith(async () => ({ data: null, error: new Error('denied') })),
    )

    expect(await loader.get('notebook-1/alice.jpg')).toBeNull()
    expect(await createLeadPhotoUrlLoader(null).get('notebook-1/alice.jpg')).toBeNull()
  })

  it('does not restore an in-flight URL to cache after auth state is cleared', async () => {
    let resolveFirst!: (value: {
      data: { signedUrl: string }
      error: null
    }) => void
    const first = new Promise<{
      data: { signedUrl: string }
      error: null
    }>((resolve) => {
      resolveFirst = resolve
    })
    const createSignedUrl = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ data: { signedUrl: 'signed-after-login' }, error: null })
    const loader = createLeadPhotoUrlLoader(clientWith(createSignedUrl))

    const oldRequest = loader.get('notebook-1/alice.jpg')
    loader.clear()
    resolveFirst({ data: { signedUrl: 'signed-before-logout' }, error: null })
    expect(await oldRequest).toBe('signed-before-logout')
    expect(await loader.get('notebook-1/alice.jpg')).toBe('signed-after-login')
    expect(createSignedUrl).toHaveBeenCalledTimes(2)
  })
})
