import { OpsError, assertOps } from "../core/errors.js";
import type { DisposableOnboardingCore } from "../core/onboarding-core.js";
import type {
  ApplyRequest,
  OperationState,
  ProviderSnapshot,
} from "../core/types.js";
import type { Registry, TenantRecord } from "../state/registry.js";
import {
  MCP_TOOL_CONTRACT_DIGEST,
  MUTATING_TOOL_NAMES,
} from "./policy.js";
import {
  ownerToolSchemas,
  SERVER_NAME,
  SERVER_VERSION,
  type OwnerToolName,
} from "./schemas.js";

export interface OwnerOperationsAdapter {
  call(toolName: OwnerToolName, input: unknown): Promise<unknown>;
}

export class RegistryOwnerOperationsAdapter implements OwnerOperationsAdapter {
  readonly #registry: Registry;
  readonly #observedSnapshots: () => readonly ProviderSnapshot[];
  readonly #onboarding: DisposableOnboardingCore | undefined;

  constructor(
    registry: Registry,
    observedSnapshots: () => readonly ProviderSnapshot[] = () => [],
    onboarding?: DisposableOnboardingCore,
  ) {
    this.#registry = registry;
    this.#observedSnapshots = observedSnapshots;
    this.#onboarding = onboarding;
  }

