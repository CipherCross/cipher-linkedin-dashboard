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
    const mapped = pathname === "/v2/projects"
      ? { project: { id: "neon-project", name: "lh2-disposable-disposable-lab" } }
      : pathname === "/v11/projects"
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

test("S26 concrete clients translate only fixed named provider operations", async () => {
  const calls: Call[] = [];
  const neon = new NeonPostgresOperationsClient(configuration(calls));
  const betterAuth = new BetterAuthOperationsClient(configuration(calls));
  const r2 = new CloudflareR2OperationsClient(configuration(calls));
  const vercel = new VercelOperationsClient(configuration(calls));
  const smtp = new SmtpEmailOperationsClient(configuration(calls));
  const domain = new DomainOperationsClient(configuration(calls));
  const source = new SourceRepositoryOperationsClient(configuration(calls));

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

  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    "POST /v2/projects",
    "POST /s26/control-plane/v1/data/portable-schema-apply",
    "POST /s26/control-plane/v1/identity/company-admin-invite",
    "POST /client/v4/accounts/provider-scope/r2/buckets",
    "POST /v11/projects",
    "POST /v10/projects/target/domains",
    "POST /s26/control-plane/v1/hosting/promote",
    "POST /s26/control-plane/v1/smtp/configure",
    "POST /s26/control-plane/v1/domain/inspect",
    "POST /s26/control-plane/v1/source-repository/inspect",
  ]);
  for (const call of calls) {
    assert.equal(call.url.includes("credential"), false);
    assert.equal(call.body?.includes("authorization"), false);
  }
  assert.equal(calls.find((call) => new URL(call.url).pathname === "/v11/projects")?.url.includes("teamId=provider-scope"), true);
  assert.equal(calls.find((call) => new URL(call.url).pathname === "/v10/projects/target/domains")?.url.includes("teamId=provider-scope"), true);
  assert.deepEqual(JSON.parse(calls[0]!.body!), { org_id: "neon-owner", project: { name: "lh2-disposable-disposable-lab", region_id: "aws-eu-central-1" } });
  assert.deepEqual(JSON.parse(calls[3]!.body!), { name: "lead-photos" });
});

test("S26 concrete transport quarantines unknown outcomes and redacts credentials", async () => {
  const secret = "local-test-credential";
  const client = new NeonPostgresOperationsClient({
    baseUrl: "https://provider.example.test",
    credential: { resolve: async () => secret },
    fetch: async () => ({ ok: false, status: 503, headers: { get: () => "opaque-request" }, json: async () => ({ token: secret }) }),
  }, new Redactor());
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
    () => new NeonPostgresOperationsClient({ baseUrl: "http://provider.example.test", credential: { resolve: async () => "unused" } }),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
});

test("Better Auth recovery uses the fixed S26 bridge paths", async () => {
  const calls: Call[] = [];
  const identity = new BetterAuthOperationsClient(configuration(calls, {
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
  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    "POST /s26/control-plane/v1/identity/recovery-capture",
  ]);
});

test("direct mappings return only canonical ownership evidence", async () => {
  const calls: Call[] = [];
  const data = new NeonPostgresOperationsClient(configuration(calls));
  const resource = await data.createOrAdoptProject({ organizationId: "neon-owner", deterministicName: "lh2-disposable-disposable-lab", regionId: "aws-eu-central-1", tierId: "neon-free", computeId: "shared", ownership });
  assert.equal(resource.ownershipMarkerDigest, ownership.digest);
  assert.equal(JSON.stringify(resource).includes("local-test-credential"), false);
});
