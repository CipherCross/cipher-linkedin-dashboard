import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * The Neon contract run. Requires the server-only `NEON_DATABASE_URL` in the
 * environment; the suite fails at import if it is absent.
 *
 *   set -a && . <your 0600 credential file> && set +a && npm run test:neon
 *
 * Timeouts are generous because these tests do real round trips to a remote
 * region, seed a few thousand fixture rows, and deliberately wait out a
 * statement timeout.
 */
export default defineConfig({
  /* Mirrors vite.config.ts. shadcn components import each other through
   * `@/components/ui/...`, so without this a test that pulls one in fails to
   * resolve rather than failing an assertion. */
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.neon.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
