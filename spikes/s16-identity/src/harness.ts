/**
 * A local stand-in for the serverless runtime: a bare `node:http` server whose
 * only job is to convert Node's request into the same Web `Request` a Vercel
 * function receives, call the handler, and write the `Response` back.
 *
 * It is deliberately thin — no routing, no middleware, no body parsing —
 * because every line of behaviour it adds is a line the real platform would
 * not have contributed. The same conversion S12 used for its browser evidence.
 *
 * What it proves: the handler works over real HTTP, with real `Set-Cookie`
 * round trips and real redirects. What it does not prove: anything specific to
 * Vercel — cold starts, the region, the platform's own header handling, or its
 * request size and duration limits. That gap is stated in the handoff.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type SpikeHandler = (request: Request) => Promise<Response>

export interface Harness {
  readonly origin: string
  /**
   * Mount the handler after the port is known.
   *
   * The candidate's `baseURL` is also its trusted origin, and the origin is not
   * known until the kernel has assigned a port — so the server has to exist
   * before the handler does. No port is pinned in any committed file.
   */
  mount(handler: SpikeHandler): void
  close(): Promise<void>
}

function toWebRequest(req: IncomingMessage, origin: string, body: Buffer): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item)
  }
  const method = req.method ?? 'GET'
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    // `Buffer` is a `Uint8Array`, but only the latter is a `BodyInit`.
    body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(body),
  })
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  // `getSetCookie()` keeps multiple Set-Cookie headers separate; joining them
  // into one string is a classic way to silently break session + cache cookies.
  const setCookies = response.headers.getSetCookie()
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') headers[key] = value
  })
  if (setCookies.length > 0) headers['set-cookie'] = setCookies

  const body = Buffer.from(await response.arrayBuffer())
  res.writeHead(response.status, headers)
  res.end(body)
}

export async function startHarness(): Promise<Harness> {
  let mounted: SpikeHandler | null = null

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      void (async () => {
        const address = server.address() as AddressInfo
        const origin = `http://127.0.0.1:${address.port}`
        if (!mounted) {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end('{"error":"No handler mounted"}')
          return
        }
        try {
          const response = await mounted(toWebRequest(req, origin, Buffer.concat(chunks)))
          await writeWebResponse(res, response)
        } catch {
          // Nothing is logged: an error's message can embed a database
          // hostname, and no log line in this session may contain one.
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end('{"error":"Unhandled"}')
        }
      })()
    })
  })

  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', resolvePromise)
  })

  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    mount: (handler: SpikeHandler) => {
      mounted = handler
    },
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()))
      }),
  }
}
