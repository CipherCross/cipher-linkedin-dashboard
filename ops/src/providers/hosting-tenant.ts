/**
 * Closed S26 application-hosting value contract.
 *
 * This is deliberately not a migration map. The old Supabase-shaped variables
 * are absent, and every entry below is carried by the approved plan, the bind
 * request, the pinned build, recovery metadata, and verification metadata as a
 * name/class/source descriptor. Values and credential labels never appear.
 */

import {
  hostingEnvironmentBindingDigest,
  type HostingValueBinding,
  type HostingValueClass,
  type HostingValueSource,
} from "./hosting.js";

/** Versioned closed contract for the S26 application's hosting values. */
export const HOSTING_ENVIRONMENT_CONTRACT = "hosting.environment.v3" as const;
export const S26_APPLICATION_HOSTING_PROFILE = "s26.application-hosting.v1" as const;

export const CANONICAL_RUNTIME_PROFILE_ID = "web-node22-1x" as const;
export const CANONICAL_BUILD_RECIPE_ID = "spa-plus-http-handlers-v1" as const;
export const CANONICAL_ROLLBACK_REASON_CODE = "verification_failed" as const;

export type HostingEnvironmentSourceSpec =
  | { readonly kind: "generated_secret"; readonly generatorId: string }
  | { readonly kind: "derived_from_plan"; readonly planFieldRef: string }
  | { readonly kind: "derived_from_owned_resource"; readonly resourceRef: string };

export interface HostingEnvironmentValueContract {
  readonly name: string;
  readonly valueClass: HostingValueClass;
  readonly source: HostingEnvironmentSourceSpec;
}

/** Approved plan references; the Worker resolves no caller-supplied path. */
export const HOSTING_PLAN_FIELD_REFS = {
  identityBaseUrl: "identity.base_url",
  authPath: "application.auth_path",
  neonReadsDefault: "application.neon_reads_default",
  neonWritesDefault: "application.neon_writes_default",
  neonAiPathDefault: "application.neon_ai_path_default",
  neonPhotosDefault: "application.neon_photos_default",
} as const;

/** Registry-owned logical resources, not provider IDs or connection strings. */
/**
 * The platform's own verified sending identity. It is one resource shared by
 * every tenant — a single verified domain — which is why the tenant's copy is
 * derived from it rather than planned per tenant.
 */
export const S26_SENDER_RESOURCE_REFS = {
  apiCredential: "email.sender.api_credential",
  fromIdentity: "email.sender.from_identity",
} as const;

export const S26_ROLE_RESOURCE_REFS = {
  appRuntime: "data.roles.app_runtime",
  appSystem: "data.roles.app_system",
  appMachine: "data.roles.app_machine",
  identityStore: "data.roles.identity_store",
} as const;

/**
 * The complete S26 value list. Four URLs are least-privilege role URLs; Better
 * Auth uses a dedicated identity store URL, session secret, base URL, and
 * explicit public auth selector. Reads/writes/AI are exactly `neon`; photos are
 * exactly `disabled`, so no tenant-scoped R2 application credentials exist.
 */
