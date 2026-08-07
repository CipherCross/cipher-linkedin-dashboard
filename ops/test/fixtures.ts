import {
  CANONICAL_RUNTIME_PROFILE_ID,
  asJsonValue,
  InMemoryCatalogResolver,
  planDigest,
  sha256Digest,
  type ApplyRequest,
  type CatalogSnapshot,
  type DisposableOnboardingProfile,
  type OnboardingBusinessInputs,
  type OnboardingExecutionContext,
  type PlanEnvelope,
  type ProviderSnapshot,
} from "../src/index.js";

export const OWNER_UUID = "11111111-1111-4111-8111-111111111111";
export const TENANT_UUID = "22222222-2222-4222-8222-222222222222";
export const GENERATED_AT = "2030-01-01T00:00:00.000Z";
export const EXPIRES_AT = "2030-01-01T00:30:00.000Z";
export const TEST_NOW = new Date("2030-01-01T00:05:00.000Z");

function digest(label: string): string {
  return sha256Digest(label);
}

const catalogKinds = [
  "regions",
  "provider_tiers",
  "pricing",
  "backup_profiles",
  "release_compatibility",
  "capabilities",
  "subprocessors",
] as const;

export function makeCatalogs(): readonly CatalogSnapshot[] {
  const common = {
    source_revision: "a".repeat(40),
    published_at: "2029-12-01T00:00:00.000Z",
    valid_until: "2030-02-01T00:00:00.000Z",
    review_status: "approved" as const,
  };
  return [
    {
      ...common,
      catalog_kind: "regions",
      catalog_version: "regions-1",
      digest: digest("regions-1"),
      entries: [
        { id: "eu-policy", availability: "available", approved: true },
        { id: "eu-west", availability: "available", approved: true },
      ],
    },
    {
      ...common,
      catalog_kind: "provider_tiers",
      catalog_version: "tiers-1",
      digest: digest("tiers-1"),
      entries: [
        {
          id: "data-standard",
          availability: "available",
          approved: true,
          billable: true,
          pricing_sku_id: "data-standard-month",
        },
        { id: "data-compute-small", availability: "available", approved: true },
        {
          id: "hosting-standard",
          availability: "available",
          approved: true,
          billable: true,
          pricing_sku_id: "hosting-standard-month",
        },
      ],
    },
    {
      ...common,
      catalog_kind: "pricing",
      catalog_version: "pricing-1",
      digest: digest("pricing-1"),
      entries: [
        { id: "data-standard-month", availability: "available", approved: true },
        { id: "hosting-standard-month", availability: "available", approved: true },
        { id: "anthropic-requests", availability: "available", approved: true },
      ],
    },
    {
      ...common,
      catalog_kind: "backup_profiles",
      catalog_version: "backup-1",
      digest: digest("backup-1"),
      entries: [
        { id: "standard-daily", availability: "available", approved: true },
        { id: "retention-standard", availability: "available", approved: true },
      ],
    },
    {
      ...common,
      catalog_kind: "release_compatibility",
      catalog_version: "compat-1",
      digest: digest("compat-1"),
      entries: [
        { id: "release-compat-1", availability: "available", approved: true },
        { id: "agent-1", availability: "available", approved: true },
        { id: "ingest-1", availability: "available", approved: true },
        { id: "smtp-standard", availability: "available", approved: true },
        { id: "templates-1", availability: "available", approved: true },
      ],
    },
    {
      ...common,
      catalog_kind: "capabilities",
      catalog_version: "capabilities-1",
      digest: digest("capabilities-1"),
      entries: [
        {
          id: "ai.classification",
          availability: "available",
          approved: true,
          cost_sku_ids: ["anthropic-requests"],
        },
        { id: "ai.coaching", availability: "available", approved: true },
        { id: "ai.briefing.daily", availability: "available", approved: true },
        { id: "ai.briefing.weekly", availability: "available", approved: true },
        {
          id: "slack.reply_alerts",
          availability: "available",
          approved: true,
          required_secret_names: ["slack.reply_alerts"],
        },
        { id: "slack.briefings", availability: "available", approved: true },
        { id: "airtable.imports", availability: "available", approved: true },
      ],
    },
    {
      ...common,
      catalog_kind: "subprocessors",
      catalog_version: "subprocessors-1",
      digest: digest("subprocessors-1"),
      entries: [{ id: "standard-processors", availability: "available", approved: true }],
    },
  ];
}

export function catalogResolver(): InMemoryCatalogResolver {
  return new InMemoryCatalogResolver(makeCatalogs());
}

