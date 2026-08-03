import * as z from "zod/v4";

import { Redactor } from "../core/redaction.js";
import type {
  DeploymentTargetRequest,
  DeploymentTargetResult,
  DeploymentVerificationRequest,
  DomainAssignmentRequest,
  DomainAssignmentResult,
  EnvironmentBindingRequest,
  EnvironmentBindingResult,
  HostingCapabilityInspection,
  HostingCapabilityInspectionRequest,
  HostingControlPlanePort,
  HostingProvider,
  HostingVerificationReport,
  PromotionRequest,
  ReleaseBuildRequest,
  ReleaseBuildResult,
  RollbackRequest,
  RolloutResult,
  ScheduleRegistrationRequest,
  ScheduleRegistrationResult,
} from "./hosting.js";
import type {
  AuthConfigurationRequest,
  AuthControlPlanePort,
  AuthInspection,
  AuthInspectionRequest,
  AuthProvider,
  CompanyAdminRequest,
  DomainControlPlanePort,
  DomainInspection,
  DomainInspectionRequest,
  DomainProvider,
  PrivateStorageRequest,
  ProviderActionResult,
  ProviderResource,
  SmtpConfigurationRequest,
  SmtpControlPlanePort,
  SmtpInspection,
  SmtpInspectionRequest,
  SmtpProvider,
  SourceRepositoryInspection,
  SourceRepositoryInspectionRequest,
  SourceRepositoryProvider,
  SourceRepositoryReadPort,
  SupabaseControlPlanePort,
  SupabaseInspection,
  SupabaseInspectionRequest,
  SupabaseProjectRequest,
  SupabaseProvider,
  TenantSchemaRequest,
} from "./interfaces.js";

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:@/-]+$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const requestResult = z.strictObject({ providerRequestId: identifier });
const resourceResult = requestResult.extend({
  providerOwnerId: identifier,
  resourceId: identifier,
  deterministicName: z.string().min(1).max(200),
  ownershipMarkerDigest: digest,
  lifecycle: identifier,
  adopted: z.boolean(),
});

/* ------------------------------------------------------------------ *
 * Canonical hosting result schemas
 *
 * `strictObject` is the enforcement of `HOSTING_RESULT_SHAPES`: a hosting
 * adapter that returned an extra field — a project ID, a deployment ID, an SDK
 * object — would be rejected here rather than reaching the registry. A test
 * asserts these key sets equal `HOSTING_RESULT_SHAPES` in both directions, so
 * the schema and the contract cannot drift apart.
 * ------------------------------------------------------------------ */

