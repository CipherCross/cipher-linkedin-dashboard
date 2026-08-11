import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

interface WorkerConfiguration {
  readonly vars: Readonly<Record<string, string>>;
  readonly secrets: { readonly required: readonly string[] };
  readonly r2_buckets: readonly { readonly binding: string; readonly bucket_name: string }[];
}

function workerConfiguration(): WorkerConfiguration {
  const path = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as WorkerConfiguration;
}

test("S26 Worker deployment requires only genuine deployment and preflight credentials", () => {
  const configuration = workerConfiguration();
  assert.deepEqual(configuration.secrets.required, [
    "BRIDGE_BEARER_SECRET",
    "NEON_API_TOKEN",
    "VERCEL_API_TOKEN",
    "RESEND_API_KEY",
    "SOURCE_REPOSITORY_TOKEN",
  ]);
  assert.deepEqual(configuration.r2_buckets, [
    { binding: "CONTROL_PLANE_OBJECTS", bucket_name: "linkedin-campaign-dashboard" },
    { binding: "TENANT_LEAD_PHOTOS", bucket_name: "lead-photos" },
  ]);
  for (const forbidden of [
    "TENANT_DATABASE_URL",
    "TENANT_DATA_API_PUBLIC_KEY",
    "TENANT_DATA_API_ADMIN_KEY",
    "TENANT_SCHEDULE_INVOKE_SECRET",
    "TENANT_INGEST_INVOKE_SECRET",
    "TENANT_TOOL_BRIDGE_SECRET",
    "BETTER_AUTH_SESSION_SECRET",
    "TENANT_R2_ACCESS_KEY_ID",
    "TENANT_R2_SECRET_ACCESS_KEY",
    "OBJECT_STORAGE_ACCESS_KEY_ID",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  ]) {
    assert.equal(configuration.secrets.required.includes(forbidden), false);
    assert.equal(Object.hasOwn(configuration.vars, forbidden), false);
  }
});

test("S26 provider, catalog, profile, and release selections are non-secret closed configuration", () => {
  const { vars, secrets } = workerConfiguration();
  for (const name of [
    "NEON_ORGANIZATION_ID",
    "NEON_REGION_ID",
    "NEON_TIER_ID",
    "NEON_COMPUTE_ID",
    "NEON_BACKUP_PROFILE_ID",
    "NEON_APPLICATION_ROLE_NAME",
    "NEON_AI_ROLE_NAME",
    "NEON_MACHINE_ROLE_NAME",
    "NEON_IDENTITY_STORE_ROLE_NAME",
    "S26_APPLICATION_HOSTING_CONTRACT",
    "S26_APPLICATION_DATA_PLANE_READY",
    "VERCEL_TEAM_ID",
    "VERCEL_BUILD_RECIPE_ID",
    "RESEND_SMTP_PROFILE_ID",
    "BETTER_AUTH_TEMPLATE_SET_ID",
    "RELEASE_COMPATIBILITY_ID",
    "APPROVED_APPLICATION_VERSION",
    "APPROVED_SCHEDULE_MANIFEST_DIGEST",
    "APPROVED_SOURCE_GIT_SHA",
  ]) {
    assert.equal(Object.hasOwn(vars, name), true, `${name} must be a non-secret Worker variable`);
    assert.equal(secrets.required.includes(name), false, `${name} must not be classified as a secret`);
  }
  assert.equal(
    vars.APPROVED_SOURCE_GIT_SHA,
    "b2c287af68b5afe46deee27aa3eb829ed0297c60",
    "the closed source selection must match the owner-approved published release",
  );
  assert.equal(/^[0-9a-f]{40}$/.test(vars.APPROVED_SOURCE_GIT_SHA), true);
  assert.equal(vars.S26_APPLICATION_HOSTING_CONTRACT, "hosting.environment.v3");
  assert.equal(vars.S26_APPLICATION_DATA_PLANE_READY, "true");
  assert.deepEqual(
    {
      region: vars.NEON_REGION_ID,
      tier: vars.NEON_TIER_ID,
      compute: vars.NEON_COMPUTE_ID,
      backup: vars.NEON_BACKUP_PROFILE_ID,
      template: vars.BETTER_AUTH_TEMPLATE_SET_ID,
      compatibility: vars.RELEASE_COMPATIBILITY_ID,
      application: vars.APPROVED_APPLICATION_VERSION,
      schedule: vars.APPROVED_SCHEDULE_MANIFEST_DIGEST,
    },
    {
      region: "aws-eu-central-1",
      tier: "neon-free",
      compute: "autoscale-0.25-2cu",
      backup: "neon-free-restore-6h",
      template: "s26-self-hosted-better-auth-v1",
      compatibility: "s26-neon-hosting-v1",
      application: "s26-b2c287a",
      schedule: "sha256:688baed28906755e59c836917b63626a44d00b2c544a7a82fe98b2cafe492ebc",
    },
  );
});
