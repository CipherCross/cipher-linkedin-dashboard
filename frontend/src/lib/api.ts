/**
 * Fetch a browser-facing Vercel API as the signed-in person.
 *
 * The session is an `HttpOnly` cookie the SPA cannot see. There is nothing to
 * read and nothing to attach; `credentials` is what makes the browser send it.
 * That also means this cannot pre-empt a signed-out caller, and should not try:
 * the server answers 401 (not signed in) or 403 (signed in, no longer an active
 * member), and those are two different things that a guess made here could only
 * collapse.
 *
 * `Origin` is not set — it is a forbidden header, stamped by the browser, and
 * that is precisely why the server's origin check is worth having.
 */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(input, { ...init, credentials: 'same-origin' })
}

export async function authPost(url: string, body: unknown): Promise<Response> {
  return authFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
