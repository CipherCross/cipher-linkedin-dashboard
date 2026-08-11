import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as z from "zod/v4";

import { validateCatalogSnapshot } from "../core/catalogs.js";
import { OpsError, assertOps } from "../core/errors.js";
import { Redactor } from "../core/redaction.js";
import { asJsonValue } from "../core/semantic-validation.js";
import type { CatalogSnapshot } from "../core/types.js";
import { CANONICAL_RUNTIME_PROFILE_ID } from "../providers/hosting-tenant.js";
import {
  createS26ConcreteApiBundle,
  type ProviderCredentialResolver,
  type ProviderHttpConfiguration,
} from "../providers/s26-concrete-clients.js";
import { MacOsKeychainSecretStore } from "../secrets/keychain.js";
import { labelsForSecret, type PlatformSecretName, type SecretStore } from "../secrets/types.js";
import type { Registry } from "../state/registry.js";
import { createS26Runtime, type S26Runtime } from "./s26-runtime.js";
import type { DisposableOnboardingProfile } from "../core/provider-preflight.js";

const HTTPS_URL = z.url().refine((value) => new URL(value).protocol === "https:", {
  message: "URL must use HTTPS",
});
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const platformSecretName = z.enum([
  "neon.operations_token",
  "r2.operations_token",
  "vercel.operations_token",
  "s26.bridge_token",
]);

const providerConfig = z.strictObject({
  base_url: HTTPS_URL,
  credential_name: platformSecretName,
  scope_id: identifier.optional(),
});

const catalogEntry = z.strictObject({
  id: identifier,
  availability: z.enum(["available", "deprecated", "unavailable"]),
  approved: z.boolean(),
  expires_at: z.iso.datetime({ offset: true }).optional(),
  pricing_sku_id: identifier.optional(),
  billable: z.boolean().optional(),
  required_secret_names: z.array(identifier).optional(),
  cost_sku_ids: z.array(identifier).optional(),
  provider_region_code: identifier.optional(),
  jurisdiction: identifier.optional(),
  residency_policy_ids: z.array(identifier).optional(),
  allowed_workspace_classes: z.array(z.enum(["internal", "disposable", "external"])).optional(),
  legal_review_status: z.enum(["approved", "pending", "rejected"]).optional(),
  provider: identifier.optional(),
  kind: z.enum(["plan", "compute"]).optional(),
  capacity_limits: z.json().optional(),
  feature_limits: z.json().optional(),
  backup_capability_ids: z.array(identifier).optional(),
  currency: z.string().length(3).optional(),
  minor_unit_price: z.number().int().nonnegative().optional(),
  pricing_unit: identifier.optional(),
  tax_treatment: z.enum(["included", "excluded", "not_applicable"]).optional(),
  effective_at: z.iso.datetime({ offset: true }).optional(),
  source_reference: z.string().min(1).max(500).optional(),
  maximum_rpo_hours: z.number().int().positive().optional(),
  maximum_rto_business_hours: z.number().int().positive().optional(),
  provider_backup_interval_hours: z.number().int().positive().optional(),
  export_interval_hours: z.number().int().positive().optional(),
  drill_interval_days: z.number().int().positive().optional(),
  retention_choices: z.array(identifier).optional(),
  required_coverage: z.array(identifier).optional(),
  compatible_tier_ids: z.array(identifier).optional(),
  baseline_version: z.number().int().positive().optional(),
  schema_min: z.number().int().positive().optional(),
  schema_max: z.number().int().positive().optional(),
  application_min: identifier.optional(),
  application_max: identifier.optional(),
  agent_min: identifier.optional(),
  agent_max: identifier.optional(),
  launcher_min: identifier.optional(),
  launcher_max: identifier.optional(),
  protocol_min: identifier.optional(),
  protocol_max: identifier.optional(),
  allowed_channels: z.array(z.enum(["internal", "canary", "stable"])).optional(),
  approved_migration_digests: z.array(sha256).optional(),
  verification_bundle_digests: z.array(sha256).optional(),
  metering_unit: identifier.optional(),
  allowed_overage_actions: z.array(z.enum(["pause_and_alert", "queue_and_alert", "disable_and_alert"])).optional(),
  approved_processors: z.array(identifier).optional(),
  data_flows: z.array(identifier).optional(),
  region_restrictions: z.array(identifier).optional(),
});

