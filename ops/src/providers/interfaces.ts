import type { HostingProvider } from "./hosting.js";

export type WorkspaceClass = "internal" | "disposable" | "external";
export type ProviderKind =
  | "data"
  | "identity"
  | "object_storage"
  | "hosting"
  | "domain"
  | "email"
  | "source_repository";

export interface OwnershipMarker {
  readonly managedBy: "lh2-platform-ops";
  readonly tenantSlug: string;
  readonly workspaceClass: WorkspaceClass;
  readonly contractVersion: "p2.v1";
  readonly registryOwnerId: string;
  readonly digest: string;
}

export interface ProviderResource {
  readonly providerRequestId: string;
  readonly providerOwnerId: string;
  readonly resourceId: string;
  readonly deterministicName: string;
  readonly ownershipMarkerDigest: string;
  readonly lifecycle: string;
  readonly adopted: boolean;
}

export interface ProviderActionResult {
  readonly providerRequestId: string;
}

export interface DataProjectRequest {
  readonly organizationId: string;
  readonly deterministicName: string;
  readonly regionId: string;
  readonly tierId: string;
  readonly computeId: string;
  readonly ownership: OwnershipMarker;
}

export interface TenantSchemaRequest {
  readonly projectId: string;
  readonly baselineVersion: 53;
  readonly migrationVersions: readonly number[];
  readonly targetSchemaVersion: number;
}

export interface PrivateStorageRequest {
  readonly projectId: string;
  readonly bucketId: "lead-photos";
  readonly visibility: "private";
}

export interface AuthConfigurationRequest {
  readonly projectId: string;
  readonly siteUrl: string;
  readonly redirectUrls: readonly string[];
  readonly templateSetId: string;
}

export interface SmtpConfigurationRequest {
  readonly projectId: string;
  readonly smtpProfileId: string;
  readonly senderDomain: string;
  readonly fromIdentity: string;
  readonly smtpSecretLabels: readonly string[];
}

export interface CompanyAdminRequest {
  readonly projectId: string;
  readonly adminEmail: string;
  /**
   * The tenant's own origin, from the plan's `auth_smtp.site_url`. The invite
   * names the dashboard the recipient must open, so it cannot come from a
   * control-plane-wide setting: one global value is right for at most one
   * tenant, and wrong — undetectably — for every other.
   */
  readonly siteUrl: string;
}

export interface DataInspectionRequest {
  readonly organizationId: string;
  readonly deterministicName: string;
  readonly regionId: string;
  readonly tierId: string;
  readonly computeId: string;
  readonly backupProfileId: string;
  readonly ownership: OwnershipMarker;
}

export interface DataInspection {
  readonly organizationAccessible: boolean;
  readonly deterministicNameAvailable: boolean;
  readonly existingResourceOwned: boolean;
  readonly regionAvailable: boolean;
  readonly tierAvailable: boolean;
  readonly computeAvailable: boolean;
  readonly backupCompatible: boolean;
  readonly authConfigurationSupported: boolean;
  readonly validUntil: string;
}

export interface IdentityInspectionRequest {
  readonly templateSetId: string;
  readonly siteUrl: string;
  readonly redirectUrls: readonly string[];
  readonly releaseCompatibilityId: string;
}

export interface IdentityInspection {
  readonly templateSetApproved: boolean;
  readonly productionUrlsValid: boolean;
  readonly inviteFlowSupported: boolean;
  readonly releaseCompatible: boolean;
  readonly validUntil: string;
}

export interface SmtpInspectionRequest {
  readonly smtpProfileId: string;
  readonly senderDomain: string;
  readonly fromIdentity: string;
  readonly smtpSecretLabels: readonly string[];
}

export interface SmtpInspection {
  readonly providerAccessible: boolean;
  readonly customSmtp: boolean;
  readonly senderIdentityVerified: boolean;
  readonly credentialsAvailable: boolean;
  readonly validUntil: string;
}

export interface DomainInspectionRequest {
  readonly hostname: string;
  readonly senderDomain: string;
  readonly workspaceClass: WorkspaceClass;
}

