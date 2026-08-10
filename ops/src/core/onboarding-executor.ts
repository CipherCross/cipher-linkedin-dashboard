import { OpsError, assertOps } from "./errors.js";
import { Redactor } from "./redaction.js";
import type { StepState } from "./types.js";
import {
  CANONICAL_TENANT_SCHEDULES,
  scheduleManifestDigest,
} from "../providers/hosting.js";
import {
  CANONICAL_BUILD_RECIPE_ID,
  CANONICAL_PUBLIC_BUILD_VALUE_NAMES,
  CANONICAL_RUNTIME_PROFILE_ID,
  HOSTING_ENVIRONMENT_CONTRACT,
  buildTenantEnvironmentBindings,
  tenantEnvironmentContractDigest,
} from "../providers/hosting-tenant.js";
import type {
  OwnershipMarker,
  OnboardingProviders,
} from "../providers/interfaces.js";
import type { Registry } from "../state/registry.js";

export interface OnboardingExecutionContext {
  readonly operationId: string;
  readonly fencingToken: number;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly companyName: string;
  readonly workspaceClass: "internal" | "disposable" | "external";
  readonly adminEmail: string;
  readonly dataOwnerScope: string;
  readonly dataProjectName: string;
  readonly dataRegionId: string;
  readonly dataTierId: string;
  readonly dataComputeId: string;
  readonly hostingOwnerScope: string;
  readonly hostingProjectName: string;
  readonly productionHostname: string;
  readonly sourceGitSha: string;
  readonly migrationVersions: readonly number[];
  readonly targetSchemaVersion: number;
  readonly siteUrl: string;
  readonly redirectUrls: readonly string[];
  readonly smtpProfileId: string;
  readonly senderDomain: string;
  readonly fromIdentity: string;
  readonly templateSetId: string;
  readonly smtpSecretLabels: readonly string[];
  readonly integrationSecretLabels: readonly string[];
  readonly publicBuildValueNames: readonly string[];
  readonly environmentContractVersion: string;
  readonly environmentContractDigest: string;
  readonly smokeTestIds: readonly string[];
  readonly ownership: OwnershipMarker;
}

/**
 * The runtime checks the hosting control plane owns inside the smoke suite. The
 * other smoke IDs belong to the data, auth and SMTP ports and are unchanged.
 */
const HOSTING_RUNTIME_CHECK_IDS: readonly string[] = [
  "api_health",
  "cron_configuration",
  "preview_isolation",
  "runtime_project_ref",
];

/** Every public build value in the closed S26 profile. */
const PUBLIC_VALUE_NAMES: readonly string[] = [...CANONICAL_PUBLIC_BUILD_VALUE_NAMES].sort();

export interface ExecuteNextResult {
  readonly ordinal: number;
  readonly state: StepState;
  readonly operationState: string;
}

export class OnboardingExecutor {
  readonly #registry: Registry;
  readonly #providers: OnboardingProviders;
  readonly #redactor: Redactor;
  readonly #clock: () => Date;

  constructor(
    registry: Registry,
    providers: OnboardingProviders,
    redactor = new Redactor(),
    clock: () => Date = () => new Date(),
  ) {
    this.#registry = registry;
    this.#providers = providers;
    this.#redactor = redactor;
    this.#clock = clock;
  }

  async executeNext(context: OnboardingExecutionContext): Promise<ExecuteNextResult> {
    this.#redactor.assertSecretFree(context, "onboarding execution context");
    const operation = this.#registry.getOperation(context.operationId);
    assertOps(operation, "invalid_plan", `Unknown operation ${context.operationId}`);
    assertOps(operation.state === "running", "invalid_state_transition", "Operation is not running");
    const steps = this.#registry.listSteps(context.operationId);
    const next = steps.find(
      (step) =>
        step.state === "pending" ||
        step.state === "failed" ||
        step.state === "outcome_unknown",
    );
    assertOps(next, "invalid_state_transition", "No executable onboarding step remains");
    for (const prior of steps.filter((step) => step.ordinal < next.ordinal)) {
      assertOps(
        prior.state === "succeeded" || prior.state === "not_applicable",
        "invalid_state_transition",
        `Step ${next.ordinal} cannot run before step ${prior.ordinal}`,
      );
    }

    if (next.ordinal > 1) {
      const tenant = this.#registry.getTenantLifecycle(context.tenantId);
      if (tenant === "quarantined") {
        this.#registry.transitionTenant(
          context.tenantId,
          next.ordinal >= 11 ? "verifying" : "provisioning",
          context.operationId,
          context.fencingToken,
          this.#clock(),
        );
      }
    }
    this.#registry.transitionStep(
      context.operationId,
      next.ordinal,
      "running",
      context.fencingToken,
      { now: this.#clock() },
    );

