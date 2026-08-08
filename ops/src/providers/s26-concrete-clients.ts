/**
 * Reviewed S26 provider clients.
 *
 * These are intentionally provider adapters, not operations-core ports: the
 * core can only receive their named methods through S26ProviderBackedOperations.
 * HTTP, credentials and provider response parsing remain private here.  No
 * constructor reads process environment variables and no method accepts a URL,
 * header map, SQL string, shell command or arbitrary payload.
 */
import { OpsError } from "../core/errors.js";
import { Redactor } from "../core/redaction.js";
import { s26BridgePath } from "./s26-bridge-contract.js";
import type {
  AuthConfigurationRequest, CompanyAdminRequest, DataInspection, DataInspectionRequest,
  DataProjectRequest, DomainInspection, DomainInspectionRequest, IdentityInspection,
  IdentityInspectionRequest, PrivateStorageRequest, ProviderActionResult, ProviderResource,
  RecoveryArtifact, RecoveryCaptureRequest, RecoveryRestoreRequest, RecoveryVerification,
  SmtpConfigurationRequest, SmtpInspection, SmtpInspectionRequest,
  SourceRepositoryInspection, SourceRepositoryInspectionRequest, TenantSchemaRequest,
} from "./interfaces.js";
import type {
  DeploymentTargetRequest, DeploymentTargetResult, DeploymentVerificationRequest,
  DomainAssignmentRequest, DomainAssignmentResult, EnvironmentBindingRequest,
  EnvironmentBindingResult, HostingCapabilityInspection, HostingCapabilityInspectionRequest,
  HostingVerificationReport, PromotionRequest, ReleaseBuildRequest, ReleaseBuildResult,
  RollbackRequest, RolloutResult, ScheduleRegistrationRequest, ScheduleRegistrationResult,
} from "./hosting.js";
import type {
  DomainOperationsApi, EmailOperationsApi, HostingOperationsApi, IdentityOperationsApi,
  NeonOperationsApi, ObjectStorageOperationsApi, S26OperationsApiBundle,
  SourceRepositoryOperationsApi,
} from "./apis.js";
import type { DataRecoveryPort, HostingRecoveryPort, IdentityRecoveryPort, ObjectStorageRecoveryPort } from "./interfaces.js";

export interface ProviderCredentialResolver {
  /** Resolves an adapter-private credential; it must never be returned. */
  resolve(): Promise<string>;
}

export interface ProviderFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type ProviderFetch = (url: string, init: Readonly<{ method: string; headers: Readonly<Record<string, string>>; body?: string }>) => Promise<ProviderFetchResponse>;

export interface ProviderHttpConfiguration {
  readonly baseUrl: string;
  readonly credential: ProviderCredentialResolver;
  /** Adapter-private owner/account scope; never a caller-selected URL component. */
  readonly scopeId?: string;
  /** Test-only replacement for the platform fetch implementation. */
  readonly fetch?: ProviderFetch;
}

class PrivateProviderHttp {
  readonly #baseUrl: URL;
  readonly #credential: ProviderCredentialResolver;
  readonly #fetch: ProviderFetch;
  readonly #redactor: Redactor;

