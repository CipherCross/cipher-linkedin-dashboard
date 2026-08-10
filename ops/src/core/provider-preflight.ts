import { canonicalJson, sha256Digest, type JsonValue } from "./canonical.js";
import { Redactor } from "./redaction.js";
import type { CatalogSnapshot, ProviderSnapshot } from "./types.js";
import type { OnboardingBusinessInputs } from "../mcp/schemas.js";
import {
  CANONICAL_TENANT_SCHEDULES,
  type HostingCapabilityInspection,
} from "../providers/hosting.js";
import {
  CANONICAL_TENANT_ENVIRONMENT,
  CANONICAL_RUNTIME_PROFILE_ID,
} from "../providers/hosting-tenant.js";
import type {
  AuthInspection,
  DomainInspection,
  OnboardingProviders,
  OwnershipMarker,
  SourceRepositoryInspection,
  SupabaseInspection,
  SmtpInspection,
} from "../providers/interfaces.js";

/**
 * How many values of each class the closed environment contract binds.
 */
const REQUIRED_SERVER_VALUE_COUNT = CANONICAL_TENANT_ENVIRONMENT.filter(
  (entry) => entry.valueClass !== "public_build",
).length;
const REQUIRED_PUBLIC_VALUE_COUNT = CANONICAL_TENANT_ENVIRONMENT.filter(
  (entry) => entry.valueClass === "public_build",
).length;

export const PREFLIGHT_KINDS = [
  "provider_access",
  "domain",
  "region_residency",
  "tier_capacity",
  "smtp_dns",
  "backup_coverage",
  "release_compatibility",
  "legal_review",
  "pricing",
] as const;
export type PreflightKind = (typeof PREFLIGHT_KINDS)[number];

export interface DisposableOnboardingProfile {
  readonly allowedTenantSlug: string;
  readonly platformDomain: string;
  readonly dataOwnerScopeId: string;
  readonly hostingOwnerScopeId: string;
  readonly sourceGitSha: string;
  readonly applicationVersion: string;
  readonly compatibilityEntryId: string;
  readonly agentReleaseId: string;
  readonly ingestProtocolId: string;
  readonly templateSetId: string;
  readonly senderDomain: string;
  readonly fromIdentity: string;
  readonly runtimeProfileId: string;
  readonly baselineVersion: 53;
  readonly migrationVersions: readonly number[];
  readonly targetSchemaVersion: number;
  readonly catalogs: readonly CatalogSnapshot[];
  readonly cost: JsonValue;
  readonly capabilityBudgets: JsonValue;
  readonly recovery: JsonValue;
  readonly smokeTestIds: readonly string[];
}

export interface DetailedProviderSnapshot extends ProviderSnapshot {
  readonly snapshotId: string;
  readonly observedAt: string;
}

export interface PreflightPrerequisite {
  readonly prerequisiteId: string;
  readonly code: string;
  readonly kind: PreflightKind;
  readonly status: "passed" | "blocker" | "manual";
  readonly summary: string;
  readonly evidenceRef: string;
}

export interface PreflightBlocker {
  readonly code: string;
  readonly summary: string;
  readonly remediation: string;
}

export interface DisposablePreflightReport {
  readonly status: "passed" | "blocked";
  readonly snapshots: readonly DetailedProviderSnapshot[];
  readonly snapshotValidUntil: string | null;
  readonly prerequisites: readonly PreflightPrerequisite[];
  readonly blockers: readonly PreflightBlocker[];
}

function snapshot(
  provider: DetailedProviderSnapshot["provider"],
  observedAt: string,
  validUntil: string,
  value: JsonValue,
): DetailedProviderSnapshot {
  const digest = sha256Digest(canonicalJson(value));
  return {
    provider,
    snapshotId: `snap_${digest.slice("sha256:".length, "sha256:".length + 16)}`,
    observedAt,
    valid_until: validUntil,
    digest,
  };
}

function prerequisite(
  kind: PreflightKind,
  passed: boolean,
  summary: string,
): PreflightPrerequisite {
  const suffix = kind.toUpperCase();
  return {
    prerequisiteId: `preflight.${kind}`,
    code: `CHECK_${suffix}`,
    kind,
    status: passed ? "passed" : "blocker",
    summary,
    evidenceRef: `provider-snapshot/${kind}`,
  };
}

function blockerFor(item: PreflightPrerequisite): PreflightBlocker {
  return {
    code: item.code,
    summary: item.summary,
    remediation: `Resolve ${item.kind} prerequisite and generate a replacement plan`,
  };
}

function allTrue(values: readonly boolean[]): boolean {
  return values.every(Boolean);
}

export class ProviderPreflightService {
  readonly #providers: OnboardingProviders;
  readonly #profile: DisposableOnboardingProfile;
  readonly #redactor: Redactor;
  readonly #clock: () => Date;