export function disposableBusinessInputs(
  slug = "disposable-lab",
): OnboardingBusinessInputs {
  return {
    company_name: "Disposable Lab",
    tenant_slug: slug,
    workspace_class: "disposable",
    admin_email: "admin@disposable.example",
    expected_instances: 1,
    release_channel: "canary",
    residency_policy_id: "eu-policy",
    region_id: "eu-west",
    data_tier_id: "data-standard",
    data_compute_id: "data-compute-small",
    hosting_tier_id: "hosting-standard",
    backup_profile_id: "standard-daily",
    pricing_catalog_id: "pricing-1",
    retention_policy_id: "retention-standard",
    subprocessor_profile_id: "standard-processors",
    smtp_profile_id: "smtp-standard",
    smtp_secret_labels: [
      `lh2-platform/tenant/${slug}/smtp.username`,
      `lh2-platform/tenant/${slug}/smtp.password`,
    ],
    integration_secret_labels: [],
    support_access_policy: {
      initial_state: "disabled",
      maximum_duration_hours: 24,
    },
  };
}

export function disposableProfile(): DisposableOnboardingProfile {
  const source = makeOnboardingPlan().spec as Record<string, unknown>;
  return {
    allowedTenantSlug: "disposable-lab",
    platformDomain: "example.com",
    dataOwnerScopeId: "data-owner-1",
    hostingOwnerScopeId: "hosting-owner-1",
    sourceGitSha: "b".repeat(40),
    applicationVersion: "app-1",
    compatibilityEntryId: "release-compat-1",
    agentReleaseId: "agent-1",
    ingestProtocolId: "ingest-1",
    templateSetId: "templates-1",
    senderDomain: "example.com",
    fromIdentity: "hello@example.com",
    runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
    baselineVersion: 53,
    migrationVersions: [54],
    targetSchemaVersion: 54,
    catalogs: makeCatalogs(),
    cost: asJsonValue(source.cost),
    capabilityBudgets: asJsonValue(source.capability_budgets),
    recovery: asJsonValue(source.recovery),
    smokeTestIds: smokeTests,
  };
}

function catalogRefs(): readonly object[] {
  return makeCatalogs().map((catalog) => ({
    kind: catalog.catalog_kind,
    version: catalog.catalog_version,
    digest: catalog.digest,
  }));
}

const snapshotProviders = [
  "data",
  "hosting",
  "domain",
  "email",
  "source_repository",
] as const;

export function observedSnapshots(): readonly ProviderSnapshot[] {
  return snapshotProviders.map((provider) => ({
    provider,
    digest: digest(`snapshot-${provider}`),
    valid_until: EXPIRES_AT,
  }));
}

