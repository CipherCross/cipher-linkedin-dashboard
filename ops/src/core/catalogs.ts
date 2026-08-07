import { OpsError } from "./errors.js";
import type {
  CatalogResolver,
  CatalogSnapshot,
} from "./types.js";

const COMMON_ENTRY_KEYS = new Set([
  "id",
  "availability",
  "approved",
  "expires_at",
]);

const ENTRY_KEYS: Readonly<Record<CatalogSnapshot["catalog_kind"], ReadonlySet<string>>> = {
  regions: new Set([
    ...COMMON_ENTRY_KEYS,
    "provider_region_code",
    "jurisdiction",
    "residency_policy_ids",
    "allowed_workspace_classes",
    "legal_review_status",
  ]),
  provider_tiers: new Set([
    ...COMMON_ENTRY_KEYS,
    "provider",
    "kind",
    "capacity_limits",
    "feature_limits",
    "backup_capability_ids",
    "billable",
    "pricing_sku_id",
  ]),
  pricing: new Set([
    ...COMMON_ENTRY_KEYS,
    "provider",
    "currency",
    "minor_unit_price",
    "pricing_unit",
    "tax_treatment",
    "effective_at",
    "source_reference",
  ]),
  backup_profiles: new Set([
    ...COMMON_ENTRY_KEYS,
    "maximum_rpo_hours",
    "maximum_rto_business_hours",
    "provider_backup_interval_hours",
    "export_interval_hours",
    "drill_interval_days",
    "retention_choices",
    "required_coverage",
    "compatible_tier_ids",
  ]),
  release_compatibility: new Set([
    ...COMMON_ENTRY_KEYS,
    "baseline_version",
    "schema_min",
    "schema_max",
    "application_min",
    "application_max",
    "agent_min",
    "agent_max",
    "launcher_min",
    "launcher_max",
    "protocol_min",
    "protocol_max",
    "allowed_workspace_classes",
    "allowed_channels",
    "approved_migration_digests",
    "verification_bundle_digests",
  ]),
  capabilities: new Set([
    ...COMMON_ENTRY_KEYS,
    "metering_unit",
    "pricing_sku_id",
    "required_secret_names",
    "cost_sku_ids",
    "allowed_overage_actions",
  ]),
  subprocessors: new Set([
    ...COMMON_ENTRY_KEYS,
    "approved_processors",
    "data_flows",
    "region_restrictions",
    "legal_review_status",
    "effective_at",
  ]),
};

const CATALOG_KINDS = new Set(Object.keys(ENTRY_KEYS));

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpsError("catalog_invalid", message);
  }
}

/**
 * Catalogs are repository-pinned inputs, not provider response containers.
 * Rejecting unknown entry keys here keeps vendor response fragments out of
 * plan inputs even when a caller bypasses the JSON Schema layer.
 */
export function validateCatalogSnapshot(value: unknown): asserts value is CatalogSnapshot {
  assertObject(value, "Catalog snapshot must be an object");
  const snapshotKeys = new Set([
    "catalog_kind",
    "catalog_version",
    "source_revision",
    "published_at",
    "valid_until",
    "digest",
    "review_status",
    "entries",
  ]);
  for (const key of Object.keys(value)) {
    if (!snapshotKeys.has(key)) {
      throw new OpsError("catalog_invalid", `Unknown catalog snapshot field ${key}`);
    }
  }
  for (const key of [
    "catalog_version",
    "source_revision",
    "published_at",
    "valid_until",
    "digest",
  ]) {
    if (typeof value[key] !== "string") {
      throw new OpsError("catalog_invalid", `Catalog ${key} must be a string`);
    }
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(value.digest))) {
    throw new OpsError("catalog_invalid", "Catalog digest is not a SHA-256 digest");
  }
  if (!new Set(["approved", "draft", "rejected"]).has(String(value.review_status))) {
    throw new OpsError("catalog_invalid", "Unknown catalog review status");
  }
  const kind = value.catalog_kind;
  if (typeof kind !== "string" || !CATALOG_KINDS.has(kind)) {
    throw new OpsError("catalog_invalid", "Unknown catalog kind");
  }
  if (!Array.isArray(value.entries)) {
    throw new OpsError("catalog_invalid", "Catalog entries must be an array");
  }
  const allowed = ENTRY_KEYS[kind as CatalogSnapshot["catalog_kind"]]!;
  const ids = new Set<string>();
  for (const entry of value.entries) {
    assertObject(entry, `Invalid ${kind} catalog entry`);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        throw new OpsError("catalog_invalid", `Unknown ${kind} catalog field ${key}`);
      }
    }
    if (
      typeof entry.id !== "string" ||
      typeof entry.availability !== "string" ||
      typeof entry.approved !== "boolean" ||
      !new Set(["available", "deprecated", "unavailable"]).has(entry.availability) ||
      ids.has(entry.id)
    ) {
      throw new OpsError("catalog_invalid", `Invalid or duplicate ${kind} catalog entry id`);
    }
    ids.add(entry.id);
  }
}

export class InMemoryCatalogResolver implements CatalogResolver {
  readonly #catalogs = new Map<string, CatalogSnapshot>();

  constructor(catalogs: readonly CatalogSnapshot[]) {
    for (const catalog of catalogs) {
      validateCatalogSnapshot(catalog);
      const key = this.#key(catalog.catalog_kind, catalog.catalog_version);
      if (this.#catalogs.has(key)) {
        throw new OpsError("catalog_invalid", `Duplicate catalog ${key}`);
      }
      this.#catalogs.set(key, catalog);
    }
  }

  getCatalog(
    kind: CatalogSnapshot["catalog_kind"],
    version: string,
  ): CatalogSnapshot | undefined {
    return this.#catalogs.get(this.#key(kind, version));
  }

  #key(kind: CatalogSnapshot["catalog_kind"], version: string): string {
    return `${kind}:${version}`;
  }
}
