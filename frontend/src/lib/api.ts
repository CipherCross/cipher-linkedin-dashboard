import { deploymentAuthPath } from './authPath'
import { supabase } from './supabase'

export class ApiAuthError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiAuthError'
    this.status = status
  }
}

/**
 * Fetch a browser-facing Vercel API as the signed-in person.
 *
 * Two authenticators, and the difference is where the credential lives:
 *
 * - **Supabase path** — the SPA holds the access token, so it reads the session
 *   first and attaches a bearer. No session means no request: the 401 is raised
 *   here rather than spent on a round trip.
 * - **Identity path** — the session is an `HttpOnly` cookie the SPA cannot see.
 *   There is nothing to read and nothing to attach; `credentials` is what makes
 *   the browser send it. That also means this cannot pre-empt a signed-out
 *   caller, and should not try: the server answers 401 (not signed in) or 403
 *   (signed in, no longer an active member), and those are two different things
 *   that a guess made here could only collapse.
 *
 * `Origin` is not set on either path — it is a forbidden header, stamped by the
 * browser, and that is precisely why the server's origin check is worth having.
 */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (deploymentAuthPath() === 'identity') {
    return fetch(input, { ...init, credentials: 'same-origin' })
  }

  if (!supabase) throw new ApiAuthError(500, 'Supabase is not configured')
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession()
  if (error || !session) {
    throw new ApiAuthError(401, 'Your session expired. Please sign in again.')
  }

  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${session.access_token}`)
  return fetch(input, { ...init, headers })
}

export async function authPost(url: string, body: unknown): Promise<Response> {
  return authFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
