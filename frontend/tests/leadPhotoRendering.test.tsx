/**
 * @vitest-environment jsdom
 *
 * Signed rendering: what `LeadAvatar` actually puts in the DOM on each path, and
 * how the API loader behaves under a page's worth of avatars.
 *
 * Two things make this worth mounting a component for rather than testing the
 * loader alone:
 *
 * 1. **The `<img src>` is the deliverable.** A loader that returns a URL nobody
 *    renders is not a working photo path, and the failure mode is invisible — the
 *    page shows initials and nothing errors. So the assertion is on the rendered
 *    attribute.
 * 2. **The fallback is a product decision, not an error path.** A lead with no
 *    photo, a deployment with no bucket and a 503 all have to render initials
 *    rather than a broken image or an error boundary, and that is only observable
 *    in the DOM.
 *
 * `N-UI-TESTS.md` records why `environment` is declared per file rather than
 * globally, and this file follows it.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LeadAvatar } from '../src/components/Avatar'
import {
  createApiLeadPhotoUrlLoader,
  createLeadPhotoSource,
  toLeadPhotoSource,
  createLeadPhotoUrlLoader,
  MAX_PHOTO_REQUEST_BATCH,
  type LeadPhotoSource,
} from '../src/lib/leadPhotos'
import type { Lead } from '../src/lib/types'

vi.mock('../src/lib/supabase', () => ({ supabase: null }))

const lead = (id: string, photoPath: string | null = 'notebook-1/alice.jpg'): Lead =>
  ({
    id,
    instance_id: 'notebook-1',
    campaign_id: 'notebook-1:1',
    profile_url: `https://www.linkedin.com/in/lead-${id}`,
    full_name: `Lead ${id}`,
    photo_path: photoPath,
  }) as unknown as Lead

const SIGNED = 'https://account.r2.cloudflarestorage.com/bucket/t/acme/lead-photos/notebook-1/alice.jpg?X-Amz-Signature=abc'

/** A fetch that answers the photo operation with the given photos. */
function photoFetch(
  respond: (leadIds: string[]) => {
    ok?: boolean
    status?: number
    body?: unknown
  },
) {
  const calls: string[][] = []
  const fetchImpl = vi.fn(async (url: string) => {
    const ids = (new URL(url, 'https://app.test').searchParams.get('lead_ids') ?? '')
      .split(',')
      .filter(Boolean)
    calls.push(ids)
    const answer = respond(ids)
    return {
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      json: async () => answer.body ?? {},
    } as unknown as Response
  })
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

const sourceOn = (
  path: 'supabase' | 'neon',
  apiSource: LeadPhotoSource,
): LeadPhotoSource =>
  createLeadPhotoSource(
    toLeadPhotoSource(createLeadPhotoUrlLoader(null)),
    apiSource,
    async () => path,
  )

describe('LeadAvatar on the API photo path', () => {
  // Explicit, because this project does not enable RTL's automatic cleanup: the
  // first version of this file leaked one test's `<img>` into the next and the
  // fallback assertion passed against the previous render.
  afterEach(cleanup)

  it('renders the signed URL the endpoint returned', async () => {
    const { fetchImpl } = photoFetch((ids) => ({
      body: {
        photos: ids.map((leadId) => ({
          leadId,
          url: SIGNED,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        })),
      },
    }))
    const photos = sourceOn('neon', createApiLeadPhotoUrlLoader(fetchImpl))

    render(<LeadAvatar lead={lead('lead-1')} photos={photos} />)

    const image = await screen.findByRole('img')
    expect(image.getAttribute('src')).toBe(SIGNED)
    // The signed URL must not travel onward as a `Referer`.
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('falls back to initials when the deployment cannot sign', async () => {
    const { fetchImpl } = photoFetch(() => ({ ok: false, status: 503 }))
    const photos = sourceOn('neon', createApiLeadPhotoUrlLoader(fetchImpl))

    render(<LeadAvatar lead={lead('lead-1')} photos={photos} />)

    await waitFor(() => {
      expect(screen.queryByRole('img')).toBeNull()
    })
    // `Lead lead-1` → "LL", the same fallback a lead with no photo gets.
    expect(document.querySelector('.avatar.fallback')?.textContent).toBe('LL')
  })

  it('falls back to initials for a lead the response omitted', async () => {
    const { fetchImpl } = photoFetch(() => ({ body: { photos: [] } }))
    const photos = sourceOn('neon', createApiLeadPhotoUrlLoader(fetchImpl))

    render(<LeadAvatar lead={lead('lead-1')} photos={photos} />)

    await waitFor(() => {
      expect(document.querySelector('.avatar.fallback')).not.toBeNull()
    })
  })

  it('asks for nothing on the Supabase path', async () => {
    const { calls, fetchImpl } = photoFetch(() => ({ body: { photos: [] } }))
    const photos = sourceOn('supabase', createApiLeadPhotoUrlLoader(fetchImpl))

    render(<LeadAvatar lead={lead('lead-1')} photos={photos} />)

    await waitFor(() => {
      expect(document.querySelector('.avatar.fallback')).not.toBeNull()
    })
    // The Supabase loader was constructed with a null client, so it answers null —
    // what matters is that the API was never called on that path.
    expect(calls).toEqual([])
  })
})

describe('the API loader under a page of avatars', () => {
  it('coalesces every avatar of one render pass into one request', async () => {
    const { calls, fetchImpl } = photoFetch((ids) => ({
      body: {
        photos: ids.map((leadId) => ({
          leadId,
          url: `${SIGNED}&id=${leadId}`,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        })),
      },
    }))
    const loader = createApiLeadPhotoUrlLoader(fetchImpl)

    const urls = await Promise.all([
      loader.get(lead('a')),
      loader.get(lead('b')),
      loader.get(lead('c')),
    ])

    expect(calls).toEqual([['a', 'b', 'c']])
    expect(urls).toEqual([
      `${SIGNED}&id=a`,
      `${SIGNED}&id=b`,
      `${SIGNED}&id=c`,
    ])
  })

  it('asks once for a lead two components render', async () => {
    const { calls, fetchImpl } = photoFetch((ids) => ({
      body: {
        photos: ids.map((leadId) => ({
          leadId,
          url: SIGNED,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        })),
      },
    }))
    const loader = createApiLeadPhotoUrlLoader(fetchImpl)

    const [first, second] = await Promise.all([
      loader.get(lead('a')),
      loader.get(lead('a')),
    ])
    expect(calls).toEqual([['a']])
    expect(first).toBe(SIGNED)
    expect(second).toBe(SIGNED)
  })

  it('serves a second render from cache until the URL nears its expiry', async () => {
    const clock = { now: 1_700_000_000_000 }
    const { calls, fetchImpl } = photoFetch(() => ({
      body: {
        photos: [
          {
            leadId: 'a',
            url: SIGNED,
            expiresAt: new Date(clock.now + 300_000).toISOString(),
          },
        ],
      },
    }))
    const loader = createApiLeadPhotoUrlLoader(fetchImpl, () => clock.now)

    expect(await loader.get(lead('a'))).toBe(SIGNED)
    expect(await loader.get(lead('a'))).toBe(SIGNED)
    expect(calls).toHaveLength(1)

    // Past the refresh skew: re-asked rather than served stale.
    clock.now += 280_000
    await loader.get(lead('a'))
    expect(calls).toHaveLength(2)
  })

  it('splits a batch larger than the endpoint accepts', async () => {
    const { calls, fetchImpl } = photoFetch(() => ({ body: { photos: [] } }))
    const loader = createApiLeadPhotoUrlLoader(fetchImpl)

    await Promise.all(
      Array.from({ length: MAX_PHOTO_REQUEST_BATCH + 5 }, (_unused, index) =>
        loader.get(lead(`lead-${index}`)),
      ),
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]).toHaveLength(MAX_PHOTO_REQUEST_BATCH)
    expect(calls[1]).toHaveLength(5)
  })

  it('answers null for every lead in a batch when the request fails', async () => {
    const { fetchImpl } = photoFetch(() => {
      throw new Error('offline')
    })
    const loader = createApiLeadPhotoUrlLoader(fetchImpl)

    const urls = await Promise.all([loader.get(lead('a')), loader.get(lead('b'))])
    expect(urls).toEqual([null, null])
  })

  /**
   * A non-200 whose body happens to look right must not be used. The first version
   * of this file only ever gave the failing response an *empty* body, so removing
   * the status check changed nothing — the loader fell through to "no photos" by
   * accident rather than by rule.
   */
  it('ignores the body of a non-ok response', async () => {
    const { fetchImpl } = photoFetch(() => ({
      ok: false,
      status: 503,
      body: {
        photos: [
          {
            leadId: 'a',
            url: SIGNED,
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        ],
      },
    }))
    const loader = createApiLeadPhotoUrlLoader(fetchImpl)
    expect(await loader.get(lead('a'))).toBeNull()
  })

  it('ignores malformed entries rather than rendering undefined', async () => {
    const { fetchImpl } = photoFetch(() => ({
      body: { photos: [{ leadId: 'a' }, { url: SIGNED }, null] },
    }))
    const loader = createApiLeadPhotoUrlLoader(fetchImpl)
    expect(await loader.get(lead('a'))).toBeNull()
  })

  it('asks for nothing when the lead has no id', async () => {
    const { calls, fetchImpl } = photoFetch(() => ({ body: { photos: [] } }))
    const loader = createApiLeadPhotoUrlLoader(fetchImpl)
    expect(await loader.get(null)).toBeNull()
    expect(await loader.get({ id: '' })).toBeNull()
    expect(calls).toEqual([])
  })

  /**
   * `clear()` runs on every sign-out and session change. A URL minted for one
   * member must not be served to the next, so the cached entry has to go — and the
   * in-flight batch's result must not be cached either.
   */
  it('drops cached URLs on clear and re-asks', async () => {
    const { calls, fetchImpl } = photoFetch(() => ({
      body: {
        photos: [
          { leadId: 'a', url: SIGNED, expiresAt: new Date(Date.now() + 300_000).toISOString() },
        ],
      },
    }))
    const loader = createApiLeadPhotoUrlLoader(fetchImpl)

    await loader.get(lead('a'))
    loader.clear()
    await loader.get(lead('a'))
    expect(calls).toHaveLength(2)
  })

  it('clears both loaders whichever path is active', () => {
    const supabaseLoader = { get: vi.fn(async () => null), clear: vi.fn() }
    const apiLoader = { get: vi.fn(async () => null), clear: vi.fn() }
    createLeadPhotoSource(supabaseLoader, apiLoader, async () => 'neon').clear()
    expect(supabaseLoader.clear).toHaveBeenCalledTimes(1)
    expect(apiLoader.clear).toHaveBeenCalledTimes(1)
  })
})
