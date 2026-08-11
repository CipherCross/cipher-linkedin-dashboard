import assert from "node:assert/strict";
import test from "node:test";

import {
  BetterAuthOperationsClient,
  CloudflareR2OperationsClient,
  DomainOperationsClient,
  NeonPostgresOperationsClient,
  OpsError,
  Redactor,
  SmtpEmailOperationsClient,
  SourceRepositoryOperationsClient,
  S26ProviderBackedOperations,
  VercelOperationsClient,
  type ProviderFetch,
} from "../src/index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const ownership = {
  managedBy: "lh2-platform-ops" as const,
  tenantSlug: "disposable-lab",
  workspaceClass: "disposable" as const,
  contractVersion: "p2.v1" as const,
  registryOwnerId: "11111111-1111-4111-8111-111111111111",
  digest: DIGEST,
};

interface Call { readonly url: string; readonly method: string; readonly body: string | undefined; }

function recordingFetch(calls: Call[], body: unknown = { providerRequestId: "req_s26" }): ProviderFetch {
  return async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const pathname = new URL(url).pathname;
    // Matched by suffix so a base URL that carries its own path prefix still
    // resolves to the same named operation.
    const mapped = pathname.endsWith("/v2/projects")
      ? { project: { id: "neon-project", name: "lh2-disposable-disposable-lab" } }
      : pathname.endsWith("/v11/projects")
        ? { id: "target", name: "lh2-disposable-disposable-lab" }
        : pathname.endsWith("/domains")
          ? { name: "disposable.example.test", verified: true }
          : body;
    return { ok: true, status: 200, headers: { get: () => "req_s26" }, json: async () => mapped };
  };
}

function configuration(calls: Call[], body?: unknown) {
  return {
    baseUrl: "https://provider.example.test",
    scopeId: "provider-scope",
    credential: { resolve: async () => "local-test-credential" },
    fetch: recordingFetch(calls, body),
  };
}

/**
 * The bridge deliberately has a different host and credential from any direct
 * provider API. Asserting origins, not just paths, is what proves a bridge
 * route never travels on a provider's own transport.
 */
function bridgeConfiguration(calls: Call[], body?: unknown) {
  return {
    baseUrl: "https://bridge.example.test",
    scopeId: "provider-scope",
    credential: { resolve: async () => "local-bridge-credential" },
    fetch: recordingFetch(calls, body),
  };
}

