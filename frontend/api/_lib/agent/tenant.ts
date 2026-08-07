/**
 * Which tenant this deployment serves.
 *
 * ## Why the value exists at all in a one-database-per-tenant shape
 *
 * G0's shape gives every tenant its own database, so "which tenant is this?" is
 * already answered by the connection string, and a `tenant_id` column is
 * redundant with it. That redundancy is the check rather than an oversight: a
 * credential minted for another tenant, or a dump restored into the wrong
 * deployment, is refused by `agent_credential_resolve` instead of being accepted
 * because the row happened to be present in the database it was asked about.
 *
 * ## Two names, and why they must agree rather than one winning
 *
 * `OBJECT_STORAGE_TENANT_ID` came first — S20 needed a tenant to prefix object
 * keys with before the schema had one, and `N-S20.md` design call 10 records
 * that it would become the bootstrap value once S21 gave the schema its column.
 * `APP_TENANT_ID` is the name that outlives the storage layer, because the
 * tenant is a property of the deployment rather than of its bucket.
 *
 * So both are read, and when both are set they must be **equal**. A precedence
 * rule would have been shorter and would have hidden the one configuration that
 * is genuinely broken: a deployment whose objects are filed under one tenant
 * while its credentials are checked against another. That deployment would sign
 * URLs for keys nobody writes and accept credentials nobody issued, and neither
 * failure looks like a misconfiguration from the outside.
 */

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

export const APP_TENANT_ID_ENV = 'APP_TENANT_ID'
export const OBJECT_STORAGE_TENANT_ID_ENV = 'OBJECT_STORAGE_TENANT_ID'

export type EnvSource = Readonly<Record<string, string | undefined>>

export class TenantConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantConfigurationError'
  }
}

const read = (env: EnvSource, name: string): string =>
  typeof env[name] === 'string' ? (env[name] as string).trim() : ''

/**
 * The deployment's tenant, or `null` when it has none configured.
 *
 * `null` rather than a throw, and rather than a default: the ingest operation
 * answers 503 for an unconfigured deployment, which is what an operator can act
 * on, while a default such as `default` would be the value production silently
 * ran on — and moving off it later means rewriting every credential row and
 * every object key that was ever filed under it.
 *
 * A value present but malformed is a different thing from an absent one and
 * throws, because it is a typo somebody made rather than a step nobody took.
 */
export function readDeploymentTenantId(
  env: EnvSource = process.env,
): string | null {
  const app = read(env, APP_TENANT_ID_ENV)
  const storage = read(env, OBJECT_STORAGE_TENANT_ID_ENV)

  for (const [name, value] of [
    [APP_TENANT_ID_ENV, app],
    [OBJECT_STORAGE_TENANT_ID_ENV, storage],
  ] as const) {
    if (value !== '' && !TENANT_ID_PATTERN.test(value)) {
      throw new TenantConfigurationError(
        `${name} must be a lowercase alphanumeric token with hyphens, 1-63 characters`,
      )
    }
  }

  if (app !== '' && storage !== '' && app !== storage) {
    throw new TenantConfigurationError(
      `${APP_TENANT_ID_ENV} and ${OBJECT_STORAGE_TENANT_ID_ENV} name different tenants; ` +
        'one deployment serves one tenant, so they must be equal or only one may be set',
    )
  }

  return app !== '' ? app : storage !== '' ? storage : null
}
