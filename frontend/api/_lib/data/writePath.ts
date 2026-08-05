/**
 * Which database a non-AI write goes to.
 *
 * The read path's equivalent is `deploymentReadPath` in `api/activity-daily.ts`,
 * and this deliberately copies its fail-closed shape: only the exact string
 * `neon` enables the new path, so unset, empty, `true`, `1` and every typo
 * resolve to `supabase`. A deployment that has not been told to write to Neon
 * cannot be talked into it by a malformed value.
 *
 * ## Why this is *not* the read flag, and must not become it
 *
 * `config.readPath` is served to the browser, and `NeonActivity` lets a session
 * override it — that is how S12 and S13 compared old and new answers side by
 * side. **The write path is deliberately not overridable and is never sent to
 * the browser.** A wrong read is corrected by reloading the page; a wrong write
 * is a row in the wrong database, and if the browser could choose, one stale tab
 * could keep writing to the provider the deployment had already left. So the
 * decision is the server's alone, taken once per invocation, and there is no
 * `config.writePath` operation to ask about it.
 *
 * ## Why a flag at all, rather than switching the handlers outright
 *
 * The invariant every session in this migration carries is that the dashboard
 * running today keeps working. `NEON_DATABASE_URL` is set in no Vercel
 * environment, so a handler that resolved a Neon store unconditionally would
 * throw `NEON_CONFIGURATION_MISSING` on the first pipeline write in production.
 * The flag is what keeps the new code inert until a deployment has both the
 * credential and the owner's decision to use it.
 */

export type WritePath = 'supabase' | 'neon'

export const NEON_WRITES_ENV = 'NEON_WRITES_DEFAULT'

/**
 * The deployment's write path. Off unless a deployment says exactly `neon`.
 *
 * Read per call rather than cached at module scope: a cached value would make
 * the flag untestable without reloading the module, and the cost is one property
 * lookup against an object already in memory.
 */
export function deploymentWritePath(env = process.env): WritePath {
  return (env[NEON_WRITES_ENV] ?? '').trim() === 'neon' ? 'neon' : 'supabase'
}
