/**
 * Which authenticator the browser runs against.
 *
 * The server-side path flags (`NEON_READS_DEFAULT`, `NEON_WRITES_DEFAULT`,
 * `NEON_AI_PATH_DEFAULT`) each move one seam of the migration while the rest
 * stay put. This is the browser's equivalent, and it exists for a reason that is
 * specific rather than symmetrical: **the Supabase session is what authorizes
 * the dashboard's data reads.**
 *
 * `DataContext.tsx` now reads through the application API when the deployment's
 * read path is `neon`, but it still falls back to PostgREST with the signed-in
 * Supabase client otherwise. So cutting `AuthContext` over to the identity cookie
 * unconditionally would sign a person in against a store that deployment may not
 * have, or hold no Supabase JWT for the reads it still makes — either way an empty
 * dashboard behind a successful sign-in. The two authenticators therefore coexist
 * until a deployment has both an identity store and the Neon read path, and which
 * one runs is a deployment decision, not a code one.
 *
 * **This flag no longer copies the server ones, and S27 is where they parted.**
 * The three server flags now default to `neon` wherever the deployment holds the
 * credential that path needs; this one still requires the exact string
 * `identity`, so unset, empty, `true`, `1`, `neon` and every typo keep the
 * Supabase authenticator. The difference is not caution, it is what the browser
 * can observe: it cannot see whether an identity store is configured, so there is
 * no credential here to derive a default from — and defaulting to `identity`
 * without one would not degrade a dashboard, it would end sign-in. A build that
 * fumbles the flag keeps the authenticator that works.
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
