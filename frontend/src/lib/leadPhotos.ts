/**
 * Lead photo delivery through the application API.
 *
 * The deployment's `photoPath` flag (`api/activity-daily.ts` §
 * `deploymentPhotoPath`) decides whether photos are served at all. `disabled`
 * renders initials and makes no photo request.
 *
 * The loader is keyed by **lead id**, and that is the security property: the
 * storage credential is the server's and is scoped to a bucket, so a
 * browser-supplied object key would move authorization into string validation.
 * Ids go up and the server derives the key from a row it just read.
 * `api/_lib/storage/leadPhotoService.ts` carries the full argument.
 *
 * That is also why the loader **batches**. A page renders dozens of avatars,
 * and one serverless invocation per avatar would pay the actor-resolution cost
 * dozens of times; requests made in the same tick are coalesced into one call.
 *
 * `leadPhotoUrls` — the shared instance every component uses — resolves the
 * flag once and delegates. `clear()` is called by `AuthContext` on every
 * sign-out and session change: a signed URL minted for one member must not
 * survive into another's session.
 */

import { authFetch } from './api'
import {
  READ_ENDPOINT,
  resolvePhotoPath,
  type ApiFetch,
  type PhotoPath,
} from './dashboardReads'

const CACHE_REFRESH_SKEW_MS = 30_000

interface CachedPhotoUrl {
  url: string
  expiresAt: number
}

/** What a caller has in hand when it wants a photo: a lead. */
export interface LeadPhotoRef {
  readonly id: string
}

/** The interface `LeadAvatar` talks to. */
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
      // In-flight batches are not cancelled; their results are simply not
      // cached, because the generation counter moved on.
      pending = null
    },
  }
}

/**
 * The instance the components use.
 *
 * Resolves the flag on first use and delegates from then on. `disabled` returns
 * `null` without calling the loader.
 */
export function createLeadPhotoSource(
  apiSource: LeadPhotoSource,
  // A thunk rather than the imported function itself: this is called at module
  // scope below, and naming the import there would make *loading* this module
  // depend on another module's runtime export — which is how a component test that
  // partially mocks `dashboardReads` fails at import time instead of where it
  // reads. The binding is touched only when a photo is actually requested.
  photoPath: () => Promise<PhotoPath> = () => resolvePhotoPath(),
): LeadPhotoSource {
  return {
    async get(lead) {
      return (await photoPath()) === 'neon' ? apiSource.get(lead) : null
    },
    clear() {
      apiSource.clear()
    },
  }
}

export const leadPhotoUrls = createLeadPhotoSource(createApiLeadPhotoUrlLoader())
