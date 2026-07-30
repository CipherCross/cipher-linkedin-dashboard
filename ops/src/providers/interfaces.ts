export type WorkspaceClass = "internal" | "disposable" | "external";
export type ProviderKind =
  | "supabase"
  | "vercel"
  | "dns"
  | "smtp"
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

export interface VercelProjectRequest {
  readonly teamId: string;
  readonly deterministicName: string;
  readonly ownership: OwnershipMarker;
  readonly gitAutoPromotion: false;
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

export interface ProductionEnvironmentRequest {
  readonly projectId: string;
  readonly tenantSlug: string;
  readonly supabaseProjectId: string;
  readonly secretLabels: readonly string[];
  readonly publicBuildValueNames: readonly (
    | "VITE_SUPABASE_URL"
    | "VITE_SUPABASE_ANON_KEY"
  )[];
  readonly scope: "production_only";
}

export interface DomainBindingRequest {
  readonly projectId: string;
  readonly hostname: string;
  readonly ownership: OwnershipMarker;
}

export interface BuildRequest {
  readonly projectId: string;
  readonly supabaseProjectId: string;
  readonly productionHostname: string;
  readonly sourceGitSha: string;
  readonly publicBuildValueNames: readonly (
    | "VITE_SUPABASE_URL"
    | "VITE_SUPABASE_ANON_KEY"
  )[];
}

export interface BuildResult extends ProviderActionResult {
  readonly buildId: string;
  readonly sourceGitSha: string;
}

export interface DeploymentResult extends ProviderActionResult {
  readonly deploymentId: string;
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

export interface VercelInspectionRequest {
  readonly teamId: string;
  readonly deterministicName: string;
  readonly tierId: string;
  readonly serverlessFunctionCount: number;
  readonly scheduledJobCount: number;
  readonly requiredCronSlots: number;
  readonly ownership: OwnershipMarker;
}

export interface VercelInspection {
  readonly teamAccessible: boolean;
  readonly deterministicNameAvailable: boolean;
  readonly existingResourceOwned: boolean;
  readonly tierAvailable: boolean;
  readonly functionCapacityAvailable: boolean;
  readonly cronCapacityAvailable: boolean;
  readonly productionOnlyEnvironmentSupported: boolean;
  readonly gitAutoPromotionCanBeDisabled: boolean;
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

export interface VercelControlPlanePort {
  inspect(request: VercelInspectionRequest): Promise<VercelInspection>;
  createOrAdoptProject(request: VercelProjectRequest): Promise<ProviderResource>;
  configureProductionEnvironment(
    request: ProductionEnvironmentRequest,
  ): Promise<ProviderActionResult>;
  buildTenant(request: BuildRequest): Promise<BuildResult>;
  deployAndPromote(projectId: string, buildId: string): Promise<DeploymentResult>;
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

export interface DomainControlPlanePort {
  inspect(request: DomainInspectionRequest): Promise<DomainInspection>;
  bindProductionDomain(request: DomainBindingRequest): Promise<ProviderActionResult>;
}

export interface SourceRepositoryReadPort {
  inspect(
    request: SourceRepositoryInspectionRequest,
  ): Promise<SourceRepositoryInspection>;
}

export interface SupabaseProvider extends SupabaseControlPlanePort {}
export interface VercelProvider extends VercelControlPlanePort {}
export interface AuthProvider extends AuthControlPlanePort {}
export interface SmtpProvider extends SmtpControlPlanePort {}
export interface DomainProvider extends DomainControlPlanePort {}
export interface SourceRepositoryProvider extends SourceRepositoryReadPort {}

export interface OnboardingProviders {
  readonly supabase: SupabaseProvider;
  readonly vercel: VercelProvider;
  readonly auth: AuthProvider;
  readonly smtp: SmtpProvider;
  readonly domain: DomainProvider;
  readonly sourceRepository: SourceRepositoryProvider;
}
