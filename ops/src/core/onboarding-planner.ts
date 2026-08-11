import { createHash } from "node:crypto";

import {
  planDigest,
  sha256Digest,
  type JsonValue,
} from "./canonical.js";
import { InMemoryCatalogResolver } from "./catalogs.js";
import { assertOps } from "./errors.js";
import { asJsonValue } from "./semantic-validation.js";
import type { OnboardingExecutionContext } from "./onboarding-executor.js";
import {
  type DisposableOnboardingProfile,
  type DisposablePreflightReport,
  ProviderPreflightService,
} from "./provider-preflight.js";
import type { PlanEnvelope } from "./types.js";
import type {
  OnboardingBusinessInputs,
} from "../mcp/schemas.js";
import { onboardingBusinessInputsSchema } from "../mcp/schemas.js";
import type { OwnershipMarker } from "../providers/interfaces.js";
import {
  CANONICAL_PUBLIC_BUILD_VALUE_NAMES,
  CANONICAL_TENANT_ENVIRONMENT,
  HOSTING_ENVIRONMENT_CONTRACT,
  S26_APPLICATION_HOSTING_PROFILE,
  tenantEnvironmentContractDigest,
} from "../providers/hosting-tenant.js";
import type { Registry } from "../state/registry.js";

const EFFECTS = [
  ["reserve_tenant", "reserve", "registry_only"],
  ["data_project", "create_or_adopt", "deterministic_name_and_owner_marker"],
  ["tenant_schema", "apply", "version_ledger"],
  ["object_storage_identity_email", "configure", "provider_request_id"],
  ["platform_support", "configure", "provider_request_id"],
  ["hosting_project", "create_or_adopt", "deterministic_name_and_owner_marker"],
  ["production_env", "configure", "provider_request_id"],
  ["domain_binding", "configure", "provider_request_id"],
  ["tenant_build", "build", "provider_request_id"],
  ["production_deployment", "deploy_and_promote", "provider_request_id"],
  ["smoke_suite", "verify", "verification_result"],
  ["company_admin", "invite", "provider_request_id"],
  ["finalize_tenant", "finalize", "registry_only"],
] as const;

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deterministicCronSlot(value: string): number {
  return createHash("sha256").update(value).digest()[0]! % 5;
}

function ownershipMarker(
  registryOwnerId: string,
  inputs: OnboardingBusinessInputs,
): OwnershipMarker {
  const marker = {
    managedBy: "lh2-platform-ops" as const,
    tenantSlug: inputs.tenant_slug,
    workspaceClass: inputs.workspace_class,
    contractVersion: "p2.v1" as const,
    registryOwnerId,
  };
  return {
    ...marker,
    digest: sha256Digest(JSON.stringify(marker)),
  };
}

export interface DisposableDryRun {
  readonly envelope: PlanEnvelope;
  readonly preflight: DisposablePreflightReport;
  readonly ownership: OwnershipMarker;
}

export class DisposableOnboardingPlanner {
  readonly #registry: Registry;
  readonly #profile: DisposableOnboardingProfile;
  readonly #preflight: ProviderPreflightService;
  readonly #clock: () => Date;

  constructor(
    registry: Registry,
    profile: DisposableOnboardingProfile,
    preflight: ProviderPreflightService,
    clock: () => Date = () => new Date(),
  ) {
    this.#registry = registry;
    this.#profile = profile;
    this.#preflight = preflight;
    this.#clock = clock;
  }

  async preflight(inputsValue: unknown): Promise<DisposablePreflightReport> {
    const inputs = onboardingBusinessInputsSchema.parse(inputsValue);
    return this.#preflight.inspect(
      inputs,
      ownershipMarker(this.#registry.ownerUuid, inputs),
    );
  }

