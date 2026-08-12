import { defineConfig } from 'vitest/config'

/**
 * Default test run: everything that needs no external provider.
 *
 * `*.neon.test.ts` is excluded here and run by `npm run test:neon` against a
 * real Neon project. It is a separate command rather than a conditional skip:
 * when it runs it must either reach the database or fail loudly, never report
 * green after testing nothing.
 *
 * `*.cleanroom.test.ts` is excluded for the same reason and run by the harness
 * in `postgres/tests/`, which builds a throwaway PostgreSQL through the
 * migration ledger and exports the credentials. Those files create people, so
 * they must never be pointed at a database by accident.
 *
 * ## The rendering files, and why `environment` stays `node`
 *
 * `*.test.tsx` files render components with `@testing-library/react` and declare
 * `@vitest-environment jsdom` in their own docblock. The default stays `node`
 * **deliberately**: every one of the pre-existing files is a node suite, several
 * import server code from `api/`, and switching the global environment would make
 * a jsdom `window` appear underneath code written to assert it has none. Opting
 * in per file keeps the cost where the benefit is — jsdom construction is the
 * slowest part of these runs — and keeps the blast radius of this addition to the
 * files that asked for it.
 *
 * No `@vitejs/plugin-react` here, and that is checked rather than assumed:
 * Vitest 4's own transform compiles JSX in both the test files and the components
 * they import, and adding the plugin only produced esbuild/oxc deprecation
 * warnings on every run. The plugin's other job — Fast Refresh — has no meaning
 * in a test process.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/**/*.neon.test.ts',
      'tests/**/*.cleanroom.test.ts',
    ],
  },
})
