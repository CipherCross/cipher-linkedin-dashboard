import { defineConfig } from 'vitest/config'

/**
 * The live-Neon leg. Read-only: it inserts, updates and deletes nothing on the
 * Neon project, and relies entirely on the three identity fixtures the tenant
 * baseline already ships.
 *
 *   set -a && . <your 0600 credential file> && set +a && npm run test:neon
 *
 * It still needs the clean-room container, because the candidate's own tables
 * cannot be created on Neon — that would be DDL outside the migration ledger.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.neon.test.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: ['tests/globalSetup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