const effects = [
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

const capabilities = [
  "ai.classification",
  "ai.coaching",
  "ai.briefing.daily",
  "ai.briefing.weekly",
  "slack.reply_alerts",
  "slack.briefings",
  "airtable.imports",
] as const;

const smokeTests = [
  "schema_ledger",
  "auth_anonymous_denied",
  "auth_inactive_denied",
  "auth_member_allowed",
  "rls_role_boundaries",
  "private_storage_delivery",
  "api_health",
  "cron_configuration",
  "preview_isolation",
  "smtp_delivery",
  "runtime_project_ref",
] as const;

const prerequisiteKinds = [
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

export function makeOnboardingPlan(
  overrides: {
    readonly planId?: string;
    readonly expectedRegistryVersion?: number;
    readonly slug?: string;
    readonly mutateSpec?: (spec: Record<string, unknown>) => void;
  } = {},
): PlanEnvelope {
  const slug = overrides.slug ?? "acme-team";
  const spec: Record<string, unknown> = {
    inputs: {
      company_name: "Acme",
      tenant_slug: slug,
      workspace_class: "external",
      admin_email: "admin@acme.example",
      expected_instances: 3,
      release_channel: "stable",
      residency_policy_id: "eu-policy",
      region_id: "eu-west",
      data_tier_id: "data-standard",
      data_compute_id: "data-compute-small",
      hosting_tier_id: "hosting-standard",
      backup_profile_id: "standard-daily",
      pricing_catalog_id: "pricing-1",
      retention_policy_id: "retention-standard",
      subprocessor_profile_id: "standard-processors",
      smtp_profile_id: "smtp-standard",
      smtp_secret_labels: [
        `lh2-platform/tenant/${slug}/smtp.username`,
        `lh2-platform/tenant/${slug}/smtp.password`,
      ],
      integration_secret_labels: [],
      support_access: {
        initial_state: "disabled",
        maximum_duration_hours: 24,
      },
    },
    catalogs: catalogRefs(),
    provider_snapshots: observedSnapshots().map((snapshot) => ({
      ...snapshot,
      snapshot_id: `snap_${snapshot.provider.replaceAll("_", "").padEnd(12, "x")}`,
      observed_at: GENERATED_AT,
    })),
    resources: {
      tenant_id: TENANT_UUID,
      data_project_name: `lh2-external-${slug}`,
      hosting_project_name: `lh2-external-${slug}`,
      production_hostname: `${slug}.example.com`,
      cron_slot: 2,
      tags: {
        "managed-by": "lh2-platform-ops",
        "tenant-slug": slug,
        "workspace-class": "external",
        "contract-version": "p2.v1",
        "registry-owner-id": OWNER_UUID,
      },
    },
    versions: {
      source_git_sha: "b".repeat(40),
      baseline_version: 53,
      migration_versions: [54],
      target_schema_version: 54,
      application_version: "app-1",
      agent_release_id: "agent-1",
      ingest_protocol_id: "ingest-1",
      compatibility_entry_id: "release-compat-1",
    },
    environment_policy: {
      git_auto_promotion: false,
      external_previews: false,
      production_secret_scope: "production_only",
      preview_secret_names: [],
      public_build_value_names: ["PUBLIC_DATA_API_URL", "PUBLIC_DATA_API_KEY"],
    },
    auth_smtp: {
      site_url: `https://${slug}.example.com`,
      redirect_urls: [`https://${slug}.example.com/auth/callback`],
      smtp_profile_id: "smtp-standard",
      sender_domain: "example.com",
      from_identity: "hello@example.com",
      template_set_id: "templates-1",
      smtp_secret_labels: [
        `lh2-platform/tenant/${slug}/smtp.username`,
        `lh2-platform/tenant/${slug}/smtp.password`,
      ],
    },
    effects: effects.map(([kind, action, reconcile], index) => ({
      ordinal: index + 1,
      kind,
      action,
      resource_ref: `tenant/${slug}/${kind}`,
      billable: kind === "data_project" || kind === "hosting_project",
      reconcile_strategy: reconcile,
    })),
    cost: {
      currency: "EUR",
      tax_included: false,
      billing_period: "monthly",
      recurring_low_minor: 4500,
      recurring_high_minor: 6000,
      usage_ceiling_minor: 10000,
      one_time_minor: 0,
      components: [
        {
          provider: "data",
          sku_id: "data-standard-month",
          quantity: 1,
          unit: "tenant_month",
          low_minor: 2500,
          high_minor: 2500,
          assumption: "Selected data plan",
        },
        {
          provider: "hosting",
          sku_id: "hosting-standard-month",
          quantity: 1,
          unit: "tenant_month",
          low_minor: 2000,
          high_minor: 2000,
          assumption: "Selected hosting plan",
        },
        {
          provider: "anthropic",
          sku_id: "anthropic-requests",
          quantity: 1000,
          unit: "request",
          low_minor: 0,
          high_minor: 1500,
          assumption: "Bounded classification usage",
        },
      ],
      pricing_catalog_version: "pricing-1",
    },
    capability_budgets: capabilities.map((capability) => ({
      capability,
      enabled: capability === "ai.classification",
      unit: "requests",
      period: "calendar_month",
      soft_limit: capability === "ai.classification" ? 800 : 0,
      hard_limit: capability === "ai.classification" ? 1000 : 0,
      overage_action: "pause_and_alert",
    })),
    recovery: {
      profile_id: "standard-daily",
      rpo_hours: 24,
      rto_business_hours: 8,
      business_timezone: "Europe/Madrid",
      provider_backup_interval_hours: 24,
      encrypted_export_interval_hours: 168,
      restore_drill_interval_days: 92,
      coverage: [
        "database_schema_data",
        "auth_configuration_identities",
        "storage_metadata",
        "private_storage_objects_or_reconstruction",
        "deployment_configuration_metadata",
      ],
      retention_policy_id: "retention-standard",
    },
    smoke_tests: smokeTests.map((id) => ({
      id,
      required: true,
      before_admin_invite: true,
    })),
  };
  overrides.mutateSpec?.(spec);
  return {
    contract_version: "p2.v1",
    plan_schema_version: 1,
    plan_kind: "tenant_onboarding",
    plan_id: overrides.planId ?? "pln_abcdefghijklmnopqrst",
    plan_digest: planDigest(asJsonValue(spec)),
    generated_at: GENERATED_AT,
    expires_at: EXPIRES_AT,
    expected_registry_version: overrides.expectedRegistryVersion ?? 1,
    state: "valid",
    spec: asJsonValue(spec),
    prerequisites: prerequisiteKinds.map((kind, index) => ({
      code: `CHECK_${String(index + 1).padStart(2, "0")}`,
      kind,
      status: "passed" as const,
      evidence_ref: `evidence/${kind}`,
    })),
    blockers: [],
  };
}

export function makeApplyRequest(
  plan: PlanEnvelope,
  overrides: Partial<ApplyRequest> = {},
): ApplyRequest {
  return {
    contract_version: "p2.v1",
    operation_kind: plan.plan_kind,
    plan_id: plan.plan_id,
    plan_digest: plan.plan_digest,
    expected_registry_version: plan.expected_registry_version,
    idempotency_key: "onboard-acme-2030-01",
    ...overrides,
  };
}

export function makeReleasePlan(
  expectedRegistryVersion = 1,
): PlanEnvelope {
  const spec: Record<string, unknown> = {
    release_id: "release-2030-01",
    bundle_digest: digest("release-bundle"),
    source_git_sha: "c".repeat(40),
    baseline_version: 53,
    migration_versions: [54],
    compatibility_entry_id: "release-compat-1",
    deployment_config_digest: digest("deployment-config"),
    release_notes_digest: digest("release-notes"),
    verification_checklist_id: "release-checklist-1",
    canary_tenant_id: TENANT_UUID,
    canary_gate: {
      required_state: "active",
      maximum_critical_drift: 0,
      maximum_heartbeat_age_minutes: 30,
      maximum_cron_age_hours: 24,
      maximum_backup_age_hours: 24,
      verification_window_minutes: 30,
      on_failure: "block_fanout",
    },
    targets: [
      {
        tenant_id: TENANT_UUID,
        tenant_slug: "acme-team",
        workspace_class: "external",
        release_channel: "stable",
        observed: {
          schema: 53,
          application: "app-0",
          agent: "agent-0",
          launcher: "launcher-1",
          ingest_protocol: "ingest-1",
        },
        target: {
          schema: 54,
          application: "app-1",
          agent: "agent-1",
          launcher: "launcher-1",
          ingest_protocol: "ingest-1",
        },
        eligibility: "eligible",
        build_input_digest: digest("build-input"),
        expected_effects: [
          "apply_migrations",
          "build_tenant",
          "deploy",
          "promote",
          "rollout_agent",
          "verify",
        ],
      },
    ],
    ordered_phases: [
      "expand_migrations",
      "internal_workspace",
      "canary_workspace",
      "canary_agent_and_verification",
      "tenant_migrations",
      "tenant_builds_and_deployments",
      "stable_agent_rollout",
    ],
    estimated_incremental_cost_minor: 0,
    currency: "EUR",
  };
  return {
    contract_version: "p2.v1",
    plan_schema_version: 1,
    plan_kind: "release",
    plan_id: "pln_releasereleasereleas",
    plan_digest: planDigest(asJsonValue(spec)),
    generated_at: GENERATED_AT,
    expires_at: EXPIRES_AT,
    expected_registry_version: expectedRegistryVersion,
    state: "valid",
    spec: asJsonValue(spec),
    blockers: [],
  };
}

export function executionContext(
  plan: PlanEnvelope,
  operationId: string,
  fencingToken: number,
): OnboardingExecutionContext {
  const spec = plan.spec as Record<string, Record<string, unknown>>;
  const inputs = spec.inputs!;
  const resources = spec.resources!;
  const versions = spec.versions!;
  const auth = spec.auth_smtp!;
  const environment = spec.environment_policy!;
  return {
    operationId,
    fencingToken,
    tenantId: String(resources.tenant_id),
    tenantSlug: String(inputs.tenant_slug),
    companyName: String(inputs.company_name),
    workspaceClass: "external",
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
    smokeTestIds: smokeTests,
    ownership: {
      managedBy: "lh2-platform-ops",
      tenantSlug: String(inputs.tenant_slug),
      workspaceClass: "external",
      contractVersion: "p2.v1",
      registryOwnerId: OWNER_UUID,
      digest: digest(`ownership-${String(inputs.tenant_slug)}`),
    },
  };
}

export { catalogKinds };