const catalog = z.strictObject({
  catalog_kind: z.enum(["regions", "provider_tiers", "pricing", "backup_profiles", "release_compatibility", "capabilities", "subprocessors"]),
  catalog_version: identifier,
  source_revision: gitSha,
  published_at: z.iso.datetime({ offset: true }),
  valid_until: z.iso.datetime({ offset: true }),
  digest: sha256,
  review_status: z.enum(["approved", "draft", "rejected"]),
  entries: z.array(catalogEntry).min(1),
});

/**
 * The catalog entries and business facts this drill selects. They are closed
 * non-secret configuration rather than code constants so an S26 run can never
 * inherit another runtime's selections: every id is resolved against the
 * pinned catalogs, and an unknown or unavailable one fails the plan.
 */
const selections = z.strictObject({
  company_name: z.string().trim().min(1).max(160),
  admin_email: z.email().max(320),
  expected_instances: z.number().int().min(1).max(100),
  release_channel: z.enum(["internal", "canary", "stable"]),
  residency_policy_id: identifier,
  region_id: identifier,
  data_tier_id: identifier,
  data_compute_id: identifier,
  hosting_tier_id: identifier,
  backup_profile_id: identifier,
  retention_policy_id: identifier,
  subprocessor_profile_id: identifier,
  smtp_profile_id: identifier,
  smtp_secret_labels: z.array(z.string().min(1).max(200)).max(8),
  support_access_maximum_duration_hours: z.number().int().min(1).max(168),
});

const profile = z.strictObject({
  allowed_tenant_slug: z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/),
  selections,
  platform_domain: z.string().min(1).max(253),
  data_owner_scope_id: identifier,
  hosting_owner_scope_id: identifier,
  source_git_sha: gitSha,
  application_version: identifier,
  compatibility_entry_id: identifier,
  agent_release_id: identifier,
  ingest_protocol_id: identifier,
  template_set_id: identifier,
  sender_domain: z.string().min(1).max(253),
  from_identity: z.email().max(320),
  baseline_version: z.literal(53),
  migration_versions: z.array(z.number().int().min(54)).min(1),
  target_schema_version: z.number().int().min(54),
  catalogs: z.array(catalog).length(7),
  cost: z.json(),
  capability_budgets: z.json(),
  recovery: z.json(),
  smoke_test_ids: z.array(identifier).min(1),
});

const s26ConfigSchema = z.strictObject({
  config_version: z.literal("s26-owner-runtime.v1"),
  providers: z.strictObject({
    neon: providerConfig.extend({ credential_name: z.literal("neon.operations_token") }),
    r2: providerConfig.extend({ credential_name: z.literal("r2.operations_token"), scope_id: identifier }),
    vercel: providerConfig.extend({ credential_name: z.literal("vercel.operations_token"), scope_id: identifier }),
    bridge: providerConfig.extend({ credential_name: z.literal("s26.bridge_token") }),
  }),
  profile,
});

export type S26OwnerRuntimeConfig = z.infer<typeof s26ConfigSchema>;

export function loadS26OwnerRuntimeConfig(path: string): S26OwnerRuntimeConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    throw new OpsError("cli_usage", "S26 runtime configuration is not valid JSON");
  }
  const parsed = s26ConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new OpsError("invalid_plan", "S26 runtime configuration is invalid", {
      issue_count: parsed.error.issues.length,
    });
  }
  const catalogKinds = new Set<string>();
  for (const snapshot of parsed.data.profile.catalogs) {
    validateCatalogSnapshot(snapshot);
    if (catalogKinds.has(snapshot.catalog_kind)) {
      throw new OpsError("catalog_invalid", `Duplicate S26 catalog kind ${snapshot.catalog_kind}`);
    }
    catalogKinds.add(snapshot.catalog_kind);
  }
  return parsed.data;
}

/**
 * The onboarding business inputs for the S26 disposable drill.
 *
 * These are derived from the loaded configuration, never from another
 * runtime's constants: the tenant slug is the one the profile allows, and the
 * pricing catalog id is read off the pinned pricing snapshot, so the pair the
 * semantic validator compares cannot drift apart.
 */
