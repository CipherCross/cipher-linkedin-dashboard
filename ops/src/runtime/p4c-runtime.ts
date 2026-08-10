import { resolve } from "node:path";

import { catalogDigest } from "../core/catalogs.js";
import { DisposableOnboardingCore } from "../core/onboarding-core.js";
import { DisposableOnboardingPlanner } from "../core/onboarding-planner.js";
import {
  ProviderPreflightService,
  type DisposableOnboardingProfile,
} from "../core/provider-preflight.js";
import { Redactor } from "../core/redaction.js";
import { asJsonValue } from "../core/semantic-validation.js";
import type { CatalogSnapshot } from "../core/types.js";
import { RegistryOwnerOperationsAdapter } from "../mcp/adapter.js";
import {
  IdentityOperationsAdapter,
  NeonDataAdapter,
  R2ObjectStorageAdapter,
  StrictDomainAdapter,
  StrictSmtpAdapter,
  StrictHostingAdapter,
  StrictSourceRepositoryAdapter,
} from "../providers/adapters.js";
import { CANONICAL_RUNTIME_PROFILE_ID } from "../providers/hosting-tenant.js";
import { createP4CSdkPorts } from "../providers/p4c-sdk.js";
import { MacOsKeychainSecretStore } from "../secrets/keychain.js";
import type { SecretStore } from "../secrets/types.js";
import type { Registry } from "../state/registry.js";

export const P4C_SOURCE_GIT_SHA =
  "bc780bd5006dee3e59bd7fa6604aded601d682b6";

const CAPABILITIES = [
  "ai.classification",
  "ai.coaching",
  "ai.briefing.daily",
  "ai.briefing.weekly",
  "slack.reply_alerts",
  "slack.briefings",
  "airtable.imports",
] as const;

