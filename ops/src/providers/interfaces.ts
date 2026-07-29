export interface OwnershipMarker {
  readonly managedBy: "lh2-platform-ops";
  readonly tenantSlug: string;
  readonly workspaceClass: "internal" | "disposable" | "external";
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

export interface AuthStorageRequest {
  readonly projectId: string;
  readonly siteUrl: string;
  readonly redirectUrls: readonly string[];
  readonly smtpProfileId: string;
  readonly smtpSecretLabels: readonly string[];
}

export interface ProductionEnvironmentRequest {
  readonly projectId: string;
  readonly secretLabels: readonly string[];
  readonly publicBuildValueNames: readonly ("VITE_SUPABASE_URL" | "VITE_SUPABASE_ANON_KEY")[];
  readonly scope: "production_only";
}

export interface BuildRequest {
  readonly projectId: string;
  readonly sourceGitSha: string;
  readonly publicBuildValueNames: readonly ("VITE_SUPABASE_URL" | "VITE_SUPABASE_ANON_KEY")[];
}

export interface ProviderActionResult {
  readonly providerRequestId: string;
}

export interface BuildResult extends ProviderActionResult {
  readonly buildId: string;
  readonly sourceGitSha: string;
}

export interface DeploymentResult extends ProviderActionResult {
  readonly deploymentId: string;
}

export interface SupabaseProvider {
  createOrAdoptProject(request: SupabaseProjectRequest): Promise<ProviderResource>;
  waitUntilReady(projectId: string): Promise<ProviderActionResult>;
  applySchema(request: TenantSchemaRequest): Promise<ProviderActionResult>;
  configurePrivateStorageAuthSmtp(
    request: AuthStorageRequest,
  ): Promise<ProviderActionResult>;
  createDisabledSupportMembership(projectId: string): Promise<ProviderActionResult>;
  runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult>;
  inviteCompanyAdmin(projectId: string, adminEmail: string): Promise<ProviderActionResult>;
}

export interface VercelProvider {
  createOrAdoptProject(request: VercelProjectRequest): Promise<ProviderResource>;
  configureProductionEnvironment(
    request: ProductionEnvironmentRequest,
  ): Promise<ProviderActionResult>;
  bindProductionDomain(projectId: string, hostname: string): Promise<ProviderActionResult>;
  buildTenant(request: BuildRequest): Promise<BuildResult>;
  deployAndPromote(projectId: string, buildId: string): Promise<DeploymentResult>;
  runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult>;
}
