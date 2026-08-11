/**
 * Reviewed S26 provider clients.
 *
 * These are intentionally provider adapters, not operations-core ports: the
 * core can only receive their named methods through S26ProviderBackedOperations.
 * HTTP, credentials and provider response parsing remain private here.  No
 * constructor reads process environment variables and no method accepts a URL,
 * header map, SQL string, shell command or arbitrary payload.
 */
import { OpsError, type OpsErrorCode } from "../core/errors.js";
import { Redactor } from "../core/redaction.js";
import { neonOwnershipRoleName } from "./neon-ownership.js";
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
  HostingValueClass, HostingValueSource, HostingValueSourceKind,
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
  /**
   * Set ONLY for our own reviewed control-plane bridge.
   *
   * The bridge derives its HTTP status from a deterministic OpsError code, so on
   * that transport alone the body's `code` is better evidence than the status.
   * A third-party provider endpoint must never carry this: there, an ambiguous
   * status is the only honest reading of a possibly-applied mutation.
   */
  readonly controlPlaneBridge?: boolean;
}

/**
 * Bridge body codes that name a decision made *before* any provider mutation
 * was attempted, so repeating the request is no less safe than the first call.
 *
 * `outcome_unknown` is deliberately absent: the bridge reports it with 502 and
 * it must never be downgraded to a deterministic failure. Any code outside this
 * closed set — including the bridge's non-OpsError `unauthorized` and
 * `unsupported_route` bodies — falls back to the status mapping.
 */
const DETERMINISTIC_BRIDGE_ERROR_CODES: ReadonlySet<string> = new Set<OpsErrorCode>([
  "provider_error",
  "provider_readiness_blocked",
  "provider_snapshot_drift",
  "schema_validation_failed",
  "secret_input_required",
  "secret_invalid",
  "secret_store_error",
  "unsupported_contract",
]);

class PrivateProviderHttp {
  readonly #baseUrl: URL;
  readonly #credential: ProviderCredentialResolver;
  readonly #fetch: ProviderFetch;
  readonly #redactor: Redactor;
  readonly #controlPlaneBridge: boolean;