export interface DomainInspection {
  readonly zoneOwned: boolean;
  readonly hostnameAvailable: boolean;
  readonly existingBindingOwned: boolean;
  readonly senderDomainVerified: boolean;
  readonly legalReviewApproved: boolean;
  readonly validUntil: string;
}

export interface SourceRepositoryInspectionRequest {
  readonly sourceGitSha: string;
  readonly compatibilityEntryId: string;
  readonly applicationVersion: string;
}

export interface SourceRepositoryInspection {
  readonly revisionPresent: boolean;
  readonly releaseCompatible: boolean;
  readonly artifactPinned: boolean;
  readonly validUntil: string;
}

/**
 * These ports are deliberately narrower than an SDK or HTTP client. A later
 * runtime may implement them with reviewed provider SDK calls, but no arbitrary
 * request, URL, payload, command, query, DNS record, or environment operation can
 * cross this boundary.
 */
export interface DataControlPlanePort {
  inspect(request: DataInspectionRequest): Promise<DataInspection>;
  createOrAdoptProject(request: DataProjectRequest): Promise<ProviderResource>;
  waitUntilReady(projectId: string): Promise<ProviderActionResult>;
  applySchema(request: TenantSchemaRequest): Promise<ProviderActionResult>;
  runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult>;
}

export interface IdentityControlPlanePort {
  inspect(request: IdentityInspectionRequest): Promise<IdentityInspection>;
  configure(request: AuthConfigurationRequest): Promise<ProviderActionResult>;
  createDisabledSupportMembership(projectId: string): Promise<ProviderActionResult>;
  createCompanyAdminAndInvite(
    request: CompanyAdminRequest,
  ): Promise<ProviderActionResult>;
  runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult>;
}

export interface SmtpControlPlanePort {
  inspect(request: SmtpInspectionRequest): Promise<SmtpInspection>;
  configure(request: SmtpConfigurationRequest): Promise<ProviderActionResult>;
  runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult>;
}

/**
 * Zone authority only. Attaching a hostname to a deployment target is an
 * operation the *hosting* control plane performs, so the binding lives on
 * `HostingControlPlanePort.assignDomain`; what stays here is the zone
 * preflight — ownership, availability and sender-domain verification.
 */
export interface DomainControlPlanePort {
  inspect(request: DomainInspectionRequest): Promise<DomainInspection>;
}

export interface SourceRepositoryReadPort {
  inspect(
    request: SourceRepositoryInspectionRequest,
  ): Promise<SourceRepositoryInspection>;
}

export interface ObjectStorageControlPlanePort {
  configurePrivateStorage(request: PrivateStorageRequest): Promise<ProviderActionResult>;
  runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult>;
}

/**
 * Recovery is deliberately a second, narrow capability surface.  It is not a
 * generic export/import escape hatch: every artifact is an opaque provider
 * reference plus a checksum/count manifest, and the only permitted restore is
 * into the reviewed disposable recovery target.
 */
export type RecoveryCoverage =
  | "database_schema_data"
  | "auth_configuration_identities"
  | "storage_metadata"
  | "private_storage_objects_or_reconstruction"
  | "deployment_configuration_metadata";

export interface RecoveryCaptureRequest {
  readonly tenantSlug: string;
  readonly sourceResourceId: string;
  readonly recoveryTargetName: string;
  readonly ownership: OwnershipMarker;
}

export interface RecoveryArtifact {
  readonly providerRequestId: string;
  readonly artifactId: string;
  readonly manifestDigest: string;
  /**
   * The same deterministic ownership marker required for creation/adoption.
   * A recovery artifact cannot be replayed into another tenant merely because
   * it has a valid checksum.
   */
  readonly ownershipMarkerDigest: string;
  readonly coverage: readonly RecoveryCoverage[];
  readonly itemCount: number;
  readonly capturedAt: string;
  /** Object bytes may be reconstructed only through a plan-approved source. */
  readonly reconstructionApproved: boolean;
}

export interface RecoveryRestoreRequest {
  readonly tenantSlug: string;
  readonly targetResourceId: string;
  readonly artifact: RecoveryArtifact;
  readonly ownership: OwnershipMarker;
}

