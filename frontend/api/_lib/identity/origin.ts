/**
 * The product's own origin check (C1, third clause).
 *
 * **Why the product needs its own.** The candidate validates `Origin` on the
 * routes it owns and on nothing else. F2 measured the session cookie as
 * `Path=/`, so it rides along on every request to this deployment — including
 * the product's endpoints, which the candidate has never heard of. That is what
 * makes a shared session work without plumbing, and it is exactly why CSRF has
 * to be handled per request here rather than assumed away.
 *
 * **Why `SameSite=Lax` is not enough on its own.** It is the first line and a
 * good one: a browser will not attach the session to a cross-site POST at all.
 * But it is a browser behaviour, not a server check — it does nothing about a
 * non-browser client, an older engine, or a same-site-but-untrusted subdomain.
 * The server check is what makes the refusal ours.
 *
 * The shape mirrors the candidate's so the two cannot disagree about what a
 * legitimate request looks like: `GET`/`HEAD`/`OPTIONS` are exempt because they
 * must not change state, and everything else requires an `Origin` header that
 * matches this deployment's own. A missing `Origin` on a state-changing request
 * is a refusal, not a pass — which is the half of this that is easy to get
 * wrong, because omitting the header is trivial for an attacker and common in
 * hand-written clients.
 */

/** Methods the origin check exempts, and which therefore must not mutate. */
export const ORIGIN_EXEMPT_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS']

export type OriginCheckOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'MISSING_ORIGIN' | 'INVALID_ORIGIN' }

/**
 * Decide whether a request may change state, given the origin we trust.
 *
 * Pure and synchronous so it can be tested exhaustively without a server: the
 * hostile-origin, missing-origin and same-origin cases are all just inputs.
 */
export function checkRequestOrigin(
  request: Request,
  trustedOrigin: string,
): OriginCheckOutcome {
  if (ORIGIN_EXEMPT_METHODS.includes(request.method.toUpperCase())) {
    return { ok: true }
  }

  const presented = request.headers.get('origin')
  // `null` is a real value browsers send for opaque origins, and it must not be
  // treated as "same origin" just because it parses as a string.
  if (presented === null || presented === '' || presented === 'null') {
    return { ok: false, reason: 'MISSING_ORIGIN' }
  }

  let presentedOrigin: string
  try {
    presentedOrigin = new URL(presented).origin
  } catch {
    return { ok: false, reason: 'INVALID_ORIGIN' }
  }

  // Compared as normalized origins — scheme, host and port — so neither a
  // trailing slash nor a default port can make an origin look different from
  // itself, and no substring or prefix comparison is involved.
  return presentedOrigin === new URL(trustedOrigin).origin
    ? { ok: true }
    : { ok: false, reason: 'INVALID_ORIGIN' }
}

/**
 * The 403 a failed origin check produces.
 *
 * The body names the reason, which is safe: it tells a legitimate client what
 * to fix and tells an attacker only that the request was refused, which the
 * status code already said. It carries no origin value back — echoing an
 * attacker-supplied header into a response body is how a refusal turns into a
 * reflection.
 */
export function originRefusal(reason: 'MISSING_ORIGIN' | 'INVALID_ORIGIN'): Response {
  return new Response(
    JSON.stringify({
      error:
        reason === 'MISSING_ORIGIN'
          ? 'A state-changing request must send its own Origin header'
          : 'Cross-origin state-changing requests are refused',
      code: reason,
    }),
    {
      status: 403,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    },
  )
}