test("S26 concrete clients translate only fixed named provider operations", async () => {
  const calls: Call[] = [];
  const neon = new NeonPostgresOperationsClient(configuration(calls), bridgeConfiguration(calls));
  const betterAuth = new BetterAuthOperationsClient(bridgeConfiguration(calls));
  const r2 = new CloudflareR2OperationsClient(configuration(calls), bridgeConfiguration(calls));
  const vercel = new VercelOperationsClient(configuration(calls), bridgeConfiguration(calls));
  const smtp = new SmtpEmailOperationsClient(bridgeConfiguration(calls));
  const domain = new DomainOperationsClient(bridgeConfiguration(calls));
  const source = new SourceRepositoryOperationsClient(bridgeConfiguration(calls));

  await neon.createOrAdoptProject({ organizationId: "neon-owner", deterministicName: "lh2-disposable-disposable-lab", regionId: "aws-eu-central-1", tierId: "neon-free", computeId: "shared", ownership });
  await neon.applySchema({ projectId: "neon-project", baselineVersion: 53, migrationVersions: [54], targetSchemaVersion: 54 });
  await betterAuth.createCompanyAdminAndInvite({ projectId: "tenant-auth", adminEmail: "admin@example.test" });
  await r2.configurePrivateStorage({ projectId: "r2-bucket", bucketId: "lead-photos", visibility: "private" });
  await vercel.createDeploymentTarget({ deterministicName: "lh2-disposable-disposable-lab", workspaceClass: "disposable", runtimeProfileId: "runtime-v1", ownership, automaticPromotionEnabled: false, isolatedPreviewsEnabled: false });
  await vercel.assignDomain({ targetHandle: "target", hostname: "disposable.example.test", ownership, certificateMode: "provider_managed" });
  await vercel.promoteRelease({ targetHandle: "target", releaseHandle: "release" });
  await smtp.configure({ projectId: "tenant-auth", smtpProfileId: "smtp-v1", senderDomain: "example.test", fromIdentity: "ops@example.test", smtpSecretLabels: ["label-a"] });
  await domain.inspect({ hostname: "disposable.example.test", senderDomain: "example.test", workspaceClass: "disposable" });
  await source.inspect({ sourceGitSha: "a".repeat(40), compatibilityEntryId: "release-v1", applicationVersion: "1" });

  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).origin}${new URL(call.url).pathname}`), [
    "POST https://provider.example.test/v2/projects",
    "POST https://bridge.example.test/s26/control-plane/v1/data/portable-schema-apply",
    "POST https://bridge.example.test/s26/control-plane/v1/identity/company-admin-invite",
    "POST https://provider.example.test/client/v4/accounts/provider-scope/r2/buckets",
    "POST https://provider.example.test/v11/projects",
    "POST https://provider.example.test/v10/projects/target/domains",
    "POST https://bridge.example.test/s26/control-plane/v1/hosting/promote",
    "POST https://bridge.example.test/s26/control-plane/v1/smtp/configure",
    "POST https://bridge.example.test/s26/control-plane/v1/domain/inspect",
    "POST https://bridge.example.test/s26/control-plane/v1/source-repository/inspect",
  ]);
  for (const call of calls) {
    assert.equal(call.url.includes("credential"), false);
    assert.equal(call.body?.includes("authorization"), false);
  }
  assert.equal(calls.find((call) => new URL(call.url).pathname === "/v11/projects")?.url.includes("teamId=provider-scope"), true);
  assert.equal(calls.find((call) => new URL(call.url).pathname === "/v10/projects/target/domains")?.url.includes("teamId=provider-scope"), true);
  assert.deepEqual(JSON.parse(calls[0]!.body!), { org_id: "neon-owner", project: { name: "lh2-disposable-disposable-lab", region_id: "aws-eu-central-1" } });
  assert.deepEqual(JSON.parse(calls[3]!.body!), { name: "lead-photos" });
  assert.deepEqual(JSON.parse(calls[4]!.body!), {
    name: "lh2-disposable-disposable-lab",
    environmentVariables: [{
      key: "LH2_OWNERSHIP_MARKER_DIGEST",
      value: ownership.digest,
      type: "plain",
      target: ["production", "preview"],
    }],
  });
});

test("S26 concrete transport quarantines unknown outcomes and redacts credentials", async () => {
  const secret = "local-test-credential";
  const client = new NeonPostgresOperationsClient({
    baseUrl: "https://provider.example.test",
    credential: { resolve: async () => secret },
    fetch: async () => ({ ok: false, status: 503, headers: { get: () => "opaque-request" }, json: async () => ({ token: secret }) }),
  }, bridgeConfiguration([]), new Redactor());
  await assert.rejects(
    client.waitUntilReady("project"),
    (error: unknown) => {
      assert.ok(error instanceof OpsError);
      assert.equal(error.code, "outcome_unknown");
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.equal(error.details.provider_request_id, "opaque-request");
      return true;
    },
  );
});

test("S26 concrete clients reject non-HTTPS transport configuration", () => {
  assert.throws(
    () => new NeonPostgresOperationsClient({ baseUrl: "http://provider.example.test", credential: { resolve: async () => "unused" } }, bridgeConfiguration([])),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
});

test("S26 environment binding forwards only the already-closed application descriptors", async () => {
  const calls: Call[] = [];
  const hosting = new VercelOperationsClient(configuration(calls), bridgeConfiguration(calls));
  await hosting.bindEnvironment({
    targetHandle: "target",
    dataProjectHandle: "neon-project",
    dataProjectName: "lh2-disposable-disposable-lab",
    ownership,
    scope: "production",
    bindings: [{
      name: "VITE_AUTH_PATH",
      valueClass: "public_build",
      source: { kind: "derived_from_plan", planFieldRef: "application.auth_path" },
    }],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0]!.body!), {
    target_handle: "target",
    data_project_id: "neon-project",
    data_project_name: "lh2-disposable-disposable-lab",
    ownership_marker_digest: ownership.digest,
    scope: "production",
    bindings: [
      {
        name: "VITE_AUTH_PATH",
        value_class: "public_build",
        source_kind: "derived_from_plan",
        source: { kind: "derived_from_plan", planFieldRef: "application.auth_path" },
      },
    ],
  });
});

test("Better Auth recovery uses the fixed S26 bridge paths", async () => {
  const calls: Call[] = [];
  const identity = new BetterAuthOperationsClient(bridgeConfiguration(calls, {
    providerRequestId: "req_recovery",
    artifactId: "artifact",
    manifestDigest: DIGEST,
    ownershipMarkerDigest: ownership.digest,
    coverage: ["auth_configuration_identities"],
    itemCount: 1,
    capturedAt: "2030-01-01T00:00:00.000Z",
    reconstructionApproved: false,
  }));
  await identity.captureRecovery({
    tenantSlug: "disposable-lab",
    sourceResourceId: "identity-source",
    recoveryTargetName: "identity-recovery",
    ownership,
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).origin}${new URL(call.url).pathname}`), [
    "POST https://bridge.example.test/s26/control-plane/v1/identity/recovery-capture",
  ]);
});

