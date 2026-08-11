import { aiStoreConfigured } from './neonConfig.js'
import { resolveProviderPath, type ProviderPath } from './providerPath.js'

/**
 * Which provider the AI layer runs against.
 *
 * The read and write flags deliberately do not govern this path. `writePath.ts`
 * opens "Which database a non-AI write goes to" — the AI layer is a third path
 * with its own credential (`NEON_AI_DATABASE_URL`) and its own principal
 * (`app_system`), and its reads and writes must move together: a briefing whose
 * seed queries read Neon while its job-state writes go to Supabase would
 * investigate one database and record its progress in another. One flag takes
 * the whole layer — guard reads, and the human-actor writes of `coach.ts`,
 * `classify.ts`, `briefing.ts` and the chat's `save_search` — or none of it.
 *
 * What the flag does **not** move: the cron GET paths of `classify.ts` and
 * `briefing.ts`, `notify-replies.ts`, and the MCP `save_search`. They are
 * machine-authenticated and never have a human actor, and the baseline has no
 * system-actor write policy — every business-table policy is an active-human
 * one. They stay on Supabase, declared blocked, until ledger step 007 (the
 * system write path) is applied. The split is per invocation, taken once, and
 * the browser never sees it.
 *
 * The shape copies `deploymentWritePath` exactly, through the resolver both call:
 * unset means `neon` wherever this path's own credential is present, `supabase`
 * is the explicit opt-out, and an unrecognised value is refused rather than
 * interpreted. A deployment that states `neon` without `NEON_AI_DATABASE_URL`
 * still fails loudly on the first AI read rather than answering from the wrong
 * database — the presence check decides the unset case only, and never turns a
 * stated choice into a silent `supabase`.
 */

export type AiPath = ProviderPath

export const NEON_AI_PATH_ENV = 'NEON_AI_PATH_DEFAULT'

/**
 * The deployment's AI path.
 *
 * **S27 inverted the default**, and this path derives it from its own
 * credential — `NEON_AI_DATABASE_URL`, never `NEON_DATABASE_URL`. That
 * separation is the same one the rest of this file argues for: the AI layer is a
 * third path with its own principal, and a deployment holding the runtime
 * credential but not the system one is a real state that must not be read as
 * consent to run the AI layer against Neon.
 *
 * Read per call rather than cached at module scope, for the same reason as
 * `deploymentWritePath`: a cached value would make the flag untestable without
 * reloading the module.
 */
export function deploymentAiPath(env = process.env): AiPath {
  return resolveProviderPath(NEON_AI_PATH_ENV, env[NEON_AI_PATH_ENV], () =>
    aiStoreConfigured(env),
  )
}
