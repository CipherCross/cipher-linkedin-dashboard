/**
 * Lead photo delivery, on either provider.
 *
 * Two loaders live here and exactly one runs, chosen by the deployment's
 * `photoPath` flag (`api/activity-daily.ts` § `deploymentPhotoPath`). The Supabase
 * loader below is unchanged — same signature, same cache, same five-minute TTL —
 * because it is the only one that works today and the Neon/R2 path has to land
 * beside it rather than in place of it.
 *
 * ## What differs, and why it is not symmetrical
 *
 * The Supabase loader is keyed by **object path** and the API loader by **lead
 * id**, which looks like an inconsistency and is the security property. On the
 * Supabase path the browser holds a JWT that Storage applies RLS to, so naming the
 * object is not what authorizes the read. On the API path the credential is the
 * server's and is scoped to a bucket, so a browser-supplied key would move
 * authorization into string validation; ids go up and the server derives the key
 * from a row it just read. `api/_lib/storage/leadPhotoService.ts` carries the full
 * argument.
 *
 * That is also why the API loader **batches**. A page renders dozens of avatars,
 * and one serverless invocation per avatar would pay the actor-resolution cost
 * dozens of times; requests made in the same tick are coalesced into one call.
 *
 * `leadPhotos` — the shared instance every component uses — resolves the flag once
 * and delegates. `clear()` clears both, so `AuthContext`'s eight sign-out and
 * session-change call sites keep working with no change: a signed URL minted for
 * one member must not survive into another's session on either path.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { authFetch } from './api'
import { READ_ENDPOINT, resolvePhotoPath, type ApiFetch } from './dashboardReads'
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

// ---------------------------------------------------------------------------
// The API-backed loader (S20)
// ---------------------------------------------------------------------------

/** What a caller has in hand when it wants a photo: a lead, on either path. */
export interface LeadPhotoRef {
  readonly id: string
  readonly photo_path?: string | null
}

/** The interface `LeadAvatar` talks to. Both loaders implement it. */
export interface LeadPhotoSource {
  get: (lead: LeadPhotoRef | null | undefined) => Promise<string | null>
  clear: () => void
}

/** The operation name; the endpoint's, spelled once. */
export const LEAD_PHOTO_URLS_OPERATION = 'leads.photoUrls'

/**
 * The endpoint's own cap, restated so the coalescer splits before the server
 * refuses. Kept equal to `MAX_PHOTO_BATCH` in
 * `api/_lib/storage/leadPhotoService.ts`; the rendering test asserts a batch of
 * more than this many leads produces more than one request rather than one 400.
 */
export const MAX_PHOTO_REQUEST_BATCH = 100

interface PhotoResponse {
  readonly photos?: readonly {
    readonly leadId?: string
    readonly url?: string
    readonly expiresAt?: string
  }[]
}

/**
 * Signed URLs from the application API, coalescing concurrent callers.
 *
 * ## The coalescing window is a microtask, not a timer
 *
 * Every avatar on a page mounts in the same render pass, so their `get()` calls
 * land in one tick. The loader collects ids into a pending batch and flushes it on
 * the next microtask — no `setTimeout`, because a timer would delay the first
 * paint of an avatar by its own duration for no benefit, and because a test would
 * then have to wait on wall-clock time to observe a batch.
 *
 * A lead that arrives while a batch is in flight starts the *next* batch rather
 * than joining the current one; that is what keeps a scroll through a long list
 * from growing one unbounded request.
 *
 * ## Failure is `null`, always
 *
 * A 503 from an unconfigured deployment, a 500, a network failure, a body that is
 * not the expected shape: all resolve `null` for every lead in the batch, and the
 * avatar renders initials. This loader is on the *display* path — a lead with no
 * photo and a photo that could not be signed look the same to a reader, and
 * turning either into a visible error would be a worse dashboard than one showing
 * initials. What must not happen, and does not, is a rejected promise reaching
 * `LeadAvatar`'s effect.
 */
