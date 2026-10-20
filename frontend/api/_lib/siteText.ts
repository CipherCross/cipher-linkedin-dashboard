// Readable text of a company website, for the AI coach. The URL comes from a
// third party (an Apollo export via Airtable, or a teammate typing ours), so
// the fetch is the server reaching out on someone else's say-so:
//
// * http(s) only, default ports only, no credentials in the URL;
// * every hop's host must resolve to public addresses only — loopback, private,
//   link-local, CGNAT, multicast and the cloud metadata range are refused —
//   and redirects are followed by hand (at most 3) so each one is re-checked;
// * 10 s budget, 1 MB of body at most, HTML or plain text only.
//
// The text is extracted the way the Skill Trainer does it (~/work/humanizer,
// fetch_site_text): title and meta description first, script/style/head
// dropped, block tags as line breaks, duplicate lines removed.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const TIMEOUT_MS = 10_000
const MAX_BYTES = 1_000_000
const MAX_REDIRECTS = 3
export const SITE_TEXT_CAP = 15_000
/** Fewer characters than this reads as a JavaScript-rendered shell. */
export const THIN_BELOW = 200

export class SiteFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SiteFetchError'
  }
}

/** `acme.com` from `https://www.acme.com/about`, or '' when it is not a URL. */
export function domainOf(value: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`)
    return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  } catch {
    return ''
  }
}

function isPublicV4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  if (a === 169 && b === 254) return false // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a >= 224) return false // multicast and reserved
  return true
}

export function isPublicAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return isPublicV4(address)
  if (kind !== 6) return false
  const lower = address.toLowerCase()
  if (lower === '::' || lower === '::1') return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped) return isPublicV4(mapped[1])
  if (/^f[cd]/.test(lower)) return false // unique local
  if (/^fe[89ab]/.test(lower)) return false // link-local
  if (/^ff/.test(lower)) return false // multicast
  return true
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SiteFetchError('Only http(s) websites can be read')
  if (url.username || url.password) throw new SiteFetchError('A website URL must not carry credentials')
  if (url.port && url.port !== '80' && url.port !== '443') throw new SiteFetchError('Only default web ports are allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => [])
  if (!addresses.length) throw new SiteFetchError(`${host} does not resolve`)
  if (!addresses.every((a) => isPublicAddress(a.address))) throw new SiteFetchError(`${host} is not a public address`)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

/** Title, meta description and the visible text of an HTML page. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => /\b(name|property)\s*=\s*["']?(description|og:description|og:title)\b/i.test(tag))
    .map((tag) => /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag))
    .map((m) => (m ? m[1] ?? m[2] ?? '' : ''))
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(p|div|li|h[1-6]|br|section|article|header|footer|tr|td|th|nav|main|aside|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of [decodeEntities(title ?? ''), ...metas.map(decodeEntities), ...decodeEntities(body).split('\n')]) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (line && !seen.has(line)) {
      seen.add(line)
      lines.push(line)
    }
  }
  const cleanTitle = title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : ''
  return { title: cleanTitle || null, text: lines.join('\n').slice(0, SITE_TEXT_CAP) }
}

export interface SiteText {
  readonly url: string
  readonly title: string | null
  readonly text: string
  readonly thin: boolean
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done || !value) break
    total += value.byteLength
    chunks.push(total > MAX_BYTES ? value.slice(0, value.byteLength - (total - MAX_BYTES)) : value)
    if (total >= MAX_BYTES) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  const charset = /charset=([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'utf-8'
  let decoder: TextDecoder
  try { decoder = new TextDecoder(charset) } catch { decoder = new TextDecoder('utf-8') }
  return decoder.decode(Buffer.concat(chunks.map((c) => Buffer.from(c))))
}

/** Fetch and extract one website. Throws `SiteFetchError` with a short reason. */
export async function fetchSiteText(input: string, fetcher: typeof fetch = fetch): Promise<SiteText> {
  let url: URL
  const trimmed = input.trim()
  try {
    // A scheme is kept so a non-web one is refused, not silently replaced.
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    throw new SiteFetchError('Not a website URL')
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  for (let hop = 0; ; hop += 1) {
    await assertPublicHost(url)
    let response: Response
    try {
      response = await fetcher(url, {
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'accept': 'text/html,text/plain;q=0.9,*/*;q=0.1',
          'accept-language': 'en-US,en;q=0.9',
        },
      })
    } catch (error) {
      throw new SiteFetchError((error as Error)?.name === 'TimeoutError' ? 'The website took too long to answer' : 'The website could not be reached')
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || hop >= MAX_REDIRECTS) throw new SiteFetchError('The website redirects too many times')
      url = new URL(location, url)
      continue
    }
    if (!response.ok) throw new SiteFetchError(`The website answered ${response.status}`)
    const type = (response.headers.get('content-type') ?? '').toLowerCase()
    if (type && !type.includes('html') && !type.includes('text/plain')) throw new SiteFetchError('The website did not return a page')
    const raw = await readCapped(response)
    const { title, text } = type.includes('text/plain') ? { title: null, text: raw.slice(0, SITE_TEXT_CAP) } : htmlToText(raw)
    return { url: url.toString(), title, text, thin: text.length < THIN_BELOW }
  }
}