  async dryRun(inputsValue: unknown): Promise<DisposableDryRun> {
    const inputs = onboardingBusinessInputsSchema.parse(inputsValue);
    const ownership = ownershipMarker(this.#registry.ownerUuid, inputs);
    const preflight = await this.#preflight.inspect(inputs, ownership);
    const generatedAt = this.#clock();
    /*
     * A plan carries no wall clock of its own. Every step re-runs the live
     * preflight before it executes, so provider drift is caught continuously
     * and by observation rather than by a timer — a short TTL added nothing
     * except a deadline that a thirteen-step onboarding could not meet.
     *
     * What genuinely bounds a plan is the approved catalogs it was built from:
     * it must not outlive them, which the semantic validator already asserts.
     */
    const expiresAt = Math.min(
      ...this.#profile.catalogs.map((catalog) => Date.parse(catalog.valid_until)),
    );
    assertOps(
      expiresAt > generatedAt.getTime(),
      "catalog_invalid",
      "Approved catalogs have expired",
    );
    const projectName = `lh2-${inputs.workspace_class}-${inputs.tenant_slug}`;
    const hostname = `${inputs.tenant_slug}.${this.#profile.platformDomain}`;
    const tags = {
      "managed-by": "lh2-platform-ops",
      "tenant-slug": inputs.tenant_slug,
      "workspace-class": inputs.workspace_class,
      "contract-version": "p2.v1",
      "registry-owner-id": this.#registry.ownerUuid,
    };
    const {
      support_access_policy: supportAccess,
      ...planBusinessInputs
    } = inputs;
    const spec = {
      inputs: {
        ...planBusinessInputs,
        support_access: supportAccess,
      },
      catalogs: this.#profile.catalogs.map((catalog) => ({
        kind: catalog.catalog_kind,
        version: catalog.catalog_version,
        digest: catalog.digest,
      })),
      provider_snapshots: preflight.snapshots.map((candidate) => ({
        provider: candidate.provider,
        snapshot_id: candidate.snapshotId,
        observed_at: candidate.observedAt,
        valid_until: candidate.valid_until,
        digest: candidate.digest,
      })),
      resources: {
        tenant_id: deterministicUuid(
          `${this.#registry.ownerUuid}:${inputs.tenant_slug}`,
        ),
        data_project_name: projectName,
        hosting_project_name: projectName,
        production_hostname: hostname,
        cron_slot: deterministicCronSlot(inputs.tenant_slug),
        tags,
      },
      versions: {
        source_git_sha: this.#profile.sourceGitSha,
        baseline_version: this.#profile.baselineVersion,
        migration_versions: this.#profile.migrationVersions,
        target_schema_version: this.#profile.targetSchemaVersion,
        application_version: this.#profile.applicationVersion,
        agent_release_id: this.#profile.agentReleaseId,
        ingest_protocol_id: this.#profile.ingestProtocolId,
        compatibility_entry_id: this.#profile.compatibilityEntryId,
      },
      environment_policy: {
        hosting_value_contract: HOSTING_ENVIRONMENT_CONTRACT,
        hosting_profile: S26_APPLICATION_HOSTING_PROFILE,
        environment_binding_digest: tenantEnvironmentContractDigest({
          tenantSlug: inputs.tenant_slug,
        }),
        value_descriptors: CANONICAL_TENANT_ENVIRONMENT.map((entry) => ({
          name: entry.name,
          value_class: entry.valueClass,
          source: entry.source,
        })),
        git_auto_promotion: false,
        external_previews: false,
        production_secret_scope: "production_only",
        preview_secret_names: [],
        public_build_value_names: CANONICAL_PUBLIC_BUILD_VALUE_NAMES,
      },
      auth_smtp: {
        site_url: `https://${hostname}`,
        redirect_urls: [`https://${hostname}/auth/callback`],
        smtp_profile_id: inputs.smtp_profile_id,
        sender_domain: this.#profile.senderDomain,
        from_identity: this.#profile.fromIdentity,
        template_set_id: this.#profile.templateSetId,
        smtp_secret_labels: inputs.smtp_secret_labels,
      },
      effects: EFFECTS.map(([kind, action, reconcile], index) => ({
        ordinal: index + 1,
        kind,
        action,
        resource_ref: `tenant/${inputs.tenant_slug}/${kind}`,
        billable: kind === "data_project" || kind === "hosting_project",
        reconcile_strategy: reconcile,
      })),
      cost: this.#profile.cost,
      capability_budgets: this.#profile.capabilityBudgets,
      recovery: this.#profile.recovery,
      smoke_tests: this.#profile.smokeTestIds.map((id) => ({
        id,
        required: true,
        before_admin_invite: true,
      })),
    };
    const jsonSpec = asJsonValue(spec);
    const digest = planDigest(jsonSpec);
    const expectedRegistryVersion = this.#registry.registryVersion + 1;
    const planIdentity = sha256Digest(
      `${digest}:${expectedRegistryVersion}`,
    );
    const blocked = preflight.status === "blocked";
    const envelope: PlanEnvelope = {
      contract_version: "p2.v1",
      plan_schema_version: 1,
      plan_kind: "tenant_onboarding",
      plan_id: `pln_${planIdentity.slice("sha256:".length, "sha256:".length + 24)}`,
      plan_digest: digest,
      generated_at: generatedAt.toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
      expected_registry_version: expectedRegistryVersion,
      state: blocked ? "blocked" : "valid",
      spec: jsonSpec,
      prerequisites: preflight.prerequisites.map((candidate) => ({
        code: candidate.code,
        kind: candidate.kind,
        status: candidate.status,
        evidence_ref: candidate.evidenceRef,
      })),
      blockers: preflight.blockers.map((candidate) => ({
        code: candidate.code,
        message: candidate.summary,
        remediation: candidate.remediation,
      })),
    };
    return { envelope, preflight, ownership };
  }

  async planAndStore(inputsValue: unknown): Promise<DisposableDryRun> {
    const result = await this.dryRun(inputsValue);
    const reusable = this.#registry.findReusablePlan(
      "tenant_onboarding",
      result.envelope.plan_digest,
      this.#clock(),
    );
    if (reusable !== undefined) {
      return { ...result, envelope: reusable };
    }
    this.#registry.savePlan(
      result.envelope,
      {
        catalogs: new InMemoryCatalogResolver(this.#profile.catalogs),
        now: this.#clock(),
      },
      "owner-mcp",
    );
    return result;
  }
}

