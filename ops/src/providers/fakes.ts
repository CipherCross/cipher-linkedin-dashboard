import { createHash } from "node:crypto";

import { OpsError } from "../core/errors.js";
import type {
  AuthStorageRequest,
  BuildRequest,
  BuildResult,
  DeploymentResult,
  ProductionEnvironmentRequest,
  ProviderActionResult,
  ProviderResource,
  SupabaseProjectRequest,
  SupabaseProvider,
  TenantSchemaRequest,
  VercelProjectRequest,
  VercelProvider,
} from "./interfaces.js";

export type FailureTiming = "before_effect" | "after_effect" | "outcome_unknown";

export interface FailureRule {
  readonly method: string;
  readonly call: number;
  readonly timing: FailureTiming;
}

class FakeProviderBase {
  readonly #calls = new Map<string, number>();
  readonly #rules: readonly FailureRule[];

  constructor(rules: readonly FailureRule[] = []) {
    this.#rules = rules;
  }

  callCount(method: string): number {
    return this.#calls.get(method) ?? 0;
  }

  protected async effect<T>(method: string, apply: () => T): Promise<T> {
    const call = this.callCount(method) + 1;
    this.#calls.set(method, call);
    const rule = this.#rules.find(
      (candidate) => candidate.method === method && candidate.call === call,
    );
    if (rule?.timing === "before_effect") {
      throw new OpsError("provider_error", `${method} failed before effect`, {
        method,
        timing: rule.timing,
      });
    }
    const result = apply();
    if (rule?.timing === "after_effect") {
      throw new OpsError("provider_error", `${method} failed after effect`, {
        method,
        timing: rule.timing,
      });
    }
    if (rule?.timing === "outcome_unknown") {
      throw new OpsError("outcome_unknown", `${method} outcome is unknown`, {
        method,
        timing: rule.timing,
        provider_request_id: requestId(method, call),
      });
    }
    return result;
  }
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function requestId(method: string, call: number): string {
  return `req_${method.replaceAll(/[^a-z0-9]/gi, "_").toLowerCase()}_${call}`;
}

export class FakeSupabaseProvider extends FakeProviderBase implements SupabaseProvider {
  readonly #projects = new Map<string, ProviderResource>();

  get projectCount(): number {
    return this.#projects.size;
  }

  async createOrAdoptProject(
    request: SupabaseProjectRequest,
  ): Promise<ProviderResource> {
    return this.effect("createOrAdoptProject", () => {
      const key = `${request.organizationId}:${request.deterministicName}`;
      const existing = this.#projects.get(key);
      if (existing !== undefined) {
        if (existing.ownershipMarkerDigest !== request.ownership.digest) {
          throw new OpsError(
            "provider_error",
            "Supabase resource ownership marker mismatch",
          );
        }
        return { ...existing, adopted: true };
      }
      const resource: ProviderResource = {
        providerRequestId: requestId("createOrAdoptProject", this.callCount("createOrAdoptProject")),
        providerOwnerId: request.organizationId,
        resourceId: stableId("sb", key),
        deterministicName: request.deterministicName,
        ownershipMarkerDigest: request.ownership.digest,
        lifecycle: "ready",
        adopted: false,
      };
      this.#projects.set(key, resource);
      return resource;
    });
  }

  async waitUntilReady(_projectId: string): Promise<ProviderActionResult> {
    return this.action("waitUntilReady");
  }

  async applySchema(_request: TenantSchemaRequest): Promise<ProviderActionResult> {
    return this.action("applySchema");
  }

  async configurePrivateStorageAuthSmtp(
    _request: AuthStorageRequest,
  ): Promise<ProviderActionResult> {
    return this.action("configurePrivateStorageAuthSmtp");
  }

  async createDisabledSupportMembership(
    _projectId: string,
  ): Promise<ProviderActionResult> {
    return this.action("createDisabledSupportMembership");
  }

  async runSmokeTests(
    _projectId: string,
    _smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return this.action("runSmokeTests");
  }

  async inviteCompanyAdmin(
    _projectId: string,
    _adminEmail: string,
  ): Promise<ProviderActionResult> {
    return this.action("inviteCompanyAdmin");
  }

  private async action(method: string): Promise<ProviderActionResult> {
    return this.effect(method, () => ({
      providerRequestId: requestId(method, this.callCount(method)),
    }));
  }
}

export class FakeVercelProvider extends FakeProviderBase implements VercelProvider {
  readonly #projects = new Map<string, ProviderResource>();

  get projectCount(): number {
    return this.#projects.size;
  }

  async createOrAdoptProject(request: VercelProjectRequest): Promise<ProviderResource> {
    return this.effect("createOrAdoptProject", () => {
      const key = `${request.teamId}:${request.deterministicName}`;
      const existing = this.#projects.get(key);
      if (existing !== undefined) {
        if (existing.ownershipMarkerDigest !== request.ownership.digest) {
          throw new OpsError(
            "provider_error",
            "Vercel resource ownership marker mismatch",
          );
        }
        return { ...existing, adopted: true };
      }
      const resource: ProviderResource = {
        providerRequestId: requestId("createOrAdoptProject", this.callCount("createOrAdoptProject")),
        providerOwnerId: request.teamId,
        resourceId: stableId("vc", key),
        deterministicName: request.deterministicName,
        ownershipMarkerDigest: request.ownership.digest,
        lifecycle: "ready",
        adopted: false,
      };
      this.#projects.set(key, resource);
      return resource;
    });
  }

  async configureProductionEnvironment(
    _request: ProductionEnvironmentRequest,
  ): Promise<ProviderActionResult> {
    return this.action("configureProductionEnvironment");
  }

  async bindProductionDomain(
    _projectId: string,
    _hostname: string,
  ): Promise<ProviderActionResult> {
    return this.action("bindProductionDomain");
  }

  async buildTenant(request: BuildRequest): Promise<BuildResult> {
    return this.effect("buildTenant", () => ({
      providerRequestId: requestId("buildTenant", this.callCount("buildTenant")),
      buildId: stableId("build", `${request.projectId}:${request.sourceGitSha}`),
      sourceGitSha: request.sourceGitSha,
    }));
  }

  async deployAndPromote(
    projectId: string,
    buildId: string,
  ): Promise<DeploymentResult> {
    return this.effect("deployAndPromote", () => ({
      providerRequestId: requestId("deployAndPromote", this.callCount("deployAndPromote")),
      deploymentId: stableId("deployment", `${projectId}:${buildId}`),
    }));
  }

  async runSmokeTests(
    _projectId: string,
    _smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return this.action("runSmokeTests");
  }

  private async action(method: string): Promise<ProviderActionResult> {
    return this.effect(method, () => ({
      providerRequestId: requestId(method, this.callCount(method)),
    }));
  }
}
