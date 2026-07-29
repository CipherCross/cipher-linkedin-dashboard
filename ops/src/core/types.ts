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
  "supabase_project",
  "tenant_schema",
  "storage_auth_smtp",
  "platform_support",
  "vercel_project",
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

export interface CatalogEntry {
  readonly id: string;
  readonly availability?: "available" | "deprecated" | "unavailable";
  readonly approved?: boolean;
  readonly expires_at?: string;
  readonly pricing_sku_id?: string;
  readonly billable?: boolean;
  readonly required_secret_names?: readonly string[];
  readonly cost_sku_ids?: readonly string[];
  readonly [key: string]: JsonValue | undefined;
}

export interface CatalogSnapshot {
  readonly catalog_kind:
    | "regions"
    | "provider_tiers"
    | "pricing"
    | "backup_profiles"
    | "release_compatibility"
    | "capabilities"
    | "subprocessors";
  readonly catalog_version: string;
  readonly source_revision: string;
  readonly published_at: string;
  readonly valid_until: string;
  readonly digest: string;
  readonly review_status: "approved" | "draft" | "rejected";
  readonly entries: readonly CatalogEntry[];
}

export interface CatalogResolver {
  getCatalog(kind: CatalogSnapshot["catalog_kind"], version: string): CatalogSnapshot | undefined;
}