export function s26BusinessInputs(config: S26OwnerRuntimeConfig): Record<string, unknown> {
  const { selections: chosen, catalogs } = config.profile;
  const pricing = catalogs.find((catalog) => catalog.catalog_kind === "pricing");
  assertOps(pricing, "catalog_invalid", "S26 configuration has no pricing catalog");
  return {
    company_name: chosen.company_name,
    tenant_slug: config.profile.allowed_tenant_slug,
    workspace_class: "disposable",
    admin_email: chosen.admin_email,
    expected_instances: chosen.expected_instances,
    release_channel: chosen.release_channel,
    residency_policy_id: chosen.residency_policy_id,
    region_id: chosen.region_id,
    data_tier_id: chosen.data_tier_id,
    data_compute_id: chosen.data_compute_id,
    hosting_tier_id: chosen.hosting_tier_id,
    backup_profile_id: chosen.backup_profile_id,
    pricing_catalog_id: pricing.catalog_version,
    retention_policy_id: chosen.retention_policy_id,
    subprocessor_profile_id: chosen.subprocessor_profile_id,
    smtp_profile_id: chosen.smtp_profile_id,
    smtp_secret_labels: chosen.smtp_secret_labels,
    integration_secret_labels: [],
    support_access_policy: {
      initial_state: "disabled",
      maximum_duration_hours: chosen.support_access_maximum_duration_hours,
    },
  };
}

function resolver(
  store: SecretStore,
  name: PlatformSecretName,
  redactor: Redactor,
): ProviderCredentialResolver {
  return {
    async resolve(): Promise<string> {
      const value = await store.get(labelsForSecret({ scope: "platform", name }));
      redactor.registerSecret(value);
      return value;
    },
  };
}

function providerHttp(
  config: { readonly base_url: string; readonly credential_name: PlatformSecretName; readonly scope_id?: string | undefined },
  store: SecretStore,
  redactor: Redactor,
): ProviderHttpConfiguration {
  return {
    baseUrl: config.base_url,
    credential: resolver(store, config.credential_name, redactor),
    ...(config.scope_id === undefined ? {} : { scopeId: config.scope_id }),
  };
}

function onboardingProfile(config: S26OwnerRuntimeConfig): DisposableOnboardingProfile {
  const candidate = config.profile;
  assertOps(
    candidate.target_schema_version >= candidate.migration_versions.at(-1)!,
    "invalid_plan",
    "S26 target schema version precedes the configured migration set",
  );
  return {
    allowedTenantSlug: candidate.allowed_tenant_slug,
    platformDomain: candidate.platform_domain,
    dataOwnerScopeId: candidate.data_owner_scope_id,
    hostingOwnerScopeId: candidate.hosting_owner_scope_id,
    sourceGitSha: candidate.source_git_sha,
    applicationVersion: candidate.application_version,
    compatibilityEntryId: candidate.compatibility_entry_id,
    agentReleaseId: candidate.agent_release_id,
    ingestProtocolId: candidate.ingest_protocol_id,
    templateSetId: candidate.template_set_id,
    senderDomain: candidate.sender_domain,
    fromIdentity: candidate.from_identity,
    runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
    baselineVersion: candidate.baseline_version,
    migrationVersions: candidate.migration_versions,
    targetSchemaVersion: candidate.target_schema_version,
    catalogs: candidate.catalogs as readonly CatalogSnapshot[],
    cost: asJsonValue(candidate.cost),
    capabilityBudgets: asJsonValue(candidate.capability_budgets),
    recovery: asJsonValue(candidate.recovery),
    smokeTestIds: candidate.smoke_test_ids,
  };
}

/** Builds the S26-only runtime without P4-C, environment forwarding, or secret output. */
export function createConfiguredS26Runtime(
  registry: Registry,
  configPath: string,
  redactor = new Redactor(),
  store: SecretStore = new MacOsKeychainSecretStore(redactor),
): S26Runtime {
  const config = loadS26OwnerRuntimeConfig(configPath);
  const bridge = providerHttp(config.providers.bridge, store, redactor);
  const apis = createS26ConcreteApiBundle({
    neon: providerHttp(config.providers.neon, store, redactor),
    r2: providerHttp(config.providers.r2, store, redactor),
    vercel: providerHttp(config.providers.vercel, store, redactor),
    betterAuth: bridge,
    smtp: bridge,
    domain: bridge,
    sourceRepository: bridge,
    bridge,
  }, redactor);
  return createS26Runtime(registry, onboardingProfile(config), apis, redactor);
}