test("a base URL path prefix is extended, not replaced", async () => {
  const calls: Call[] = [];
  // Neon's control plane lives under /api; an absolute path would address
  // console.neon.tech/v2/projects, which is a 404.
  const neon = new NeonPostgresOperationsClient(
    { ...configuration(calls), baseUrl: "https://provider.example.test/api" },
    bridgeConfiguration(calls),
  );
  await neon.createOrAdoptProject({
    organizationId: "neon-owner", deterministicName: "lh2-disposable-disposable-lab",
    regionId: "aws-eu-central-1", tierId: "neon-free", computeId: "shared", ownership,
  });
  assert.equal(calls[0]!.url, "https://provider.example.test/api/v2/projects");
});

test("preflight inspections travel on the bridge, never on a provider API host", async () => {
  const calls: Call[] = [];
  const inspection = {
    organizationAccessible: true, deterministicNameAvailable: true, existingResourceOwned: false,
    regionAvailable: true, tierAvailable: true, computeAvailable: true, backupCompatible: true,
    authConfigurationSupported: true, validUntil: "2030-01-01T00:00:00.000Z",
  };
  const neon = new NeonPostgresOperationsClient(
    configuration(calls, inspection),
    bridgeConfiguration(calls, inspection),
  );
  const vercel = new VercelOperationsClient(
    configuration(calls, inspection),
    bridgeConfiguration(calls, inspection),
  );

  await neon.inspect({
    organizationId: "neon-owner", deterministicName: "lh2-disposable-disposable-lab",
    regionId: "aws-eu-central-1", tierId: "neon-free", computeId: "shared",
    backupProfileId: "daily", ownership,
  });
  await vercel.inspect({
    deterministicName: "lh2-disposable-disposable-lab", workspaceClass: "disposable",
    runtimeProfileId: "runtime-v1", requiredScheduleCount: 4,
    requiredServerValueCount: 10, requiredPublicValueCount: 1, ownership,
  });

  // Both are bridge vocabulary. Sending either to console.neon.tech or
  // api.vercel.com presents the provider token to a route it does not serve,
  // which is how S26 preflight failed with an opaque 401.
  assert.deepEqual(calls.map((call) => new URL(call.url).origin), [
    "https://bridge.example.test",
    "https://bridge.example.test",
  ]);
});

test("direct mappings return only canonical ownership evidence", async () => {
  const calls: Call[] = [];
  const data = new NeonPostgresOperationsClient(configuration(calls), bridgeConfiguration(calls));
  const resource = await data.createOrAdoptProject({ organizationId: "neon-owner", deterministicName: "lh2-disposable-disposable-lab", regionId: "aws-eu-central-1", tierId: "neon-free", computeId: "shared", ownership });
  assert.equal(resource.ownershipMarkerDigest, ownership.digest);
  assert.equal(JSON.stringify(resource).includes("local-test-credential"), false);
});
