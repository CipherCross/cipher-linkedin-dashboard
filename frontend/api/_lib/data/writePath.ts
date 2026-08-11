import { dataStoreConfigured } from './neonConfig.js'
import { resolveProviderPath, type ProviderPath } from './providerPath.js'

/**
 * Which database a non-AI write goes to.
 *
 * The read path's equivalent is `deploymentReadPath` in `api/activity-daily.ts`,
 * and the two share one resolver — `providerPath.ts` — rather than each restating
 * the rule, because the two flags disagreeing is how a deployment ends up reading
 * one provider and writing another. Since S27 that rule is: `neon` wherever the
 * deployment holds the credential this path needs, `supabase` where it does not,
 * and a refusal for a value nobody recognises.
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
 * running today keeps working, and a deployment holding no Neon credential would
 * throw `NEON_CONFIGURATION_MISSING` on its first pipeline write if a handler
 * resolved a Neon store unconditionally. S27 moved *what decides* that — the
 * credential's presence now answers it, so the flag no longer has to be set by
 * hand for the new path to come on — but not *whether* something has to decide:
 * `supabase` stays reachable as an explicit opt-out, for a deployment that holds
 * the credential and is deliberately being held back.
 */

export type WritePath = ProviderPath

export const NEON_WRITES_ENV = 'NEON_WRITES_DEFAULT'

/**
 * The deployment's write path.
 *
 * **S27 inverted the default.** It used to be off unless a deployment said
 * exactly `neon`; it is now on wherever the deployment holds
 * `NEON_DATABASE_URL`, and `supabase` is the explicit opt-out. `providerPath.ts`
 * carries the whole argument, including why the default is derived from the
 * credential rather than simply flipped — the short version is that a plain
 * inversion would have taken the owner's live dashboard down on the next deploy.
 *
 * What did not change: the write path is still never sent to the browser and
 * still not overridable by a session. A wrong read is corrected by reloading the
 * page; a wrong write is a row in the wrong database.
 *
 * Read per call rather than cached at module scope: a cached value would make
 * the flag untestable without reloading the module, and the cost is one property
 * lookup against an object already in memory.
 */
export function deploymentWritePath(env = process.env): WritePath {
  return resolveProviderPath(NEON_WRITES_ENV, env[NEON_WRITES_ENV], () =>
    dataStoreConfigured(env),
  )
}
