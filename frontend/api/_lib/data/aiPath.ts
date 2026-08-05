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
 * The shape copies `deploymentWritePath` exactly: only the string `neon`
 * enables the new path, so unset, empty, `true`, `1` and every typo resolve to
 * `supabase`. `NEON_AI_DATABASE_URL` is set in no Vercel environment, so a
 * deployment that flips the flag without the credential fails loudly on the
 * first AI read rather than answering from the wrong database.
 */

export type AiPath = 'supabase' | 'neon'

export const NEON_AI_PATH_ENV = 'NEON_AI_PATH_DEFAULT'

/**
 * The deployment's AI path. Off unless a deployment says exactly `neon`.
 *
 * Read per call rather than cached at module scope, for the same reason as
 * `deploymentWritePath`: a cached value would make the flag untestable without
 * reloading the module.
 */
export function deploymentAiPath(env = process.env): AiPath {
  return (env[NEON_AI_PATH_ENV] ?? '').trim() === 'neon' ? 'neon' : 'supabase'
}
