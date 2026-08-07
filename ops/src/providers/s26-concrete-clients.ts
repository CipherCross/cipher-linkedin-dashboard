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
      return body;
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

abstract class ConcreteRecoveryClient {
  protected abstract readonly http: PrivateProviderHttp;
  protected abstract readonly prefix: string;

  async captureRecovery(request: RecoveryCaptureRequest): Promise<RecoveryArtifact> {
    return result(await this.http.invoke("POST", `${this.prefix}/${id(request.sourceResourceId)}/recovery/capture`, {
      tenant_slug: request.tenantSlug, recovery_target_name: request.recoveryTargetName,
      ownership_marker_digest: request.ownership.digest,
    }), "recovery capture");
  }
  async restoreRecovery(request: RecoveryRestoreRequest): Promise<ProviderActionResult> {
    return result(await this.http.invoke("POST", `${this.prefix}/${id(request.targetResourceId)}/recovery/restore`, {
      tenant_slug: request.tenantSlug, artifact_id: request.artifact.artifactId,
      artifact_manifest_digest: request.artifact.manifestDigest,
      ownership_marker_digest: request.ownership.digest,
    }), "recovery restore");
  }
  async verifyRecovery(request: RecoveryRestoreRequest): Promise<RecoveryVerification> {
    return result(await this.http.invoke("POST", `${this.prefix}/${id(request.targetResourceId)}/recovery/verify`, {
      tenant_slug: request.tenantSlug, artifact_id: request.artifact.artifactId,
      ownership_marker_digest: request.ownership.digest,
    }), "recovery verification");
  }
}

/** Neon control-plane plus the fixed portable-Postgres migration/recovery protocol. */
export class NeonPostgresOperationsClient extends ConcreteRecoveryClient implements NeonOperationsApi, DataRecoveryPort {
  protected readonly http: PrivateProviderHttp;
  protected readonly prefix = "/v2/projects";
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { super(); this.http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: DataInspectionRequest): Promise<DataInspection> { return result(await this.http.invoke("POST", "/v2/projects/inspect", { organization_id: request.organizationId, deterministic_name: request.deterministicName, region_id: request.regionId, tier_id: request.tierId, compute_id: request.computeId, backup_profile_id: request.backupProfileId, ownership_marker_digest: request.ownership.digest }), "Neon inspect"); }
  async createOrAdoptProject(request: DataProjectRequest): Promise<ProviderResource> { return result(await this.http.invoke("POST", this.prefix, { organization_id: request.organizationId, project_name: request.deterministicName, region_id: request.regionId, tier_id: request.tierId, compute_id: request.computeId, ownership_marker_digest: request.ownership.digest }), "Neon project"); }
  async waitUntilReady(projectId: string): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(projectId)}/wait-ready`), "Neon readiness"); }
  async applySchema(request: TenantSchemaRequest): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(request.projectId)}/portable-postgres/apply`, { baseline_version: request.baselineVersion, migration_versions: request.migrationVersions, target_schema_version: request.targetSchemaVersion }), "Postgres migration"); }
  async runSmokeTests(projectId: string, smokeTestIds: readonly string[]): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(projectId)}/portable-postgres/smoke`, { smoke_test_ids: smokeTestIds }), "Postgres smoke"); }
}

/** Better Auth is application-hosted; its reviewed admin bridge has named operations only. */
export class BetterAuthOperationsClient extends ConcreteRecoveryClient implements IdentityOperationsApi, IdentityRecoveryPort {
  protected readonly http: PrivateProviderHttp;
  protected readonly prefix = "/s26/better-auth/tenants";
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { super(); this.http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: IdentityInspectionRequest): Promise<IdentityInspection> { return result(await this.http.invoke("POST", "/s26/better-auth/inspect", { template_set_id: request.templateSetId, site_url: request.siteUrl, redirect_urls: request.redirectUrls, release_compatibility_id: request.releaseCompatibilityId }), "Better Auth inspect"); }
  async configure(request: AuthConfigurationRequest): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(request.projectId)}/configure`, { site_url: request.siteUrl, redirect_urls: request.redirectUrls, template_set_id: request.templateSetId }), "Better Auth configure"); }
  async createDisabledSupportMembership(projectId: string): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(projectId)}/support-membership`), "Better Auth support membership"); }
  async createCompanyAdminAndInvite(request: CompanyAdminRequest): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(request.projectId)}/company-admin-invite`, { admin_email: request.adminEmail }), "Better Auth company invite"); }
  async runSmokeTests(projectId: string, smokeTestIds: readonly string[]): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(projectId)}/smoke`, { smoke_test_ids: smokeTestIds }), "Better Auth smoke"); }
}

/** Cloudflare R2 private-bucket and object-recovery client. */
export class CloudflareR2OperationsClient extends ConcreteRecoveryClient implements ObjectStorageOperationsApi, ObjectStorageRecoveryPort {
  protected readonly http: PrivateProviderHttp;
  protected readonly prefix = "/client/v4/accounts/r2/buckets";
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { super(); this.http = new PrivateProviderHttp(configuration, redactor); }
  async configurePrivateStorage(request: PrivateStorageRequest): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(request.projectId)}/private-storage`, { bucket_id: request.bucketId, visibility: request.visibility }), "R2 private storage"); }
  async runSmokeTests(projectId: string, smokeTestIds: readonly string[]): Promise<ProviderActionResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(projectId)}/smoke`, { smoke_test_ids: smokeTestIds, require_private_access_checks: true }), "R2 smoke"); }
}

/** Vercel deployment/configuration client. Every operation maps to one fixed route. */
export class VercelOperationsClient extends ConcreteRecoveryClient implements HostingOperationsApi, HostingRecoveryPort {
  protected readonly http: PrivateProviderHttp;
  protected readonly prefix = "/v13/projects";
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { super(); this.http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: HostingCapabilityInspectionRequest): Promise<HostingCapabilityInspection> { return result(await this.http.invoke("POST", "/v13/projects/inspect", { deterministic_name: request.deterministicName, workspace_class: request.workspaceClass, runtime_profile_id: request.runtimeProfileId, required_schedule_count: request.requiredScheduleCount, required_server_value_count: request.requiredServerValueCount, required_public_value_count: request.requiredPublicValueCount, ownership_marker_digest: request.ownership.digest }), "Vercel inspect"); }
  async createDeploymentTarget(request: DeploymentTargetRequest): Promise<DeploymentTargetResult> { return result(await this.http.invoke("POST", this.prefix, { name: request.deterministicName, workspace_class: request.workspaceClass, runtime_profile_id: request.runtimeProfileId, ownership_marker_digest: request.ownership.digest, automatic_promotion_enabled: false, isolated_previews_enabled: false }), "Vercel deployment target"); }
  async bindEnvironment(request: EnvironmentBindingRequest): Promise<EnvironmentBindingResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(request.targetHandle)}/env/production`, { bindings: request.bindings.map((binding) => ({ name: binding.name, value_class: binding.valueClass, source_kind: binding.source.kind })) }), "Vercel environment binding"); }
  async buildRelease(request: ReleaseBuildRequest): Promise<ReleaseBuildResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(request.targetHandle)}/deployments`, { revision_id: request.revisionId, build_recipe_id: request.buildRecipeId, public_value_names: request.publicValueNames, schedule_manifest_digest: request.scheduleManifestDigest }), "Vercel build"); }
  async assignDomain(request: DomainAssignmentRequest): Promise<DomainAssignmentResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(request.targetHandle)}/domains`, { hostname: request.hostname, certificate_mode: request.certificateMode, ownership_marker_digest: request.ownership.digest }), "Vercel domain"); }
  async registerSchedules(request: ScheduleRegistrationRequest): Promise<ScheduleRegistrationResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(request.targetHandle)}/release-schedules`, { release_handle: request.releaseHandle, schedules: request.schedules, manifest_digest: request.manifestDigest }), "Vercel schedules"); }
  async promoteRelease(request: PromotionRequest): Promise<RolloutResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(request.targetHandle)}/promote`, { release_handle: request.releaseHandle }), "Vercel promotion"); }
  async rollbackRelease(request: RollbackRequest): Promise<RolloutResult> { return result(await this.http.invoke("POST", `${this.prefix}/${id(request.targetHandle)}/rollback`, { release_handle: request.releaseHandle, superseded_release_handle: request.supersededReleaseHandle, reason_code: request.reasonCode }), "Vercel rollback"); }
  async verifyDeployment(request: DeploymentVerificationRequest): Promise<HostingVerificationReport> { return result(await this.http.invoke("POST", `${this.prefix}/${id(request.targetHandle)}/verify`, { expected_active_release_handle: request.expectedActiveReleaseHandle, expected_revision_id: request.expectedRevisionId, expected_hostname: request.expectedHostname, expected_schedules: request.expectedSchedules, runtime_check_ids: request.runtimeCheckIds }), "Vercel verification"); }
}

