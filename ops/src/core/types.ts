import type { JsonValue } from "./canonical.js";

export const CONTRACT_VERSION = "p2.v1" as const;

export type PlanKind = "tenant_onboarding" | "release";
export type PlanState =
  | "draft"
  | "valid"
  | "blocked"
  | "consumed"
  | "expired"
  | "invalidated";
export type TenantLifecycle =
  | "absent"
  | "planned"
  | "provisioning"
  | "verifying"
  | "active"
  | "quarantined"
  | "suspended"
  | "offboarding_planned"
  | "retained";
export type OperationState =
  | "pending"
  | "running"
  | "waiting_provider"
  | "failed"
  | "quarantined"
  | "succeeded"
  | "partially_succeeded";
export type StepState =
  | "pending"
  | "running"
  | "waiting_provider"
  | "failed"
  | "outcome_unknown"
  | "succeeded"
  | "not_applicable";

export const ONBOARDING_STEP_KINDS = [
  "reserve_tenant",
  "data_project",
  "tenant_schema",
  "object_storage_identity_email",
  "platform_support",
  "hosting_project",
  "production_env",
  "domain_binding",
  "tenant_build",
  "production_deployment",
  "smoke_suite",
  "company_admin",
  "finalize_tenant",
] as const;
export type OnboardingStepKind = (typeof ONBOARDING_STEP_KINDS)[number];

export interface PlanEnvelope {
  readonly contract_version: typeof CONTRACT_VERSION;
  readonly plan_schema_version: 1;
  readonly plan_kind: PlanKind;
  readonly plan_id: string;
  readonly plan_digest: string;
  readonly generated_at: string;
  readonly expires_at: string;
  readonly expected_registry_version: number;
  readonly state: PlanState;
  readonly spec: JsonValue;
  readonly blockers: readonly unknown[];
  readonly prerequisites?: readonly {
    readonly status: "passed" | "blocker" | "manual";
  }[];
}

export interface ApplyRequest {
  readonly contract_version: typeof CONTRACT_VERSION;
  readonly operation_kind: PlanKind;
  readonly plan_id: string;
  readonly plan_digest: string;
  readonly expected_registry_version: number;
  readonly idempotency_key: string;
  readonly operation_id?: string;
}

export interface ProviderSnapshot {
  readonly provider: string;
  readonly digest: string;
  readonly valid_until: string;
}

export interface StartOperationResult {
  readonly operationId: string;
  readonly state: OperationState;
  readonly fencingToken: number;
  readonly resumed: boolean;
}

export type CatalogKind =
  | "regions"
  | "provider_tiers"
  | "pricing"
  | "backup_profiles"
  | "release_compatibility"
  | "capabilities"
  | "subprocessors";

interface CatalogEntryBase {
  readonly id: string;
  readonly availability: "available" | "deprecated" | "unavailable";
  readonly approved: boolean;
  readonly expires_at?: string;
  readonly pricing_sku_id?: string;
  readonly billable?: boolean;
  readonly required_secret_names?: readonly string[];
  readonly cost_sku_ids?: readonly string[];
}

export interface RegionCatalogEntry extends CatalogEntryBase {
  readonly provider_region_code?: string;
  readonly jurisdiction?: string;
  readonly residency_policy_ids?: readonly string[];
  readonly allowed_workspace_classes?: readonly ("internal" | "disposable" | "external")[];
  readonly legal_review_status?: "approved" | "pending" | "rejected";
}

export interface ProviderTierCatalogEntry extends CatalogEntryBase {
  readonly provider?: string;
  readonly kind?: "plan" | "compute";
  readonly capacity_limits?: JsonValue;
  readonly feature_limits?: JsonValue;
  readonly backup_capability_ids?: readonly string[];
}

export interface PricingCatalogEntry extends CatalogEntryBase {
  readonly provider?: string;
  readonly currency?: string;
  readonly minor_unit_price?: number;
  readonly pricing_unit?: string;
  readonly tax_treatment?: "included" | "excluded" | "not_applicable";
  readonly effective_at?: string;
  readonly source_reference?: string;
}

export interface BackupProfileCatalogEntry extends CatalogEntryBase {
  readonly maximum_rpo_hours?: number;
  readonly maximum_rto_business_hours?: number;
  readonly provider_backup_interval_hours?: number;
  readonly export_interval_hours?: number;
  readonly drill_interval_days?: number;
  readonly retention_choices?: readonly string[];
  readonly required_coverage?: readonly string[];
  readonly compatible_tier_ids?: readonly string[];
}

export interface ReleaseCompatibilityCatalogEntry extends CatalogEntryBase {
  readonly baseline_version?: number;
  readonly schema_min?: number;
  readonly schema_max?: number;
  readonly application_min?: string;
  readonly application_max?: string;
  readonly agent_min?: string;
  readonly agent_max?: string;
  readonly launcher_min?: string;
  readonly launcher_max?: string;
  readonly protocol_min?: string;
  readonly protocol_max?: string;
  readonly allowed_workspace_classes?: readonly ("internal" | "disposable" | "external")[];
  readonly allowed_channels?: readonly ("internal" | "canary" | "stable")[];
  readonly approved_migration_digests?: readonly string[];
  readonly verification_bundle_digests?: readonly string[];
}

export interface CapabilityCatalogEntry extends CatalogEntryBase {
  readonly metering_unit?: string;
  readonly allowed_overage_actions?: readonly ("pause_and_alert" | "queue_and_alert" | "disable_and_alert")[];
}

export interface SubprocessorCatalogEntry extends CatalogEntryBase {
  readonly approved_processors?: readonly string[];
  readonly data_flows?: readonly string[];
  readonly region_restrictions?: readonly string[];
  readonly legal_review_status?: "approved" | "pending" | "rejected";
  readonly effective_at?: string;
}

export type CatalogEntry =
  | RegionCatalogEntry
  | ProviderTierCatalogEntry
  | PricingCatalogEntry
  | BackupProfileCatalogEntry
  | ReleaseCompatibilityCatalogEntry
  | CapabilityCatalogEntry
  | SubprocessorCatalogEntry;

export interface CatalogSnapshot {
  readonly catalog_kind: CatalogKind;
  readonly catalog_version: string;
  readonly source_revision: string;
  readonly published_at: string;
  readonly valid_until: string;
  readonly digest: string;
  readonly review_status: "approved" | "draft" | "rejected";
  readonly entries: readonly CatalogEntry[];
}

export interface CatalogResolver {
  getCatalog(kind: CatalogKind, version: string): CatalogSnapshot | undefined;
}
