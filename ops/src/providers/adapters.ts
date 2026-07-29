import * as z from "zod/v4";

import { Redactor } from "../core/redaction.js";
import type {
  AuthConfigurationRequest,
  AuthControlPlanePort,
  AuthInspection,
  AuthInspectionRequest,
  AuthProvider,
  BuildRequest,
  BuildResult,
  CompanyAdminRequest,
  DeploymentResult,
  DomainBindingRequest,
  DomainControlPlanePort,
  DomainInspection,
  DomainInspectionRequest,
  DomainProvider,
  PrivateStorageRequest,
  ProductionEnvironmentRequest,
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
  VercelControlPlanePort,
  VercelInspection,
  VercelInspectionRequest,
  VercelProjectRequest,
  VercelProvider,
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
const buildResult = requestResult.extend({
  buildId: identifier,
  sourceGitSha: z.string().regex(/^[0-9a-f]{40}$/),
});
const deploymentResult = requestResult.extend({ deploymentId: identifier });
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
const vercelInspection = z.strictObject({
  teamAccessible: z.boolean(),
  deterministicNameAvailable: z.boolean(),
  existingResourceOwned: z.boolean(),
  tierAvailable: z.boolean(),
  functionCapacityAvailable: z.boolean(),
  cronCapacityAvailable: z.boolean(),
  productionOnlyEnvironmentSupported: z.boolean(),
  gitAutoPromotionCanBeDisabled: z.boolean(),
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

export class StrictVercelAdapter extends StrictAdapter implements VercelProvider {
  readonly #port: VercelControlPlanePort;

  constructor(port: VercelControlPlanePort, redactor = new Redactor()) {
    super(redactor);
    this.#port = port;
  }

  inspect(request: VercelInspectionRequest): Promise<VercelInspection> {
    return this.call("vercel.inspect", () => this.#port.inspect(request), vercelInspection);
  }

  createOrAdoptProject(request: VercelProjectRequest): Promise<ProviderResource> {
    return this.call(
      "vercel.createOrAdoptProject",
      () => this.#port.createOrAdoptProject(request),
      resourceResult,
    );
  }

  configureProductionEnvironment(
    request: ProductionEnvironmentRequest,
  ): Promise<ProviderActionResult> {
    return this.call(
      "vercel.configureProductionEnvironment",
      () => this.#port.configureProductionEnvironment(request),
      requestResult,
    );
  }

  buildTenant(request: BuildRequest): Promise<BuildResult> {
    return this.call(
      "vercel.buildTenant",
      () => this.#port.buildTenant(request),
      buildResult,
    );
  }

  deployAndPromote(projectId: string, buildId: string): Promise<DeploymentResult> {
    return this.call(
      "vercel.deployAndPromote",
      () => this.#port.deployAndPromote(projectId, buildId),
      deploymentResult,
    );
  }

  runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return this.call(
      "vercel.runSmokeTests",
      () => this.#port.runSmokeTests(projectId, smokeTestIds),
      requestResult,
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

  bindProductionDomain(request: DomainBindingRequest): Promise<ProviderActionResult> {
    return this.call(
      "domain.bindProductionDomain",
      () => this.#port.bindProductionDomain(request),
      requestResult,
    );
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