export const CANONICAL_TENANT_ENVIRONMENT: readonly HostingEnvironmentValueContract[] = [
  {
    name: "NEON_DATABASE_URL",
    valueClass: "server_secret",
    source: { kind: "derived_from_owned_resource", resourceRef: S26_ROLE_RESOURCE_REFS.appRuntime },
  },
  {
    name: "NEON_AI_DATABASE_URL",
    valueClass: "server_secret",
    source: { kind: "derived_from_owned_resource", resourceRef: S26_ROLE_RESOURCE_REFS.appSystem },
  },
  {
    name: "NEON_MACHINE_DATABASE_URL",
    valueClass: "server_secret",
    source: { kind: "derived_from_owned_resource", resourceRef: S26_ROLE_RESOURCE_REFS.appMachine },
  },
  {
    name: "IDENTITY_STORE_DATABASE_URL",
    valueClass: "server_secret",
    source: { kind: "derived_from_owned_resource", resourceRef: S26_ROLE_RESOURCE_REFS.identityStore },
  },
  {
    name: "IDENTITY_SESSION_SECRET",
    valueClass: "server_secret",
    source: { kind: "generated_secret", generatorId: "tenant.identity_session_secret" },
  },
  {
    name: "CRON_SECRET",
    valueClass: "server_secret",
    source: { kind: "generated_secret", generatorId: "tenant.cron_secret" },
  },
  {
    name: "NOTIFY_SECRET",
    valueClass: "server_secret",
    source: { kind: "generated_secret", generatorId: "tenant.notify_secret" },
  },
  {
    name: "MCP_SECRET",
    valueClass: "server_secret",
    source: { kind: "generated_secret", generatorId: "tenant.mcp_secret" },
  },
  {
    name: "IDENTITY_BASE_URL",
    valueClass: "server_public",
    source: { kind: "derived_from_plan", planFieldRef: HOSTING_PLAN_FIELD_REFS.identityBaseUrl },
  },
  {
    name: "NEON_READS_DEFAULT",
    valueClass: "server_public",
    source: { kind: "derived_from_plan", planFieldRef: HOSTING_PLAN_FIELD_REFS.neonReadsDefault },
  },
  {
    name: "NEON_WRITES_DEFAULT",
    valueClass: "server_public",
    source: { kind: "derived_from_plan", planFieldRef: HOSTING_PLAN_FIELD_REFS.neonWritesDefault },
  },
  {
    name: "NEON_AI_PATH_DEFAULT",
    valueClass: "server_public",
    source: { kind: "derived_from_plan", planFieldRef: HOSTING_PLAN_FIELD_REFS.neonAiPathDefault },
  },
  {
    name: "NEON_PHOTOS_DEFAULT",
    valueClass: "server_public",
    source: { kind: "derived_from_plan", planFieldRef: HOSTING_PLAN_FIELD_REFS.neonPhotosDefault },
  },
  {
    // Without these two the application can send no mail at all, and the one
    // flow that needs it is the only way anybody reaches an account: an invite
    // creates a credential nobody knows and points at the reset link. v2 bound
    // no sender, so `dropResetLink` discarded every link and no invited person
    // could sign in.
    name: "RESEND_API_KEY",
    valueClass: "server_secret",
    source: { kind: "derived_from_owned_resource", resourceRef: S26_SENDER_RESOURCE_REFS.apiCredential },
  },
  {
    name: "RESEND_FROM_IDENTITY",
    valueClass: "server_public",
    source: { kind: "derived_from_owned_resource", resourceRef: S26_SENDER_RESOURCE_REFS.fromIdentity },
  },
  {
    name: "VITE_AUTH_PATH",
    valueClass: "public_build",
    source: { kind: "derived_from_plan", planFieldRef: HOSTING_PLAN_FIELD_REFS.authPath },
  },
];

export const CANONICAL_PUBLIC_BUILD_VALUE_NAMES: readonly string[] =
  CANONICAL_TENANT_ENVIRONMENT
    .filter((entry) => entry.valueClass === "public_build")
    .map((entry) => entry.name);

/** Present only for source compatibility; v2 deliberately has no legacy names. */
export const LEGACY_PUBLIC_BUILD_VALUE_NAMES: readonly string[] = [];
export const CANONICAL_ENVIRONMENT_NAME_MAPPING: readonly {
  readonly legacyName: string;
  readonly name: string;
}[] = [];

/** Legacy SDK helper; v2 never calls it because the closed profile has no labels. */
export function tenantSecretLabel(tenantSlug: string, secretName: string): string {
  return `lh2-platform/tenant/${tenantSlug}/${secretName}`;
}

function bindingSource(spec: HostingEnvironmentSourceSpec): HostingValueSource {
  if (spec.kind === "generated_secret") {
    return { kind: spec.kind, generatorId: spec.generatorId };
  }
  if (spec.kind === "derived_from_plan") {
    return { kind: spec.kind, planFieldRef: spec.planFieldRef };
  }
  return { kind: spec.kind, resourceRef: spec.resourceRef };
}

export interface TenantEnvironmentBindingInput {
  /** Kept to preserve the provider-neutral builder shape; never becomes a secret label. */
  readonly tenantSlug: string;
  /** Ignored by v2: the transition aliases have been removed. */
  readonly includeLegacyNames?: boolean;
}

/** Closed, sorted descriptor list used by every lifecycle digest. */
export function buildTenantEnvironmentBindings(
  _input: TenantEnvironmentBindingInput,
): readonly HostingValueBinding[] {
  return CANONICAL_TENANT_ENVIRONMENT.map((entry) => ({
    name: entry.name,
    valueClass: entry.valueClass,
    source: bindingSource(entry.source),
  })).sort((left, right) => left.name.localeCompare(right.name));
}

export function tenantEnvironmentContractDigest(
  input: TenantEnvironmentBindingInput,
): string {
  return hostingEnvironmentBindingDigest(
    buildTenantEnvironmentBindings(input).map((binding) => ({
      name: binding.name,
      valueClass: binding.valueClass,
      source: binding.source,
    })),
  );
}