  constructor(configuration: ProviderHttpConfiguration, redactor: Redactor) {
    try {
      this.#baseUrl = new URL(configuration.baseUrl);
    } catch {
      throw new OpsError("provider_error", "Provider base URL is invalid");
    }
    if (this.#baseUrl.protocol !== "https:") {
      throw new OpsError("provider_error", "Provider base URL must use HTTPS");
    }
    // A base may carry a path prefix of its own — Neon's API lives under
    // `/api`. Resolution below is relative, so the base must end in a slash or
    // its last segment would be replaced instead of extended.
    if (!this.#baseUrl.pathname.endsWith("/")) {
      this.#baseUrl.pathname = `${this.#baseUrl.pathname}/`;
    }
    this.#credential = configuration.credential;
    this.#fetch = configuration.fetch ?? (async (url, init) => {
      const response = await fetch(url, init);
      return response;
    });
    this.#redactor = redactor;
    this.#controlPlaneBridge = configuration.controlPlaneBridge === true;
  }

  /**
   * The deterministic code our own bridge put in the body, when it left one.
   *
   * Returns undefined — keeping the conservative status mapping — for any
   * non-bridge transport, an unreadable or non-JSON body, or a code outside the
   * closed deterministic set. An edge or proxy failure never reaches this shape.
   */
  async #deterministicBridgeFailure(
    response: ProviderFetchResponse,
  ): Promise<{
    readonly code: OpsErrorCode;
    readonly providerRequestId?: string;
    readonly upstreamStatus?: number;
    readonly upstreamCode?: string;
  } | undefined> {
    if (!this.#controlPlaneBridge) return undefined;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return undefined;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
    const record = body as Record<string, unknown>;
    const code = record.code;
    if (typeof code !== "string" || !DETERMINISTIC_BRIDGE_ERROR_CODES.has(code)) return undefined;
    const providerRequestId = record.provider_request_id;
    const upstreamStatus = record.provider_status;
    const upstreamCode = record.provider_error_code;
    return {
      code: code as OpsErrorCode,
      ...(typeof providerRequestId === "string" ? { providerRequestId } : {}),
      ...(typeof upstreamStatus === "number" ? { upstreamStatus } : {}),
      ...(typeof upstreamCode === "string" ? { upstreamCode } : {}),
    };
  }

  async invoke(method: "GET" | "POST" | "PATCH", path: string, payload?: unknown): Promise<unknown> {
    const credential = await this.#credential.resolve();
    this.#redactor.registerSecret(credential);
    // Resolve relative to the base's own path. An absolute `/v2/projects`
    // would discard the base prefix and address `console.neon.tech/v2/...`,
    // which answers 404.
    const url = new URL(path.replace(/^\/+/, ""), this.#baseUrl).toString();
    try {
      const response = await this.#fetch(url, {
        method,
        headers: { authorization: `Bearer ${credential}`, accept: "application/json", ...(payload === undefined ? {} : { "content-type": "application/json" }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      let requestId = response.headers.get("x-request-id") ?? "provider-request-unknown";
      if (!response.ok) {
        // Our own bridge answers a deterministic OpsError with a status chosen
        // FROM that code — provider_error and provider_readiness_blocked both
        // become 409. Reading only the status therefore threw the safe code away
        // and recorded a decided failure as an ambiguous one, which is what
        // quarantined S26 step 3 behind an `outcome_unknown` that no evidence
        // could ever resolve. The body is authoritative on that transport only.
        const bridgeFailure = await this.#deterministicBridgeFailure(response);
        if (bridgeFailure?.providerRequestId !== undefined) requestId = bridgeFailure.providerRequestId;
        const code = bridgeFailure?.code
          ?? (response.status === 408 || response.status === 409 || response.status === 423 || response.status === 429 || response.status >= 500
            ? "outcome_unknown" : "provider_error");
        // The host and path say which named operation failed. Without them a
        // provider status is unattributable, which is how a bridge route sent
        // to a provider's own API stayed hidden behind an opaque 401.
        // Credentials live in the header, never here, and the query string is
        // dropped so no scope value rides along.
        // Naming the upstream status in the message is what makes a bridge
        // failure attributable at all: "status 409" alone only ever said "our own
        // bridge refused", never which provider refused it or why.
        const upstream = bridgeFailure?.upstreamStatus;
        const upstreamCode = bridgeFailure?.upstreamCode;
        const attribution = upstream === undefined
          ? ""
          : ` (upstream ${upstream}${upstreamCode === undefined ? "" : ` ${upstreamCode}`})`;
        throw new OpsError(code, `Provider request failed with status ${response.status}${attribution}`, {
          ...(upstream === undefined ? {} : { upstream_provider_status: upstream }),
          ...(upstreamCode === undefined ? {} : { upstream_provider_error_code: upstreamCode }),
          provider_request_id: requestId,
          provider_endpoint: `${method} ${new URL(url).origin}${new URL(url).pathname}`,
          // Adoption has to tell "this resource does not exist yet" apart from
          // "the provider refused". Only the status can say that, and it is a
          // number, so it carries no scope, credential or payload with it.
          provider_status: response.status,
        });
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

/**
 * How long to keep re-writing the Neon ownership marker while the freshly
 * created project is still locked. Bounded, because a marker that never lands
 * must surface as a failure rather than hang the step.
 */
const NEON_MARKER_ATTEMPTS = 10;
const NEON_MARKER_RETRY_MS = 2_000;
/** True when the provider answered "no such resource" rather than refusing. */
function isAbsent(error: unknown): boolean {
  return error instanceof OpsError && error.code === "provider_error" && error.details.provider_status === 404;
}
async function absentOr<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); } catch (error) { if (isAbsent(error)) return undefined; throw error; }
}
function result<T>(value: unknown, label: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpsError("provider_error", `${label} returned an invalid response`);
  }
  return value as T;
}

/** Drops the key the transport adds, for shapes whose canonical form lacks it. */
function withoutProviderRequestId<T>(value: unknown, label: string): T {
  const { providerRequestId: _providerRequestId, ...rest } = result<Record<string, unknown>>(value, label);
  return rest as T;
}

/**
 * Read-only inspections carry no provider request id in their canonical shape:
 * that id exists to make an ambiguous *mutation* resumable. The transport adds
 * one to every response, so it is dropped here rather than reaching the
 * canonical adapter's strict schema as an unrecognized key.
 */
function inspection<T>(value: unknown, label: string): T {
  return withoutProviderRequestId<T>(value, label);
}

/**
 * Hosting results name their request id `hostingRequestId`, which the bridge
 * sets, so the transport's added `providerRequestId` is a second, redundant copy
 * — and the canonical hosting schemas are strict, so it is rejected as an
 * unrecognized key.
 *
 * This is the mutation half of the defect that was fixed for the six inspections.
 * It went unnoticed because the two hosting operations that build their result
 * explicitly — createDeploymentTarget and assignDomain — map providerRequestId to
 * hostingRequestId by hand, so steps 6 and 8 passed while every hosting call that
 * returns the bridge body as-is (steps 7, 9, 10 and the final verify) failed.
 */
function hostingResult<T>(value: unknown, label: string): T {
  return withoutProviderRequestId<T>(value, label);
}

abstract class BridgeRecoveryClient {
  /**
   * Recovery is a bridge vocabulary, so it must travel over the bridge
   * transport. Sending a bridge path to a provider's own API host presents the
   * provider credential to a route that provider does not serve, which it
   * rejects as unauthorized.
   */
  protected abstract readonly bridge: PrivateProviderHttp;

  async captureRecovery(request: RecoveryCaptureRequest): Promise<RecoveryArtifact> {
    return result(await this.bridge.invoke("POST", s26BridgePath(this.capability, "recovery-capture"), {
      source_resource_id: request.sourceResourceId, tenant_slug: request.tenantSlug,
      recovery_target_name: request.recoveryTargetName, ownership_marker_digest: request.ownership.digest,
    }), "recovery capture");
  }
  async restoreRecovery(request: RecoveryRestoreRequest): Promise<ProviderActionResult> {
    return result(await this.bridge.invoke("POST", s26BridgePath(this.capability, "recovery-restore"), {
      target_resource_id: request.targetResourceId, tenant_slug: request.tenantSlug, artifact_id: request.artifact.artifactId,
      artifact_manifest_digest: request.artifact.manifestDigest,
      ownership_marker_digest: request.ownership.digest,
    }), "recovery restore");
  }
  async verifyRecovery(request: RecoveryRestoreRequest): Promise<RecoveryVerification> {
    return result(await this.bridge.invoke("POST", s26BridgePath(this.capability, "recovery-verify"), {
      target_resource_id: request.targetResourceId, tenant_slug: request.tenantSlug, artifact_id: request.artifact.artifactId,
      ownership_marker_digest: request.ownership.digest,
    }), "recovery verification");
  }

  protected abstract readonly capability: "data" | "objectStorage" | "hosting";
}

/** Direct Neon project control-plane mapping; portable Postgres work is bridged. */
export class NeonPostgresOperationsClient extends BridgeRecoveryClient implements NeonOperationsApi, DataRecoveryPort {
  protected readonly bridge: PrivateProviderHttp;
  readonly #direct: PrivateProviderHttp;
  protected readonly capability = "data" as const;
  protected readonly prefix = "/v2/projects";
  /**
   * The real Neon organization, like the R2 account and Vercel team, is
   * adapter-private configuration. The core deliberately passes an opaque
   * capability label as the owner scope, so a caller-supplied value must never
   * reach the provider as an organization id.
   */
  readonly #organizationId: string;
  constructor(configuration: ProviderHttpConfiguration, bridge: ProviderHttpConfiguration, redactor = new Redactor()) { super(); this.#direct = new PrivateProviderHttp(configuration, redactor); this.bridge = new PrivateProviderHttp(bridge, redactor); if (!configuration.scopeId) throw new OpsError("provider_error", "Neon organization scope is required"); this.#organizationId = configuration.scopeId; }
  async inspect(request: DataInspectionRequest): Promise<DataInspection> { return inspection(await this.bridge.invoke("POST", s26BridgePath("data", "inspect"), { organization_id: request.organizationId, deterministic_name: request.deterministicName, region_id: request.regionId, tier_id: request.tierId, compute_id: request.computeId, backup_profile_id: request.backupProfileId, ownership_marker_digest: request.ownership.digest }), "Neon inspection bridge"); }
  async createOrAdoptProject(request: DataProjectRequest): Promise<ProviderResource> {
    // Adoption is what makes this step safe to retry. Without it a resumed or
    // re-planned operation creates a second project every time, because Neon
    // does not require project names to be unique.
    const adopted = await this.#findOwnedProject(request.deterministicName, request.ownership.digest);
    if (adopted !== undefined) {
      return { providerRequestId: adopted.providerRequestId, providerOwnerId: request.organizationId, resourceId: adopted.resourceId, deterministicName: request.deterministicName, ownershipMarkerDigest: request.ownership.digest, lifecycle: "provisioning", adopted: true };
    }
    const value = result<{
      readonly providerRequestId: string;
      readonly project?: { readonly id?: string; readonly name?: string };
      readonly branch?: { readonly id?: string };
    }>(await this.#direct.invoke("POST", this.prefix, { org_id: this.#organizationId, project: { name: request.deterministicName, region_id: request.regionId } }), "Neon project");
    if (!value.project?.id || value.project.name !== request.deterministicName) throw new OpsError("provider_error", "Neon project response is incomplete");
    if (!value.branch?.id) throw new OpsError("provider_error", "Neon project response has no default branch");
    // The marker must exist before anything inspects this project, otherwise
    // our own resource reads back as foreign and blocks every later step.
    await this.#markOwnership(value.project.id, value.branch.id, request.ownership.digest);
    return { providerRequestId: value.providerRequestId, providerOwnerId: request.organizationId, resourceId: value.project.id, deterministicName: request.deterministicName, ownershipMarkerDigest: request.ownership.digest, lifecycle: "provisioning", adopted: false };
  }
  /**
   * A project is ours only if it carries our ownership marker. A name match
   * alone is a foreign resource, so it is deliberately not adopted.
   */
  async #findOwnedProject(
    deterministicName: string,
    ownershipMarkerDigest: string,
  ): Promise<{ readonly resourceId: string; readonly providerRequestId: string } | undefined> {
    const query = new URLSearchParams({ org_id: this.#organizationId, search: deterministicName, limit: "100" });
    const listed = result<{
      readonly providerRequestId: string;
      readonly projects?: readonly { readonly id?: string; readonly name?: string }[];
    }>(await this.#direct.invoke("GET", `${this.prefix}?${query.toString()}`), "Neon project search");
    const match = (listed.projects ?? []).find((project) => project.name === deterministicName);
    if (!match?.id) return undefined;
    const expected = neonOwnershipRoleName(ownershipMarkerDigest);
    const branches = result<{ readonly branches?: readonly { readonly id?: string }[] }>(
      await this.#direct.invoke("GET", `${this.prefix}/${id(match.id)}/branches`),
      "Neon branches",
    );
    for (const branch of branches.branches ?? []) {
      if (!branch.id) continue;
      const roles = result<{ readonly roles?: readonly { readonly name?: string }[] }>(
        await this.#direct.invoke("GET", `${this.prefix}/${id(match.id)}/branches/${id(branch.id)}/roles`),
        "Neon roles",
      );
      if ((roles.roles ?? []).some((role) => role.name === expected)) {
        return { resourceId: match.id, providerRequestId: listed.providerRequestId };
      }
    }
    return undefined;
  }
  /**
   * Writes the ownership marker, retrying while the project is still locked.
   *
   * Neon answers `423 Locked` on a branch operation issued immediately after
   * `POST /projects`, because the project is still initialising. That single
   * status is what makes this write racy, and losing it is unrecoverable: the
   * comment on the call site is exact — an unmarked project reads back as
   * foreign, so the name is taken and the project can never be adopted. Onboarding
   * `uitop` produced precisely that orphan on its first attempt.
   *
   * Creating the marker role is the only mutation here and it is name-addressed,
   * so repeating it is safe. The retry covers the transient statuses only; a
   * deterministic refusal still fails on the first attempt.
   */
  async #markOwnership(projectId: string, branchId: string, ownershipMarkerDigest: string): Promise<void> {
    const path = `${this.prefix}/${id(projectId)}/branches/${id(branchId)}/roles`;
    const payload = { role: { name: neonOwnershipRoleName(ownershipMarkerDigest) } };
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.#direct.invoke("POST", path, payload);
        return;
      } catch (error) {
        const status = error instanceof OpsError ? error.details.provider_status : undefined;
        const transient = status === 423 || status === 429 || status === 408
          || (typeof status === "number" && status >= 500);
        if (!transient || attempt >= NEON_MARKER_ATTEMPTS) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, NEON_MARKER_RETRY_MS));
      }
    }
  }
  async waitUntilReady(projectId: string): Promise<ProviderActionResult> {
    // Only the request id crosses the boundary. Returning the provider's own
    // project payload would both leak vendor shape into the core and fail the
    // canonical adapter's strict action schema.
    const value = result<{ readonly providerRequestId: string }>(await this.#direct.invoke("GET", `${this.prefix}/${id(projectId)}`), "Neon project readiness");
    return { providerRequestId: value.providerRequestId };
  }
  async applySchema(request: TenantSchemaRequest): Promise<ProviderActionResult> { return result(await this.bridge.invoke("POST", s26BridgePath("data", "portable-schema-apply"), { project_id: request.projectId, baseline_version: request.baselineVersion, migration_versions: request.migrationVersions, target_schema_version: request.targetSchemaVersion }), "Postgres migration bridge"); }
  async runSmokeTests(projectId: string, smokeTestIds: readonly string[]): Promise<ProviderActionResult> { return result(await this.bridge.invoke("POST", s26BridgePath("data", "smoke"), { project_id: projectId, smoke_test_ids: smokeTestIds }), "Postgres smoke bridge"); }
}

/** Better Auth is application-hosted; its reviewed admin bridge has named operations only. */
export class BetterAuthOperationsClient implements IdentityOperationsApi, IdentityRecoveryPort {
  protected readonly http: PrivateProviderHttp;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { this.http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: IdentityInspectionRequest): Promise<IdentityInspection> { return inspection(await this.http.invoke("POST", s26BridgePath("identity", "inspect"), { template_set_id: request.templateSetId, site_url: request.siteUrl, redirect_urls: request.redirectUrls, release_compatibility_id: request.releaseCompatibilityId }), "Better Auth inspect"); }
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
  protected readonly bridge: PrivateProviderHttp;
  readonly #direct: PrivateProviderHttp;
  protected readonly capability = "objectStorage" as const;
  readonly #accountId: string;
  constructor(configuration: ProviderHttpConfiguration, bridge: ProviderHttpConfiguration, redactor = new Redactor()) { super(); this.#direct = new PrivateProviderHttp(configuration, redactor); this.bridge = new PrivateProviderHttp(bridge, redactor); if (!configuration.scopeId) throw new OpsError("provider_error", "Cloudflare account scope is required"); this.#accountId = configuration.scopeId; }
  async configurePrivateStorage(request: PrivateStorageRequest): Promise<ProviderActionResult> {
    try {
      const value = result<{ readonly providerRequestId: string }>(await this.#direct.invoke("POST", `/client/v4/accounts/${id(this.#accountId)}/r2/buckets`, { name: request.bucketId }), "R2 bucket");
      return { providerRequestId: value.providerRequestId };
    } catch (error) {
      // A bucket this account already holds is the retried case, not a failure:
      // the step's outcome — the bucket exists — is already true. Bucket
      // existence IS the whole postcondition here, because R2 buckets are
      // private unless a public binding is added.
      //
      // This deliberately does not decide from the create's classification.
      // Cloudflare answers an existing bucket with 409, which the transport reads
      // as `outcome_unknown` — correctly, since a bare status cannot say whether
      // an arbitrary provider applied a mutation. Requiring `provider_error` here
      // therefore made the adopt branch unreachable for the one status that
      // actually means "already there", and step 4 failed on a bucket it had
      // itself created. Keying on the status instead would be almost as brittle:
      // Cloudflare has used both 400 and 409 for error 10004.
      //
      // Instead the authoritative list decides. Re-reading is read-only and safe
      // to repeat after an ambiguous create, and it is what resolves the
      // ambiguity: present means the postcondition holds, absent means the
      // original error stands, unchanged, so a genuine unknown stays unknown.
      if (!(error instanceof OpsError)) throw error;
      let existing;
      try {
        existing = result<{ readonly providerRequestId: string; readonly result?: { readonly buckets?: readonly { readonly name?: string }[] } }>(
          await this.#direct.invoke("GET", `/client/v4/accounts/${id(this.#accountId)}/r2/buckets`),
          "R2 buckets",
        );
      } catch {
        // The confirming read failed too, so it proves nothing. The create's own
        // error is the honest result.
        throw error;
      }
      const found = (existing.result?.buckets ?? []).some((bucket) => bucket.name === request.bucketId);
      if (!found) throw error;
      return { providerRequestId: existing.providerRequestId };
    }
  }
  async runSmokeTests(projectId: string, smokeTestIds: readonly string[]): Promise<ProviderActionResult> { return result(await this.bridge.invoke("POST", s26BridgePath("objectStorage", "smoke"), { project_id: projectId, smoke_test_ids: smokeTestIds, require_private_access_checks: true }), "R2 smoke bridge"); }
}

/** Vercel deployment/configuration client. Every operation maps to one fixed route. */
export class VercelOperationsClient extends BridgeRecoveryClient implements HostingOperationsApi, HostingRecoveryPort {
  protected readonly bridge: PrivateProviderHttp;
  readonly #direct: PrivateProviderHttp;
  protected readonly capability = "hosting" as const;
  readonly #teamId: string;
  constructor(configuration: ProviderHttpConfiguration, bridge: ProviderHttpConfiguration, redactor = new Redactor()) { super(); this.#direct = new PrivateProviderHttp(configuration, redactor); this.bridge = new PrivateProviderHttp(bridge, redactor); if (!configuration.scopeId) throw new OpsError("provider_error", "Vercel team scope is required"); this.#teamId = configuration.scopeId; }
  #projectPath(version: string, handle?: string, suffix = ""): string { return `/v${version}/projects${handle ? `/${id(handle)}` : ""}${suffix}?teamId=${id(this.#teamId)}`; }
  async inspect(request: HostingCapabilityInspectionRequest): Promise<HostingCapabilityInspection> { return inspection(await this.bridge.invoke("POST", s26BridgePath("hosting", "inspect"), { deterministic_name: request.deterministicName, workspace_class: request.workspaceClass, runtime_profile_id: request.runtimeProfileId, required_schedule_count: request.requiredScheduleCount, required_server_value_count: request.requiredServerValueCount, required_public_value_count: request.requiredPublicValueCount, ownership_marker_digest: request.ownership.digest }), "Vercel inspection bridge"); }
  async createDeploymentTarget(request: DeploymentTargetRequest): Promise<DeploymentTargetResult> {
    // Vercel rejects a duplicate project name outright, so without adoption a
    // resumed or re-planned operation can never get past this step again.
    const common = {
      deterministicName: request.deterministicName, workspaceClass: request.workspaceClass,
      runtimeProfileId: request.runtimeProfileId, ownershipMarkerDigest: request.ownership.digest,
      lifecycle: "provisioning" as const, automaticPromotionEnabled: false as const, isolatedPreviewsEnabled: false as const,
    };
    const adopted = await this.#findOwnedTarget(request.deterministicName, request.ownership.digest);
    if (adopted !== undefined) {
      return { hostingRequestId: adopted.providerRequestId, targetHandle: adopted.targetHandle, adopted: true, ...common };
    }
    const value = result<{ readonly providerRequestId: string; readonly id?: string; readonly name?: string }>(await this.#direct.invoke("POST", this.#projectPath("11"), { name: request.deterministicName, previewDeploymentsDisabled: true, environmentVariables: [{ key: "LH2_OWNERSHIP_MARKER_DIGEST", value: request.ownership.digest, type: "plain", target: ["production", "preview"] }] }), "Vercel project");
    if (!value.id || value.name !== request.deterministicName) throw new OpsError("provider_error", "Vercel project response is incomplete");
    const configured = await this.#ensureStagedProduction(value.id);
    return { hostingRequestId: configured, targetHandle: value.id, adopted: false, ...common };
  }
  /**
   * A target is ours only if it carries our ownership marker, which is written
   * as a plain environment value when the project is created. A name match
   * alone is a foreign project and is deliberately not adopted.
   */
  async #findOwnedTarget(
    deterministicName: string,
    ownershipMarkerDigest: string,
  ): Promise<{ readonly targetHandle: string; readonly providerRequestId: string } | undefined> {
    const existing = await absentOr(() => this.#direct.invoke("GET", this.#projectPath("9", deterministicName)));
    if (existing === undefined) return undefined;
    const project = result<{
      readonly providerRequestId: string;
      readonly id?: string;
      readonly autoAssignCustomDomains?: boolean;
    }>(existing, "Vercel project");
    if (!project.id) throw new OpsError("provider_error", "Vercel project response is incomplete");
    const environment = result<{
      readonly envs?: readonly { readonly key?: string; readonly value?: string }[];
    }>(await this.#direct.invoke("GET", this.#projectPath("9", project.id, "/env")), "Vercel project environment");
    const owned = (environment.envs ?? []).some(
      (entry) => entry.key === "LH2_OWNERSHIP_MARKER_DIGEST" && entry.value === ownershipMarkerDigest,
    );
    if (!owned) throw new OpsError("provider_error", "Vercel deterministic name is held by a foreign project");
    return {
      targetHandle: project.id,
      providerRequestId: project.autoAssignCustomDomains === false
        ? project.providerRequestId
        : await this.#ensureStagedProduction(project.id),
    };
  }
  async #ensureStagedProduction(targetHandle: string): Promise<string> {
    // Step 9 creates a production-environment build so it receives the
    // production-only bindings from step 7. Domain auto-assignment must stay
    // off until step 10 explicitly promotes that verified deployment, and the
    // contract does not permit separate preview deployments.
    const configured = result<{
      readonly providerRequestId: string;
      readonly autoAssignCustomDomains?: boolean;
    }>(await this.#direct.invoke(
      "PATCH",
      this.#projectPath("9", targetHandle),
      { autoAssignCustomDomains: false, previewDeploymentsDisabled: true },
    ), "Vercel project configuration");
    if (configured.autoAssignCustomDomains !== false) {
      throw new OpsError("provider_error", "Vercel staged-production configuration was not applied");
    }
    return configured.providerRequestId;
  }
  async bindEnvironment(request: EnvironmentBindingRequest): Promise<EnvironmentBindingResult> {
    if (!request.dataProjectHandle || !request.dataProjectName || !request.ownership) {
      throw new OpsError("invalid_plan", "S26 environment binding requires the owned data project context");
    }
    const bindings: Array<{
      name: string;
      value_class: HostingValueClass;
      source_kind: HostingValueSourceKind;
      source: HostingValueSource;
    }> = request.bindings.map((binding) => ({
      name: binding.name,
      value_class: binding.valueClass,
      source_kind: binding.source.kind,
      source: binding.source,
    }));
    return hostingResult(await this.bridge.invoke("POST", s26BridgePath("hosting", "environment-bind"), {
      target_handle: request.targetHandle,
      data_project_id: request.dataProjectHandle,
      data_project_name: request.dataProjectName,
      ownership_marker_digest: request.ownership.digest,
      scope: request.scope,
      bindings,
    }), "Vercel environment bridge");
  }
  async buildRelease(request: ReleaseBuildRequest): Promise<ReleaseBuildResult> { return hostingResult(await this.bridge.invoke("POST", s26BridgePath("hosting", "build"), { target_handle: request.targetHandle, revision_id: request.revisionId, build_recipe_id: request.buildRecipeId, public_value_names: request.publicValueNames, environment_binding_digest: request.environmentBindingDigest, schedule_manifest_digest: request.scheduleManifestDigest }), "Vercel build bridge"); }
  async assignDomain(request: DomainAssignmentRequest): Promise<DomainAssignmentResult> {
    // A hostname already bound to this same target is the retried case, not a
    // conflict: Vercel answers a second POST with "domain already in use",
    // which would otherwise fail the step for a binding it already has.
    const existing = await absentOr(() => this.#direct.invoke(
      "GET",
      this.#projectPath("10", request.targetHandle, `/domains/${id(request.hostname)}`),
    ));
    const value = result<{ readonly providerRequestId: string; readonly name?: string; readonly verified?: boolean }>(
      existing ?? await this.#direct.invoke("POST", this.#projectPath("10", request.targetHandle, "/domains"), { name: request.hostname }),
      "Vercel domain",
    );
    if (value.name !== request.hostname) throw new OpsError("provider_error", "Vercel domain response is incomplete");
    return { hostingRequestId: value.providerRequestId, targetHandle: request.targetHandle, hostname: request.hostname, assigned: true, certificateReady: value.verified === true, certificateMode: "provider_managed", ownershipMarkerDigest: request.ownership.digest };
  }
  async registerSchedules(request: ScheduleRegistrationRequest): Promise<ScheduleRegistrationResult> { return hostingResult(await this.bridge.invoke("POST", s26BridgePath("hosting", "schedules"), { target_handle: request.targetHandle, release_handle: request.releaseHandle, schedules: request.schedules, manifest_digest: request.manifestDigest }), "Vercel schedules bridge"); }
  async promoteRelease(request: PromotionRequest): Promise<RolloutResult> { return hostingResult(await this.bridge.invoke("POST", s26BridgePath("hosting", "promote"), { target_handle: request.targetHandle, release_handle: request.releaseHandle, expected_hostname: request.hostname }), "Vercel promotion bridge"); }
  async rollbackRelease(request: RollbackRequest): Promise<RolloutResult> { return hostingResult(await this.bridge.invoke("POST", s26BridgePath("hosting", "rollback"), { target_handle: request.targetHandle, release_handle: request.releaseHandle, superseded_release_handle: request.supersededReleaseHandle, reason_code: request.reasonCode }), "Vercel rollback bridge"); }
  async verifyDeployment(request: DeploymentVerificationRequest): Promise<HostingVerificationReport> { return hostingResult(await this.bridge.invoke("POST", s26BridgePath("hosting", "verify"), { target_handle: request.targetHandle, expected_active_release_handle: request.expectedActiveReleaseHandle, expected_revision_id: request.expectedRevisionId, expected_hostname: request.expectedHostname, expected_schedules: request.expectedSchedules, runtime_check_ids: request.runtimeCheckIds }), "Vercel verification bridge"); }
}

export class SmtpEmailOperationsClient implements EmailOperationsApi {
  readonly #http: PrivateProviderHttp;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { this.#http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: SmtpInspectionRequest): Promise<SmtpInspection> { return inspection(await this.#http.invoke("POST", s26BridgePath("smtp", "inspect"), { smtp_profile_id: request.smtpProfileId, sender_domain: request.senderDomain, from_identity: request.fromIdentity, smtp_secret_labels: request.smtpSecretLabels }), "SMTP inspect"); }
  async configure(request: SmtpConfigurationRequest): Promise<ProviderActionResult> { return result(await this.#http.invoke("POST", s26BridgePath("smtp", "configure"), { project_id: request.projectId, smtp_profile_id: request.smtpProfileId, sender_domain: request.senderDomain, from_identity: request.fromIdentity, smtp_secret_labels: request.smtpSecretLabels }), "SMTP configure"); }
  async runSmokeTests(projectId: string, smokeTestIds: readonly string[]): Promise<ProviderActionResult> { return result(await this.#http.invoke("POST", s26BridgePath("smtp", "smoke"), { project_id: projectId, smoke_test_ids: smokeTestIds }), "SMTP smoke"); }
}

export class DomainOperationsClient implements DomainOperationsApi {
  readonly #http: PrivateProviderHttp;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { this.#http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: DomainInspectionRequest): Promise<DomainInspection> { return inspection(await this.#http.invoke("POST", s26BridgePath("domain", "inspect"), { hostname: request.hostname, sender_domain: request.senderDomain, workspace_class: request.workspaceClass }), "Domain inspect"); }
}

/** Read-only source release inspection; no Git mutation or remote request is exposed. */
export class SourceRepositoryOperationsClient implements SourceRepositoryOperationsApi {
  readonly #http: PrivateProviderHttp;
  constructor(configuration: ProviderHttpConfiguration, redactor = new Redactor()) { this.#http = new PrivateProviderHttp(configuration, redactor); }
  async inspect(request: SourceRepositoryInspectionRequest): Promise<SourceRepositoryInspection> { return inspection(await this.#http.invoke("POST", s26BridgePath("sourceRepository", "inspect"), { source_git_sha: request.sourceGitSha, compatibility_entry_id: request.compatibilityEntryId, application_version: request.applicationVersion }), "Source repository inspect"); }
}

export interface S26ConcreteClientConfiguration {
  readonly neon: ProviderHttpConfiguration;
  readonly betterAuth: ProviderHttpConfiguration;
  readonly r2: ProviderHttpConfiguration;
  readonly vercel: ProviderHttpConfiguration;
  readonly smtp: ProviderHttpConfiguration;
  readonly domain: ProviderHttpConfiguration;
  readonly sourceRepository: ProviderHttpConfiguration;
  /**
   * The control-plane bridge transport. Neon, R2 and Vercel each expose a
   * mixture of direct provider routes and bridge routes, so those three clients
   * need both transports rather than one.
   */
  readonly bridge: ProviderHttpConfiguration;
}

/** Builds the only reviewed concrete S26 bundle; it never imports p4c-sdk.ts. */
export function createS26ConcreteApiBundle(
  configuration: S26ConcreteClientConfiguration,
  redactor = new Redactor(),
): S26OperationsApiBundle {
  return {
    data: new NeonPostgresOperationsClient(configuration.neon, configuration.bridge, redactor),
    identity: new BetterAuthOperationsClient(configuration.betterAuth, redactor),
    objectStorage: new CloudflareR2OperationsClient(configuration.r2, configuration.bridge, redactor),
    hosting: new VercelOperationsClient(configuration.vercel, configuration.bridge, redactor),
    email: new SmtpEmailOperationsClient(configuration.smtp, redactor),
    domain: new DomainOperationsClient(configuration.domain, redactor),
    sourceRepository: new SourceRepositoryOperationsClient(configuration.sourceRepository, redactor),
  };
}
