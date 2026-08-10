/**
 * Canonical, provider-neutral hosting control plane.
 *
 * This module describes hosting *capabilities*, not the resources of any one
 * hosting vendor. Nothing here may name a vendor, carry a vendor resource ID,
 * or import a vendor SDK type. A concrete adapter translates these canonical
 * requests into vendor calls and translates vendor responses back into the
 * canonical results below; the translation is the adapter's private business.
 *
 * The seven capabilities are fixed by the migration spec, Approach section 8:
 * create a tenant deployment; bind server-side and public environment values
 * without ever returning secrets; build a pinned application revision; assign a
 * domain; register schedules; promote and roll back a deployment; verify
 * runtime, schedules, domain and build metadata.
 *
 * Handles (`HostingTargetHandle`, `HostingReleaseHandle`,
 * `HostingRolloutHandle`) are opaque strings issued by whichever adapter is in
 * use. The canonical layer never parses them and never assumes they encode a
 * vendor identifier.
 */

import { canonicalJson, sha256Digest, type JsonValue } from "../core/canonical.js";
import { OpsError } from "../core/errors.js";
import type { OwnershipMarker, WorkspaceClass } from "./interfaces.js";

/** Version of the canonical hosting capability contract. */
export const HOSTING_CAPABILITY_CONTRACT = "hosting.capability.v1" as const;
/** Schema version of the canonical hosting plan produced by this module. */
export const HOSTING_PLAN_SCHEMA_VERSION = 1 as const;

export type HostingTargetHandle = string;
export type HostingReleaseHandle = string;
export type HostingRolloutHandle = string;

export interface HostingRequestResult {
  /** Correlation ID for the underlying control-plane call. Never a resource ID. */
  readonly hostingRequestId: string;
}

/* ------------------------------------------------------------------ *
 * Capability vocabulary
 * ------------------------------------------------------------------ */

export const HOSTING_CAPABILITIES = [
  "tenant_deployment",
  "environment_binding",
  "pinned_build",
  "domain_assignment",
  "schedule_registration",
  "release_rollout",
  "deployment_verification",
] as const;
export type HostingCapability = (typeof HOSTING_CAPABILITIES)[number];

/**
 * Which port methods realize each capability. `release_rollout` is one
 * capability with two directions, so it maps to two methods; a caller must be
 * able to reach both, and the two must stay distinguishable in their results.
 */
export const HOSTING_CAPABILITY_METHODS: Readonly<
  Record<HostingCapability, readonly HostingPortMethod[]>
> = {
  tenant_deployment: ["createDeploymentTarget"],
  environment_binding: ["bindEnvironment"],
  pinned_build: ["buildRelease"],
  domain_assignment: ["assignDomain"],
  schedule_registration: ["registerSchedules"],
  release_rollout: ["promoteRelease", "rollbackRelease"],
  deployment_verification: ["verifyDeployment"],
};

export type HostingPortMethod =
  | "createDeploymentTarget"
  | "bindEnvironment"
  | "buildRelease"
  | "assignDomain"
  | "registerSchedules"
  | "promoteRelease"
  | "rollbackRelease"
  | "verifyDeployment";

/* ------------------------------------------------------------------ *
 * Readiness inspection (read-only, preflight)
 * ------------------------------------------------------------------ */

export interface HostingCapabilityInspectionRequest {
  readonly deterministicName: string;
  readonly workspaceClass: WorkspaceClass;
  readonly runtimeProfileId: string;
  readonly requiredScheduleCount: number;
  readonly requiredServerValueCount: number;
  readonly requiredPublicValueCount: number;
  readonly ownership: OwnershipMarker;
}

/**
 * Every field answers "can the hosting provider do this?", never "what is the
 * provider's resource shaped like?".
 */
export interface HostingCapabilityInspection {
  readonly controlPlaneAccessible: boolean;
  readonly deterministicNameAvailable: boolean;
  readonly existingTargetOwned: boolean;
  readonly runtimeProfileAvailable: boolean;
  readonly serverValueBindingSupported: boolean;
  readonly publicValueBindingSupported: boolean;
  readonly pinnedRevisionBuildSupported: boolean;
  readonly customDomainSupported: boolean;
  readonly scheduleCapacityAvailable: boolean;
  readonly rollbackSupported: boolean;
  readonly automaticPromotionCanBeDisabled: boolean;
  readonly isolatedPreviewsSupported: boolean;
  readonly validUntil: string;
}

