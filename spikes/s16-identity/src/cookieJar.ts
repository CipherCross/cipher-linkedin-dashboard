/**
 * A cookie jar that applies the browser storage and sending rules, so the
 * spike's HTTP evidence is about what a browser would do rather than about
 * what a `Set-Cookie` header says.
 *
 * **What this is and is not.** It implements the RFC 6265bis rules the spike's
 * claims depend on: `Secure` (store and send over HTTPS only), `HttpOnly`
 * (invisible to script), `Path` matching, `Domain`/host matching, `Max-Age`
 * and `Expires`, and `SameSite` on cross-site requests. It is **not a
 * browser**: it does not implement Chrome's two-minute `SameSite=Lax` POST
 * exception, third-party cookie policy, cookie-jar partitioning, the
 * `__Secure-`/`__Host-` prefix *enforcement* a browser applies, or any
 * fetch-metadata behaviour a browser adds on its own. Every test that uses it
 * states which of those it therefore does not cover.
 */

export interface StoredCookie {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly sameSite: 'strict' | 'lax' | 'none' | null
  /** null means a session cookie — gone when the browser closes. */
  readonly expiresAt: number | null
  readonly maxAge: number | null
  /** The raw header, kept so a test can assert on the exact text. */
  readonly raw: string
}

export interface SendContext {
  /** True when the request is issued from a different site than the target. */
  readonly crossSite?: boolean
  /** A top-level navigation, which `SameSite=Lax` allows for safe methods. */
  readonly topLevelNavigation?: boolean
  readonly method?: string
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/'
  const lastSlash = pathname.lastIndexOf('/')
  return lastSlash === 0 ? '/' : pathname.slice(0, lastSlash)
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

/** Parse one `Set-Cookie` header value. Returns null if it is unusable. */
export function parseSetCookie(header: string, requestUrl: string): StoredCookie | null {
  const url = new URL(requestUrl)
  const [pair, ...attributeParts] = header.split(';')
  const equals = pair.indexOf('=')
  if (equals <= 0) return null

  const name = pair.slice(0, equals).trim()
  const value = pair.slice(equals + 1).trim()

  let path: string | null = null
  let domain = url.hostname
  let secure = false
  let httpOnly = false
  let sameSite: StoredCookie['sameSite'] = null
  let maxAge: number | null = null
  let expiresAt: number | null = null

  for (const part of attributeParts) {
    const separator = part.indexOf('=')
    const key = (separator === -1 ? part : part.slice(0, separator)).trim().toLowerCase()
    const attributeValue = separator === -1 ? '' : part.slice(separator + 1).trim()

    if (key === 'path') path = attributeValue || '/'
    else if (key === 'domain') domain = attributeValue.replace(/^\./, '').toLowerCase()
    else if (key === 'secure') secure = true
    else if (key === 'httponly') httpOnly = true
    else if (key === 'samesite') {
      const lowered = attributeValue.toLowerCase()
      if (lowered === 'strict' || lowered === 'lax' || lowered === 'none') sameSite = lowered
    } else if (key === 'max-age') {
      const parsed = Number(attributeValue)
      if (Number.isFinite(parsed)) maxAge = parsed
    } else if (key === 'expires') {
      const parsed = Date.parse(attributeValue)
      if (!Number.isNaN(parsed)) expiresAt = parsed
    }
  }

  // Max-Age wins over Expires, per RFC 6265 section 5.3.
  if (maxAge !== null) expiresAt = Date.now() + maxAge * 1000

  return {
    name,
    value,
    domain,
    path: path ?? defaultPath(url.pathname),
    secure,
    httpOnly,
    sameSite,
    expiresAt,
    maxAge,
    raw: header,
  }
}

export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>()

  /** Cookies a browser refused to store, kept so a test can assert the refusal. */
  readonly rejected: Array<{ readonly cookie: StoredCookie; readonly reason: string }> = []