/** Opaque, adapter-issued handles and correlation IDs. Never a provider resource ID. */
const opaqueHandle = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:@/_-]+$/);
const valueName = z.string().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const hostingRequestResult = z.strictObject({ hostingRequestId: opaqueHandle });
const hostingSchedule = z.strictObject({
  scheduleId: z.string().min(1).max(120),
  method: z.literal("GET"),
  routePath: z.string().min(1).max(200),
  queryParameters: z.record(z.string(), z.string()),
  expression: z.string().min(1).max(120),
  expressionFormat: z.literal("cron5"),
  timezone: z.literal("UTC"),
});
const hostingInspection = z.strictObject({
  controlPlaneAccessible: z.boolean(),
  deterministicNameAvailable: z.boolean(),
  existingTargetOwned: z.boolean(),
  runtimeProfileAvailable: z.boolean(),
  serverValueBindingSupported: z.boolean(),
  publicValueBindingSupported: z.boolean(),
  pinnedRevisionBuildSupported: z.boolean(),
  customDomainSupported: z.boolean(),
  scheduleCapacityAvailable: z.boolean(),
  rollbackSupported: z.boolean(),
  automaticPromotionCanBeDisabled: z.boolean(),
  isolatedPreviewsSupported: z.boolean(),
  validUntil: timestamp,
});
const deploymentTargetResult = hostingRequestResult.extend({
  targetHandle: opaqueHandle,
  deterministicName: z.string().min(1).max(200),
  workspaceClass: z.enum(["internal", "disposable", "external"]),
  runtimeProfileId: identifier,
  ownershipMarkerDigest: digest,
  lifecycle: z.enum(["provisioning", "ready", "degraded"]),
  adopted: z.boolean(),
  automaticPromotionEnabled: z.literal(false),
  isolatedPreviewsEnabled: z.literal(false),
});
const environmentBindingResult = hostingRequestResult.extend({
  targetHandle: opaqueHandle,
  scope: z.literal("production"),
  bindings: z.array(
    z.strictObject({
      name: valueName,
      valueClass: z.enum(["server_secret", "server_public", "public_build"]),
      sourceKind: z.enum([
        "secret_label",
        "generated_secret",
        "derived_from_plan",
      ]),
    }),
  ),
  bindingDigest: digest,
});
const releaseBuildResult = hostingRequestResult.extend({
  releaseHandle: opaqueHandle,
  targetHandle: opaqueHandle,
  revisionId: z.string().regex(/^[0-9a-f]{40}$/),
  revisionPinned: z.literal(true),
  buildRecipeId: identifier,
  publicValueNames: z.array(valueName),
  scheduleManifestDigest: digest,
  artifactDigest: digest,
  status: z.literal("verified"),
});
const domainAssignmentResult = hostingRequestResult.extend({
  targetHandle: opaqueHandle,
  hostname: z.string().min(1).max(253),
  assigned: z.literal(true),
  certificateReady: z.boolean(),
  certificateMode: z.literal("provider_managed"),
  ownershipMarkerDigest: digest,
});
const scheduleRegistrationResult = hostingRequestResult.extend({
  targetHandle: opaqueHandle,
  releaseHandle: opaqueHandle,
  registered: z.array(hostingSchedule),
  manifestDigest: digest,
});
const rolloutResult = hostingRequestResult.extend({
  targetHandle: opaqueHandle,
  rolloutHandle: opaqueHandle,
  rolloutKind: z.enum(["promote", "rollback"]),
  activeReleaseHandle: opaqueHandle,
  previousReleaseHandle: opaqueHandle.nullable(),
  rolloutSequence: z.number().int().nonnegative(),
  reasonCode: identifier.nullable(),
});
const verificationReport = hostingRequestResult.extend({
  targetHandle: opaqueHandle,
  status: z.enum(["passed", "failed"]),
  runtime: z.strictObject({
    reachable: z.boolean(),
    activeReleaseHandle: opaqueHandle.nullable(),
    activeReleaseMatchesExpected: z.boolean(),
    passedCheckIds: z.array(identifier),
    failedCheckIds: z.array(identifier),
  }),
  schedules: z.strictObject({
    registered: z.array(hostingSchedule),
    expectedScheduleIds: z.array(z.string().min(1).max(120)),
    missingScheduleIds: z.array(z.string().min(1).max(120)),
    unexpectedScheduleIds: z.array(z.string().min(1).max(120)),
    manifestDigest: digest.nullable(),
    manifestMatchesRelease: z.boolean(),
  }),
  domain: z.strictObject({
    hostname: z.string().min(1).max(253).nullable(),
    assigned: z.boolean(),
    certificateReady: z.boolean(),
    matchesExpected: z.boolean(),
    servesActiveRelease: z.boolean(),
  }),
  build: z.strictObject({
    releaseHandle: opaqueHandle.nullable(),
    revisionId: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    revisionPinned: z.boolean(),
    revisionMatchesExpected: z.boolean(),
    buildRecipeId: identifier.nullable(),
    artifactDigest: digest.nullable(),
    publicValueNames: z.array(valueName),
    scheduleManifestDigest: digest.nullable(),
  }),
  rollout: z.strictObject({
    rolloutKind: z.enum(["promote", "rollback"]).nullable(),
    rolloutSequence: z.number().int().nonnegative(),
    previousReleaseHandle: opaqueHandle.nullable(),
  }),
});

/** Exposed so a test can assert the schema key sets equal `HOSTING_RESULT_SHAPES`. */
export const HOSTING_RESULT_SCHEMAS = {
  inspect: hostingInspection,
  createDeploymentTarget: deploymentTargetResult,
  bindEnvironment: environmentBindingResult,
  buildRelease: releaseBuildResult,
  assignDomain: domainAssignmentResult,
  registerSchedules: scheduleRegistrationResult,
  promoteRelease: rolloutResult,
  rollbackRelease: rolloutResult,
  verifyDeployment: verificationReport,
} as const;

