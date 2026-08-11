/**
 * Which provider a deployment's data path runs against — and, since S27, which
 * way that decision leans when nobody has stated it.
 *
 * ## What changed, and why the old direction had to go
 *
 * Every path flag used to read `value === 'neon' ? 'neon' : 'supabase'`. That
 * was right while Supabase was the thing that worked and Neon was the thing
 * being proved: unset, empty, `true`, `1` and every typo kept the working
 * dashboard, and the new code stayed inert until a deployment had both the
 * credential and the owner's decision.
 *
 * Supabase is now the thing being removed. Keeping that direction would mean
 * every future deployment — every tenant the control plane onboards — has to
 * remember to say `neon` four times or silently reach for a provider it was
 * never given, and a forgotten binding would present as a dead dashboard rather
 * than as a misconfiguration. So the default inverts.
 *
 * ## The default is derived, not assumed, and that is the safety property
 *
 * `neon` is **not** simply hardcoded as the new fallback. An unset flag resolves
 * to `neon` only when the deployment actually holds the credential that path
 * needs, and to `supabase` when it does not.
 *
 * That single condition is what makes this change safe to land ahead of the data
 * migration. The owner's own deployment sets none of these flags and holds no
 * Neon connection string; a plain inversion would have moved it to Neon on the
 * next deploy, where `readNeonConnectionString` throws and every read 500s — a
 * live dashboard taken down by a merge, with no env change to blame it on and
 * none possible from inside this repository. Deriving from the credential means
 * that deployment keeps answering from Supabase until somebody gives it a Neon
 * credential, which is precisely the moment it should stop.
 *
 * It is per path, not global, because the credentials are: the AI layer has its
 * own (`NEON_AI_DATABASE_URL`, the `app_system` principal) and a deployment that
 * holds one and not the other is a real state.
 *
 * ## An unrecognised value is refused, not interpreted
 *
 * The old shape treated every unknown string as "stay on Supabase", which was a
 * safe guess in that direction and is not one in this direction: a mistyped
 * opt-out would move a deployment holding both credentials onto the provider its
 * live data is not in. There are exactly two legal values and anything else is a
 * misconfiguration, so it says so instead of choosing a database.
 *
 * This is safe to be strict about because nothing sets these to anything else
 * today: the tenant contract binds the exact string `neon`, and the owner's
 * deployment binds nothing at all.
 */

export type ProviderPath = 'supabase' | 'neon'

/** The two values every provider flag accepts. */
export const PROVIDER_PATH_VALUES = ['neon', 'supabase'] as const

export class ProviderPathError extends Error {
  readonly variable: string

  /**
   * `legal` is a parameter because the photo flag has a third legal value
   * (`disabled`, a deployment posture rather than a provider) and must name it:
   * an error that listed two values while the code accepts three would send the
   * reader looking for a bug in the wrong place.
   */
  constructor(
    variable: string,
    legal: readonly string[] = PROVIDER_PATH_VALUES,
  ) {
    super(
      `${variable} must be exactly ${legal.map((value) => `"${value}"`).join(' or ')} ` +
        `when it is set. Leave it unset to take this deployment's derived ` +
        `default, which follows what the deployment is equipped for. Refusing to ` +
        `continue: guessing which value was meant would choose a database.`,
    )
    this.name = 'ProviderPathError'
    this.variable = variable
  }
}

/**
 * Resolve one path.
 *
 * `credentialConfigured` is a thunk rather than a boolean so a deployment that
 * states its choice never pays for a lookup it does not need — and, more to the
 * point, so the presence check is not what decides an explicit `neon`. A
 * deployment that says `neon` and holds no credential must fail loudly on first
 * use, exactly as it does today; silently answering `supabase` would be this
 * migration's worst outcome, a deployment reading the wrong database while
 * reporting success.
 */
export function resolveProviderPath(
  variable: string,
  raw: unknown,
  credentialConfigured: () => boolean,
): ProviderPath {
  // A missing variable is the unset case; a *present* value of some other type is
  // a misconfiguration, and reading it as unset would hide it. The environment
  // only ever holds strings, so this is about a caller passing a parsed config.
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new ProviderPathError(variable)
  }
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === 'neon') return 'neon'
  if (value === 'supabase') return 'supabase'
  if (value !== '') throw new ProviderPathError(variable)
  return credentialConfigured() ? 'neon' : 'supabase'
}