export function executionContextFromPlan(
  plan: PlanEnvelope,
  operationId: string,
  fencingToken: number,
  registryOwnerId: string,
): OnboardingExecutionContext {
  const spec = plan.spec as Record<string, Record<string, unknown>>;
  const inputs = spec.inputs!;
  const resources = spec.resources!;
  const versions = spec.versions!;
  const auth = spec.auth_smtp!;
  const environment = spec.environment_policy!;
  const smokeTests = spec.smoke_tests as unknown as readonly {
    readonly id: string;
  }[];
  const workspaceClass = String(inputs.workspace_class);
  assertOps(
    workspaceClass === "disposable",
    "unsupported_contract",
    "P4-B execution is limited to disposable tenants",
  );
  return {
    operationId,
    fencingToken,
    tenantId: String(resources.tenant_id),
    tenantSlug: String(inputs.tenant_slug),
    companyName: String(inputs.company_name),
    workspaceClass,
    adminEmail: String(inputs.admin_email),
    dataOwnerScope: "platform-data",
    dataProjectName: String(resources.data_project_name),
    dataRegionId: String(inputs.region_id),
    dataTierId: String(inputs.data_tier_id),
    dataComputeId: String(inputs.data_compute_id),
    hostingOwnerScope: "platform-hosting",
    hostingProjectName: String(resources.hosting_project_name),
    productionHostname: String(resources.production_hostname),
    sourceGitSha: String(versions.source_git_sha),
    migrationVersions: versions.migration_versions as unknown as readonly number[],
    targetSchemaVersion: Number(versions.target_schema_version),
    siteUrl: String(auth.site_url),
    redirectUrls: auth.redirect_urls as unknown as readonly string[],
    smtpProfileId: String(auth.smtp_profile_id),
    senderDomain: String(auth.sender_domain),
    fromIdentity: String(auth.from_identity),
    templateSetId: String(auth.template_set_id),
    smtpSecretLabels: auth.smtp_secret_labels as unknown as readonly string[],
    integrationSecretLabels:
      inputs.integration_secret_labels as unknown as readonly string[],
    publicBuildValueNames:
      environment.public_build_value_names as unknown as OnboardingExecutionContext["publicBuildValueNames"],
    environmentContractVersion: String(environment.hosting_value_contract),
    environmentContractDigest: String(environment.environment_binding_digest),
    smokeTestIds: smokeTests.map((candidate) => candidate.id),
    ownership: {
      managedBy: "lh2-platform-ops",
      tenantSlug: String(inputs.tenant_slug),
      workspaceClass,
      contractVersion: "p2.v1",
      registryOwnerId,
      digest: sha256Digest(
        JSON.stringify({
          managedBy: "lh2-platform-ops",
          tenantSlug: String(inputs.tenant_slug),
          workspaceClass,
          contractVersion: "p2.v1",
          registryOwnerId,
        }),
      ),
    },
  };
}