  constructor(configuration: ProviderHttpConfiguration, redactor: Redactor) {
    try {
      this.#baseUrl = new URL(configuration.baseUrl);
    } catch {
      throw new OpsError("provider_error", "Provider base URL is invalid");
    }
    if (this.#baseUrl.protocol !== "https:") {
      throw new OpsError("provider_error", "Provider base URL must use HTTPS");
    }
    this.#credential = configuration.credential;
    this.#fetch = configuration.fetch ?? (async (url, init) => {
      const response = await fetch(url, init);
      return response;
    });
    this.#redactor = redactor;
  }

  async invoke(method: "GET" | "POST", path: string, payload?: unknown): Promise<unknown> {
    const credential = await this.#credential.resolve();
    this.#redactor.registerSecret(credential);
    const url = new URL(path, this.#baseUrl).toString();
    try {
      const response = await this.#fetch(url, {
        method,
        headers: { authorization: `Bearer ${credential}`, accept: "application/json", ...(payload === undefined ? {} : { "content-type": "application/json" }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const requestId = response.headers.get("x-request-id") ?? "provider-request-unknown";
      if (!response.ok) {
        const code = response.status === 408 || response.status === 429 || response.status >= 500
          ? "outcome_unknown" : "provider_error";
        throw new OpsError(code, `Provider request failed with status ${response.status}`, { provider_request_id: requestId });
      }
      const body = await response.json();
      this.#redactor.assertSecretFree(body, "provider response");
      if (typeof body === "object" && body !== null && !Array.isArray(body)) {
        return { ...body, providerRequestId: requestId };
      }
      return { providerRequestId: requestId };
    } catch (error) {
      throw this.#redactor.sanitizeError(error);
    }
  }
}

function id(value: string): string { return encodeURIComponent(value); }
function result<T>(value: unknown, label: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpsError("provider_error", `${label} returned an invalid response`);
  }
  return value as T;
}

abstract class BridgeRecoveryClient {
  protected abstract readonly http: PrivateProviderHttp;

  async captureRecovery(request: RecoveryCaptureRequest): Promise<RecoveryArtifact> {
    return result(await this.http.invoke("POST", s26BridgePath(this.capability, "recovery-capture"), {
      source_resource_id: request.sourceResourceId, tenant_slug: request.tenantSlug,
      recovery_target_name: request.recoveryTargetName, ownership_marker_digest: request.ownership.digest,
    }), "recovery capture");
  }
  async restoreRecovery(request: RecoveryRestoreRequest): Promise<ProviderActionResult> {
    return result(await this.http.invoke("POST", s26BridgePath(this.capability, "recovery-restore"), {
      target_resource_id: request.targetResourceId, tenant_slug: request.tenantSlug, artifact_id: request.artifact.artifactId,
      artifact_manifest_digest: request.artifact.manifestDigest,
      ownership_marker_digest: request.ownership.digest,
    }), "recovery restore");
  }
  async verifyRecovery(request: RecoveryRestoreRequest): Promise<RecoveryVerification> {
    return result(await this.http.invoke("POST", s26BridgePath(this.capability, "recovery-verify"), {
      target_resource_id: request.targetResourceId, tenant_slug: request.tenantSlug, artifact_id: request.artifact.artifactId,
      ownership_marker_digest: request.ownership.digest,
    }), "recovery verification");
  }

  protected abstract readonly capability: "data" | "objectStorage" | "hosting";
}

/** Direct Neon project control-plane mapping; portable Postgres work is bridged. */
export class NeonPostgresOperationsClient extends BridgeRecoveryClient implements NeonOperationsApi, DataRecoveryPort {
  protected readonly http: PrivateProviderHttp;
  protected readonly capability = "data" as const;
  protected readonly prefix = "/v2/projects";
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { super(); this.http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: DataInspectionRequest): Promise<DataInspection> { return result(await this.http.invoke("POST", s26BridgePath("data", "inspect"), { organization_id: request.organizationId, deterministic_name: request.deterministicName, region_id: request.regionId, tier_id: request.tierId, compute_id: request.computeId, backup_profile_id: request.backupProfileId, ownership_marker_digest: request.ownership.digest }), "Neon inspection bridge"); }
  async createOrAdoptProject(request: DataProjectRequest): Promise<ProviderResource> {
    const value = result<{ readonly providerRequestId: string; readonly project?: { readonly id?: string; readonly name?: string } }>(await this.http.invoke("POST", this.prefix, { org_id: request.organizationId, project: { name: request.deterministicName, region_id: request.regionId } }), "Neon project");
    if (!value.project?.id || value.project.name !== request.deterministicName) throw new OpsError("provider_error", "Neon project response is incomplete");
    return { providerRequestId: value.providerRequestId, providerOwnerId: request.organizationId, resourceId: value.project.id, deterministicName: request.deterministicName, ownershipMarkerDigest: request.ownership.digest, lifecycle: "provisioning", adopted: false };
  }
  async waitUntilReady(projectId: string): Promise<ProviderActionResult> { return result(await this.http.invoke("GET", `${this.prefix}/${id(projectId)}`), "Neon project readiness"); }
  async applySchema(request: TenantSchemaRequest): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", s26BridgePath("data", "portable-schema-apply"), { project_id: request.projectId, baseline_version: request.baselineVersion, migration_versions: request.migrationVersions, target_schema_version: request.targetSchemaVersion }), "Postgres migration bridge"); }
  async runSmokeTests(projectId: string, smokeTestIds: readonly string[]): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", s26BridgePath("data", "smoke"), { project_id: projectId, smoke_test_ids: smokeTestIds }), "Postgres smoke bridge"); }
}

/** Better Auth is application-hosted; its reviewed admin bridge has named operations only. */
export class BetterAuthOperationsClient implements IdentityOperationsApi, IdentityRecoveryPort {
  protected readonly http: PrivateProviderHttp;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { this.http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: IdentityInspectionRequest): Promise<IdentityInspection> { return result(await this.http.invoke("POST", s26BridgePath("identity", "inspect"), { template_set_id: request.templateSetId, site_url: request.siteUrl, redirect_urls: request.redirectUrls, release_compatibility_id: request.releaseCompatibilityId }), "Better Auth inspect"); }
  async configure(request: AuthConfigurationRequest): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", s26BridgePath("identity", "configure"), { project_id: request.projectId, site_url: request.siteUrl, redirect_urls: request.redirectUrls, template_set_id: request.templateSetId }), "Better Auth configure"); }
  async createDisabledSupportMembership(projectId: string): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", s26BridgePath("identity", "support-membership"), { project_id: projectId }), "Better Auth support membership"); }
  async createCompanyAdminAndInvite(request: CompanyAdminRequest): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", s26BridgePath("identity", "company-admin-invite"), { project_id: request.projectId, admin_email: request.adminEmail }), "Better Auth company invite"); }
  async runSmokeTests(projectId: string, smokeTestIds: readonly string[]): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", s26BridgePath("identity", "smoke"), { project_id: projectId, smoke_test_ids: smokeTestIds }), "Better Auth smoke"); }
  async captureRecovery(request: RecoveryCaptureRequest): Promise<RecoveryArtifact> { return result(await this.http.invoke("POST", s26BridgePath("identity", "recovery-capture"), { source_resource_id: request.sourceResourceId, tenant_slug: request.tenantSlug, recovery_target_name: request.recoveryTargetName, ownership_marker_digest: request.ownership.digest }), "Better Auth recovery capture"); }
  async restoreRecovery(request: RecoveryRestoreRequest): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", s26BridgePath("identity", "recovery-restore"), { target_resource_id: request.targetResourceId, tenant_slug: request.tenantSlug, artifact_id: request.artifact.artifactId, artifact_manifest_digest: request.artifact.manifestDigest, ownership_marker_digest: request.ownership.digest }), "Better Auth recovery restore"); }
  async verifyRecovery(request: RecoveryRestoreRequest): Promise<RecoveryVerification> { return result(await this.http.invoke("POST", s26BridgePath("identity", "recovery-verify"), { target_resource_id: request.targetResourceId, tenant_slug: request.tenantSlug, artifact_id: request.artifact.artifactId, ownership_marker_digest: request.ownership.digest }), "Better Auth recovery verification"); }
}

/** Cloudflare R2 private-bucket and object-recovery client. */
export class CloudflareR2OperationsClient extends BridgeRecoveryClient implements ObjectStorageOperationsApi, ObjectStorageRecoveryPort {
  protected readonly http: PrivateProviderHttp;
  protected readonly capability = "objectStorage" as const;
  readonly #accountId: string;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { super(); this.http = new PrivateProviderHttp(configuration, redactor); if (!configuration.scopeId) throw new OpsError("provider_error", "Cloudflare account scope is required"); this.#accountId = configuration.scopeId; }
  async configurePrivateStorage(request: PrivateStorageRequest): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", `/client/v4/accounts/${id(this.#accountId)}/r2/buckets`, { name: request.bucketId }), "R2 bucket"); }
  async runSmokeTests(projectId: string, smokeTestIds: readonly string[]): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", s26BridgePath("objectStorage", "smoke"), { project_id: projectId, smoke_test_ids: smokeTestIds, require_private_access_checks: true }), "R2 smoke bridge"); }
}

/** Vercel deployment/configuration client. Every operation maps to one fixed route. */
export class VercelOperationsClient extends BridgeRecoveryClient implements HostingOperationsApi, HostingRecoveryPort {
  protected readonly http: PrivateProviderHttp;
  protected readonly capability = "hosting" as const;
  readonly #teamId: string;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { super(); this.http = new PrivateProviderHttp(configuration, redactor); if (!configuration.scopeId) throw new OpsError("provider_error", "Vercel team scope is required"); this.#teamId = configuration.scopeId; }
  #projectPath(version: string, handle?: string, suffix = ""): string { return `/v${version}/projects${handle ? `/${id(handle)}` : ""}${suffix}?teamId=${id(this.#teamId)}`; }
  async inspect(request: HostingCapabilityInspectionRequest): Promise<HostingCapabilityInspection> { return result(await this.http.invoke("POST", s26BridgePath("hosting", "inspect"), { deterministic_name: request.deterministicName, workspace_class: request.workspaceClass, runtime_profile_id: request.runtimeProfileId, required_schedule_count: request.requiredScheduleCount, required_server_value_count: request.requiredServerValueCount, required_public_value_count: request.requiredPublicValueCount, ownership_marker_digest: request.ownership.digest }), "Vercel inspection bridge"); }
  async createDeploymentTarget(request: DeploymentTargetRequest): Promise<DeploymentTargetResult> { const value = result<{ readonly providerRequestId: string; readonly id?: string; readonly name?: string }>(await this.http.invoke("POST", this.#projectPath("11"), { name: request.deterministicName }), "Vercel project"); if (!value.id || value.name !== request.deterministicName) throw new OpsError("provider_error", "Vercel project response is incomplete"); return { hostingRequestId: value.providerRequestId, targetHandle: value.id, deterministicName: request.deterministicName, workspaceClass: request.workspaceClass, runtimeProfileId: request.runtimeProfileId, ownershipMarkerDigest: request.ownership.digest, lifecycle: "provisioning", adopted: false, automaticPromotionEnabled: false, isolatedPreviewsEnabled: false }; }
  async bindEnvironment(request: EnvironmentBindingRequest): Promise<EnvironmentBindingResult> { return result(await this.http.invoke("POST", s26BridgePath("hosting", "environment-bind"), { target_handle: request.targetHandle, scope: request.scope, bindings: request.bindings.map((binding) => ({ name: binding.name, value_class: binding.valueClass, source_kind: binding.source.kind })) }), "Vercel environment bridge"); }
  async buildRelease(request: ReleaseBuildRequest): Promise<ReleaseBuildResult> { return result(await this.http.invoke("POST", s26BridgePath("hosting", "build"), { target_handle: request.targetHandle, revision_id: request.revisionId, build_recipe_id: request.buildRecipeId, public_value_names: request.publicValueNames, schedule_manifest_digest: request.scheduleManifestDigest }), "Vercel build bridge"); }
  async assignDomain(request: DomainAssignmentRequest): Promise<DomainAssignmentResult> { const value = result<{ readonly providerRequestId: string; readonly name?: string; readonly verified?: boolean }>(await this.http.invoke("POST", this.#projectPath("10", request.targetHandle, "/domains"), { name: request.hostname }), "Vercel domain"); if (value.name !== request.hostname) throw new OpsError("provider_error", "Vercel domain response is incomplete"); return { hostingRequestId: value.providerRequestId, targetHandle: request.targetHandle, hostname: request.hostname, assigned: true, certificateReady: value.verified === true, certificateMode: "provider_managed", ownershipMarkerDigest: request.ownership.digest }; }
  async registerSchedules(request: ScheduleRegistrationRequest): Promise<ScheduleRegistrationResult> { return result(await this.http.invoke("POST", s26BridgePath("hosting", "schedules"), { target_handle: request.targetHandle, release_handle: request.releaseHandle, schedules: request.schedules, manifest_digest: request.manifestDigest }), "Vercel schedules bridge"); }
  async promoteRelease(request: PromotionRequest): Promise<RolloutResult> { return result(await this.http.invoke("POST", s26BridgePath("hosting", "promote"), { target_handle: request.targetHandle, release_handle: request.releaseHandle }), "Vercel promotion bridge"); }
  async rollbackRelease(request: RollbackRequest): Promise<RolloutResult> { return result(await this.http.invoke("POST", s26BridgePath("hosting", "rollback"), { target_handle: request.targetHandle, release_handle: request.releaseHandle, superseded_release_handle: request.supersededReleaseHandle, reason_code: request.reasonCode }), "Vercel rollback bridge"); }
  async verifyDeployment(request: DeploymentVerificationRequest): Promise<HostingVerificationReport> { return result(await this.http.invoke("POST", s26BridgePath("hosting", "verify"), { target_handle: request.targetHandle, expected_active_release_handle: request.expectedActiveReleaseHandle, expected_revision_id: request.expectedRevisionId, expected_hostname: request.expectedHostname, expected_schedules: request.expectedSchedules, runtime_check_ids: request.runtimeCheckIds }), "Vercel verification bridge"); }
}

export class SmtpEmailOperationsClient implements EmailOperationsApi {
  readonly #http: PrivateProviderHttp;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { this.#http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: SmtpInspectionRequest): Promise<SmtpInspection> { return result(await this.#http.invoke("POST", s26BridgePath("smtp", "inspect"), { smtp_profile_id: request.smtpProfileId, sender_domain: request.senderDomain, from_identity: request.fromIdentity, smtp_secret_labels: request.smtpSecretLabels }), "SMTP inspect"); }
  async configure(request: SmtpConfigurationRequest): Promise<ProviderActionResult> { return result(await this.#http.invoke("POST", s26BridgePath("smtp", "configure"), { project_id: request.projectId, smtp_profile_id: request.smtpProfileId, sender_domain: request.senderDomain, from_identity: request.fromIdentity, smtp_secret_labels: request.smtpSecretLabels }), "SMTP configure"); }
  async runSmokeTests(projectId: string, smokeTestIds: readonly string[]): Promise<ProviderActionResult> { return result(await this.#http.invoke("POST", s26BridgePath("smtp", "smoke"), { project_id: projectId, smoke_test_ids: smokeTestIds }), "SMTP smoke"); }
}

export class DomainOperationsClient implements DomainOperationsApi {
  readonly #http: PrivateProviderHttp;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { this.#http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: DomainInspectionRequest): Promise<DomainInspection> { return result(await this.#http.invoke("POST", s26BridgePath("domain", "inspect"), { hostname: request.hostname, sender_domain: request.senderDomain, workspace_class: request.workspaceClass }), "Domain inspect"); }
}

/** Read-only source release inspection; no Git mutation or remote request is exposed. */
export class SourceRepositoryOperationsClient implements SourceRepositoryOperationsApi {
  readonly #http: PrivateProviderHttp;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { this.#http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: SourceRepositoryInspectionRequest): Promise<SourceRepositoryInspection> { return result(await this.#http.invoke("POST", s26BridgePath("sourceRepository", "inspect"), { source_git_sha: request.sourceGitSha, compatibility_entry_id: request.compatibilityEntryId, application_version: request.applicationVersion }), "Source repository inspect"); }
}

export interface S26ConcreteClientConfiguration {
  readonly neon: ProviderHttpConfiguration;
  readonly betterAuth: ProviderHttpConfiguration;
  readonly r2: ProviderHttpConfiguration;
  readonly vercel: ProviderHttpConfiguration;
  readonly smtp: ProviderHttpConfiguration;
  readonly domain: ProviderHttpConfiguration;
  readonly sourceRepository: ProviderHttpConfiguration;
}

/** Builds the only reviewed concrete S26 bundle; it never imports p4c-sdk.ts. */
export function createS26ConcreteApiBundle(
  configuration: S26ConcreteClientConfiguration,
  redactor = new Redactor(),
): S26OperationsApiBundle {
  return {
    data: new NeonPostgresOperationsClient(configuration.neon, redactor),
    identity: new BetterAuthOperationsClient(configuration.betterAuth, redactor),
    objectStorage: new CloudflareR2OperationsClient(configuration.r2, redactor),
    hosting: new VercelOperationsClient(configuration.vercel, redactor),
    email: new SmtpEmailOperationsClient(configuration.smtp, redactor),
    domain: new DomainOperationsClient(configuration.domain, redactor),
    sourceRepository: new SourceRepositoryOperationsClient(configuration.sourceRepository, redactor),
  };
}
