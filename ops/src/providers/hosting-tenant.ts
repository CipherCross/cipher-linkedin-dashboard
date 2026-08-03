/**
 * The canonical tenant hosting profile: which environment values a tenant
 * deployment carries, what class each one is, where each one comes from, and
 * which runtime profile, build recipe and rollback reason the platform pins.
 *
 * This is the "new environment variable names" surface. It belongs to the
 * hosting port because binding environment values *is* one of the seven hosting
 * capabilities: the port owns the names it writes, and a provider-neutral port
 * cannot own names that spell a specific data vendor.
 *
 * **Dual naming.** Every canonical name carries the `legacyName` that the
 * running application reads today. `buildTenantEnvironmentBindings` emits both,
 * with the same value class and the same source, so a deployment produced
 * through this contract still satisfies every consumer that has not yet been
 * ported. The legacy column is removed when `frontend/` and `sync-agent/` stop
 * reading it — S13–S15 and S21–S23, not here.
 *
 * No value ever appears in this module. A binding declares a *source*: a
 * key-store secret name, a generator ID, or a reference to a field of the
 * approved plan. Resolution happens inside an adapter, and the resolved value
 * is written to the provider and then dropped.
 */

import type {
  HostingValueBinding,
  HostingValueClass,
  HostingValueSource,
} from "./hosting.js";

/** Version of the canonical environment binding contract. */
export const HOSTING_ENVIRONMENT_CONTRACT = "hosting.environment.v1" as const;

/**
 * Opaque catalog identifiers. They are placeholders in exactly the sense S09
 * recorded: the approved runtime-profile and build-recipe catalogs are S24's,
 * and these constants move there when they exist.
 */
export const CANONICAL_RUNTIME_PROFILE_ID = "web-node22-1x" as const;
export const CANONICAL_BUILD_RECIPE_ID = "spa-plus-http-handlers-v1" as const;
export const CANONICAL_ROLLBACK_REASON_CODE = "verification_failed" as const;

/**
 * Where a value comes from, stated without a tenant. `secretName` is a
 * tenant-scoped secret *name*; the tenant slug is applied by the builder, so
 * the contract itself is tenant-independent and carries no key-store label.
 */
export type HostingEnvironmentSourceSpec =
  | { readonly kind: "secret_label"; readonly secretName: string }
  | { readonly kind: "generated_secret"; readonly generatorId: string }
  | { readonly kind: "derived_from_plan"; readonly planFieldRef: string };

export interface HostingEnvironmentValueContract {
  /** Canonical, provider-neutral name. */
  readonly name: string;
  /** The name today's application reads, dual-written during the transition. */
  readonly legacyName: string | null;
  readonly valueClass: HostingValueClass;
  readonly source: HostingEnvironmentSourceSpec;
}

/**
 * Plan-field references a caller must be able to resolve. They name fields the
 * approved plan already pins, never free-form provider output.
 */
export const HOSTING_PLAN_FIELD_REFS = {
  dataApiUrl: "resources.data_api_url",
  hostname: "domain.hostname",
} as const;

/**
 * The nine values a tenant deployment needs, in canonical order.
 *
 * The database connection string a Neon-backed runtime will need is
 * deliberately absent: S11 owns the driver and is blocked on G1, and declaring
 * a binding whose source nothing can resolve would make the plan promise a
 * value the apply step could not produce.
 */
