import { planDigest, type JsonValue } from "./canonical.js";
import { OpsError, assertOps } from "./errors.js";
import type {
  CatalogEntry,
  CatalogResolver,
  CatalogSnapshot,
  PlanEnvelope,
  ProviderSnapshot,
} from "./types.js";

const MAX_PLAN_TTL_MS = 30 * 60 * 1_000;
const RESERVED_SLUGS = new Set([
  "api",
  "app",
  "admin",
  "auth",
  "canary",
  "internal",
  "ops",
  "preview",
  "prod",
  "staging",
  "support",
  "www",
]);

type RecordValue = Record<string, unknown>;

function object(value: unknown, label: string): RecordValue {
  assertOps(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "invalid_plan",
    `${label} must be an object`,
  );
  return value as RecordValue;
}

function array(value: unknown, label: string): readonly unknown[] {
  assertOps(Array.isArray(value), "invalid_plan", `${label} must be an array`);
  return value;
}

function integer(value: unknown, label: string): number {
  assertOps(
    Number.isSafeInteger(value),
    "invalid_plan",
    `${label} must be a safe integer`,
  );
  return value as number;
}

function string(value: unknown, label: string): string {
  assertOps(typeof value === "string", "invalid_plan", `${label} must be a string`);
  return value;
}

function instant(value: string, label: string): number {
  const result = Date.parse(value);
  assertOps(Number.isFinite(result), "invalid_plan", `${label} is not a timestamp`);
  return result;
}

function validateDigest(plan: PlanEnvelope): void {
  const calculated = planDigest(plan.spec);
  assertOps(
    calculated === plan.plan_digest,
    "plan_digest_mismatch",
    "Plan digest does not match canonical spec",
    { expected: calculated, received: plan.plan_digest },
  );
}

function validateEnvelopeTime(plan: PlanEnvelope, now: Date): void {
  const generatedAt = instant(plan.generated_at, "generated_at");
  const expiresAt = instant(plan.expires_at, "expires_at");
  assertOps(expiresAt > generatedAt, "invalid_plan", "Plan expiry must follow generation");
  assertOps(
    expiresAt - generatedAt <= MAX_PLAN_TTL_MS,
    "invalid_plan",
    "Plan TTL exceeds 30 minutes",
  );
  assertOps(now.getTime() < expiresAt, "plan_expired", "Plan has expired");
}

function validateCatalogs(
  spec: RecordValue,
  resolver: CatalogResolver,
  now: Date,
  planExpiresAt: number,
): Map<CatalogSnapshot["catalog_kind"], CatalogSnapshot> {
  const resolved = new Map<CatalogSnapshot["catalog_kind"], CatalogSnapshot>();
  for (const rawRef of array(spec.catalogs, "spec.catalogs")) {
    const ref = object(rawRef, "catalog reference");
    const kind = string(ref.kind, "catalog kind") as CatalogSnapshot["catalog_kind"];
    const version = string(ref.version, "catalog version");
    const catalog = resolver.getCatalog(kind, version);
    assertOps(catalog, "catalog_invalid", `Catalog ${kind}:${version} is not loaded`);
    assertOps(
      catalog.digest === ref.digest,
      "catalog_invalid",
      `Catalog digest mismatch for ${kind}:${version}`,
    );
    assertOps(
      catalog.review_status === "approved",
      "catalog_invalid",
      `Catalog ${kind}:${version} is not approved`,
    );
    assertOps(
      now.getTime() < instant(catalog.valid_until, `${kind}.valid_until`),
      "catalog_invalid",
      `Catalog ${kind}:${version} is expired`,
    );
    assertOps(
      planExpiresAt <= instant(catalog.valid_until, `${kind}.valid_until`),
      "catalog_invalid",
      `Plan outlives catalog ${kind}:${version}`,
    );
    assertOps(!resolved.has(kind), "catalog_invalid", `Duplicate ${kind} catalog`);
    resolved.set(kind, catalog);
  }
  return resolved;
}

