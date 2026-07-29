import { createHash } from "node:crypto";

import { OpsError } from "../core/errors.js";
import type {
  AuthConfigurationRequest,
  AuthInspectionRequest,
  AuthProvider,
  BuildRequest,
  BuildResult,
  CompanyAdminRequest,
  DeploymentResult,
  DomainBindingRequest,
  DomainInspectionRequest,
  DomainProvider,
  OnboardingProviders,
  PrivateStorageRequest,
  ProductionEnvironmentRequest,
  ProviderActionResult,
  ProviderResource,
  SmtpConfigurationRequest,
  SmtpInspectionRequest,
  SmtpProvider,
  SourceRepositoryInspectionRequest,
  SourceRepositoryProvider,
  SupabaseInspectionRequest,
  SupabaseProjectRequest,
  SupabaseProvider,
  TenantSchemaRequest,
  VercelInspectionRequest,
  VercelProjectRequest,
  VercelProvider,
} from "./interfaces.js";

export type FailureTiming = "before_effect" | "after_effect" | "outcome_unknown";

export interface FailureRule {
  readonly method: string;
  readonly call: number;
  readonly timing: FailureTiming;
}

export class FakeProviderBase {
  readonly #calls = new Map<string, number>();
  readonly #rules: readonly FailureRule[];
  readonly #effects = new Map<string, unknown>();

  constructor(rules: readonly FailureRule[] = []) {
    this.#rules = rules;
  }

  callCount(method: string): number {
    return this.#calls.get(method) ?? 0;
  }

  effectCount(method: string): number {
    return [...this.#effects.keys()].filter((key) =>
      key.startsWith(`${method}:`),
    ).length;
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

  protected async idempotentEffect<T>(
    method: string,
    key: string,
    apply: () => T,
  ): Promise<T> {
    return this.effect(method, () => {
      const cacheKey = `${method}:${key}`;
      const existing = this.#effects.get(cacheKey);
      if (existing !== undefined) return existing as T;
      const result = apply();
      this.#effects.set(cacheKey, result);
      return result;
    });
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

  async inspect(request: SupabaseInspectionRequest) {
    const existing = this.#projects.get(
      `${request.organizationId}:${request.deterministicName}`,
    );
    return this.effect("inspect", () => ({
      organizationAccessible: true,
      deterministicNameAvailable: existing === undefined,
      existingResourceOwned:
        existing?.ownershipMarkerDigest === request.ownership.digest,
      regionAvailable: true,
      tierAvailable: true,
      computeAvailable: true,
      backupCompatible: true,
      authConfigurationSupported: true,
      validUntil: "2030-01-01T00:30:00.000Z",
    }));
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
    return this.action("waitUntilReady", _projectId);
  }

  async applySchema(request: TenantSchemaRequest): Promise<ProviderActionResult> {
    return this.action("applySchema", JSON.stringify(request));
  }

  async configurePrivateStorage(
    request: PrivateStorageRequest,
  ): Promise<ProviderActionResult> {
    return this.action("configurePrivateStorage", JSON.stringify(request));
  }

  async runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return this.action("runSmokeTests", `${projectId}:${smokeTestIds.join(",")}`);
  }

  protected async action(method: string, key: string): Promise<ProviderActionResult> {
    return this.idempotentEffect(method, key, () => ({
      providerRequestId: requestId(method, this.callCount(method)),
    }));
  }
}

export class FakeVercelProvider extends FakeProviderBase implements VercelProvider {
  readonly #projects = new Map<string, ProviderResource>();

  get projectCount(): number {
    return this.#projects.size;
  }

  async inspect(request: VercelInspectionRequest) {
    const existing = this.#projects.get(
      `${request.teamId}:${request.deterministicName}`,
    );
    return this.effect("inspect", () => ({
      teamAccessible: true,
      deterministicNameAvailable: existing === undefined,
      existingResourceOwned:
        existing?.ownershipMarkerDigest === request.ownership.digest,
      tierAvailable: true,
      functionCapacityAvailable: true,
      cronCapacityAvailable: true,
      productionOnlyEnvironmentSupported: true,
      gitAutoPromotionCanBeDisabled: true,
      validUntil: "2030-01-01T00:30:00.000Z",
    }));
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
    request: ProductionEnvironmentRequest,
  ): Promise<ProviderActionResult> {
    return this.action(
      "configureProductionEnvironment",
      JSON.stringify(request),
    );
  }

  async buildTenant(request: BuildRequest): Promise<BuildResult> {
    return this.idempotentEffect("buildTenant", JSON.stringify(request), () => ({
      providerRequestId: requestId("buildTenant", this.callCount("buildTenant")),
      buildId: stableId("build", `${request.projectId}:${request.sourceGitSha}`),
      sourceGitSha: request.sourceGitSha,
    }));
  }

  async deployAndPromote(
    projectId: string,
    buildId: string,
  ): Promise<DeploymentResult> {
    return this.idempotentEffect("deployAndPromote", `${projectId}:${buildId}`, () => ({
      providerRequestId: requestId("deployAndPromote", this.callCount("deployAndPromote")),
      deploymentId: stableId("deployment", `${projectId}:${buildId}`),
    }));
  }

  async runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return this.action("runSmokeTests", `${projectId}:${smokeTestIds.join(",")}`);
  }

  private async action(method: string, key: string): Promise<ProviderActionResult> {
    return this.idempotentEffect(method, key, () => ({
      providerRequestId: requestId(method, this.callCount(method)),
    }));
  }
}