  constructor(
    providers: OnboardingProviders,
    profile: DisposableOnboardingProfile,
    options: {
      readonly redactor?: Redactor;
      readonly clock?: () => Date;
    } = {},
  ) {
    this.#providers = providers;
    this.#profile = profile;
    this.#redactor = options.redactor ?? new Redactor();
    this.#clock = options.clock ?? (() => new Date());
  }

  async inspect(
    inputs: OnboardingBusinessInputs,
    ownership: OwnershipMarker,
  ): Promise<DisposablePreflightReport> {
    this.#redactor.assertSecretFree(inputs, "preflight business inputs");
    const observedAt = this.#clock().toISOString();
    const projectName = `lh2-${inputs.workspace_class}-${inputs.tenant_slug}`;
    const hostname = `${inputs.tenant_slug}.${this.#profile.platformDomain}`;
    const siteUrl = `https://${hostname}`;
    const redirectUrls = [`${siteUrl}/auth/callback`];

    const [
      data,
      hosting,
      identity,
      email,
      domain,
      sourceRepository,
    ] = await Promise.all([
      this.#providers.data.inspect({
        organizationId: this.#profile.dataOwnerScopeId,
        deterministicName: projectName,
        regionId: inputs.region_id,
        tierId: inputs.data_tier_id,
        computeId: inputs.data_compute_id,
        backupProfileId: inputs.backup_profile_id,
        ownership,
      }),
      this.#providers.hosting.inspect({
        deterministicName: projectName,
        workspaceClass: inputs.workspace_class,
        runtimeProfileId: this.#profile.runtimeProfileId,
        requiredScheduleCount: CANONICAL_TENANT_SCHEDULES.length,
        requiredServerValueCount: REQUIRED_SERVER_VALUE_COUNT,
        requiredPublicValueCount: REQUIRED_PUBLIC_VALUE_COUNT,
        ownership,
      }),
      this.#providers.identity.inspect({
        templateSetId: this.#profile.templateSetId,
        siteUrl,
        redirectUrls,
        releaseCompatibilityId: this.#profile.compatibilityEntryId,
      }),
      this.#providers.email.inspect({
        smtpProfileId: inputs.smtp_profile_id,
        senderDomain: this.#profile.senderDomain,
        fromIdentity: this.#profile.fromIdentity,
        smtpSecretLabels: inputs.smtp_secret_labels,
      }),
      this.#providers.domain.inspect({
        hostname,
        senderDomain: this.#profile.senderDomain,
        workspaceClass: inputs.workspace_class,
      }),
      this.#providers.sourceRepository.inspect({
        sourceGitSha: this.#profile.sourceGitSha,
        compatibilityEntryId: this.#profile.compatibilityEntryId,
        applicationVersion: this.#profile.applicationVersion,
      }),
    ]);

    const raw = { data, hosting, identity, email, domain, sourceRepository };
    this.#redactor.assertSecretFree(raw, "provider preflight responses");
    const snapshots = this.#snapshots(observedAt, raw);
    const now = Date.parse(observedAt);
    const validSnapshots = snapshots.every(
      (candidate) => Date.parse(candidate.valid_until) > now,
    );
    const prerequisites = this.#prerequisites(
      inputs,
      raw,
      validSnapshots,
    );
    const blockers = prerequisites
      .filter((candidate) => candidate.status !== "passed")
      .map(blockerFor);
    return {
      status: blockers.length === 0 ? "passed" : "blocked",
      snapshots,
      snapshotValidUntil:
        snapshots.length === 0
          ? null
          : snapshots
              .map((candidate) => candidate.valid_until)
              .sort()[0]!,
      prerequisites,
      blockers,
    };
  }

  #snapshots(
    observedAt: string,
    observations: {
      readonly data: SupabaseInspection;
      readonly hosting: HostingCapabilityInspection;
      readonly identity: AuthInspection;
      readonly email: SmtpInspection;
      readonly domain: DomainInspection;
      readonly sourceRepository: SourceRepositoryInspection;
    },
  ): readonly DetailedProviderSnapshot[] {
    const { data, hosting, identity, email, domain, sourceRepository } = observations;
    return [
      snapshot(
        "data",
        observedAt,
        [data.validUntil, identity.validUntil].sort()[0]!,
        {
          provider: "data",
          organization_accessible: data.organizationAccessible,
          deterministic_name_usable:
            data.deterministicNameAvailable ||
            data.existingResourceOwned,
          region_available: data.regionAvailable,
          tier_available: data.tierAvailable,
          compute_available: data.computeAvailable,
          backup_compatible: data.backupCompatible,
          auth_configuration_supported: data.authConfigurationSupported,
          auth_template_set_approved: identity.templateSetApproved,
          auth_production_urls_valid: identity.productionUrlsValid,
          auth_invite_flow_supported: identity.inviteFlowSupported,
          auth_release_compatible: identity.releaseCompatible,
        },
      ),
      snapshot("hosting", observedAt, hosting.validUntil, {
        provider: "hosting",
        control_plane_accessible: hosting.controlPlaneAccessible,
        deterministic_name_usable:
          hosting.deterministicNameAvailable || hosting.existingTargetOwned,
        runtime_profile_available: hosting.runtimeProfileAvailable,
        server_value_binding_supported: hosting.serverValueBindingSupported,
        public_value_binding_supported: hosting.publicValueBindingSupported,
        pinned_revision_build_supported: hosting.pinnedRevisionBuildSupported,
        custom_domain_supported: hosting.customDomainSupported,
        schedule_capacity_available: hosting.scheduleCapacityAvailable,
        rollback_supported: hosting.rollbackSupported,
        automatic_promotion_can_be_disabled:
          hosting.automaticPromotionCanBeDisabled,
        isolated_previews_supported: hosting.isolatedPreviewsSupported,
      }),
      snapshot("domain", observedAt, domain.validUntil, {
        provider: "domain",
        zone_owned: domain.zoneOwned,
        hostname_usable:
          domain.hostnameAvailable || domain.existingBindingOwned,
        sender_domain_verified: domain.senderDomainVerified,
        legal_review_approved: domain.legalReviewApproved,
      }),
      snapshot("email", observedAt, email.validUntil, {
        provider: "email",
        provider_accessible: email.providerAccessible,
        custom_smtp: email.customSmtp,
        sender_identity_verified: email.senderIdentityVerified,
        credentials_available: email.credentialsAvailable,
      }),
      snapshot("source_repository", observedAt, sourceRepository.validUntil, {
        provider: "source_repository",
        revision_present: sourceRepository.revisionPresent,
        release_compatible: sourceRepository.releaseCompatible,
        artifact_pinned: sourceRepository.artifactPinned,
      }),
    ];
  }

  #prerequisites(
    inputs: OnboardingBusinessInputs,
    observations: {
      readonly data: SupabaseInspection;
      readonly hosting: HostingCapabilityInspection;
      readonly identity: AuthInspection;
      readonly email: SmtpInspection;
      readonly domain: DomainInspection;
      readonly sourceRepository: SourceRepositoryInspection;
    },
    validSnapshots: boolean,
  ): readonly PreflightPrerequisite[] {
    const { data, hosting, identity, email, domain, sourceRepository } = observations;
    const disposableScope =
      inputs.workspace_class === "disposable" &&
      inputs.release_channel === "canary" &&
      inputs.tenant_slug === this.#profile.allowedTenantSlug;
    const checks: Record<PreflightKind, boolean> = {
      provider_access:
        validSnapshots &&
        data.organizationAccessible &&
        (data.deterministicNameAvailable ||
          data.existingResourceOwned) &&
        hosting.controlPlaneAccessible &&
        (hosting.deterministicNameAvailable || hosting.existingTargetOwned) &&
        email.providerAccessible,
      domain:
        domain.zoneOwned &&
        (domain.hostnameAvailable || domain.existingBindingOwned),
      region_residency: data.regionAvailable && disposableScope,
      tier_capacity: allTrue([
        data.tierAvailable,
        data.computeAvailable,
        hosting.runtimeProfileAvailable,
        hosting.scheduleCapacityAvailable,
        hosting.serverValueBindingSupported,
        hosting.publicValueBindingSupported,
        hosting.pinnedRevisionBuildSupported,
        hosting.customDomainSupported,
        hosting.rollbackSupported,
        hosting.automaticPromotionCanBeDisabled,
        hosting.isolatedPreviewsSupported,
      ]),
      smtp_dns: allTrue([
        email.customSmtp,
        email.senderIdentityVerified,
        email.credentialsAvailable,
        domain.senderDomainVerified,
      ]),
      backup_coverage: data.backupCompatible,
      release_compatibility: allTrue([
        data.authConfigurationSupported,
        identity.templateSetApproved,
        identity.productionUrlsValid,
        identity.inviteFlowSupported,
        identity.releaseCompatible,
        sourceRepository.revisionPresent,
        sourceRepository.releaseCompatible,
        sourceRepository.artifactPinned,
      ]),
      legal_review: domain.legalReviewApproved && disposableScope,
      pricing: this.#profile.catalogs.some(
        (catalog) =>
          catalog.catalog_kind === "pricing" &&
          catalog.catalog_version === inputs.pricing_catalog_id &&
          catalog.review_status === "approved",
      ),
    };
    return PREFLIGHT_KINDS.map((kind) =>
      prerequisite(
        kind,
        checks[kind],
        checks[kind]
          ? `${kind} prerequisite passed`
          : `${kind} prerequisite is blocked`,
      ),
    );
  }
}
