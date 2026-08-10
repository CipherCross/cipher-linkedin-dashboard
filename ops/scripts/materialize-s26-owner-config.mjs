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
  || policy.disposition !== "configuration-valid-plan-blocked"
  || !Array.isArray(policy.catalogs)
  || policy.catalogs.length !== 7
) {
  throw new Error("S26 disposable policy artifact is not the reviewed blocked configuration");
}

const capabilityIds = [
  "ai.classification",
  "ai.coaching",
  "ai.briefing.daily",
  "ai.briefing.weekly",
  "slack.reply_alerts",
  "slack.briefings",
  "airtable.imports",
];

const config = {
  config_version: "s26-owner-runtime.v1",
  providers: {
    neon: {
      base_url: "https://console.neon.tech/api/",
      credential_name: "neon.operations_token",
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
    platform_domain: "app.ciphercross.dev",
    data_owner_scope_id: "org-damp-hill-86577285",
    hosting_owner_scope_id: "team_AB0nAOId1mR7gHxPldsG9f2u",
    source_git_sha: "b2c287af68b5afe46deee27aa3eb829ed0297c60",
    application_version: "s26-b2c287a",
    compatibility_entry_id: "s26-neon-hosting-v1",
    agent_release_id: "sync-agent-1.14.0",
    ingest_protocol_id: "agent-ingest.v1",
    template_set_id: "s26-self-hosted-better-auth-v1",
    sender_domain: "ciphercross.dev",
    from_identity: "noreply@ciphercross.dev",
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
      components: [
        {
          provider: "hosting",
          sku_id: "vercel-commercial-entitlement-pending",
          quantity: 1,
          unit: "team_month",
          low_minor: 0,
          high_minor: 0,
          assumption: "Unavailable until a commercial Vercel entitlement and exact incremental price are provider-verified",
        },
      ],
      pricing_catalog_version: "s26-pricing-2026-08-10",
    },
    capability_budgets: capabilityIds.map((capability) => ({
      capability,
      enabled: false,
      unit: "events",
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
    smoke_test_ids: [
      "schema",
      "auth",
      "rls",
      "storage",
      "api",
      "cron",
      "preview-isolation",
      "smtp",
    ],
  },
};

mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(`${targetPath}\n`);