export class FakeAuthProvider extends FakeProviderBase implements AuthProvider {
  async inspect(_request: AuthInspectionRequest) {
    return this.effect("inspect", () => ({
      templateSetApproved: true,
      productionUrlsValid: true,
      inviteFlowSupported: true,
      releaseCompatible: true,
      validUntil: "2030-01-01T00:30:00.000Z",
    }));
  }

  async configure(
    request: AuthConfigurationRequest,
  ): Promise<ProviderActionResult> {
    return this.action("configure", JSON.stringify(request));
  }

  async createDisabledSupportMembership(
    projectId: string,
  ): Promise<ProviderActionResult> {
    return this.action("createDisabledSupportMembership", projectId);
  }

  async createCompanyAdminAndInvite(
    request: CompanyAdminRequest,
  ): Promise<ProviderActionResult> {
    return this.action(
      "createCompanyAdminAndInvite",
      `${request.projectId}:${request.adminEmail.toLowerCase()}`,
    );
  }

  async runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return this.action("runSmokeTests", `${projectId}:${smokeTestIds.join(",")}`);
  }

  private async action(method: string, key: string): Promise<ProviderActionResult> {
    return this.idempotentEffect(method, key, () => ({
      providerRequestId: requestId(method, this.callCount(method)),
    }));
  }
}

export class FakeSmtpProvider extends FakeProviderBase implements SmtpProvider {
  async inspect(_request: SmtpInspectionRequest) {
    return this.effect("inspect", () => ({
      providerAccessible: true,
      customSmtp: true,
      senderIdentityVerified: true,
      credentialsAvailable: true,
      validUntil: "2030-01-01T00:30:00.000Z",
    }));
  }

  async configure(
    request: SmtpConfigurationRequest,
  ): Promise<ProviderActionResult> {
    return this.action("configure", JSON.stringify(request));
  }

  async runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return this.action("runSmokeTests", `${projectId}:${smokeTestIds.join(",")}`);
  }

  private async action(method: string, key: string): Promise<ProviderActionResult> {
    return this.idempotentEffect(method, key, () => ({
      providerRequestId: requestId(method, this.callCount(method)),
    }));
  }
}

export class FakeDomainProvider extends FakeProviderBase implements DomainProvider {
  readonly #bindings = new Set<string>();

  async inspect(request: DomainInspectionRequest) {
    const existing = this.#bindings.has(request.hostname);
    return this.effect("inspect", () => ({
      zoneOwned: true,
      hostnameAvailable: !existing,
      existingBindingOwned: existing,
      senderDomainVerified: true,
      legalReviewApproved: true,
      validUntil: "2030-01-01T00:30:00.000Z",
    }));
  }

  async bindProductionDomain(
    request: DomainBindingRequest,
  ): Promise<ProviderActionResult> {
    return this.idempotentEffect(
      "bindProductionDomain",
      `${request.projectId}:${request.hostname}`,
      () => {
        this.#bindings.add(request.hostname);
        return {
          providerRequestId: requestId(
            "bindProductionDomain",
            this.callCount("bindProductionDomain"),
          ),
        };
      },
    );
  }
}

export class FakeSourceRepositoryProvider
  extends FakeProviderBase
  implements SourceRepositoryProvider
{
  async inspect(_request: SourceRepositoryInspectionRequest) {
    return this.effect("inspect", () => ({
      revisionPresent: true,
      releaseCompatible: true,
      artifactPinned: true,
      validUntil: "2030-01-01T00:30:00.000Z",
    }));
  }
}

export class FakeOnboardingProviderBundle implements OnboardingProviders {
  readonly supabase: FakeSupabaseProvider;
  readonly vercel: FakeVercelProvider;
  readonly auth: FakeAuthProvider;
  readonly smtp: FakeSmtpProvider;
  readonly domain: FakeDomainProvider;
  readonly sourceRepository: FakeSourceRepositoryProvider;

  constructor(
    rules: {
      readonly supabase?: readonly FailureRule[];
      readonly vercel?: readonly FailureRule[];
      readonly auth?: readonly FailureRule[];
      readonly smtp?: readonly FailureRule[];
      readonly domain?: readonly FailureRule[];
      readonly sourceRepository?: readonly FailureRule[];
    } = {},
  ) {
    this.supabase = new FakeSupabaseProvider(rules.supabase);
    this.vercel = new FakeVercelProvider(rules.vercel);
    this.auth = new FakeAuthProvider(rules.auth);
    this.smtp = new FakeSmtpProvider(rules.smtp);
    this.domain = new FakeDomainProvider(rules.domain);
    this.sourceRepository = new FakeSourceRepositoryProvider(
      rules.sourceRepository,
    );
  }
}