export interface RecoveryVerification {
  readonly providerRequestId: string;
  readonly coverage: readonly RecoveryCoverage[];
  readonly passed: boolean;
  readonly checkedAt: string;
}

export interface DataRecoveryPort {
  captureRecovery(request: RecoveryCaptureRequest): Promise<RecoveryArtifact>;
  restoreRecovery(request: RecoveryRestoreRequest): Promise<ProviderActionResult>;
  verifyRecovery(request: RecoveryRestoreRequest): Promise<RecoveryVerification>;
}

export interface IdentityRecoveryPort {
  captureRecovery(request: RecoveryCaptureRequest): Promise<RecoveryArtifact>;
  restoreRecovery(request: RecoveryRestoreRequest): Promise<ProviderActionResult>;
  verifyRecovery(request: RecoveryRestoreRequest): Promise<RecoveryVerification>;
}

export interface ObjectStorageRecoveryPort {
  captureRecovery(request: RecoveryCaptureRequest): Promise<RecoveryArtifact>;
  restoreRecovery(request: RecoveryRestoreRequest): Promise<ProviderActionResult>;
  verifyRecovery(request: RecoveryRestoreRequest): Promise<RecoveryVerification>;
}

export interface HostingRecoveryPort {
  captureRecovery(request: RecoveryCaptureRequest): Promise<RecoveryArtifact>;
  restoreRecovery(request: RecoveryRestoreRequest): Promise<ProviderActionResult>;
  verifyRecovery(request: RecoveryRestoreRequest): Promise<RecoveryVerification>;
}

export interface TenantRecoveryProviders {
  readonly data: DataRecoveryPort;
  readonly identity: IdentityRecoveryPort;
  readonly objectStorage: ObjectStorageRecoveryPort;
  readonly hosting: HostingRecoveryPort;
}

export interface DataProvider extends DataControlPlanePort {}
export interface IdentityProvider extends IdentityControlPlanePort {}
export interface ObjectStorageProvider extends ObjectStorageControlPlanePort {}
export interface EmailProvider extends SmtpControlPlanePort {}
export interface SmtpProvider extends SmtpControlPlanePort {}
export interface DomainProvider extends DomainControlPlanePort {}
export interface SourceRepositoryProvider extends SourceRepositoryReadPort {}

/** Legacy P4-C names remain source-compatible while callers migrate to the
 * capability vocabulary. They do not define an additional runtime path. */
/** @deprecated use DataProjectRequest */
export type SupabaseProjectRequest = DataProjectRequest;
/** @deprecated use DataInspectionRequest */
export type SupabaseInspectionRequest = DataInspectionRequest;
/** @deprecated use DataInspection */
export type SupabaseInspection = DataInspection;
/** @deprecated use IdentityInspectionRequest */
export type AuthInspectionRequest = IdentityInspectionRequest;
/** @deprecated use IdentityInspection */
export type AuthInspection = IdentityInspection;
/** @deprecated use DataControlPlanePort */
export interface SupabaseControlPlanePort extends DataControlPlanePort {
  configurePrivateStorage(request: PrivateStorageRequest): Promise<ProviderActionResult>;
}
/** @deprecated use IdentityControlPlanePort */
export interface AuthControlPlanePort extends IdentityControlPlanePort {}
/** @deprecated use DataProvider */
export interface SupabaseProvider extends SupabaseControlPlanePort {}
/** @deprecated use IdentityProvider */
export interface AuthProvider extends AuthControlPlanePort {}

export interface OnboardingProviders {
  /** Data-plane capability; the production adapter is Neon-backed. */
  readonly data: DataProvider;
  /** Identity capability; the production adapter is provider-neutral. */
  readonly identity: IdentityProvider;
  /** Object capability; the production adapter is S3-compatible/R2-backed. */
  readonly objectStorage: ObjectStorageProvider;
  /**
   * The canonical hosting capability port. Any adapter satisfying it —
   * the in-memory fake or the concrete Vercel adapter — drives the same plan
   * to the same canonical results.
   */
  readonly hosting: HostingProvider;
  /** Email delivery capability, independent of SMTP vendor. */
  readonly email: EmailProvider;
  readonly domain: DomainProvider;
  readonly sourceRepository: SourceRepositoryProvider;
}
