import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createConfiguredS26Runtime,
  loadS26OwnerRuntimeConfig,
  MemorySecretStore,
  OpsError,
  Registry,
  runCli,
  s26BusinessInputs,
  type SecretStore,
} from "../src/index.js";
import {
  disposableBusinessInputs,
  disposableProfile,
  makeCatalogs,
  OWNER_UUID,
} from "./fixtures.js";

function configValue() {
  const profile = disposableProfile();
  const inputs = disposableBusinessInputs(profile.allowedTenantSlug);
  return {
    config_version: "s26-owner-runtime.v1",
    providers: {
      neon: { base_url: "https://console.neon.tech/api/", credential_name: "neon.operations_token", scope_id: "neon-org" },
      r2: { base_url: "https://api.cloudflare.com/", credential_name: "r2.operations_token", scope_id: "cloudflare-account" },
      vercel: { base_url: "https://api.vercel.com/", credential_name: "vercel.operations_token", scope_id: "vercel-team" },
      bridge: { base_url: "https://s26-control.example.test/", credential_name: "s26.bridge_token" },
    },
    profile: {
      allowed_tenant_slug: profile.allowedTenantSlug,
      selections: {
        company_name: inputs.company_name,
        admin_email: inputs.admin_email,
        expected_instances: inputs.expected_instances,
        release_channel: inputs.release_channel,
        residency_policy_id: inputs.residency_policy_id,
        region_id: inputs.region_id,
        data_tier_id: inputs.data_tier_id,
        data_compute_id: inputs.data_compute_id,
        hosting_tier_id: inputs.hosting_tier_id,
        backup_profile_id: inputs.backup_profile_id,
        retention_policy_id: inputs.retention_policy_id,
        subprocessor_profile_id: inputs.subprocessor_profile_id,
        smtp_profile_id: inputs.smtp_profile_id,
        smtp_secret_labels: inputs.smtp_secret_labels,
        support_access_maximum_duration_hours:
          inputs.support_access_policy.maximum_duration_hours,
      },
      platform_domain: profile.platformDomain,
      data_owner_scope_id: profile.dataOwnerScopeId,
      hosting_owner_scope_id: profile.hostingOwnerScopeId,
      source_git_sha: profile.sourceGitSha,
      application_version: profile.applicationVersion,
      compatibility_entry_id: profile.compatibilityEntryId,
      agent_release_id: profile.agentReleaseId,
      ingest_protocol_id: profile.ingestProtocolId,
      template_set_id: profile.templateSetId,
      sender_domain: profile.senderDomain,
      from_identity: profile.fromIdentity,
      baseline_version: 53,
      migration_versions: profile.migrationVersions,
      target_schema_version: profile.targetSchemaVersion,
      catalogs: makeCatalogs(),
      cost: profile.cost,
      capability_budgets: profile.capabilityBudgets,
      recovery: profile.recovery,
      smoke_test_ids: profile.smokeTestIds,
    },
  };
}

async function inTemporaryDirectory(run: (directory: string) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "lh2-s26-config-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("S26 configuration is closed, HTTPS-only, and contains no credential value field", async () => {
  await inTemporaryDirectory((directory) => {
    const path = join(directory, "s26.json");
    const value = configValue();
    writeFileSync(path, JSON.stringify(value), "utf8");
    const parsed = loadS26OwnerRuntimeConfig(path);
    assert.equal(parsed.providers.neon.credential_name, "neon.operations_token");
    assert.equal("token" in parsed.providers.neon, false);

    writeFileSync(path, JSON.stringify({ ...value, unexpected: true }), "utf8");
    assert.throws(
      () => loadS26OwnerRuntimeConfig(path),
      (error: unknown) => error instanceof OpsError && error.code === "invalid_plan",
    );

    writeFileSync(path, JSON.stringify({
      ...value,
      providers: { ...value.providers, neon: { ...value.providers.neon, base_url: "http://neon.example.test" } },
    }), "utf8");
    assert.throws(
      () => loadS26OwnerRuntimeConfig(path),
      (error: unknown) => error instanceof OpsError && error.code === "invalid_plan",
    );
  });
});