const supabaseInspection = z.strictObject({
  organizationAccessible: z.boolean(),
  deterministicNameAvailable: z.boolean(),
  existingResourceOwned: z.boolean(),
  regionAvailable: z.boolean(),
  tierAvailable: z.boolean(),
  computeAvailable: z.boolean(),
  backupCompatible: z.boolean(),
  authConfigurationSupported: z.boolean(),
  validUntil: timestamp,
});
const authInspection = z.strictObject({
  templateSetApproved: z.boolean(),
  productionUrlsValid: z.boolean(),
  inviteFlowSupported: z.boolean(),
  releaseCompatible: z.boolean(),
  validUntil: timestamp,
});
const smtpInspection = z.strictObject({
  providerAccessible: z.boolean(),
  customSmtp: z.boolean(),
  senderIdentityVerified: z.boolean(),
  credentialsAvailable: z.boolean(),
  validUntil: timestamp,
});
const domainInspection = z.strictObject({
  zoneOwned: z.boolean(),
  hostnameAvailable: z.boolean(),
  existingBindingOwned: z.boolean(),
  senderDomainVerified: z.boolean(),
  legalReviewApproved: z.boolean(),
  validUntil: timestamp,
});
const sourceInspection = z.strictObject({
  revisionPresent: z.boolean(),
  releaseCompatible: z.boolean(),
  artifactPinned: z.boolean(),
  validUntil: timestamp,
});

abstract class StrictAdapter {
  readonly redactor: Redactor;

  constructor(redactor = new Redactor()) {
    this.redactor = redactor;
  }

  protected async call<T>(
    label: string,
    action: () => Promise<unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      const raw = await action();
      this.redactor.assertSecretFree(raw, `${label} provider response`);
      return schema.parse(raw);
    } catch (error) {
      throw this.redactor.sanitizeError(error);
    }
  }
}

export class StrictSupabaseAdapter
  extends StrictAdapter
  implements SupabaseProvider
{
  readonly #port: SupabaseControlPlanePort;

  constructor(port: SupabaseControlPlanePort, redactor = new Redactor()) {
    super(redactor);
    this.#port = port;
  }

  inspect(request: SupabaseInspectionRequest): Promise<SupabaseInspection> {
    return this.call("supabase.inspect", () => this.#port.inspect(request), supabaseInspection);
  }

  createOrAdoptProject(request: SupabaseProjectRequest): Promise<ProviderResource> {
    return this.call(
      "supabase.createOrAdoptProject",
      () => this.#port.createOrAdoptProject(request),
      resourceResult,
    );
  }

  waitUntilReady(projectId: string): Promise<ProviderActionResult> {
    return this.call(
      "supabase.waitUntilReady",
      () => this.#port.waitUntilReady(projectId),
      requestResult,
    );
  }

  applySchema(request: TenantSchemaRequest): Promise<ProviderActionResult> {
    return this.call(
      "supabase.applySchema",
      () => this.#port.applySchema(request),
      requestResult,
    );
  }

  configurePrivateStorage(request: PrivateStorageRequest): Promise<ProviderActionResult> {
    return this.call(
      "supabase.configurePrivateStorage",
      () => this.#port.configurePrivateStorage(request),
      requestResult,
    );
  }

  runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return this.call(
      "supabase.runSmokeTests",
      () => this.#port.runSmokeTests(projectId, smokeTestIds),
      requestResult,
    );
  }
}

/**
 * The canonical hosting boundary. Every result is parsed against the strict
 * schema above before it can reach the executor or the registry, so an adapter
 * that leaked a provider identifier or an SDK object fails closed here.
 */
export class StrictHostingAdapter extends StrictAdapter implements HostingProvider {
  readonly #port: HostingControlPlanePort;

  constructor(port: HostingControlPlanePort, redactor = new Redactor()) {
    super(redactor);
    this.#port = port;
  }

  inspect(
    request: HostingCapabilityInspectionRequest,
  ): Promise<HostingCapabilityInspection> {
    return this.call(
      "hosting.inspect",
      () => this.#port.inspect(request),
      hostingInspection,
    );
  }

  createDeploymentTarget(
    request: DeploymentTargetRequest,
  ): Promise<DeploymentTargetResult> {
    return this.call(
      "hosting.createDeploymentTarget",
      () => this.#port.createDeploymentTarget(request),
      deploymentTargetResult,
    );
  }

  bindEnvironment(
    request: EnvironmentBindingRequest,
  ): Promise<EnvironmentBindingResult> {
    return this.call(
      "hosting.bindEnvironment",
      () => this.#port.bindEnvironment(request),
      environmentBindingResult,
    );
  }

