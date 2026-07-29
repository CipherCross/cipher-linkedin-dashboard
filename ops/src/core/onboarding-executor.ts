import { OpsError, assertOps } from "./errors.js";
import { Redactor } from "./redaction.js";
import type { StepState } from "./types.js";
import type {
  OwnershipMarker,
  SupabaseProvider,
  VercelProvider,
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
  readonly supabaseOrganizationId: string;
  readonly supabaseProjectName: string;
  readonly supabaseRegionId: string;
  readonly supabaseTierId: string;
  readonly supabaseComputeId: string;
  readonly vercelTeamId: string;
  readonly vercelProjectName: string;
  readonly productionHostname: string;
  readonly sourceGitSha: string;
  readonly migrationVersions: readonly number[];
  readonly targetSchemaVersion: number;
  readonly siteUrl: string;
  readonly redirectUrls: readonly string[];
  readonly smtpProfileId: string;
  readonly smtpSecretLabels: readonly string[];
  readonly integrationSecretLabels: readonly string[];
  readonly publicBuildValueNames: readonly (
    | "VITE_SUPABASE_URL"
    | "VITE_SUPABASE_ANON_KEY"
  )[];
  readonly smokeTestIds: readonly string[];
  readonly ownership: OwnershipMarker;
}

export interface ExecuteNextResult {
  readonly ordinal: number;
  readonly state: StepState;
  readonly operationState: string;
}

export class OnboardingExecutor {
  readonly #registry: Registry;
  readonly #supabase: SupabaseProvider;
  readonly #vercel: VercelProvider;
  readonly #redactor: Redactor;