    try {
      const providerRequestId = await this.#execute(context, next.ordinal);
      if (next.ordinal === 1) {
        this.#registry.transitionTenant(
          context.tenantId,
          "provisioning",
          context.operationId,
          context.fencingToken,
          this.#clock(),
        );
      } else if (next.ordinal === 11) {
        if (this.#registry.getTenantLifecycle(context.tenantId) !== "verifying") {
          this.#registry.transitionTenant(
            context.tenantId,
            "verifying",
            context.operationId,
            context.fencingToken,
            this.#clock(),
          );
        }
      }
      this.#registry.transitionStep(
        context.operationId,
        next.ordinal,
        "succeeded",
        context.fencingToken,
        {
          ...(providerRequestId === undefined ? {} : { providerRequestId }),
          now: this.#clock(),
        },
      );
      if (next.ordinal === 13) {
        this.#registry.transitionTenant(
          context.tenantId,
          "active",
          context.operationId,
          context.fencingToken,
          this.#clock(),
        );
        this.#registry.transitionOperation(
          context.operationId,
          "succeeded",
          context.fencingToken,
          { now: this.#clock() },
        );
      }
      return {
        ordinal: next.ordinal,
        state: "succeeded",
        operationState: this.#registry.getOperation(context.operationId)!.state,
      };
    } catch (error) {
      const safeError = this.#redactor.sanitizeError(error);
      const unknown = safeError.code === "outcome_unknown";
      const providerRequestId =
        typeof safeError.details.provider_request_id === "string"
          ? safeError.details.provider_request_id
          : undefined;
      this.#registry.transitionStep(
        context.operationId,
        next.ordinal,
        unknown ? "outcome_unknown" : "failed",
        context.fencingToken,
        {
          ...(providerRequestId === undefined ? {} : { providerRequestId }),
          redactedError:
            `${safeError.code}: ${safeError.message}`,
          now: this.#clock(),
        },
      );
      const lifecycle = this.#registry.getTenantLifecycle(context.tenantId);
      if (lifecycle === "provisioning" || lifecycle === "verifying") {
        this.#registry.transitionTenant(
          context.tenantId,
          "quarantined",
          context.operationId,
          context.fencingToken,
          this.#clock(),
        );
      }
      this.#registry.transitionOperation(
        context.operationId,
        "failed",
        context.fencingToken,
        {
          errorCode: safeError.code,
          redactedErrorSummary: safeError.message,
          now: this.#clock(),
        },
      );
      throw safeError;
    }
  }

  async #execute(
    context: OnboardingExecutionContext,
    ordinal: number,
  ): Promise<string | undefined> {
    const dataProject = this.#registry.getResourceReference(
      context.tenantId,
      "data",
      "project",
    );
    const hostingTarget = this.#registry.getResourceReference(
      context.tenantId,
      "hosting",
      "project",
    );
    switch (ordinal) {
      case 1:
      case 13:
        return undefined;
      case 2: {
        const resource = await this.#providerCall("data.createOrAdoptProject", () => this.#providers.data.createOrAdoptProject({
          organizationId: context.dataOwnerScope,
          deterministicName: context.dataProjectName,
          regionId: context.dataRegionId,
          tierId: context.dataTierId,
          computeId: context.dataComputeId,
          ownership: context.ownership,
        }));
        this.#registry.saveResourceReference(
          {
            tenantId: context.tenantId,
            providerKind: "data",
            resourceKind: "project",
            providerOwnerId: resource.providerOwnerId,
            resourceId: resource.resourceId,
            deterministicName: resource.deterministicName,
            ownershipMarkerDigest: resource.ownershipMarkerDigest,
            observedLifecycle: resource.lifecycle,
          },
          context.operationId,
          context.fencingToken,
          resource.providerRequestId,
          this.#clock(),
        );
        return resource.providerRequestId;
      }
      case 3: {
        assertOps(dataProject, "invalid_plan", "Data resource reference is missing");
        await this.#providerCall("data.waitUntilReady", () =>
          this.#providers.data.waitUntilReady(dataProject.resourceId),
        );
        return (
          await this.#providerCall("data.applySchema", () => this.#providers.data.applySchema({
            projectId: dataProject.resourceId,
            baselineVersion: 53,
            migrationVersions: context.migrationVersions,
            targetSchemaVersion: context.targetSchemaVersion,
          }))
        ).providerRequestId;
      }
      case 4: {
        assertOps(dataProject, "invalid_plan", "Data resource reference is missing");
        await this.#providerCall(
          "objectStorage.configurePrivateStorage",
          () => this.#providers.objectStorage.configurePrivateStorage({
            projectId: dataProject.resourceId,
            bucketId: "lead-photos",
            visibility: "private",
          }),
        );
        await this.#providerCall(
          "identity.configure",
          () => this.#providers.identity.configure({
            projectId: dataProject.resourceId,
            siteUrl: context.siteUrl,
            redirectUrls: context.redirectUrls,
            templateSetId: context.templateSetId,
          }),
        );
        return (
          await this.#providerCall("email.configure", () => this.#providers.email.configure({
            projectId: dataProject.resourceId,
            smtpProfileId: context.smtpProfileId,
            senderDomain: context.senderDomain,
            fromIdentity: context.fromIdentity,
            smtpSecretLabels: context.smtpSecretLabels,
          }))
        ).providerRequestId;
      }
      case 5:
        assertOps(dataProject, "invalid_plan", "Data resource reference is missing");
        return (
          await this.#providerCall("identity.createDisabledSupportMembership", () =>
            this.#providers.identity.createDisabledSupportMembership(dataProject.resourceId),
          )
        ).providerRequestId;
      case 6: {
        const target = await this.#providerCall(
          "hosting.createDeploymentTarget",
          () => this.#providers.hosting.createDeploymentTarget({
            deterministicName: context.hostingProjectName,
            workspaceClass: context.workspaceClass,
            runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
            ownership: context.ownership,
            automaticPromotionEnabled: false,
            isolatedPreviewsEnabled: false,
          }),
        );
        this.#registry.saveResourceReference(
          {
            tenantId: context.tenantId,
            providerKind: "hosting",
            resourceKind: "project",
            providerOwnerId: context.hostingOwnerScope,
            resourceId: target.targetHandle,
            deterministicName: target.deterministicName,
            ownershipMarkerDigest: target.ownershipMarkerDigest,
            observedLifecycle: target.lifecycle,
          },
          context.operationId,
          context.fencingToken,
          target.hostingRequestId,
          this.#clock(),
        );
        return target.hostingRequestId;
      }
      case 7: {
        assertOps(hostingTarget, "invalid_plan", "Hosting target reference is missing");
        assertOps(dataProject, "invalid_plan", "Data resource reference is missing");
        // Ties the plan's declared public build values to the canonical
        // environment contract; legacy names are adapter-only transition data.
        assertOps(
          JSON.stringify([...context.publicBuildValueNames].sort()) ===
            JSON.stringify([...CANONICAL_PUBLIC_BUILD_VALUE_NAMES].sort()),
          "invalid_plan",
          "Plan public build values do not match the canonical environment contract",
        );
        assertOps(
          context.environmentContractVersion === HOSTING_ENVIRONMENT_CONTRACT &&
            context.environmentContractDigest === tenantEnvironmentContractDigest({ tenantSlug: context.tenantSlug }),
          "invalid_plan",
          "Plan environment contract does not match the closed S26 profile",
        );
        const binding = await this.#providerCall("hosting.bindEnvironment", () =>
          this.#providers.hosting.bindEnvironment({
            targetHandle: hostingTarget.resourceId,
            scope: "production",
            dataProjectHandle: dataProject.resourceId,
            dataProjectName: context.dataProjectName,
            ownership: context.ownership,
            bindings: buildTenantEnvironmentBindings({
              tenantSlug: context.tenantSlug,
            }),
          }),
        );
        assertOps(
          binding.bindingDigest === context.environmentContractDigest,
          "provider_error",
          "Hosting binding digest does not match the approved S26 contract",
        );
        return binding.hostingRequestId;
      }
      case 8:
        assertOps(hostingTarget, "invalid_plan", "Hosting target reference is missing");
        return (
          await this.#providerCall("hosting.assignDomain", () =>
            this.#providers.hosting.assignDomain({
              targetHandle: hostingTarget.resourceId,
              hostname: context.productionHostname,
              ownership: context.ownership,
              certificateMode: "provider_managed",
            }),
          )
        ).hostingRequestId;
      case 9: {
        assertOps(hostingTarget, "invalid_plan", "Hosting target reference is missing");
        assertOps(dataProject, "invalid_plan", "Data resource reference is missing");
        const manifestDigest = scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES);
        const release = await this.#providerCall("hosting.buildRelease", () =>
          this.#providers.hosting.buildRelease({
            targetHandle: hostingTarget.resourceId,
            revisionId: context.sourceGitSha,
            buildRecipeId: CANONICAL_BUILD_RECIPE_ID,
            publicValueNames: PUBLIC_VALUE_NAMES,
            environmentBindingDigest: context.environmentContractDigest,
            scheduleManifestDigest: manifestDigest,
          }),
        );
        this.#registry.saveResourceReference(
          {
            tenantId: context.tenantId,
            providerKind: "hosting",
            resourceKind: "build",
            providerOwnerId: context.hostingOwnerScope,
            resourceId: release.releaseHandle,
            deterministicName: `${context.hostingProjectName}@${context.sourceGitSha}`,
            ownershipMarkerDigest: context.ownership.digest,
            observedLifecycle: "verified",
          },
          context.operationId,
          context.fencingToken,
          release.hostingRequestId,
          this.#clock(),
        );
        // Schedules are pinned to the release they belong to, so they are
        // registered as part of building it rather than as a free-standing step
        // that could drift away from the revision serving those routes.
        return (
          await this.#providerCall("hosting.registerSchedules", () =>
            this.#providers.hosting.registerSchedules({
              targetHandle: hostingTarget.resourceId,
              releaseHandle: release.releaseHandle,
              schedules: CANONICAL_TENANT_SCHEDULES,
              manifestDigest,
            }),
          )
        ).hostingRequestId;
      }
      case 10: {
        assertOps(hostingTarget, "invalid_plan", "Hosting target reference is missing");
        const release = this.#registry.getResourceReference(
          context.tenantId,
          "hosting",
          "build",
        );
        assertOps(release, "invalid_plan", "Verified tenant build is missing");
        const rollout = await this.#providerCall("hosting.promoteRelease", () =>
          this.#providers.hosting.promoteRelease({
            targetHandle: hostingTarget.resourceId,
            releaseHandle: release.resourceId,
          }),
        );
        this.#registry.saveResourceReference(
          {
            tenantId: context.tenantId,
            providerKind: "hosting",
            resourceKind: "deployment",
            providerOwnerId: context.hostingOwnerScope,
            resourceId: rollout.rolloutHandle,
            deterministicName: `${context.hostingProjectName}@production`,
            ownershipMarkerDigest: context.ownership.digest,
            observedLifecycle: "promoted",
          },
          context.operationId,
          context.fencingToken,
          rollout.hostingRequestId,
          this.#clock(),
        );
        return rollout.hostingRequestId;
      }
      case 11: {
        assertOps(dataProject, "invalid_plan", "Data resource reference is missing");
        assertOps(hostingTarget, "invalid_plan", "Hosting target reference is missing");
        const release = this.#registry.getResourceReference(
          context.tenantId,
          "hosting",
          "build",
        );
        assertOps(release, "invalid_plan", "Verified tenant build is missing");
        await this.#providerCall("data.runSmokeTests", () =>
          this.#providers.data.runSmokeTests(
            dataProject.resourceId,
            context.smokeTestIds.filter((id) =>
              [
                "schema_ledger",
                "rls_role_boundaries",
                "private_storage_delivery",
              ].includes(id),
            ),
          ),
        );
        await this.#providerCall("identity.runSmokeTests", () =>
          this.#providers.identity.runSmokeTests(
            dataProject.resourceId,
            context.smokeTestIds.filter((id) =>
              [
                "auth_anonymous_denied",
                "auth_inactive_denied",
                "auth_member_allowed",
              ].includes(id),
            ),
          ),
        );
        await this.#providerCall("email.runSmokeTests", () =>
          this.#providers.email.runSmokeTests(
            dataProject.resourceId,
            context.smokeTestIds.filter((id) => id === "smtp_delivery"),
          ),
        );
        const verification = await this.#providerCall(
          "hosting.verifyDeployment",
          () => this.#providers.hosting.verifyDeployment({
            targetHandle: hostingTarget.resourceId,
            expectedActiveReleaseHandle: release.resourceId,
            expectedHostname: context.productionHostname,
            expectedRevisionId: context.sourceGitSha,
            expectedSchedules: CANONICAL_TENANT_SCHEDULES,
            runtimeCheckIds: context.smokeTestIds.filter((id) =>
              HOSTING_RUNTIME_CHECK_IDS.includes(id),
            ),
          }),
        );
        assertOps(
          verification.status === "passed",
          "provider_error",
          "Hosting deployment verification did not pass",
        );
        return verification.hostingRequestId;
      }
      case 12:
        assertOps(dataProject, "invalid_plan", "Data resource reference is missing");
        return (
          await this.#providerCall("identity.inviteCompanyAdmin", () =>
            this.#providers.identity.createCompanyAdminAndInvite({
              projectId: dataProject.resourceId,
              adminEmail: context.adminEmail,
            }),
          )
        ).providerRequestId;
      default:
        throw new OpsError("invalid_plan", `Unknown onboarding ordinal ${ordinal}`);
    }
  }

  async #providerCall<T>(context: string, call: () => Promise<T>): Promise<T> {
    const result = await call();
    this.#redactor.assertSecretFree(result, `${context} response`);
    return result;
  }
}
