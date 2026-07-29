import { canonicalJson, sha256Digest, type JsonValue } from "./canonical.js";
import { Redactor } from "./redaction.js";
import type { CatalogSnapshot, ProviderSnapshot } from "./types.js";
import type { OnboardingBusinessInputs } from "../mcp/schemas.js";
import type {
  AuthInspection,
  DomainInspection,
  OnboardingProviders,
  OwnershipMarker,
  SourceRepositoryInspection,
  SupabaseInspection,
  VercelInspection,
  SmtpInspection,
} from "../providers/interfaces.js";

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
  readonly platformDomain: string;
  readonly supabaseOrganizationId: string;
  readonly vercelTeamId: string;
  readonly sourceGitSha: string;
  readonly applicationVersion: string;
  readonly compatibilityEntryId: string;
  readonly agentReleaseId: string;
  readonly ingestProtocolId: string;
  readonly templateSetId: string;
  readonly senderDomain: string;
  readonly fromIdentity: string;
  readonly serverlessFunctionCount: number;
  readonly scheduledJobCount: number;
  readonly requiredCronSlots: 1;
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
      supabase,
      vercel,
      auth,
      smtp,
      domain,
      sourceRepository,
    ] = await Promise.all([
      this.#providers.supabase.inspect({
        organizationId: this.#profile.supabaseOrganizationId,
        deterministicName: projectName,
        regionId: inputs.supabase_region_id,
        tierId: inputs.supabase_tier_id,
        computeId: inputs.supabase_compute_id,
        backupProfileId: inputs.backup_profile_id,
        ownership,
      }),
      this.#providers.vercel.inspect({
        teamId: this.#profile.vercelTeamId,
        deterministicName: projectName,
        tierId: inputs.vercel_tier_id,
        serverlessFunctionCount: this.#profile.serverlessFunctionCount,
        scheduledJobCount: this.#profile.scheduledJobCount,
        requiredCronSlots: this.#profile.requiredCronSlots,
        ownership,
      }),
      this.#providers.auth.inspect({
        templateSetId: this.#profile.templateSetId,
        siteUrl,
        redirectUrls,
        releaseCompatibilityId: this.#profile.compatibilityEntryId,
      }),
      this.#providers.smtp.inspect({
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

    const raw = { supabase, vercel, auth, smtp, domain, sourceRepository };
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
      readonly supabase: SupabaseInspection;
      readonly vercel: VercelInspection;
      readonly auth: AuthInspection;
      readonly smtp: SmtpInspection;
      readonly domain: DomainInspection;
      readonly sourceRepository: SourceRepositoryInspection;
    },
  ): readonly DetailedProviderSnapshot[] {
    const { supabase, vercel, auth, smtp, domain, sourceRepository } = observations;
    return [
      snapshot(
        "supabase",
        observedAt,
        [supabase.validUntil, auth.validUntil].sort()[0]!,
        {
          provider: "supabase",
          organization_accessible: supabase.organizationAccessible,
          deterministic_name_usable:
            supabase.deterministicNameAvailable ||
            supabase.existingResourceOwned,
          region_available: supabase.regionAvailable,
          tier_available: supabase.tierAvailable,
          compute_available: supabase.computeAvailable,
          backup_compatible: supabase.backupCompatible,
          auth_configuration_supported: supabase.authConfigurationSupported,
          auth_template_set_approved: auth.templateSetApproved,
          auth_production_urls_valid: auth.productionUrlsValid,
          auth_invite_flow_supported: auth.inviteFlowSupported,
          auth_release_compatible: auth.releaseCompatible,
        },
      ),
      snapshot("vercel", observedAt, vercel.validUntil, {
        provider: "vercel",
        team_accessible: vercel.teamAccessible,
        deterministic_name_usable:
          vercel.deterministicNameAvailable || vercel.existingResourceOwned,
        tier_available: vercel.tierAvailable,
        function_capacity_available: vercel.functionCapacityAvailable,
        cron_capacity_available: vercel.cronCapacityAvailable,
        production_only_environment_supported:
          vercel.productionOnlyEnvironmentSupported,
        git_auto_promotion_can_be_disabled:
          vercel.gitAutoPromotionCanBeDisabled,
      }),
      snapshot("dns", observedAt, domain.validUntil, {
        provider: "dns",
        zone_owned: domain.zoneOwned,
        hostname_usable:
          domain.hostnameAvailable || domain.existingBindingOwned,
        sender_domain_verified: domain.senderDomainVerified,
        legal_review_approved: domain.legalReviewApproved,
      }),
      snapshot("smtp", observedAt, smtp.validUntil, {
        provider: "smtp",
        provider_accessible: smtp.providerAccessible,
        custom_smtp: smtp.customSmtp,
        sender_identity_verified: smtp.senderIdentityVerified,
        credentials_available: smtp.credentialsAvailable,
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
      readonly supabase: SupabaseInspection;
      readonly vercel: VercelInspection;
      readonly auth: AuthInspection;
      readonly smtp: SmtpInspection;
      readonly domain: DomainInspection;
      readonly sourceRepository: SourceRepositoryInspection;
    },
    validSnapshots: boolean,
  ): readonly PreflightPrerequisite[] {
    const { supabase, vercel, auth, smtp, domain, sourceRepository } = observations;
    const disposableScope =
      inputs.workspace_class === "disposable" &&
      inputs.release_channel === "canary";
    const checks: Record<PreflightKind, boolean> = {
      provider_access:
        validSnapshots &&
        supabase.organizationAccessible &&
        (supabase.deterministicNameAvailable ||
          supabase.existingResourceOwned) &&
        vercel.teamAccessible &&
        (vercel.deterministicNameAvailable || vercel.existingResourceOwned) &&
        smtp.providerAccessible,
      domain:
        domain.zoneOwned &&
        (domain.hostnameAvailable || domain.existingBindingOwned),
      region_residency: supabase.regionAvailable && disposableScope,
      tier_capacity: allTrue([
        supabase.tierAvailable,
        supabase.computeAvailable,
        vercel.tierAvailable,
        vercel.functionCapacityAvailable,
        vercel.cronCapacityAvailable,
        vercel.productionOnlyEnvironmentSupported,
        vercel.gitAutoPromotionCanBeDisabled,
      ]),
      smtp_dns: allTrue([
        smtp.customSmtp,
        smtp.senderIdentityVerified,
        smtp.credentialsAvailable,
        domain.senderDomainVerified,
      ]),
      backup_coverage: supabase.backupCompatible,
      release_compatibility: allTrue([
        supabase.authConfigurationSupported,
        auth.templateSetApproved,
        auth.productionUrlsValid,
        auth.inviteFlowSupported,
        auth.releaseCompatible,
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
