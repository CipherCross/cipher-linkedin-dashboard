/**
 * The process-wide object-storage provider.
 *
 * Module scope for the reason `identity/runtime.ts` and `data/store.ts` are:
 * a serverless function that rebuilds its clients per invocation throws the
 * warm one away every time. Lazily constructed, so importing a handler never
 * requires a credential — a type-check or a test can import this module without
 * a bucket existing anywhere.
 *
 * **One instance per tenant, keyed by tenant.** A provider is bound to a single
 * tenant at construction (`keys.ts` explains why the binding is re-checked on
 * every call rather than trusted from construction), so the cache is a map
 * rather than a single slot. A warm container serving two tenants keeps two
 * providers, which is correct and cheap: a provider holds a credential and a
 * bucket name, not a connection.
 *
 * **No caller yet, deliberately.** S19 owns the port, the isolation and the
 * policy; `S20` owns the lead-photo API and UI that will call this, and `S23`
 * owns the agent-artifact bucket, which is separately scoped and does not use
 * this factory. This module exists so that work starts from a wired entry point
 * rather than re-deciding how configuration reaches an adapter.
 */

import { readObjectStorageConfig } from './config.js'
import { isValidTenantId, ObjectKeyError } from './keys.js'
import type { ObjectStorageProvider } from './provider.js'
import { R2ObjectStorageProvider } from './r2Provider.js'

const providers = new Map<string, ObjectStorageProvider>()

export function getObjectStorageProvider(
  tenantId: string,
): ObjectStorageProvider {
  if (!isValidTenantId(tenantId)) {
    // Refused here as well as inside the provider: this is the point where a
    // caller-supplied value would otherwise become a cache key.
    throw new ObjectKeyError(
      `Cannot build an object storage provider for tenant ` +
        `${JSON.stringify(tenantId)}: not a valid tenant id`,
    )
  }

  const existing = providers.get(tenantId)
  if (existing) return existing

  const config = readObjectStorageConfig()
  const provider = new R2ObjectStorageProvider({
    tenantId,
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
  })
  providers.set(tenantId, provider)
  return provider
}

/** True once a provider exists, so a test can assert the instance is reused. */
export function objectStorageProviderExists(tenantId: string): boolean {
  return providers.has(tenantId)
}

/**
 * Drop every cached provider. For tests and graceful shutdown — never the
 * request path, which must not close a provider other requests are using.
 */
export async function resetObjectStorageProviders(): Promise<void> {
  const existing = [...providers.values()]
  providers.clear()
  await Promise.all(existing.map((provider) => provider.close()))
}