const SMOKE_TESTS = [
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

function catalogs(): readonly CatalogSnapshot[] {
  const common = {
    source_revision: P4C_SOURCE_GIT_SHA,
    published_at: "2026-07-29T00:00:00.000Z",
    valid_until: "2026-08-31T23:59:59.000Z",
    review_status: "approved" as const,
  };
  const snapshots = [
    {
      ...common,
      catalog_kind: "regions",
      catalog_version: "p4c-regions-2026-07-29",
      entries: [
        { id: "eu-eea-reviewed", availability: "available", approved: true },
        { id: "eu-west-1", availability: "available", approved: true },
      ],
    },
    {
      ...common,
      catalog_kind: "provider_tiers",
      catalog_version: "p4c-tiers-2026-07-29",
      entries: [
        {
          id: "supabase-pro",
          availability: "available",
          approved: true,
          billable: true,
          pricing_sku_id: "supabase-pro-month",
        },
        { id: "supabase-micro", availability: "available", approved: true },
        {
          id: "vercel-pro",
          availability: "available",
          approved: true,
          billable: true,
          pricing_sku_id: "vercel-existing-team",
        },
      ],
    },
    {
      ...common,
      catalog_kind: "pricing",
      catalog_version: "p4c-pricing-2026-07-29",
      entries: [
        { id: "supabase-pro-month", availability: "available", approved: true },
        { id: "vercel-existing-team", availability: "available", approved: true },
        { id: "resend-existing-account", availability: "available", approved: true },
      ],
    },
    {
      ...common,
      catalog_kind: "backup_profiles",
      catalog_version: "p4c-backups-2026-07-29",
      entries: [
        {
          id: "supabase-pro-daily-7d",
          availability: "available",
          approved: true,
        },
        {
          id: "p4c-disposable-retention",
          availability: "available",
          approved: true,
        },
      ],
    },
    {
      ...common,
      catalog_kind: "release_compatibility",
      catalog_version: "p4c-compatibility-2026-07-29",
      entries: [
        { id: "p4c-release-v1", availability: "available", approved: true },
        { id: "p4c-agent-v1", availability: "available", approved: true },
        { id: "p4c-ingest-v1", availability: "available", approved: true },
        { id: "resend-eu-west-1", availability: "available", approved: true },
        { id: "p4c-auth-v1", availability: "available", approved: true },
      ],
    },
    {
      ...common,
      catalog_kind: "capabilities",
      catalog_version: "p4c-capabilities-2026-07-29",
      entries: CAPABILITIES.map((id) => ({
        id,
        availability: "available" as const,
        approved: true,
      })),
    },
    {
      ...common,
      catalog_kind: "subprocessors",
      catalog_version: "p4c-subprocessors-2026-07-29",
      entries: [
        {
          id: "p4c-reviewed-processors",
          availability: "available",
          approved: true,
        },
      ],
    },
  ] satisfies readonly Omit<CatalogSnapshot, "digest">[];
  return snapshots.map((catalog) => ({
    ...catalog,
    digest: catalogDigest(catalog),
  }));
}

export function p4cProfile(): DisposableOnboardingProfile {
  return {
    allowedTenantSlug: "p4c-lab",
    platformDomain: "app.ciphercross.dev",
    dataOwnerScopeId: "dzfikwgcfdbgxpejzfnk",
    hostingOwnerScopeId: "team_AB0nAOId1mR7gHxPldsG9f2u",
    sourceGitSha: P4C_SOURCE_GIT_SHA,
    applicationVersion: "p4c-app-v1",
    compatibilityEntryId: "p4c-release-v1",
    agentReleaseId: "p4c-agent-v1",
    ingestProtocolId: "p4c-ingest-v1",
    templateSetId: "p4c-auth-v1",
    senderDomain: "mail.ciphercross.dev",
    fromIdentity: "no-reply@mail.ciphercross.dev",
    runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
    baselineVersion: 53,
    migrationVersions: [54],
    targetSchemaVersion: 54,
    catalogs: catalogs(),
    cost: asJsonValue({
      currency: "USD",
      tax_included: false,
      billing_period: "monthly",
      recurring_low_minor: 2500,
      recurring_high_minor: 2500,
      usage_ceiling_minor: 3500,
      one_time_minor: 0,
      components: [
        {
          provider: "data",
          sku_id: "supabase-pro-month",
          quantity: 1,
          unit: "tenant_month",
          low_minor: 2500,
          high_minor: 2500,
          assumption:
            "Supabase Pro organization with one included Micro project; usage overages are excluded from the recurring estimate",
        },
        {
          provider: "hosting",
          sku_id: "vercel-existing-team",
          quantity: 1,
          unit: "tenant_month",
          low_minor: 0,
          high_minor: 0,
          assumption:
            "Disposable project uses the owner's existing Vercel team without adding a paid seat",
        },
        {
          provider: "email",
          sku_id: "resend-existing-account",
          quantity: 1,
          unit: "email",
          low_minor: 0,
          high_minor: 0,
          assumption:
            "P4-C sends one SMTP smoke and one admin invitation from the existing Resend account",
        },
      ],
      pricing_catalog_version: "p4c-pricing-2026-07-29",
    }),
    capabilityBudgets: asJsonValue(
      CAPABILITIES.map((capability) => ({
        capability,
        enabled: false,
        unit: capability === "airtable.imports" ? "imports" : "requests",
        period: "calendar_month",
        soft_limit: 0,
        hard_limit: 0,
        overage_action: "disable_and_alert",
      })),
    ),
    recovery: asJsonValue({
      profile_id: "supabase-pro-daily-7d",
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
      retention_policy_id: "p4c-disposable-retention",
    }),
    smokeTestIds: SMOKE_TESTS,
  };
}

export function p4cBusinessInputs() {
  return {
    company_name: "P4-C Disposable Lab",
    tenant_slug: "p4c-lab",
    workspace_class: "disposable" as const,
    admin_email: "mykyta.shevchenko@ciphercross.com",
    expected_instances: 1,
    release_channel: "canary" as const,
    residency_policy_id: "eu-eea-reviewed",
    region_id: "eu-west-1",
    data_tier_id: "supabase-pro",
    data_compute_id: "supabase-micro",
    hosting_tier_id: "vercel-pro",
    backup_profile_id: "supabase-pro-daily-7d",
    pricing_catalog_id: "p4c-pricing-2026-07-29",
    retention_policy_id: "p4c-disposable-retention",
    subprocessor_profile_id: "p4c-reviewed-processors",
    smtp_profile_id: "resend-eu-west-1",
    smtp_secret_labels: [
      "lh2-platform/platform/smtp.username",
      "lh2-platform/platform/smtp.password",
    ],
    integration_secret_labels: [],
    support_access_policy: {
      initial_state: "disabled" as const,
      maximum_duration_hours: 24,
    },
  };
}

export async function createP4COwnerOperations(
  repositoryRoot: string,
  registry: Registry,
  redactor: Redactor,
  secretStore: SecretStore = new MacOsKeychainSecretStore(redactor),
): Promise<RegistryOwnerOperationsAdapter> {
  const profile = p4cProfile();
  const ports = await createP4CSdkPorts(
    {
      repositoryRoot: resolve(repositoryRoot),
      allowedTenantSlug: "p4c-lab",
      supabaseOrganizationSlug: profile.dataOwnerScopeId,
      vercelTeamId: profile.hostingOwnerScopeId,
      apexDomain: "ciphercross.dev",
      platformDomain: "app.ciphercross.dev",
      senderDomain: "mail.ciphercross.dev",
      fromIdentity: "no-reply@mail.ciphercross.dev",
      smtpHost: "smtp.resend.com",
      smtpPort: 465,
      smtpRecipient: "mykyta.shevchenko@ciphercross.com",
      sourceGitSha: P4C_SOURCE_GIT_SHA,
    },
    registry,
    secretStore,
    redactor,
  );
  const providers = {
    data: new NeonDataAdapter(ports.data, redactor),
    objectStorage: new R2ObjectStorageAdapter(ports.objectStorage, redactor),
    hosting: new StrictHostingAdapter(ports.hosting, redactor),
    identity: new IdentityOperationsAdapter(ports.identity, redactor),
    email: new StrictSmtpAdapter(ports.smtp, redactor),
    domain: new StrictDomainAdapter(ports.domain, redactor),
    sourceRepository: new StrictSourceRepositoryAdapter(
      ports.sourceRepository,
      redactor,
    ),
  };
  const preflight = new ProviderPreflightService(providers, profile, {
    redactor,
  });
  const planner = new DisposableOnboardingPlanner(registry, profile, preflight);
  const core = new DisposableOnboardingCore(
    registry,
    providers,
    planner,
    () => new Date(),
    true,
  );
  return new RegistryOwnerOperationsAdapter(registry, () => [], core);
}
