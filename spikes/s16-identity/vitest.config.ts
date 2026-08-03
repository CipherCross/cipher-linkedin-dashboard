import { defineConfig } from 'vitest/config'

/**
 * The clean-room suite. Requires a local Docker daemon and the
 * `postgres:17-alpine` image the S08 harnesses already pin; it refuses an
 * implicit network pull and fails loudly rather than skipping, because a green
 * identity suite that touched no database would be worse than a red one.
 *
 * Touches no provider. The live Neon leg is `npm run test:neon`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/**/*.neon.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