  constructor(
    registry: Registry,
    supabase: SupabaseProvider,
    vercel: VercelProvider,
    redactor = new Redactor(),
  ) {
    this.#registry = registry;
    this.#supabase = supabase;
    this.#vercel = vercel;
    this.#redactor = redactor;
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
        );
      }
    }
    this.#registry.transitionStep(
      context.operationId,
      next.ordinal,
      "running",
      context.fencingToken,
    );

    try {
      const providerRequestId = await this.#execute(context, next.ordinal);
      if (next.ordinal === 1) {
        this.#registry.transitionTenant(
          context.tenantId,
          "provisioning",
          context.operationId,
          context.fencingToken,
        );
      } else if (next.ordinal === 11) {
        this.#registry.transitionTenant(
          context.tenantId,
          "verifying",
          context.operationId,
          context.fencingToken,
        );
      }
      this.#registry.transitionStep(
        context.operationId,
        next.ordinal,
        "succeeded",
        context.fencingToken,
        providerRequestId === undefined ? {} : { providerRequestId },
      );
      if (next.ordinal === 13) {
        this.#registry.transitionTenant(
          context.tenantId,
          "active",
          context.operationId,
          context.fencingToken,
        );
        this.#registry.transitionOperation(
          context.operationId,
          "succeeded",
          context.fencingToken,
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
      this.#registry.transitionStep(
        context.operationId,
        next.ordinal,
        unknown ? "outcome_unknown" : "failed",
        context.fencingToken,
        {
          redactedError:
            `${safeError.code}: ${safeError.message}`,
        },
      );
      const lifecycle = this.#registry.getTenantLifecycle(context.tenantId);
      if (lifecycle === "provisioning" || lifecycle === "verifying") {
        this.#registry.transitionTenant(
          context.tenantId,
          "quarantined",
          context.operationId,
          context.fencingToken,
        );
      }
      this.#registry.transitionOperation(
        context.operationId,
        "failed",
        context.fencingToken,
        {
          errorCode: safeError.code,
          redactedErrorSummary: safeError.message,
        },
      );
      throw safeError;
    }
  }

  async #execute(
    context: OnboardingExecutionContext,
    ordinal: number,
  ): Promise<string | undefined> {
    const supabaseProject = this.#registry.getResourceReference(
      context.tenantId,
      "supabase",
      "project",
    );
    const vercelProject = this.#registry.getResourceReference(
      context.tenantId,
      "vercel",
      "project",
    );
    switch (ordinal) {
      case 1:
      case 13:
        return undefined;
      case 2: {
        const resource = await this.#providerCall("supabase.createOrAdoptProject", () => this.#supabase.createOrAdoptProject({
          organizationId: context.supabaseOrganizationId,
          deterministicName: context.supabaseProjectName,
          regionId: context.supabaseRegionId,
          tierId: context.supabaseTierId,
          computeId: context.supabaseComputeId,
          ownership: context.ownership,
        }));
        this.#registry.saveResourceReference(
          {
            tenantId: context.tenantId,
            providerKind: "supabase",
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
        );
        return resource.providerRequestId;
      }
      case 3: {
        assertOps(supabaseProject, "invalid_plan", "Supabase resource reference is missing");
        await this.#providerCall("supabase.waitUntilReady", () =>
          this.#supabase.waitUntilReady(supabaseProject.resourceId),
        );
        return (
          await this.#providerCall("supabase.applySchema", () => this.#supabase.applySchema({
            projectId: supabaseProject.resourceId,
            baselineVersion: 53,
            migrationVersions: context.migrationVersions,
            targetSchemaVersion: context.targetSchemaVersion,
          }))
        ).providerRequestId;
      }
      case 4:
        assertOps(supabaseProject, "invalid_plan", "Supabase resource reference is missing");
        return (
          await this.#providerCall("supabase.configurePrivateStorageAuthSmtp", () => this.#supabase.configurePrivateStorageAuthSmtp({
            projectId: supabaseProject.resourceId,
            siteUrl: context.siteUrl,
            redirectUrls: context.redirectUrls,
            smtpProfileId: context.smtpProfileId,
            smtpSecretLabels: context.smtpSecretLabels,
          }))
        ).providerRequestId;
      case 5:
        assertOps(supabaseProject, "invalid_plan", "Supabase resource reference is missing");
        return (
          await this.#providerCall("supabase.createDisabledSupportMembership", () =>
            this.#supabase.createDisabledSupportMembership(supabaseProject.resourceId),
          )
        ).providerRequestId;
      case 6: {
        const resource = await this.#providerCall("vercel.createOrAdoptProject", () => this.#vercel.createOrAdoptProject({
          teamId: context.vercelTeamId,
          deterministicName: context.vercelProjectName,
          ownership: context.ownership,
          gitAutoPromotion: false,
        }));
        this.#registry.saveResourceReference(
          {
            tenantId: context.tenantId,
            providerKind: "vercel",
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
        );
        return resource.providerRequestId;
      }
      case 7:
        assertOps(vercelProject, "invalid_plan", "Vercel resource reference is missing");
        return (
          await this.#providerCall("vercel.configureProductionEnvironment", () => this.#vercel.configureProductionEnvironment({
            projectId: vercelProject.resourceId,
            secretLabels: [
              ...context.smtpSecretLabels,
              ...context.integrationSecretLabels,
            ],
            publicBuildValueNames: context.publicBuildValueNames,
            scope: "production_only",
          }))
        ).providerRequestId;
      case 8:
        assertOps(vercelProject, "invalid_plan", "Vercel resource reference is missing");
        return (
          await this.#providerCall("vercel.bindProductionDomain", () =>
            this.#vercel.bindProductionDomain(
              vercelProject.resourceId,
              context.productionHostname,
            ),
          )
        ).providerRequestId;
      case 9: {
        assertOps(vercelProject, "invalid_plan", "Vercel resource reference is missing");
        const build = await this.#providerCall("vercel.buildTenant", () => this.#vercel.buildTenant({
          projectId: vercelProject.resourceId,
          sourceGitSha: context.sourceGitSha,
          publicBuildValueNames: context.publicBuildValueNames,
        }));
        this.#registry.saveResourceReference(
          {
            tenantId: context.tenantId,
            providerKind: "vercel",
            resourceKind: "build",
            providerOwnerId: context.vercelTeamId,
            resourceId: build.buildId,
            deterministicName: `${context.vercelProjectName}@${context.sourceGitSha}`,
            ownershipMarkerDigest: context.ownership.digest,
            observedLifecycle: "verified",
          },
          context.operationId,
          context.fencingToken,
          build.providerRequestId,
        );
        return build.providerRequestId;
      }
      case 10: {
        assertOps(vercelProject, "invalid_plan", "Vercel resource reference is missing");
        const build = this.#registry.getResourceReference(
          context.tenantId,
          "vercel",
          "build",
        );
        assertOps(build, "invalid_plan", "Verified tenant build is missing");
        const deployment = await this.#providerCall("vercel.deployAndPromote", () =>
          this.#vercel.deployAndPromote(
            vercelProject.resourceId,
            build.resourceId,
          ),
        );
        this.#registry.saveResourceReference(
          {
            tenantId: context.tenantId,
            providerKind: "vercel",
            resourceKind: "deployment",
            providerOwnerId: context.vercelTeamId,
            resourceId: deployment.deploymentId,
            deterministicName: `${context.vercelProjectName}@production`,
            ownershipMarkerDigest: context.ownership.digest,
            observedLifecycle: "promoted",
          },
          context.operationId,
          context.fencingToken,
          deployment.providerRequestId,
        );
        return deployment.providerRequestId;
      }
      case 11: {
        assertOps(supabaseProject, "invalid_plan", "Supabase resource reference is missing");
        assertOps(vercelProject, "invalid_plan", "Vercel resource reference is missing");
        await this.#providerCall("supabase.runSmokeTests", () =>
          this.#supabase.runSmokeTests(
            supabaseProject.resourceId,
            context.smokeTestIds,
          ),
        );
        return (
          await this.#providerCall("vercel.runSmokeTests", () =>
            this.#vercel.runSmokeTests(
              vercelProject.resourceId,
              context.smokeTestIds,
            ),
          )
        ).providerRequestId;
      }
      case 12:
        assertOps(supabaseProject, "invalid_plan", "Supabase resource reference is missing");
        return (
          await this.#providerCall("supabase.inviteCompanyAdmin", () =>
            this.#supabase.inviteCompanyAdmin(
              supabaseProject.resourceId,
              context.adminEmail,
            ),
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