  buildRelease(request: ReleaseBuildRequest): Promise<ReleaseBuildResult> {
    return this.call(
      "hosting.buildRelease",
      () => this.#port.buildRelease(request),
      releaseBuildResult,
    );
  }

  assignDomain(
    request: DomainAssignmentRequest,
  ): Promise<DomainAssignmentResult> {
    return this.call(
      "hosting.assignDomain",
      () => this.#port.assignDomain(request),
      domainAssignmentResult,
    );
  }

  registerSchedules(
    request: ScheduleRegistrationRequest,
  ): Promise<ScheduleRegistrationResult> {
    return this.call(
      "hosting.registerSchedules",
      () => this.#port.registerSchedules(request),
      scheduleRegistrationResult,
    );
  }

  promoteRelease(request: PromotionRequest): Promise<RolloutResult> {
    return this.call(
      "hosting.promoteRelease",
      () => this.#port.promoteRelease(request),
      rolloutResult,
    );
  }

  rollbackRelease(request: RollbackRequest): Promise<RolloutResult> {
    return this.call(
      "hosting.rollbackRelease",
      () => this.#port.rollbackRelease(request),
      rolloutResult,
    );
  }

  verifyDeployment(
    request: DeploymentVerificationRequest,
  ): Promise<HostingVerificationReport> {
    return this.call(
      "hosting.verifyDeployment",
      () => this.#port.verifyDeployment(request),
      verificationReport,
    );
  }
}

export class StrictAuthAdapter extends StrictAdapter implements AuthProvider {
  readonly #port: AuthControlPlanePort;

  constructor(port: AuthControlPlanePort, redactor = new Redactor()) {
    super(redactor);
    this.#port = port;
  }

  inspect(request: AuthInspectionRequest): Promise<AuthInspection> {
    return this.call("auth.inspect", () => this.#port.inspect(request), authInspection);
  }

  configure(request: AuthConfigurationRequest): Promise<ProviderActionResult> {
    return this.call("auth.configure", () => this.#port.configure(request), requestResult);
  }

  createDisabledSupportMembership(projectId: string): Promise<ProviderActionResult> {
    return this.call(
      "auth.createDisabledSupportMembership",
      () => this.#port.createDisabledSupportMembership(projectId),
      requestResult,
    );
  }

  createCompanyAdminAndInvite(
    request: CompanyAdminRequest,
  ): Promise<ProviderActionResult> {
    return this.call(
      "auth.createCompanyAdminAndInvite",
      () => this.#port.createCompanyAdminAndInvite(request),
      requestResult,
    );
  }

  runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return this.call(
      "auth.runSmokeTests",
      () => this.#port.runSmokeTests(projectId, smokeTestIds),
      requestResult,
    );
  }
}

export class StrictSmtpAdapter extends StrictAdapter implements SmtpProvider {
  readonly #port: SmtpControlPlanePort;

  constructor(port: SmtpControlPlanePort, redactor = new Redactor()) {
    super(redactor);
    this.#port = port;
  }

  inspect(request: SmtpInspectionRequest): Promise<SmtpInspection> {
    return this.call("smtp.inspect", () => this.#port.inspect(request), smtpInspection);
  }

  configure(request: SmtpConfigurationRequest): Promise<ProviderActionResult> {
    return this.call("smtp.configure", () => this.#port.configure(request), requestResult);
  }

  runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return this.call(
      "smtp.runSmokeTests",
      () => this.#port.runSmokeTests(projectId, smokeTestIds),
      requestResult,
    );
  }
}

export class StrictDomainAdapter extends StrictAdapter implements DomainProvider {
  readonly #port: DomainControlPlanePort;

  constructor(port: DomainControlPlanePort, redactor = new Redactor()) {
    super(redactor);
    this.#port = port;
  }

  inspect(request: DomainInspectionRequest): Promise<DomainInspection> {
    return this.call("domain.inspect", () => this.#port.inspect(request), domainInspection);
  }
}

export class StrictSourceRepositoryAdapter
  extends StrictAdapter
  implements SourceRepositoryProvider
{
  readonly #port: SourceRepositoryReadPort;

  constructor(port: SourceRepositoryReadPort, redactor = new Redactor()) {
    super(redactor);
    this.#port = port;
  }

  inspect(
    request: SourceRepositoryInspectionRequest,
  ): Promise<SourceRepositoryInspection> {
    return this.call(
      "sourceRepository.inspect",
      () => this.#port.inspect(request),
      sourceInspection,
    );
  }
}