export function createApiLeadPhotoUrlLoader(
  fetchImpl: ApiFetch = authFetch,
  now: () => number = Date.now,
): LeadPhotoSource {
  const cache = new Map<string, CachedPhotoUrl>()
  let pending: Map<string, ((url: string | null) => void)[]> | null = null
  let generation = 0

  const flush = async (
    batch: Map<string, ((url: string | null) => void)[]>,
    requestGeneration: number,
  ) => {
    const ids = [...batch.keys()]
    const resolveAll = (urls: Map<string, string>) => {
      for (const [leadId, waiters] of batch) {
        const url = urls.get(leadId) ?? null
        for (const waiter of waiters) waiter(url)
      }
    }

    try {
      const url =
        `${READ_ENDPOINT}?op=${encodeURIComponent(LEAD_PHOTO_URLS_OPERATION)}` +
        `&lead_ids=${encodeURIComponent(ids.join(','))}`
      const res = await fetchImpl(url)
      if (!res.ok) return resolveAll(new Map())

      const body = (await res.json()) as PhotoResponse | null
      const urls = new Map<string, string>()
      for (const photo of body?.photos ?? []) {
        if (typeof photo?.leadId !== 'string' || typeof photo.url !== 'string') {
          continue
        }
        urls.set(photo.leadId, photo.url)
        // Cached against the URL's own stated expiry rather than a local
        // assumption about the TTL: the server owns the lifetime, and a client
        // that guessed longer would serve dead URLs from cache.
        const expiresAt = Date.parse(photo.expiresAt ?? '')
        if (generation === requestGeneration && Number.isFinite(expiresAt)) {
          cache.set(photo.leadId, { url: photo.url, expiresAt })
        }
      }
      resolveAll(urls)
    } catch {
      resolveAll(new Map())
    }
  }

  return {
    async get(lead) {
      const leadId = lead?.id
      if (typeof leadId !== 'string' || leadId === '') return null

      const cached = cache.get(leadId)
      if (cached && cached.expiresAt - CACHE_REFRESH_SKEW_MS > now()) {
        return cached.url
      }

      if (pending === null || pending.size >= MAX_PHOTO_REQUEST_BATCH) {
        const batch = new Map<string, ((url: string | null) => void)[]>()
        pending = batch
        const requestGeneration = generation
        // A microtask, so every avatar mounted in this render pass joins.
        void Promise.resolve().then(() => {
          if (pending === batch) pending = null
          void flush(batch, requestGeneration)
        })
      }

      const batch = pending
      return new Promise<string | null>((resolve) => {
        const waiters = batch.get(leadId)
        if (waiters) waiters.push(resolve)
        else batch.set(leadId, [resolve])
      })
    },
    clear() {
      generation += 1
      cache.clear()
      // In-flight batches are not cancelled; their results are simply not cached,
      // which is the same rule the Supabase loader's generation counter applies.
      pending = null
    },
  }
}

/**
 * The Supabase loader behind the `LeadPhotoSource` interface.
 *
 * A thin adapter rather than a change to `createLeadPhotoUrlLoader`, so the live
 * path keeps its own signature, its own tests and its path-keyed cache exactly as
 * they are.
 */
export function toLeadPhotoSource(loader: LeadPhotoUrlLoader): LeadPhotoSource {
  return {
    get: (lead) => loader.get(lead?.photo_path),
    clear: () => loader.clear(),
  }
}

/**
 * The instance the components use.
 *
 * Resolves the flag on first use and delegates from then on. `clear()` reaches
 * **both** loaders regardless of which one is active: `AuthContext` calls it on
 * every sign-out and session change, and a URL minted for one member must not
 * survive into another's session on either provider — including a loader that was
 * active earlier in the page's life.
 */
export function createLeadPhotoSource(
  supabaseSource: LeadPhotoSource,
  apiSource: LeadPhotoSource,
  // A thunk rather than the imported function itself: this is called at module
  // scope below, and naming the import there would make *loading* this module
  // depend on another module's runtime export — which is how a component test that
  // partially mocks `dashboardReads` fails at import time instead of where it
  // reads. The binding is touched only when a photo is actually requested.
  photoPath: () => Promise<'supabase' | 'neon'> = () => resolvePhotoPath(),
): LeadPhotoSource {
  return {
    async get(lead) {
      const path = await photoPath()
      return path === 'neon' ? apiSource.get(lead) : supabaseSource.get(lead)
    },
    clear() {
      supabaseSource.clear()
      apiSource.clear()
    },
  }
}

/** The Supabase loader, still exported under its old name and unchanged. */
export const leadPhotoUrls = createLeadPhotoSource(
  toLeadPhotoSource(createLeadPhotoUrlLoader(supabase)),
  createApiLeadPhotoUrlLoader(),
)
