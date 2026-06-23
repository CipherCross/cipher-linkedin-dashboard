// Self-hosted app server (replaces Vercel). Serves the built SPA and the /api
// endpoints from one Node process, so each team runs one container behind the
// VPS reverse proxy. Handlers are the same Web-standard functions that ran on
// Vercel; this file just routes to them, enforces RBAC, injects per-team runtime
// config, and runs the daily classify cron that vercel.json used to schedule.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import cron from 'node-cron'

import * as chat from '../api/chat.js'
import * as classify from '../api/classify.js'
import * as config from '../api/config.js'
import * as members from '../api/members.js'
import * as mcp from '../api/mcp.js'
import { AuthError, requireRole as requireRoleFn, type AppRole } from '../api/_lib/auth.js'

const DIST = join(process.cwd(), 'dist')
const PORT = Number(process.env.PORT ?? 8080)

// Public, browser-safe config (anon key + URL only). Injected into the SPA via
// /config.js and also exposed as JSON for debugging.
const publicConfig = () => ({
  supabaseUrl: process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
})

// --- RBAC middleware -------------------------------------------------------
// Gate a route to a minimum role. Reads only headers, so the request body stays
// intact for the downstream handler.
function requireRole(min: AppRole): MiddlewareHandler {
  return async (c, next) => {
    try {
      const ctx = await requireRoleFn(c.req.raw, min)
      c.set('auth', ctx)
      await next()
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 401
      return c.json({ error: e instanceof Error ? e.message : 'unauthorized' }, status as 401 | 403)
    }
  }
}

// MCP is a powerful external surface and off by default. Enable per team by
// setting MCP_TOKEN; external clients then send it as a bearer token.
const requireMcpToken: MiddlewareHandler = async (c, next) => {
  const token = process.env.MCP_TOKEN
  if (!token) return c.json({ error: 'mcp disabled' }, 404)
  if (c.req.header('authorization') !== `Bearer ${token}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}

// Adapt a Web-standard handler (req: Request) => Response to a Hono handler.
const web =
  (h: (req: Request) => Response | Promise<Response>) => (c: Context) =>
    h(c.req.raw)

const app = new Hono()

// --- Runtime config --------------------------------------------------------
app.get('/config.js', (c) =>
  c.body(`window.__APP_CONFIG__=${JSON.stringify(publicConfig())}`, 200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-store',
  }),
)
app.get('/config.json', (c) => c.json(publicConfig()))
app.get('/healthz', (c) => c.text('ok'))

// --- API routes ------------------------------------------------------------
app.post('/api/chat', requireRole('member'), web(chat.POST))
app.get('/api/classify', web(classify.GET)) // cron path: CRON_SECRET checked inside the handler
app.post('/api/classify', requireRole('member'), web(classify.POST))
app.post('/api/config', requireRole('admin'), web(config.POST))
app.get('/api/members', requireRole('admin'), web(members.GET))
app.post('/api/members', requireRole('admin'), web(members.POST))
app.patch('/api/members', requireRole('admin'), web(members.PATCH))
app.delete('/api/members', requireRole('admin'), web(members.DELETE))
app.all('/api/mcp', requireMcpToken, web(mcp.POST))

// --- Static SPA ------------------------------------------------------------
// Hashed build assets, then an index.html fallback for every other path (the
// app uses HashRouter, so the server only ever serves "/").
app.use('/assets/*', serveStatic({ root: './dist' }))
app.get('*', async (c) => {
  try {
    return c.html(await readFile(join(DIST, 'index.html'), 'utf8'))
  } catch {
    return c.text('build missing: run `npm run build`', 500)
  }
})

// --- Daily classify cron (replaces vercel.json crons) ----------------------
if (process.env.CRON_SECRET) {
  cron.schedule(process.env.CLASSIFY_CRON ?? '0 6 * * *', async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/classify`, {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      })
      console.log(`[cron] classify ${res.status}`, await res.text())
    } catch (e) {
      console.error('[cron] classify failed', e)
    }
  })
  console.log('[cron] daily classify scheduled')
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`app server listening on :${info.port}`)
})

// Tell Hono about the `auth` context var set by requireRole.
declare module 'hono' {
  interface ContextVariableMap {
    auth: import('../api/_lib/auth.js').AuthContext
  }
}
