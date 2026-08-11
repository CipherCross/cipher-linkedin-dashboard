import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const policyPath = resolve(
  scriptDirectory,
  "../../docs/platform-ops/catalogs/s26-disposable-policy-v1.json",
);
const targetPath = resolve(
  homedir(),
  ".config/lh2-platform/s26-owner-runtime.json",
);
const policy = JSON.parse(readFileSync(policyPath, "utf8"));

if (
  policy.policy_id !== "s26-disposable-policy-v1"
  || policy.disposition !== "configuration-valid-plan-eligible"
  || !Array.isArray(policy.catalogs)
  || policy.catalogs.length !== 7
  || policy.blocking_conditions.length !== 0
) {
  throw new Error("S26 disposable policy artifact is not the reviewed plan-eligible configuration");
}

// Each budget's unit must equal that capability's metering unit, so it is read
// off the approved capabilities catalog rather than restated here.
const capabilityCatalog = policy.catalogs.find(
  (catalog) => catalog.catalog_kind === "capabilities",
);
const capabilities = capabilityCatalog.entries.map((entry) => ({
  id: entry.id,
  meteringUnit: entry.metering_unit,
}));

// The onboarding contract fixes this suite exactly; it is not a free selection.
const smokeTestIds = [
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
];

const config = {
  config_version: "s26-owner-runtime.v1",
  providers: {
    neon: {
      base_url: "https://console.neon.tech/api/",
      credential_name: "neon.operations_token",
      scope_id: "org-damp-hill-86577285",
    },
    r2: {
      base_url: "https://api.cloudflare.com/",
      credential_name: "r2.operations_token",
      scope_id: "eb89cc458183927bebefdebe1f751880",
    },
    vercel: {
      base_url: "https://api.vercel.com/",
      credential_name: "vercel.operations_token",
      scope_id: "team_AB0nAOId1mR7gHxPldsG9f2u",
    },
    bridge: {
      base_url: "https://lh2-s26-control-plane.s26.workers.dev/",
      credential_name: "s26.bridge_token",
    },
  },
  profile: {
    allowed_tenant_slug: "s26-disposable-lab",
    selections: {
      company_name: "S26 Disposable Lab",
      admin_email: "accounts@ciphercross.com",
      expected_instances: 1,
      release_channel: "canary",
      residency_policy_id: "eu-disposable-policy",
      region_id: "aws-eu-central-1",
      data_tier_id: "neon-free",
      data_compute_id: "autoscale-0.25-2cu",
      hosting_tier_id: "vercel-hobby",
      // Neon Free's actual restore window is the provider-level profile;
      // s26-disposable-daily remains the platform recovery profile below.
      backup_profile_id: "neon-free-restore-6h",
      retention_policy_id: "retention-30d",
      subprocessor_profile_id: "s26-disposable-processors",
      smtp_profile_id: "resend-eu-west-1",
      smtp_secret_labels: [
        "lh2-platform/platform/smtp.username",
        "lh2-platform/platform/smtp.password",
      ],
      support_access_maximum_duration_hours: 24,
    },
    // The disposable drill binds no owned zone; it uses the hostname
    // Vercel serves itself.
    platform_domain: "vercel.app",
    data_owner_scope_id: "org-damp-hill-86577285",
    hosting_owner_scope_id: "team_AB0nAOId1mR7gHxPldsG9f2u",
    source_git_sha: "fc4729e0968f79ca13cb7b751abdbf14db612658",
    application_version: "s26-fc4729e",
    compatibility_entry_id: "s26-neon-hosting-v1",
    agent_release_id: "sync-agent-1.14.0",
    ingest_protocol_id: "agent-ingest.v1",
    template_set_id: "s26-self-hosted-better-auth-v1",
    // The verified Resend domain is the mail subdomain, not the apex.
    sender_domain: "mail.ciphercross.dev",
    from_identity: "noreply@mail.ciphercross.dev",
    baseline_version: 53,
    migration_versions: [54],
    target_schema_version: 54,
    catalogs: policy.catalogs,
    cost: {
      currency: "USD",
      tax_included: false,
      billing_period: "monthly",
      recurring_low_minor: 0,
      recurring_high_minor: 0,
      usage_ceiling_minor: 0,
      one_time_minor: 0,
      // The contract requires at least one component. The drill buys nothing,
      // so it declares the free Neon project at zero cost.
      components: [
        {
          provider: "data",
          sku_id: "neon-free-project-month",
          quantity: 1,
          unit: "tenant_month",
          low_minor: 0,
          high_minor: 0,
          assumption: "Neon Free project for a disposable, non-production drill; no paid entitlement is selected",
        },
      ],
      pricing_catalog_version: "s26-pricing-2026-08-10",
    },
    capability_budgets: capabilities.map(({ id, meteringUnit }) => ({
      capability: id,
      enabled: false,
      unit: meteringUnit,
      period: "calendar_month",
      soft_limit: 0,
      hard_limit: 0,
      overage_action: "disable_and_alert",
    })),
    recovery: {
      profile_id: "s26-disposable-daily",
      rpo_hours: 24,
      rto_business_hours: 8,
      business_timezone: "Europe/Madrid",
      provider_backup_interval_hours: 24,
      encrypted_export_interval_hours: 24,
      restore_drill_interval_days: 90,
      coverage: [
        "database_schema_data",
        "auth_configuration_identities",
        "storage_metadata",
        "private_storage_objects_or_reconstruction",
        "deployment_configuration_metadata",
      ],
      retention_policy_id: "retention-30d",
    },
    smoke_test_ids: smokeTestIds,
  },
};

mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(`${targetPath}\n`);
