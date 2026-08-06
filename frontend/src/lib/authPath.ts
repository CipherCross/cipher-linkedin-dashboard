/**
 * Which authenticator the browser runs against.
 *
 * The server-side path flags (`NEON_READS_DEFAULT`, `NEON_WRITES_DEFAULT`,
 * `NEON_AI_PATH_DEFAULT`) each move one seam of the migration while the rest
 * stay put. This is the browser's equivalent, and it exists for a reason that is
 * specific rather than symmetrical: **the Supabase session is what authorizes
 * the dashboard's data reads.**
 *
 * `DataContext.tsx` fetches all twenty datasets straight from PostgREST with the
 * signed-in Supabase client, and `N-S13-consolidation.md` records that it was
 * never rewired to the Neon read path. So cutting `AuthContext` over to the
 * identity cookie unconditionally would sign a person in and then show them an
 * empty dashboard: the browser would hold no Supabase JWT and every read would
 * be refused. The two authenticators therefore have to coexist until the read
 * cutover, and which one runs is a deployment decision, not a code one.
 *
 * The shape copies `deploymentAiPath` exactly: only the string `identity`
 * enables the new path, so unset, empty, `true`, `1`, `neon` and every typo
 * resolve to `supabase`. That direction matters — a build that fumbles the flag
 * keeps the authenticator that works rather than losing sign-in altogether.
 *
 * It is a `VITE_`-prefixed variable because it is read in the browser, and it is
 * safe to expose: it names which sign-in surface the SPA calls and carries no
 * credential. Its server-side counterpart is `acceptLegacyBearer` in
 * `api/_lib/identity/session.ts` — while this flag can be `supabase` anywhere,
 * that transitional bearer branch must stay.
 */

export type AuthPath = 'supabase' | 'identity'

export const AUTH_PATH_ENV = 'VITE_AUTH_PATH'

/** What `deploymentAuthPath` reads. Narrower than `ImportMetaEnv` so a test can
 *  pass a plain object without restating Vite's whole env type. */
export type AuthPathEnv = Readonly<Record<string, unknown>>

/**
 * The deployment's auth path. Off unless a build says exactly `identity`.
 *
 * Read per call rather than cached at module scope, for the same reason as
 * `deploymentAiPath`: a cached value would make the flag untestable without
 * reloading the module.
 */
export function deploymentAuthPath(
  env: AuthPathEnv = import.meta.env as unknown as AuthPathEnv,
): AuthPath {
  const raw = env[AUTH_PATH_ENV]
  return typeof raw === 'string' && raw.trim() === 'identity'
    ? 'identity'
    : 'supabase'
}