/* ------------------------------------------------------------------ *
 * Capability 1 — create a tenant deployment
 * ------------------------------------------------------------------ */

export type HostingLifecycle = "provisioning" | "ready" | "degraded";

export interface DeploymentTargetRequest {
  readonly deterministicName: string;
  readonly workspaceClass: WorkspaceClass;
  readonly runtimeProfileId: string;
  readonly ownership: OwnershipMarker;
  /** Promotion is always an explicit, planned effect. */
  readonly automaticPromotionEnabled: false;
  /** Preview environments never receive production values. */
  readonly isolatedPreviewsEnabled: false;
}

export interface DeploymentTargetResult extends HostingRequestResult {
  readonly targetHandle: HostingTargetHandle;
  readonly deterministicName: string;
  readonly workspaceClass: WorkspaceClass;
  readonly runtimeProfileId: string;
  readonly ownershipMarkerDigest: string;
  readonly lifecycle: HostingLifecycle;
  readonly adopted: boolean;
  readonly automaticPromotionEnabled: false;
  readonly isolatedPreviewsEnabled: false;
}

/* ------------------------------------------------------------------ *
 * Capability 2 — bind environment values without returning secrets
 * ------------------------------------------------------------------ */

export type HostingValueClass = "server_secret" | "server_public" | "public_build";
export type HostingValueSourceKind =
  | "secret_label"
  | "generated_secret"
  | "derived_from_plan"
  | "derived_from_owned_resource";

/**
 * A binding declares *where a value comes from*, never the value. A
 * `secret_label` is a key-store label; a `generated_secret` names the generator
 * the adapter must run; `derived_from_plan` points at a field already inside
 * the approved plan.
 */
export type HostingValueSource =
  | { readonly kind: "secret_label"; readonly secretLabel: string }
  | { readonly kind: "generated_secret"; readonly generatorId: string }
  | { readonly kind: "derived_from_plan"; readonly planFieldRef: string }
  | { readonly kind: "derived_from_owned_resource"; readonly resourceRef: string };

export interface HostingValueBinding {
  readonly name: string;
  readonly valueClass: HostingValueClass;
  readonly source: HostingValueSource;
}

export interface EnvironmentBindingRequest {
  readonly targetHandle: HostingTargetHandle;
  readonly scope: "production";
  readonly bindings: readonly HostingValueBinding[];
  /** S26 supplies the already-created, registry-owned data resource here. */
  readonly dataProjectHandle?: string;
  readonly dataProjectName?: string;
  readonly ownership?: OwnershipMarker;
}

/** Carries safe binding provenance — never a resolved value. */
export interface EnvironmentBindingResult extends HostingRequestResult {
  readonly targetHandle: HostingTargetHandle;
  readonly scope: "production";
  readonly bindings: readonly {
    readonly name: string;
    readonly valueClass: HostingValueClass;
    readonly sourceKind: HostingValueSourceKind;
  }[];
  /** Digest over the binding descriptors. Not derived from any value. */
  readonly bindingDigest: string;
}

/**
 * Digest every value descriptor a deployment receives. It covers the name,
 * classification and complete source reference (role resource, plan field, or
 * generator). Resolved values never enter this digest or any operation output.
 */