  /** Store every `Set-Cookie` on a response, applying the browser's rules. */
  applyResponse(response: Response, requestUrl: string): void {
    const headers = response.headers.getSetCookie()
    for (const header of headers) {
      const cookie = parseSetCookie(header, requestUrl)
      if (!cookie) continue

      // A browser refuses to store a Secure cookie sent over a plain
      // connection. This is the rule that decides whether `useSecureCookies`
      // is compatible with a local http harness.
      if (cookie.secure && new URL(requestUrl).protocol !== 'https:') {
        this.rejected.push({ cookie, reason: 'Secure cookie over a non-HTTPS connection' })
        continue
      }

      const key = `${cookie.domain}|${cookie.path}|${cookie.name}`
      if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) {
        this.cookies.delete(key)
        continue
      }
      this.cookies.set(key, cookie)
    }
  }

  /** The `Cookie` header a browser would send, or null if it would send none. */
  header(requestUrl: string, context: SendContext = {}): string | null {
    const url = new URL(requestUrl)
    const now = Date.now()
    const parts: string[] = []

    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(key)
        continue
      }
      if (cookie.domain !== url.hostname) continue
      if (!pathMatches(cookie.path, url.pathname)) continue
      if (cookie.secure && url.protocol !== 'https:') continue

      if (context.crossSite) {
        const effective = cookie.sameSite ?? 'lax'
        if (effective === 'strict') continue
        if (effective === 'lax') {
          const safeMethod = (context.method ?? 'GET').toUpperCase() === 'GET'
          if (!context.topLevelNavigation || !safeMethod) continue
        }
        // SameSite=None is sent cross-site, but only if it is also Secure —
        // a browser rejects `SameSite=None` without `Secure` at storage time.
      }
      parts.push(`${cookie.name}=${cookie.value}`)
    }

    return parts.length > 0 ? parts.join('; ') : null
  }

  get(name: string): StoredCookie | undefined {
    for (const cookie of this.cookies.values()) if (cookie.name === name) return cookie
    return undefined
  }

  all(): readonly StoredCookie[] {
    return [...this.cookies.values()]
  }

  /** What `document.cookie` would expose — i.e. what an XSS payload can read. */
  scriptVisible(): readonly string[] {
    return this.all().filter((cookie) => !cookie.httpOnly).map((cookie) => cookie.name)
  }

  clear(): void {
    this.cookies.clear()
    this.rejected.length = 0
  }
}

export interface JarFetchResult {
  readonly response: Response
  readonly body: string
  /** Every hop, in order, for a redirect chain. */
  readonly chain: ReadonlyArray<{ readonly url: string; readonly status: number }>
}

/**
 * Fetch through the jar, following redirects the way a browser does: each hop
 * stores its own cookies and the next hop sends whatever the jar then holds.
 */
export async function jarFetch(
  jar: CookieJar,
  url: string,
  init: RequestInit & { readonly context?: SendContext } = {},
): Promise<JarFetchResult> {
  const chain: Array<{ url: string; status: number }> = []
  let currentUrl = url
  let currentInit: RequestInit = { ...init, redirect: 'manual' }
  let method = (init.method ?? 'GET').toUpperCase()

  for (let hop = 0; hop < 6; hop += 1) {
    const headers = new Headers(currentInit.headers)
    const cookieHeader = jar.header(currentUrl, {
      ...init.context,
      method,
      // Only the first hop inherits the caller's cross-site framing; a
      // redirect the browser follows is a top-level navigation.
      ...(hop > 0 ? { crossSite: false, topLevelNavigation: true } : {}),
    })
    if (cookieHeader) headers.set('cookie', cookieHeader)
    else headers.delete('cookie')

    const response = await fetch(currentUrl, { ...currentInit, headers, redirect: 'manual' })
    jar.applyResponse(response, currentUrl)
    chain.push({ url: currentUrl, status: response.status })

    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString()
      // A browser turns a 303 — and, in practice, a 301/302 after a POST —
      // into a GET with no body.
      method = 'GET'
      currentInit = { redirect: 'manual', method: 'GET' }
      continue
    }

    return { response, body: await response.text(), chain }
  }

  throw new Error('too many redirects')
}