  async call(toolName: OwnerToolName, input: unknown): Promise<unknown> {
    ownerToolSchemas[toolName].input.parse(input);
    if (MUTATING_TOOL_NAMES.includes(toolName)) {
      this.#assertToolContract(input);
    }

    switch (toolName) {
      case "tenant_list": {
        const parsed = ownerToolSchemas.tenant_list.input.parse(input);
        return {
          meta: this.#meta(),
          tenants: this.#registry
            .listTenants({
              ...(parsed.lifecycle === undefined
                ? {}
                : { lifecycle: parsed.lifecycle }),
              ...(parsed.workspace_class === undefined
                ? {}
                : { workspaceClass: parsed.workspace_class }),
            })
            .map((tenant) => this.#tenant(tenant)),
        };
      }
      case "tenant_get": {
        const parsed = ownerToolSchemas.tenant_get.input.parse(input);
        const tenant = this.#registry.getTenant(parsed.tenant_slug);
        assertOps(tenant, "invalid_plan", "Unknown tenant");
        return {
          meta: this.#meta(),
          tenant: this.#tenant(tenant),
          resources: this.#registry
            .listResourceReferences(tenant.tenantId)
            .map((resource) => ({
              provider_kind: resource.providerKind,
              resource_kind: resource.resourceKind,
              provider_owner_id: resource.providerOwnerId,
              resource_id: resource.resourceId,
              deterministic_name: resource.deterministicName,
              ownership_marker_digest: resource.ownershipMarkerDigest,
              observed_lifecycle: resource.observedLifecycle,
            })),
        };
      }
      case "operation_get": {
        const parsed = ownerToolSchemas.operation_get.input.parse(input);
        const operation = this.#registry.getOperation(parsed.operation_id);
        assertOps(operation, "invalid_plan", "Unknown operation");
        const steps = this.#registry.listSteps(parsed.operation_id).map((step) => ({
          ordinal: step.ordinal,
          kind: step.kind,
          state: step.state,
          attempt: step.attempt,
          provider_request_id: step.providerRequestId,
          redacted_error: step.redactedError,
        }));
        return {
          meta: this.#meta(),
          operation: {
            operation_id: operation.operationId,
            operation_kind: operation.kind,
            scope: operation.scope,
            plan_id: operation.planId,
            plan_digest: operation.planDigest,
            idempotency_key: operation.idempotencyKey,
            state: operation.state,
            error_code: operation.errorCode,
            redacted_error_summary: operation.redactedErrorSummary,
            created_at: operation.createdAt,
            updated_at: operation.updatedAt,
            completed_at: operation.completedAt,
          },
          steps,
          next_step:
            steps.find(
              (step) =>
                step.state !== "succeeded" &&
                step.state !== "not_applicable",
            ) ?? null,
        };
      }
      case "tenant_preflight": {
        const onboarding = this.#requireOnboarding(toolName);
        const parsed = ownerToolSchemas.tenant_preflight.input.parse(input);
        const report = await onboarding.preflight(parsed);
        return {
          meta: this.#meta(),
          status: report.status,
          provider_snapshot_valid_until: report.snapshotValidUntil,
          prerequisites: report.prerequisites.map((candidate) => ({
            prerequisite_id: candidate.prerequisiteId,
            status: candidate.status,
            summary: candidate.summary,
          })),
          blockers: report.blockers.map((candidate) => ({
            code: candidate.code,
            summary: candidate.summary,
            remediation: candidate.remediation,
          })),
        };
      }
      case "tenant_plan_onboarding": {
        const onboarding = this.#requireOnboarding(toolName);
        const parsed =
          ownerToolSchemas.tenant_plan_onboarding.input.parse(input);
        const result = await onboarding.planOnboarding(parsed);
        const spec = result.envelope.spec as Record<
          string,
          Record<string, unknown>
        >;
        const resources = spec.resources!;
        const versions = spec.versions!;
        const cost = spec.cost!;
        const effects = spec.effects as unknown as readonly Record<
          string,
          unknown
        >[];
        return {
          meta: this.#meta(),
          plan: {
            plan_id: result.envelope.plan_id,
            plan_digest: result.envelope.plan_digest,
            generated_at: result.envelope.generated_at,
            expires_at: result.envelope.expires_at,
            expected_registry_version:
              result.envelope.expected_registry_version,
            state: result.envelope.state,
            effects: effects.map((effect) => ({
              ordinal: Number(effect.ordinal),
              effect_kind: String(effect.kind),
              action: String(effect.action),
              target: String(effect.resource_ref),
            })),
            prerequisites: result.preflight.prerequisites.map((candidate) => ({
              prerequisite_id: candidate.prerequisiteId,
              status: candidate.status,
              summary: candidate.summary,
            })),
            blockers: result.preflight.blockers.map((candidate) => ({
              code: candidate.code,
              summary: candidate.summary,
              remediation: candidate.remediation,
            })),
            tenant_slug: parsed.tenant_slug,
            production_hostname: String(resources.production_hostname),
        data_project_name: String(resources.data_project_name),
        hosting_project_name: String(resources.hosting_project_name),
            source_git_sha: String(versions.source_git_sha),
            baseline_version: 53,
            migration_versions:
              versions.migration_versions as unknown as readonly number[],
            recurring_cost_low_minor: Number(cost.recurring_low_minor),
            recurring_cost_high_minor: Number(cost.recurring_high_minor),
            currency: String(cost.currency),
          },
        };
      }
      case "tenant_apply_onboarding": {
        const parsed =
          ownerToolSchemas.tenant_apply_onboarding.input.parse(input);
        if (this.#onboarding !== undefined) {
          return this.#advance(
            await this.#onboarding.applyOrResume(
              this.#applyRequest(
                parsed.authorization,
                "tenant_onboarding",
              ),
            ),
          );
        }
        return this.#startOrResume({
          ...this.#applyRequest(
            parsed.authorization,
            "tenant_onboarding",
          ),
        });
      }
      case "tenant_resume_operation": {
        const parsed =
          ownerToolSchemas.tenant_resume_operation.input.parse(input);
        if (this.#onboarding !== undefined) {
          return this.#advance(
            await this.#onboarding.applyOrResume({
              ...this.#applyRequest(
                parsed.authorization,
                "tenant_onboarding",
              ),
              operation_id: parsed.operation_id,
            }),
          );
        }
        return this.#startOrResume({
          ...this.#applyRequest(
            parsed.authorization,
            "tenant_onboarding",
          ),
          operation_id: parsed.operation_id,
        });
      }
      case "tenant_drift":
      case "release_plan":
      case "tenant_prepare_offboarding":
      case "admin_invite":
      case "machine_enrollment_create":
      case "machine_revoke":
      case "support_access_enable":
      case "support_access_disable":
      case "tenant_suspend":
      case "release_apply":
        throw new OpsError(
          "unsupported_contract",
          `${toolName} is unavailable in P4-A; its approved operations-core capability is not installed`,
        );
    }
  }

  #advance(result: {
    readonly operationId: string;
    readonly state: OperationState;
    readonly resumed: boolean;
  }): unknown {
    return {
      meta: this.#meta(),
      operation_id: result.operationId,
      state: result.state,
      resumed: result.resumed,
      next_action:
        result.state === "succeeded" ? "tenant_get" : "operation_get",
    };
  }

  #requireOnboarding(toolName: OwnerToolName): DisposableOnboardingCore {
    if (this.#onboarding === undefined) {
      throw new OpsError(
        "unsupported_contract",
        `${toolName} is unavailable until an explicit P4-B disposable provider runtime is installed`,
      );
    }
    return this.#onboarding;
  }

  #startOrResume(request: ApplyRequest): unknown {
    const result = this.#registry.startOrResumeOperation(
      request,
      "owner-mcp",
      this.#observedSnapshots(),
    );
    return {
      meta: this.#meta(),
      operation_id: result.operationId,
      state: result.state,
      resumed: result.resumed,
      next_action: "operation_get",
    };
  }

  #applyRequest(
    authorization: {
      readonly plan_id: string;
      readonly plan_digest: string;
      readonly expected_registry_version: number;
      readonly idempotency_key: string;
    },
    operationKind: ApplyRequest["operation_kind"],
  ): ApplyRequest {
    return {
      contract_version: "p2.v1",
      operation_kind: operationKind,
      plan_id: authorization.plan_id,
      plan_digest: authorization.plan_digest,
      expected_registry_version: authorization.expected_registry_version,
      idempotency_key: authorization.idempotency_key,
    };
  }

  #assertToolContract(input: unknown): void {
    assertOps(
      typeof input === "object" &&
        input !== null &&
        "authorization" in input &&
        typeof input.authorization === "object" &&
        input.authorization !== null &&
        "tool_contract_digest" in input.authorization &&
        input.authorization.tool_contract_digest ===
          MCP_TOOL_CONTRACT_DIGEST,
      "unsupported_contract",
      "MCP tool contract digest does not match this operations server",
    );
  }

  #meta(): {
    readonly server_name: typeof SERVER_NAME;
    readonly server_version: typeof SERVER_VERSION;
    readonly tool_contract_digest: string;
    readonly operations_contract_version: "p2.v1";
    readonly registry_version: number;
  } {
    return {
      server_name: SERVER_NAME,
      server_version: SERVER_VERSION,
      tool_contract_digest: MCP_TOOL_CONTRACT_DIGEST,
      operations_contract_version: "p2.v1",
      registry_version: this.#registry.registryVersion,
    };
  }

  #tenant(tenant: TenantRecord): object {
    return {
      tenant_id: tenant.tenantId,
      tenant_slug: tenant.slug,
      company_name: tenant.companyName,
      workspace_class: tenant.workspaceClass,
      desired_lifecycle: tenant.desiredLifecycle,
      observed_lifecycle: tenant.observedLifecycle,
      release_channel: tenant.releaseChannel,
      region_id: tenant.regionId,
      data_tier_id: tenant.dataTierId,
      data_compute_id: tenant.dataComputeId,
      hosting_tier_id: tenant.hostingTierId,
      backup_profile_id: tenant.backupProfileId,
      cron_slot: tenant.cronSlot,
      created_at: tenant.createdAt,
      updated_at: tenant.updatedAt,
    };
  }
}