export class SmtpEmailOperationsClient implements EmailOperationsApi {
  readonly #http: PrivateProviderHttp;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { this.#http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: SmtpInspectionRequest): Promise<SmtpInspection> { return result(await this.#http.invoke("POST", "/s26/smtp/inspect", { smtp_profile_id: request.smtpProfileId, sender_domain: request.senderDomain, from_identity: request.fromIdentity, smtp_secret_labels: request.smtpSecretLabels }), "SMTP inspect"); }
  async configure(request: SmtpConfigurationRequest): Promise<ProviderActionResult> { return result(await this.#http.invoke("POST", "/s26/smtp/configure", { project_id: request.projectId, smtp_profile_id: request.smtpProfileId, sender_domain: request.senderDomain, from_identity: request.fromIdentity, smtp_secret_labels: request.smtpSecretLabels }), "SMTP configure"); }
  async runSmokeTests(projectId: string, smokeTestIds: readonly string[]): Promise<ProviderActionResult> { return result(await this.#http.invoke("POST", `/s26/smtp/${id(projectId)}/smoke`, { smoke_test_ids: smokeTestIds }), "SMTP smoke"); }
}

export class DomainOperationsClient implements DomainOperationsApi {
  readonly #http: PrivateProviderHttp;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { this.#http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: DomainInspectionRequest): Promise<DomainInspection> { return result(await this.#http.invoke("POST", "/client/v4/zones/domain-inspection", { hostname: request.hostname, sender_domain: request.senderDomain, workspace_class: request.workspaceClass }), "Domain inspect"); }
}

/** Read-only source release inspection; no Git mutation or remote request is exposed. */
export class SourceRepositoryOperationsClient implements SourceRepositoryOperationsApi {
  readonly #http: PrivateProviderHttp;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { this.#http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: SourceRepositoryInspectionRequest): Promise<SourceRepositoryInspection> { return result(await this.#http.invoke("POST", "/s26/source-repository/inspect", { source_git_sha: request.sourceGitSha, compatibility_entry_id: request.compatibilityEntryId, application_version: request.applicationVersion }), "Source repository inspect"); }
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
