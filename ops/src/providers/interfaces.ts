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

export interface SupabaseProjectRequest {
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
}

export interface SupabaseInspectionRequest {
  readonly organizationId: string;
  readonly deterministicName: string;
  readonly regionId: string;
  readonly tierId: string;
  readonly computeId: string;
  readonly backupProfileId: string;
  readonly ownership: OwnershipMarker;
}

export interface SupabaseInspection {
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

export interface AuthInspectionRequest {
  readonly templateSetId: string;
  readonly siteUrl: string;
  readonly redirectUrls: readonly string[];
  readonly releaseCompatibilityId: string;
}

export interface AuthInspection {
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
export interface SupabaseControlPlanePort {
  inspect(request: SupabaseInspectionRequest): Promise<SupabaseInspection>;
  createOrAdoptProject(request: SupabaseProjectRequest): Promise<ProviderResource>;
  waitUntilReady(projectId: string): Promise<ProviderActionResult>;
  applySchema(request: TenantSchemaRequest): Promise<ProviderActionResult>;
  configurePrivateStorage(request: PrivateStorageRequest): Promise<ProviderActionResult>;
  runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult>;
}

export interface AuthControlPlanePort {
  inspect(request: AuthInspectionRequest): Promise<AuthInspection>;
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

export interface SupabaseProvider extends SupabaseControlPlanePort {}
export interface AuthProvider extends AuthControlPlanePort {}
export interface SmtpProvider extends SmtpControlPlanePort {}
export interface DomainProvider extends DomainControlPlanePort {}
export interface SourceRepositoryProvider extends SourceRepositoryReadPort {}

export interface OnboardingProviders {
  /** Data-plane capability; the concrete implementation may be Neon. */
  readonly data: SupabaseProvider;
  /** Identity capability; the concrete implementation may be Better Auth. */
  readonly identity: AuthProvider;
  /** Object capability; the concrete implementation may be Cloudflare R2. */
  readonly objectStorage: SupabaseProvider;
  /**
   * The canonical hosting capability port. Any adapter satisfying it —
   * the in-memory fake or the concrete Vercel adapter — drives the same plan
   * to the same canonical results.
   */
  readonly hosting: HostingProvider;
  /** Email delivery capability, independent of SMTP vendor. */
  readonly email: SmtpProvider;
  readonly domain: DomainProvider;
  readonly sourceRepository: SourceRepositoryProvider;
}