export function hostingEnvironmentBindingDigest(
  bindings: readonly {
    readonly name: string;
    readonly valueClass: string;
    readonly source: HostingValueSource;
  }[],
): string {
  return sha256Digest(
    canonicalJson(
      [...bindings]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((binding) => ({
          name: binding.name,
          value_class: binding.valueClass,
          source: binding.source,
        })),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Capability 3 — build a pinned application revision
 * ------------------------------------------------------------------ */

export interface ReleaseBuildRequest {
  readonly targetHandle: HostingTargetHandle;
  /** Full 40-character source revision. Working-tree content is never a build input. */
  readonly revisionId: string;
  readonly buildRecipeId: string;
  readonly publicValueNames: readonly string[];
  /** The exact environment descriptor digest produced by the bind step. */
  readonly environmentBindingDigest: string;
  /** Pins the schedule set to this release; see `scheduleManifestDigest`. */
  readonly scheduleManifestDigest: string;
}

export interface ReleaseBuildResult extends HostingRequestResult {
  readonly releaseHandle: HostingReleaseHandle;
  readonly targetHandle: HostingTargetHandle;
  readonly revisionId: string;
  readonly revisionPinned: true;
  readonly buildRecipeId: string;
  readonly publicValueNames: readonly string[];
  readonly environmentBindingDigest: string;
  readonly scheduleManifestDigest: string;
  readonly artifactDigest: string;
  readonly status: "verified";
}

/* ------------------------------------------------------------------ *
 * Capability 4 — assign a domain
 * ------------------------------------------------------------------ */

export interface DomainAssignmentRequest {
  readonly targetHandle: HostingTargetHandle;
  readonly hostname: string;
  readonly ownership: OwnershipMarker;
  readonly certificateMode: "provider_managed";
}

export interface DomainAssignmentResult extends HostingRequestResult {
  readonly targetHandle: HostingTargetHandle;
  readonly hostname: string;
  readonly assigned: true;
  readonly certificateReady: boolean;
  readonly certificateMode: "provider_managed";
  readonly ownershipMarkerDigest: string;
}

/* ------------------------------------------------------------------ *
 * Capability 5 — register schedules
 * ------------------------------------------------------------------ */

/**
 * A schedule is an HTTP route plus a recurrence, not a vendor cron entry. The
 * recurrence format is named as a value (`cron5` = POSIX five-field), so the
 * canonical shape does not assume any particular scheduler.
 */
export interface HostingSchedule {
  readonly scheduleId: string;
  readonly method: "GET";
  readonly routePath: string;
  readonly queryParameters: Readonly<Record<string, string>>;
  readonly expression: string;
  readonly expressionFormat: "cron5";
  readonly timezone: "UTC";
}

export interface ScheduleRegistrationRequest {
  readonly targetHandle: HostingTargetHandle;
  /** Schedules belong to a pinned release, never to a mutable project. */
  readonly releaseHandle: HostingReleaseHandle;
  readonly schedules: readonly HostingSchedule[];
  readonly manifestDigest: string;
}

export interface ScheduleRegistrationResult extends HostingRequestResult {
  readonly targetHandle: HostingTargetHandle;
  readonly releaseHandle: HostingReleaseHandle;
  readonly registered: readonly HostingSchedule[];
  readonly manifestDigest: string;
}

/**
 * The four schedules this application requires, stated canonically. They are
 * part of the pinned release manifest: a schedule that calls a route is only
 * meaningful together with the revision that serves that route.
 */
export const CANONICAL_TENANT_SCHEDULES: readonly HostingSchedule[] = [
  {
    scheduleId: "classify.daily",
    method: "GET",
    routePath: "/api/classify",
    queryParameters: {},
    expression: "0 6 * * *",
    expressionFormat: "cron5",
    timezone: "UTC",
  },
  {
    scheduleId: "notify_replies.sweep",
    method: "GET",
    routePath: "/api/notify-replies",
    queryParameters: {},
    expression: "30 6 * * *",
    expressionFormat: "cron5",
    timezone: "UTC",
  },
  {
    scheduleId: "briefing.weekly",
    method: "GET",
    routePath: "/api/briefing",
    queryParameters: { kind: "weekly" },
    expression: "0 7 * * 1",
    expressionFormat: "cron5",
    timezone: "UTC",
  },
  {
    scheduleId: "briefing.daily",
    method: "GET",
    routePath: "/api/briefing",
    queryParameters: { kind: "daily" },
    expression: "30 7 * * 1-5",
    expressionFormat: "cron5",
    timezone: "UTC",
  },
];

/** Deterministic order: schedule identity, not registration order, is canonical. */
export function normalizeSchedules(
  schedules: readonly HostingSchedule[],
): readonly HostingSchedule[] {
  return [...schedules].sort((left, right) =>
    left.scheduleId < right.scheduleId ? -1 : left.scheduleId > right.scheduleId ? 1 : 0,
  );
}

export function scheduleAsJson(schedule: HostingSchedule): JsonValue {
  return {
    schedule_id: schedule.scheduleId,
    method: schedule.method,
    route_path: schedule.routePath,
    query_parameters: { ...schedule.queryParameters },
    expression: schedule.expression,
    expression_format: schedule.expressionFormat,
    timezone: schedule.timezone,
  };
}

/** Digest of a schedule set, stable under registration order. */
export function scheduleManifestDigest(
  schedules: readonly HostingSchedule[],
): string {
  return sha256Digest(
    canonicalJson(normalizeSchedules(schedules).map(scheduleAsJson)),
  );
}

/* ------------------------------------------------------------------ *
 * Capability 6 — promote and roll back
 * ------------------------------------------------------------------ */

export type HostingRolloutKind = "promote" | "rollback";

export interface PromotionRequest {
  readonly targetHandle: HostingTargetHandle;
  readonly releaseHandle: HostingReleaseHandle;
}

export interface RollbackRequest {
  readonly targetHandle: HostingTargetHandle;
  /** The previously-active release to restore. */
  readonly releaseHandle: HostingReleaseHandle;
  /** The release being withdrawn; must be the currently active one. */
  readonly supersededReleaseHandle: HostingReleaseHandle;
  readonly reasonCode: string;
}

export interface RolloutResult extends HostingRequestResult {
  readonly targetHandle: HostingTargetHandle;
  readonly rolloutHandle: HostingRolloutHandle;
  readonly rolloutKind: HostingRolloutKind;
  readonly activeReleaseHandle: HostingReleaseHandle;
  readonly previousReleaseHandle: HostingReleaseHandle | null;
  /** Monotonic per target. Ordering evidence without a wall clock. */
  readonly rolloutSequence: number;
  readonly reasonCode: string | null;
}

/* ------------------------------------------------------------------ *
 * Capability 7 — verify runtime, schedules, domain and build metadata
 * ------------------------------------------------------------------ */

export interface DeploymentVerificationRequest {
  readonly targetHandle: HostingTargetHandle;
  readonly expectedActiveReleaseHandle: HostingReleaseHandle;
  readonly expectedHostname: string;
  readonly expectedRevisionId: string;
  readonly expectedSchedules: readonly HostingSchedule[];
  readonly runtimeCheckIds: readonly string[];
}

export interface HostingRuntimeVerification {
  readonly reachable: boolean;
  readonly activeReleaseHandle: HostingReleaseHandle | null;
  readonly activeReleaseMatchesExpected: boolean;
  readonly passedCheckIds: readonly string[];
  readonly failedCheckIds: readonly string[];
}

export interface HostingScheduleVerification {
  readonly registered: readonly HostingSchedule[];
  readonly expectedScheduleIds: readonly string[];
  readonly missingScheduleIds: readonly string[];
  readonly unexpectedScheduleIds: readonly string[];
  readonly manifestDigest: string | null;
  readonly manifestMatchesRelease: boolean;
}

export interface HostingDomainVerification {
  readonly hostname: string | null;
  readonly assigned: boolean;
  readonly certificateReady: boolean;
  readonly matchesExpected: boolean;
  readonly servesActiveRelease: boolean;
}

export interface HostingBuildVerification {
  readonly releaseHandle: HostingReleaseHandle | null;
  readonly revisionId: string | null;
  readonly revisionPinned: boolean;
  readonly revisionMatchesExpected: boolean;
  readonly buildRecipeId: string | null;
  readonly artifactDigest: string | null;
  readonly publicValueNames: readonly string[];
  readonly environmentBindingDigest: string | null;
  readonly scheduleManifestDigest: string | null;
}

export interface HostingRolloutVerification {
  readonly rolloutKind: HostingRolloutKind | null;
  readonly rolloutSequence: number;
  readonly previousReleaseHandle: HostingReleaseHandle | null;
}

export interface HostingVerificationReport extends HostingRequestResult {
  readonly targetHandle: HostingTargetHandle;
  readonly status: "passed" | "failed";
  readonly runtime: HostingRuntimeVerification;
  readonly schedules: HostingScheduleVerification;
  readonly domain: HostingDomainVerification;
  readonly build: HostingBuildVerification;
  readonly rollout: HostingRolloutVerification;
}

/* ------------------------------------------------------------------ *
 * The port
 * ------------------------------------------------------------------ */

/**
 * Deliberately narrower than an SDK or HTTP client: no arbitrary request, URL,
 * payload, command or environment operation can cross this boundary. An
 * implementation may reach a real provider, but only through these shapes.
 */
export interface HostingControlPlanePort {
  inspect(
    request: HostingCapabilityInspectionRequest,
  ): Promise<HostingCapabilityInspection>;
  createDeploymentTarget(
    request: DeploymentTargetRequest,
  ): Promise<DeploymentTargetResult>;
  bindEnvironment(
    request: EnvironmentBindingRequest,
  ): Promise<EnvironmentBindingResult>;
  buildRelease(request: ReleaseBuildRequest): Promise<ReleaseBuildResult>;
  assignDomain(request: DomainAssignmentRequest): Promise<DomainAssignmentResult>;
  registerSchedules(
    request: ScheduleRegistrationRequest,
  ): Promise<ScheduleRegistrationResult>;
  promoteRelease(request: PromotionRequest): Promise<RolloutResult>;
  rollbackRelease(request: RollbackRequest): Promise<RolloutResult>;
  verifyDeployment(
    request: DeploymentVerificationRequest,
  ): Promise<HostingVerificationReport>;
}

export interface HostingProvider extends HostingControlPlanePort {}

/* ------------------------------------------------------------------ *
 * Result shape contract
 * ------------------------------------------------------------------ */

/**
 * The exact key set every canonical result must carry. A concrete adapter is at
 * parity when its results have these keys and no others — that is the assertion
 * S10 runs against the hosting adapter, and the test suite runs against the
 * fake.
 */
export const HOSTING_RESULT_SHAPES: Readonly<
  Record<HostingPortMethod | "inspect", readonly string[]>
> = {
  inspect: [
    "controlPlaneAccessible",
    "deterministicNameAvailable",
    "existingTargetOwned",
    "runtimeProfileAvailable",
    "serverValueBindingSupported",
    "publicValueBindingSupported",
    "pinnedRevisionBuildSupported",
    "customDomainSupported",
    "scheduleCapacityAvailable",
    "rollbackSupported",
    "automaticPromotionCanBeDisabled",
    "isolatedPreviewsSupported",
    "validUntil",
  ],
  createDeploymentTarget: [
    "hostingRequestId",
    "targetHandle",
    "deterministicName",
    "workspaceClass",
    "runtimeProfileId",
    "ownershipMarkerDigest",
    "lifecycle",
    "adopted",
    "automaticPromotionEnabled",
    "isolatedPreviewsEnabled",
  ],
  bindEnvironment: [
    "hostingRequestId",
    "targetHandle",
    "scope",
    "bindings",
    "bindingDigest",
  ],
  buildRelease: [
    "hostingRequestId",
    "releaseHandle",
    "targetHandle",
    "revisionId",
    "revisionPinned",
    "buildRecipeId",
    "publicValueNames",
    "environmentBindingDigest",
    "scheduleManifestDigest",
    "artifactDigest",
    "status",
  ],
  assignDomain: [
    "hostingRequestId",
    "targetHandle",
    "hostname",
    "assigned",
    "certificateReady",
    "certificateMode",
    "ownershipMarkerDigest",
  ],
  registerSchedules: [
    "hostingRequestId",
    "targetHandle",
    "releaseHandle",
    "registered",
    "manifestDigest",
  ],
  promoteRelease: [
    "hostingRequestId",
    "targetHandle",
    "rolloutHandle",
    "rolloutKind",
    "activeReleaseHandle",
    "previousReleaseHandle",
    "rolloutSequence",
    "reasonCode",
  ],
  rollbackRelease: [
    "hostingRequestId",
    "targetHandle",
    "rolloutHandle",
    "rolloutKind",
    "activeReleaseHandle",
    "previousReleaseHandle",
    "rolloutSequence",
    "reasonCode",
  ],
  verifyDeployment: [
    "hostingRequestId",
    "targetHandle",
    "status",
    "runtime",
    "schedules",
    "domain",
    "build",
    "rollout",
  ],
};

/* ------------------------------------------------------------------ *
 * Canonical hosting plan
 * ------------------------------------------------------------------ */

export interface HostingPlanInput {
  readonly tenantSlug: string;
  readonly workspaceClass: WorkspaceClass;
  readonly deterministicName: string;
  readonly hostname: string;
  readonly runtimeProfileId: string;
  readonly buildRecipeId: string;
  readonly revisionId: string;
  readonly bindings: readonly HostingValueBinding[];
  readonly schedules: readonly HostingSchedule[];
  readonly runtimeCheckIds: readonly string[];
  readonly rollbackReasonCode: string;
  readonly ownershipMarkerDigest: string;
}

function bindingAsJson(binding: HostingValueBinding): JsonValue {
  const source: JsonValue =
    binding.source.kind === "secret_label"
      ? { kind: binding.source.kind, secret_label: binding.source.secretLabel }
      : binding.source.kind === "generated_secret"
        ? { kind: binding.source.kind, generator_id: binding.source.generatorId }
        : binding.source.kind === "derived_from_plan"
          ? { kind: binding.source.kind, plan_field_ref: binding.source.planFieldRef }
          : { kind: binding.source.kind, resource_ref: binding.source.resourceRef };
  return {
    name: binding.name,
    value_class: binding.valueClass,
    source,
  };
}

/**
 * Builds the canonical hosting plan: an ordered, provider-neutral description
 * of the seven capabilities as they will be applied. Every effect input is a
 * reference to a field already declared in the plan, never an inline URL,
 * payload or environment value.
 *
 * The rollback step is planned, not executed: it declares the reversal that the
 * approved plan authorizes, which is what makes rollback an operation the owner
 * approved rather than an improvisation during an incident.
 */
export function buildHostingCapabilityPlan(input: HostingPlanInput): JsonValue {
  if (!/^[0-9a-f]{40}$/.test(input.revisionId)) {
    throw new OpsError(
      "invalid_plan",
      "Hosting plan requires a full 40-character source revision",
    );
  }
  const schedules = normalizeSchedules(input.schedules);
  const manifestDigest = scheduleManifestDigest(schedules);
  const serverValueNames = input.bindings
    .filter((binding) => binding.valueClass !== "public_build")
    .map((binding) => binding.name)
    .sort();
  const publicValueNames = input.bindings
    .filter((binding) => binding.valueClass === "public_build")
    .map((binding) => binding.name)
    .sort();

  return {
    hosting_plan_schema_version: HOSTING_PLAN_SCHEMA_VERSION,
    capability_contract: HOSTING_CAPABILITY_CONTRACT,
    tenant_slug: input.tenantSlug,
    workspace_class: input.workspaceClass,
    ownership_marker_digest: input.ownershipMarkerDigest,
    target: {
      deterministic_name: input.deterministicName,
      runtime_profile_id: input.runtimeProfileId,
      automatic_promotion_enabled: false,
      isolated_previews_enabled: false,
    },
    release: {
      revision_id: input.revisionId,
      build_recipe_id: input.buildRecipeId,
      public_value_names: publicValueNames,
      environment_binding_digest: hostingEnvironmentBindingDigest(
        input.bindings.map((binding) => ({
          name: binding.name,
          valueClass: binding.valueClass,
          source: binding.source,
        })),
      ),
      schedule_manifest_digest: manifestDigest,
    },
    environment: {
      scope: "production",
      server_value_names: serverValueNames,
      public_value_names: publicValueNames,
      bindings: input.bindings.map(bindingAsJson),
    },
    domain: {
      hostname: input.hostname,
      certificate_mode: "provider_managed",
    },
    schedules: {
      manifest_digest: manifestDigest,
      entries: schedules.map(scheduleAsJson),
    },
    steps: [
      {
        ordinal: 1,
        capability: "tenant_deployment",
        method: "createDeploymentTarget",
        inputs_ref: ["target", "ownership_marker_digest"],
      },
      {
        ordinal: 2,
        capability: "environment_binding",
        method: "bindEnvironment",
        inputs_ref: ["environment"],
        returns_secret_values: false,
      },
      {
        ordinal: 3,
        capability: "pinned_build",
        method: "buildRelease",
        inputs_ref: ["release", "schedules.manifest_digest"],
      },
      {
        ordinal: 4,
        capability: "domain_assignment",
        method: "assignDomain",
        inputs_ref: ["domain", "ownership_marker_digest"],
      },
      {
        ordinal: 5,
        capability: "schedule_registration",
        method: "registerSchedules",
        inputs_ref: ["schedules"],
      },
      {
        ordinal: 6,
        capability: "release_rollout",
        method: "promoteRelease",
        rollout_kind: "promote",
        inputs_ref: ["release"],
      },
      {
        ordinal: 7,
        capability: "release_rollout",
        method: "rollbackRelease",
        rollout_kind: "rollback",
        planned_only: true,
        reason_code: input.rollbackReasonCode,
        inputs_ref: ["release"],
      },
      {
        ordinal: 8,
        capability: "deployment_verification",
        method: "verifyDeployment",
        inputs_ref: ["release", "domain", "schedules"],
        runtime_check_ids: [...input.runtimeCheckIds].sort(),
      },
    ],
  };
}

export function hostingPlanDigest(plan: JsonValue): string {
  return sha256Digest(canonicalJson(plan));
}
