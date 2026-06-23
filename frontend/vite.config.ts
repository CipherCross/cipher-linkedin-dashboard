import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Serve /config.js in `vite dev` with the same shape the Hono server uses in
// production, so runtime config works identically in both. Reads VITE_SUPABASE_*
// from the local .env (loadEnv), not process.env.
function runtimeConfigJs(env: Record<string, string>): Plugin {
  const body = () =>
    `window.__APP_CONFIG__=${JSON.stringify({
      supabaseUrl: env.VITE_SUPABASE_URL ?? '',
      supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY ?? '',
    })}`
  return {
    name: 'runtime-config-js',
    configureServer(server) {
      server.middlewares.use('/config.js', (_req, res) => {
        res.setHeader('content-type', 'application/javascript; charset=utf-8')
        res.end(body())
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), runtimeConfigJs(env)],
  }
})