function activeEntry(catalog: CatalogSnapshot, id: string, now: Date): CatalogEntry {
  const entry = catalog.entries.find((candidate) => candidate.id === id);
  assertOps(entry, "catalog_invalid", `Unknown ${catalog.catalog_kind} entry ${id}`);
  assertOps(
    entry.availability !== "deprecated" && entry.availability !== "unavailable",
    "catalog_invalid",
    `Catalog entry ${id} is unavailable`,
  );
  assertOps(entry.approved !== false, "catalog_invalid", `Catalog entry ${id} is unapproved`);
  if (entry.expires_at !== undefined) {
    assertOps(
      now.getTime() < instant(entry.expires_at, `${id}.expires_at`),
      "catalog_invalid",
      `Catalog entry ${id} is expired`,
    );
  }
  return entry;
}

function validateConsecutiveMigrations(
  rawVersions: unknown,
  targetVersion: unknown,
): void {
  const versions = array(rawVersions, "migration_versions").map((value) =>
    integer(value, "migration version"),
  );
  for (let index = 0; index < versions.length; index += 1) {
    const expected = 54 + index;
    assertOps(
      versions[index] === expected,
      "invalid_plan",
      `Migration versions must be consecutive from 54; expected ${expected}`,
    );
  }
  if (targetVersion !== undefined) {
    assertOps(
      versions.at(-1) === integer(targetVersion, "target_schema_version"),
      "invalid_plan",
      "Target schema version must equal the last migration",
    );
  }
}

