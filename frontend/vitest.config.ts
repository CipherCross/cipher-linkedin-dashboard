import { defineConfig } from 'vitest/config'

/**
 * Default test run: everything that needs no external provider.
 *
 * `*.neon.test.ts` is excluded here and run by `npm run test:neon` against a
 * real Neon project. It is a separate command rather than a conditional skip:
 * when it runs it must either reach the database or fail loudly, never report
 * green after testing nothing.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/**/*.neon.test.ts'],
  },
})
