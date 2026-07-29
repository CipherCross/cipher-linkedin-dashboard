import { OpsError, assertOps } from "../core/errors.js";
import type { ApplyRequest, ProviderSnapshot } from "../core/types.js";
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

  constructor(
    registry: Registry,
    observedSnapshots: () => readonly ProviderSnapshot[] = () => [],
  ) {
    this.#registry = registry;
    this.#observedSnapshots = observedSnapshots;
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
      case "tenant_apply_onboarding": {
        const parsed =
          ownerToolSchemas.tenant_apply_onboarding.input.parse(input);
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
        return this.#startOrResume({
          ...this.#applyRequest(
            parsed.authorization,
            "tenant_onboarding",
          ),
          operation_id: parsed.operation_id,
        });
      }
      case "tenant_preflight":
      case "tenant_plan_onboarding":
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
      supabase_tier_id: tenant.supabaseTierId,
      supabase_compute_id: tenant.supabaseComputeId,
      vercel_tier_id: tenant.vercelTierId,
      backup_profile_id: tenant.backupProfileId,
      cron_slot: tenant.cronSlot,
      created_at: tenant.createdAt,
      updated_at: tenant.updatedAt,
    };
  }
}
