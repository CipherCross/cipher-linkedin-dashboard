import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './supabase'

export const LEAD_PHOTO_BUCKET = 'lead-photos'
export const LEAD_PHOTO_SIGNED_URL_TTL_SECONDS = 5 * 60
const CACHE_REFRESH_SKEW_MS = 30_000

interface CachedPhotoUrl {
  url: string
  expiresAt: number
}

export interface LeadPhotoUrlLoader {
  get: (path: string | null | undefined) => Promise<string | null>
  clear: () => void
}

/** Accept only bucket-relative object names. `photo_path` is service-written,
 * but rejecting URL/traversal-shaped values keeps this display helper narrowly
 * scoped to the private lead-photo bucket. */
export function normalizeLeadPhotoPath(
  path: string | null | undefined,
): string | null {
  if (!path || path !== path.trim()) return null
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('://')
  ) {
    return null
  }
  const segments = path.split('/')
  if (segments.length < 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null
  }
  return path
}

/** Creates short-lived URLs only through the signed-in Supabase client.
 * Successful URLs are cached just short of their expiry and concurrent
 * requests for the same object share one Storage call. */
export function createLeadPhotoUrlLoader(
  client: SupabaseClient | null,
  now: () => number = Date.now,
): LeadPhotoUrlLoader {
  const cache = new Map<string, CachedPhotoUrl>()
  const pending = new Map<string, Promise<string | null>>()
  let generation = 0

  return {
    async get(rawPath) {
      const path = normalizeLeadPhotoPath(rawPath)
      if (!path || !client) return null

      const cached = cache.get(path)
      if (cached && cached.expiresAt - CACHE_REFRESH_SKEW_MS > now()) {
        return cached.url
      }

      const existing = pending.get(path)
      if (existing) return existing

      const requestGeneration = generation
      const request = (async () => {
        try {
          const { data, error } = await client.storage
            .from(LEAD_PHOTO_BUCKET)
            .createSignedUrl(path, LEAD_PHOTO_SIGNED_URL_TTL_SECONDS)
          if (error || !data?.signedUrl) return null
          if (generation === requestGeneration) {
            cache.set(path, {
              url: data.signedUrl,
              expiresAt: now() + LEAD_PHOTO_SIGNED_URL_TTL_SECONDS * 1000,
            })
          }
          return data.signedUrl
        } catch {
          return null
        }
      })()

      pending.set(path, request)
      const clearPending = () => {
        if (pending.get(path) === request) pending.delete(path)
      }
      void request.then(clearPending, clearPending)
      return request
    },
    clear() {
      generation += 1
      cache.clear()
      pending.clear()
    },
  }
}

export const leadPhotoUrls = createLeadPhotoUrlLoader(supabase)