test("S26 configuration rejects changed catalog content and duplicate kinds", async () => {
  await inTemporaryDirectory((directory) => {
    const path = join(directory, "s26.json");
    const value = configValue();
    const first = value.profile.catalogs[0]!;
    const tampered = {
      ...value,
      profile: {
        ...value.profile,
        catalogs: [
          {
            ...first,
            entries: [
              { ...first.entries[0]!, approved: false },
              ...first.entries.slice(1),
            ],
          },
          ...value.profile.catalogs.slice(1),
        ],
      },
    };
    writeFileSync(path, JSON.stringify(tampered), "utf8");
    assert.throws(
      () => loadS26OwnerRuntimeConfig(path),
      (error: unknown) => error instanceof OpsError && error.code === "catalog_invalid",
    );

    const duplicateKinds = {
      ...value,
      profile: {
        ...value.profile,
        catalogs: [
          value.profile.catalogs[0]!,
          value.profile.catalogs[0]!,
          ...value.profile.catalogs.slice(2),
        ],
      },
    };
    writeFileSync(path, JSON.stringify(duplicateKinds), "utf8");
    assert.throws(
      () => loadS26OwnerRuntimeConfig(path),
      (error: unknown) => error instanceof OpsError && error.code === "catalog_invalid",
    );
  });
});

test("S26 runtime construction does not resolve Keychain values or instantiate P4-C", async () => {
  await inTemporaryDirectory((directory) => {
    const path = join(directory, "s26.json");
    writeFileSync(path, JSON.stringify(configValue()), "utf8");
    const registry = new Registry(join(directory, "registry.sqlite"), OWNER_UUID);
    let credentialReads = 0;
    const store: SecretStore = {
      async set() { throw new Error("not used"); },
      async get() { credentialReads += 1; throw new Error("not used"); },
      async has() { return false; },
    };
    try {
      const runtime = createConfiguredS26Runtime(registry, path, undefined, store);
      assert.ok(runtime.ownerOperations);
      assert.equal(credentialReads, 0);
    } finally {
      registry.close();
    }
  });
});

test("S26 plans on its own selections, never another runtime's", async () => {
  await inTemporaryDirectory((directory) => {
    const path = join(directory, "s26.json");
    writeFileSync(path, JSON.stringify(configValue()), "utf8");
    const config = loadS26OwnerRuntimeConfig(path);
    const inputs = s26BusinessInputs(config);

    // The tenant slug the plan targets must be the one the profile allows;
    // a foreign slug would inspect and later create the wrong tenant.
    assert.equal(inputs.tenant_slug, config.profile.allowed_tenant_slug);
    assert.equal(inputs.workspace_class, "disposable");

    // The validator compares this pair for equality, so it is read off the
    // pinned pricing snapshot rather than restated by hand.
    const pricing = config.profile.catalogs.find(
      (catalog) => catalog.catalog_kind === "pricing",
    );
    assert.equal(inputs.pricing_catalog_id, pricing?.catalog_version);

    // Every catalog id comes from the reviewed selections block.
    const chosen = config.profile.selections;
    assert.equal(inputs.region_id, chosen.region_id);
    assert.equal(inputs.data_tier_id, chosen.data_tier_id);
    assert.equal(inputs.hosting_tier_id, chosen.hosting_tier_id);
    assert.equal(inputs.subprocessor_profile_id, chosen.subprocessor_profile_id);
    assert.deepEqual(inputs.integration_secret_labels, []);
  });
});

test("owner CLI requires an explicit provider runtime for tenant operations", async () => {
  await inTemporaryDirectory(async (directory) => {
    const path = join(directory, "registry.sqlite");
    const registry = new Registry(path, OWNER_UUID);
    registry.close();
    const errors: string[] = [];
    const code = await runCli(["tenant", "preflight", "--registry", path], {
      stdout: () => undefined,
      stderr: (value) => errors.push(value),
      makeSecretStore: () => new MemorySecretStore(),
    });
    assert.equal(code, 2);
    assert.match(errors.join("\n"), /explicit --p4c or --s26 runtime/);
  });
});
