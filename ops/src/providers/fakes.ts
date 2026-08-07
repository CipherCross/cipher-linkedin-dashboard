import { createHash } from "node:crypto";

import { OpsError } from "../core/errors.js";
import type {
  AuthConfigurationRequest,
  AuthInspectionRequest,
  AuthProvider,
  CompanyAdminRequest,
  DomainInspectionRequest,
  DomainProvider,
  PrivateStorageRequest,
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
  DataProvider,
  ObjectStorageProvider,
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

/** Canonical fake names used by S25 contract tests. */
export class FakeNeonDataProvider extends FakeSupabaseProvider implements DataProvider {}

/** Private object storage fake: no project discovery or database methods. */
export class FakeObjectStorageProvider
  extends FakeProviderBase
  implements ObjectStorageProvider
{
  async configurePrivateStorage(
    request: PrivateStorageRequest,
  ): Promise<ProviderActionResult> {
    return this.idempotentEffect(
      "configurePrivateStorage",
      JSON.stringify(request),
      () => ({
        providerRequestId: requestId(
          "configurePrivateStorage",
          this.callCount("configurePrivateStorage"),
        ),
      }),
    );
  }

  async runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return this.idempotentEffect(
      "runSmokeTests",
      `${projectId}:${smokeTestIds.join(",")}`,
      () => ({
        providerRequestId: requestId(
          "runSmokeTests",
          this.callCount("runSmokeTests"),
        ),
      }),
    );
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

export class FakeIdentityProvider extends FakeAuthProvider {}

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

/**
 * Zone preflight only. The hostname binding itself is a hosting capability and
 * lives on `FakeHostingProvider.assignDomain`.
 */
export class FakeDomainProvider extends FakeProviderBase implements DomainProvider {
  readonly #ownedHostnames: ReadonlySet<string>;

  constructor(
    rules: readonly FailureRule[] = [],
    ownedHostnames: readonly string[] = [],
  ) {
    super(rules);
    this.#ownedHostnames = new Set(ownedHostnames);
  }

  async inspect(request: DomainInspectionRequest) {
    const existing = this.#ownedHostnames.has(request.hostname);
    return this.effect("inspect", () => ({
      zoneOwned: true,
      hostnameAvailable: !existing,
      existingBindingOwned: existing,
      senderDomainVerified: true,
      legalReviewApproved: true,
      validUntil: "2030-01-01T00:30:00.000Z",
    }));
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
