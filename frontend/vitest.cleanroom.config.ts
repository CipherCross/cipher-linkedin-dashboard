import { defineConfig } from 'vitest/config'

/**
 * The clean-room run: the real candidate against a real PostgreSQL identity
 * store, in a throwaway container.
 *
 * Never run directly — `postgres/tests/portable_identity_invitation_link_cleanroom.sh`
 * builds the database through the migration ledger and exports the credentials
 * this expects. Without them the suite skips, loudly.
 *
 * Separate from `test:neon` because that one runs against the live project and
 * is read-only by decision; this one creates people, which is only safe in a
 * container that is deleted afterwards.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.cleanroom.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
