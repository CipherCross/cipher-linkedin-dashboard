import { supabase } from './supabase'

export class ApiAuthError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiAuthError'
    this.status = status
  }
}

/** Fetch a browser-facing Vercel API with the current Supabase access token. */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
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