function validateOnboarding(
  plan: PlanEnvelope,
  resolver: CatalogResolver,
  now: Date,
  registryOwnerId?: string,
): void {
  const spec = object(plan.spec, "spec");
  const inputs = object(spec.inputs, "spec.inputs");
  const resources = object(spec.resources, "spec.resources");
  const versions = object(spec.versions, "spec.versions");
  const cost = object(spec.cost, "spec.cost");

  const slug = string(inputs.tenant_slug, "tenant_slug");
  assertOps(!RESERVED_SLUGS.has(slug), "invalid_plan", `Tenant slug ${slug} is reserved`);
  const workspaceClass = string(inputs.workspace_class, "workspace_class");
  const expectedName = `lh2-${workspaceClass}-${slug}`;
  assertOps(
    resources.data_project_name === expectedName,
    "invalid_plan",
    "Data project name is not deterministic",
  );
  assertOps(
    resources.hosting_project_name === expectedName,
    "invalid_plan",
    "Hosting project name is not deterministic",
  );
  const hostname = string(resources.production_hostname, "production_hostname");
  assertOps(
    hostname.startsWith(`${slug}.`),
    "invalid_plan",
    "Production hostname does not start with the tenant slug",
  );
  const tags = object(resources.tags, "resource tags");
  assertOps(tags["tenant-slug"] === slug, "invalid_plan", "Ownership slug tag mismatch");
  assertOps(
    tags["workspace-class"] === workspaceClass,
    "invalid_plan",
    "Ownership workspace tag mismatch",
  );
  if (registryOwnerId !== undefined) {
    assertOps(
      tags["registry-owner-id"] === registryOwnerId,
      "invalid_plan",
      "Registry owner tag mismatch",
    );
  }

  validateConsecutiveMigrations(
    versions.migration_versions,
    versions.target_schema_version,
  );

  const recurringLow = integer(cost.recurring_low_minor, "recurring_low_minor");
  const recurringHigh = integer(cost.recurring_high_minor, "recurring_high_minor");
  const ceiling = integer(cost.usage_ceiling_minor, "usage_ceiling_minor");
  assertOps(
    recurringHigh >= recurringLow,
    "invalid_plan",
    "Recurring high estimate must be at least the low estimate",
  );
  assertOps(
    ceiling >= recurringHigh,
    "invalid_plan",
    "Usage ceiling must cover the recurring high estimate",
  );
  const costSkuIds = new Set<string>();
  for (const rawComponent of array(cost.components, "cost.components")) {
    const component = object(rawComponent, "cost component");
    const low = integer(component.low_minor, "component.low_minor");
    const high = integer(component.high_minor, "component.high_minor");
    assertOps(high >= low, "invalid_plan", "Cost component high must be at least low");
    costSkuIds.add(string(component.sku_id, "component.sku_id"));
  }

  const catalogs = validateCatalogs(
    spec,
    resolver,
    now,
    instant(plan.expires_at, "expires_at"),
  );
  const regions = catalogs.get("regions")!;
  const tiers = catalogs.get("provider_tiers")!;
  const pricing = catalogs.get("pricing")!;
  const backups = catalogs.get("backup_profiles")!;
  const compatibility = catalogs.get("release_compatibility")!;
  const capabilities = catalogs.get("capabilities")!;
  const subprocessors = catalogs.get("subprocessors")!;

  for (const idField of ["residency_policy_id", "region_id"] as const) {
    activeEntry(regions, string(inputs[idField], idField), now);
  }
  for (const idField of [
    "data_tier_id",
    "data_compute_id",
    "hosting_tier_id",
  ] as const) {
    const entry = activeEntry(tiers, string(inputs[idField], idField), now);
    if (entry.billable === true) {
      assertOps(
        typeof entry.pricing_sku_id === "string" && costSkuIds.has(entry.pricing_sku_id),
        "catalog_invalid",
        `Billable tier ${entry.id} has no selected priced component`,
      );
    }
  }
  activeEntry(backups, string(inputs.backup_profile_id, "backup_profile_id"), now);
  activeEntry(
    backups,
    string(inputs.retention_policy_id, "retention_policy_id"),
    now,
  );
  activeEntry(
    subprocessors,
    string(inputs.subprocessor_profile_id, "subprocessor_profile_id"),
    now,
  );
  activeEntry(
    compatibility,
    string(versions.compatibility_entry_id, "compatibility_entry_id"),
    now,
  );
  activeEntry(
    compatibility,
    string(versions.agent_release_id, "agent_release_id"),
    now,
  );
  activeEntry(
    compatibility,
    string(versions.ingest_protocol_id, "ingest_protocol_id"),
    now,
  );
  assertOps(
    inputs.pricing_catalog_id === pricing.catalog_version,
    "catalog_invalid",
    "Pricing catalog selection does not match the pinned pricing catalog",
  );
  const authSmtp = object(spec.auth_smtp, "spec.auth_smtp");
  activeEntry(
    compatibility,
    string(inputs.smtp_profile_id, "smtp_profile_id"),
    now,
  );
  activeEntry(
    compatibility,
    string(authSmtp.template_set_id, "template_set_id"),
    now,
  );
  for (const skuId of costSkuIds) {
    activeEntry(pricing, skuId, now);
  }

  const labels = [
    ...array(inputs.smtp_secret_labels, "smtp_secret_labels"),
    ...array(inputs.integration_secret_labels, "integration_secret_labels"),
  ].map((label) => string(label, "secret label"));

  for (const rawBudget of array(spec.capability_budgets, "capability_budgets")) {
    const budget = object(rawBudget, "capability budget");
    const capabilityId = string(budget.capability, "capability");
    const entry = activeEntry(capabilities, capabilityId, now);
    const soft = integer(budget.soft_limit, "soft_limit");
    const hard = integer(budget.hard_limit, "hard_limit");
    assertOps(hard >= soft, "invalid_plan", `Hard limit is below soft limit for ${capabilityId}`);
    const enabled = budget.enabled === true;
    const requiredSecrets = entry.required_secret_names ?? [];
    if (!enabled) {
      for (const secretName of requiredSecrets) {
        assertOps(
          !labels.some((label) => label.endsWith(`/${secretName}`)),
          "invalid_plan",
          `Disabled capability ${capabilityId} cannot require secret ${secretName}`,
        );
      }
    }
    if (enabled && (entry.cost_sku_ids?.length ?? 0) > 0) {
      assertOps(hard > 0, "invalid_plan", `Paid capability ${capabilityId} needs a hard limit`);
      for (const skuId of entry.cost_sku_ids ?? []) {
        assertOps(
          costSkuIds.has(skuId),
          "catalog_invalid",
          `Enabled capability ${capabilityId} is missing priced SKU ${skuId}`,
        );
      }
    }
  }

  const recovery = object(spec.recovery, "spec.recovery");
  activeEntry(backups, string(recovery.profile_id, "recovery.profile_id"), now);
  activeEntry(
    backups,
    string(recovery.retention_policy_id, "recovery.retention_policy_id"),
    now,
  );

  const planExpiry = instant(plan.expires_at, "expires_at");
  for (const rawSnapshot of array(spec.provider_snapshots, "provider_snapshots")) {
    const snapshot = object(rawSnapshot, "provider snapshot");
    const observedAt = instant(string(snapshot.observed_at, "observed_at"), "observed_at");
    const validUntil = instant(
      string(snapshot.valid_until, "valid_until"),
      "valid_until",
    );
    assertOps(validUntil > observedAt, "invalid_plan", "Snapshot validity is empty");
    assertOps(
      planExpiry <= validUntil,
      "invalid_plan",
      "Plan expiry exceeds provider snapshot validity",
    );
  }
}