export const CANONICAL_TENANT_ENVIRONMENT: readonly HostingEnvironmentValueContract[] =
  [
    {
      name: "PUBLIC_DATA_API_URL",
      legacyName: "VITE_SUPABASE_URL",
      valueClass: "public_build",
      source: {
        kind: "derived_from_plan",
        planFieldRef: HOSTING_PLAN_FIELD_REFS.dataApiUrl,
      },
    },
    {
      name: "PUBLIC_DATA_API_KEY",
      legacyName: "VITE_SUPABASE_ANON_KEY",
      valueClass: "public_build",
      source: { kind: "secret_label", secretName: "data.public_key" },
    },
    {
      name: "DATA_API_URL",
      legacyName: "SUPABASE_URL",
      valueClass: "server_public",
      source: {
        kind: "derived_from_plan",
        planFieldRef: HOSTING_PLAN_FIELD_REFS.dataApiUrl,
      },
    },
    {
      name: "DATA_API_KEY",
      legacyName: "SUPABASE_ANON_KEY",
      valueClass: "server_public",
      source: { kind: "secret_label", secretName: "data.public_key" },
    },
    {
      name: "DATA_API_ADMIN_KEY",
      legacyName: "SUPABASE_SERVICE_ROLE_KEY",
      valueClass: "server_secret",
      source: { kind: "secret_label", secretName: "data.admin_key" },
    },
    {
      name: "SCHEDULE_INVOKE_SECRET",
      legacyName: "CRON_SECRET",
      valueClass: "server_secret",
      source: {
        kind: "generated_secret",
        generatorId: "tenant.schedule_invoke_secret",
      },
    },
    {
      name: "INGEST_INVOKE_SECRET",
      legacyName: "NOTIFY_SECRET",
      valueClass: "server_secret",
      source: {
        kind: "generated_secret",
        generatorId: "tenant.ingest_invoke_secret",
      },
    },
    {
      name: "TOOL_BRIDGE_SECRET",
      legacyName: "MCP_SECRET",
      valueClass: "server_secret",
      source: {
        kind: "generated_secret",
        generatorId: "tenant.tool_bridge_secret",
      },
    },
    {
      name: "APP_BASE_URL",
      legacyName: "DASHBOARD_URL",
      valueClass: "server_public",
      source: {
        kind: "derived_from_plan",
        planFieldRef: HOSTING_PLAN_FIELD_REFS.hostname,
      },
    },
  ];

/** The old→new mapping, as data, so a test can assert it rather than trust prose. */
export const CANONICAL_ENVIRONMENT_NAME_MAPPING: readonly {
  readonly legacyName: string;
  readonly name: string;
}[] = CANONICAL_TENANT_ENVIRONMENT.filter(
  (entry): entry is HostingEnvironmentValueContract & { legacyName: string } =>
    entry.legacyName !== null,
).map((entry) => ({ legacyName: entry.legacyName, name: entry.name }));

export const CANONICAL_PUBLIC_BUILD_VALUE_NAMES: readonly string[] =
  CANONICAL_TENANT_ENVIRONMENT.filter(
    (entry) => entry.valueClass === "public_build",
  ).map((entry) => entry.name);

export const LEGACY_PUBLIC_BUILD_VALUE_NAMES: readonly string[] =
  CANONICAL_TENANT_ENVIRONMENT.filter(
    (entry) => entry.valueClass === "public_build" && entry.legacyName !== null,
  ).map((entry) => entry.legacyName!);

export function tenantSecretLabel(tenantSlug: string, secretName: string): string {
  return `lh2-platform/tenant/${tenantSlug}/${secretName}`;
}

function bindingSource(
  spec: HostingEnvironmentSourceSpec,
  tenantSlug: string,
): HostingValueSource {
  if (spec.kind === "secret_label") {
    return {
      kind: "secret_label",
      secretLabel: tenantSecretLabel(tenantSlug, spec.secretName),
    };
  }
  if (spec.kind === "generated_secret") {
    return { kind: "generated_secret", generatorId: spec.generatorId };
  }
  return { kind: "derived_from_plan", planFieldRef: spec.planFieldRef };
}

export interface TenantEnvironmentBindingInput {
  readonly tenantSlug: string;
  /**
   * Emit the legacy name alongside each canonical name. Default true: the
   * running application still reads the legacy names, and a deployment that
   * dropped them would lose a value it needs.
   */
  readonly includeLegacyNames?: boolean;
}

/**
 * The canonical binding list for one tenant, sorted by name so the request, the
 * binding digest and the resulting registry rows are order-independent.
 */
export function buildTenantEnvironmentBindings(
  input: TenantEnvironmentBindingInput,
): readonly HostingValueBinding[] {
  const includeLegacy = input.includeLegacyNames ?? true;
  const bindings: HostingValueBinding[] = [];
  for (const entry of CANONICAL_TENANT_ENVIRONMENT) {
    const source = bindingSource(entry.source, input.tenantSlug);
    bindings.push({ name: entry.name, valueClass: entry.valueClass, source });
    if (includeLegacy && entry.legacyName !== null) {
      bindings.push({
        name: entry.legacyName,
        valueClass: entry.valueClass,
        source,
      });
    }
  }
  return bindings.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}