function validateRelease(plan: PlanEnvelope): void {
  const spec = object(plan.spec, "spec");
  validateConsecutiveMigrations(spec.migration_versions, undefined);
  const targets = array(spec.targets, "release targets").map((target) =>
    object(target, "release target"),
  );
  const tenantIds = new Set<string>();
  for (const target of targets) {
    const tenantId = string(target.tenant_id, "target.tenant_id");
    assertOps(!tenantIds.has(tenantId), "invalid_plan", `Duplicate release target ${tenantId}`);
    tenantIds.add(tenantId);
  }
  assertOps(
    tenantIds.has(string(spec.canary_tenant_id, "canary_tenant_id")),
    "invalid_plan",
    "Canary tenant must be a release target",
  );
}

export interface ValidatePlanOptions {
  readonly catalogs?: CatalogResolver;
  readonly now?: Date;
  readonly registryOwnerId?: string;
}

export function validatePlanSemantics(
  plan: PlanEnvelope,
  options: ValidatePlanOptions = {},
): void {
  const now = options.now ?? new Date();
  assertOps(
    plan.contract_version === "p2.v1" && plan.plan_schema_version === 1,
    "unsupported_contract",
    "Unsupported plan contract",
  );
  validateDigest(plan);
  validateEnvelopeTime(plan, now);
  if (plan.state === "valid") {
    assertOps(plan.blockers.length === 0, "invalid_plan", "Valid plan has blockers");
    for (const prerequisite of plan.prerequisites ?? []) {
      assertOps(
        prerequisite.status === "passed",
        "invalid_plan",
        "Valid plan has an unmet prerequisite",
      );
    }
  } else {
    assertOps(plan.blockers.length > 0, "invalid_plan", "Blocked plan has no blocker");
  }

  if (plan.plan_kind === "tenant_onboarding") {
    assertOps(options.catalogs, "catalog_invalid", "Onboarding catalog resolver is required");
    validateOnboarding(plan, options.catalogs, now, options.registryOwnerId);
  } else {
    validateRelease(plan);
  }
}

export function validateProviderSnapshots(
  plan: PlanEnvelope,
  observed: readonly ProviderSnapshot[],
  now: Date = new Date(),
): void {
  if (plan.plan_kind !== "tenant_onboarding") return;
  const spec = object(plan.spec, "spec");
  const expected = array(spec.provider_snapshots, "provider_snapshots").map((snapshot) =>
    object(snapshot, "provider snapshot"),
  );
  const observedByProvider = new Map(observed.map((snapshot) => [snapshot.provider, snapshot]));
  for (const snapshot of expected) {
    const provider = string(snapshot.provider, "snapshot.provider");
    const current = observedByProvider.get(provider);
    assertOps(current, "provider_snapshot_drift", `Missing current snapshot for ${provider}`);
    assertOps(
      current.digest === snapshot.digest,
      "provider_snapshot_drift",
      `Provider snapshot drift for ${provider}`,
    );
    assertOps(
      now.getTime() < instant(current.valid_until, `${provider}.valid_until`),
      "provider_snapshot_drift",
      `Provider snapshot expired for ${provider}`,
    );
    assertOps(
      instant(current.valid_until, `${provider}.valid_until`) >=
        instant(plan.expires_at, "plan.expires_at"),
      "provider_snapshot_drift",
      `Current provider snapshot for ${provider} expires before the plan`,
    );
  }
}

export function asPlanEnvelope(value: unknown): PlanEnvelope {
  return value as PlanEnvelope;
}

export function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}
