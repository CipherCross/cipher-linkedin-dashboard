import assert from "node:assert/strict";
import test from "node:test";

import {
  BetterAuthOperationsClient,
  CloudflareR2OperationsClient,
  DomainOperationsClient,
  neonOwnershipRoleName,
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
    // The adoption reads find nothing, so creation proceeds. A provider says
    // "no such project/domain" with 404, which is the only answer that lets an
    // adopting client tell an absent resource from a refused request.
    if (init.method === "GET" && /^\/v(9|10)\/projects\//.test(pathname)) {
      return { ok: false, status: 404, headers: { get: () => "req_s26" }, json: async () => ({}) };
    }
    // Matched by suffix so a base URL that carries its own path prefix still
    // resolves to the same named operation.
    const mapped = pathname.endsWith("/v2/projects") && init.method === "GET"
      // The adoption search finds nothing, so creation proceeds.
      ? { projects: [] }
      : pathname.endsWith("/v2/projects")
      ? {
        project: { id: "neon-project", name: "lh2-disposable-disposable-lab" },
        branch: { id: "br-main" },
      }
      : pathname.endsWith("/v11/projects")
        ? { id: "target", name: "lh2-disposable-disposable-lab" }
        : pathname.endsWith("/v9/projects/target") && init.method === "PATCH"
          ? { id: "target", autoAssignCustomDomains: false, previewDeploymentsDisabled: true }
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
  await betterAuth.createCompanyAdminAndInvite({ projectId: "tenant-auth", adminEmail: "admin@example.test", siteUrl: "https://tenant.example.test" });
  await r2.configurePrivateStorage({ projectId: "r2-bucket", bucketId: "lead-photos", visibility: "private" });
  await vercel.createDeploymentTarget({ deterministicName: "lh2-disposable-disposable-lab", workspaceClass: "disposable", runtimeProfileId: "runtime-v1", ownership, automaticPromotionEnabled: false, isolatedPreviewsEnabled: false });
  await vercel.assignDomain({ targetHandle: "target", hostname: "disposable.example.test", ownership, certificateMode: "provider_managed" });
  await vercel.promoteRelease({ targetHandle: "target", releaseHandle: "release", hostname: "tenant.example.test" });
  await smtp.configure({ projectId: "tenant-auth", smtpProfileId: "smtp-v1", senderDomain: "example.test", fromIdentity: "ops@example.test", smtpSecretLabels: ["label-a"] });
  await domain.inspect({ hostname: "disposable.example.test", senderDomain: "example.test", workspaceClass: "disposable" });
  await source.inspect({ sourceGitSha: "a".repeat(40), compatibilityEntryId: "release-v1", applicationVersion: "1" });

  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).origin}${new URL(call.url).pathname}`), [
    "GET https://provider.example.test/v2/projects",
    "POST https://provider.example.test/v2/projects",
    "POST https://provider.example.test/v2/projects/neon-project/branches/br-main/roles",
    "POST https://bridge.example.test/s26/control-plane/v1/data/portable-schema-apply",
    "POST https://bridge.example.test/s26/control-plane/v1/identity/company-admin-invite",
    "POST https://provider.example.test/client/v4/accounts/provider-scope/r2/buckets",
    "GET https://provider.example.test/v9/projects/lh2-disposable-disposable-lab",
    "POST https://provider.example.test/v11/projects",
    "PATCH https://provider.example.test/v9/projects/target",
    "GET https://provider.example.test/v10/projects/target/domains/disposable.example.test",
    "POST https://provider.example.test/v10/projects/target/domains",
    "POST https://bridge.example.test/s26/control-plane/v1/hosting/promote",
    "POST https://bridge.example.test/s26/control-plane/v1/smtp/configure",
    "POST https://bridge.example.test/s26/control-plane/v1/domain/inspect",
    "POST https://bridge.example.test/s26/control-plane/v1/source-repository/inspect",
  ]);
  for (const call of calls) {
    assert.equal(call.url.includes("credential"), false);
    // A GET carries no body; the assertion must not pass vacuously either way.
    assert.notEqual(call.body?.includes("authorization"), true);
  }
  assert.equal(calls.find((call) => new URL(call.url).pathname === "/v11/projects")?.url.includes("teamId=provider-scope"), true);
  assert.equal(calls.find((call) => new URL(call.url).pathname === "/v10/projects/target/domains")?.url.includes("teamId=provider-scope"), true);
  assert.deepEqual(JSON.parse(calls[1]!.body!), { org_id: "provider-scope", project: { name: "lh2-disposable-disposable-lab", region_id: "aws-eu-central-1" } });
  assert.deepEqual(JSON.parse(calls[5]!.body!), { name: "lead-photos" });
  assert.deepEqual(JSON.parse(calls[7]!.body!), {
    name: "lh2-disposable-disposable-lab",
    previewDeploymentsDisabled: true,
    environmentVariables: [{
      key: "LH2_OWNERSHIP_MARKER_DIGEST",
      value: ownership.digest,
      type: "plain",
      target: ["production", "preview"],
    }],
  });
  assert.deepEqual(JSON.parse(calls[8]!.body!), {
    autoAssignCustomDomains: false,
    previewDeploymentsDisabled: true,
  });
});

test("S26 concrete transport quarantines unknown outcomes and redacts credentials", async () => {
  const secret = "local-test-credential";
  const client = new NeonPostgresOperationsClient({
    baseUrl: "https://provider.example.test",
    scopeId: "provider-scope",
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

// The bridge derives its HTTP status FROM a deterministic OpsError code, so on
// that transport the status alone is lossy: provider_error and
// provider_readiness_blocked both leave as 409. Reading only the status recorded
// the live step-3 schema-apply refusal as `outcome_unknown`, which quarantined
// the operation behind ambiguity that no evidence could resolve — while the
// database had in fact rejected one statement deterministically.
function bridgeFailure(status: number, body: unknown, requestId = "opaque-request") {
  return {
    baseUrl: "https://bridge.example.test",
    scopeId: "provider-scope",
    controlPlaneBridge: true,
    credential: { resolve: async () => "local-bridge-credential" },
    fetch: async () => ({
      ok: false,
      status,
      headers: { get: () => requestId },
      json: async () => {
        if (body === undefined) throw new Error("response body is not JSON");
        return body;
      },
    }),
  };
}

async function schemaApplyFailure(bridge: ReturnType<typeof bridgeFailure>): Promise<OpsError> {
  const client = new NeonPostgresOperationsClient(
    { baseUrl: "https://provider.example.test", scopeId: "provider-scope", credential: { resolve: async () => "unused" } },
    bridge,
    new Redactor(),
  );
  try {
    await client.applySchema({ projectId: "neon-project", baselineVersion: 53, migrationVersions: [54], targetSchemaVersion: 54 });
  } catch (error) {
    assert.ok(error instanceof OpsError);
    return error;
  }
  throw new Error("the bridge failure did not reject");
}

test("a deterministic control-plane bridge failure keeps its own code instead of becoming ambiguous", async () => {
  const decided = await schemaApplyFailure(
    bridgeFailure(409, { code: "provider_error", provider_request_id: "bridge-request-7" }),
  );
  assert.equal(decided.code, "provider_error");
  // The bridge's own request id is better evidence than the missing header that
  // left the live registry holding "provider-request-unknown".
  assert.equal(decided.details.provider_request_id, "bridge-request-7");

  const blocked = await schemaApplyFailure(bridgeFailure(409, { code: "provider_readiness_blocked" }));
  assert.equal(blocked.code, "provider_readiness_blocked");

  const secrets = await schemaApplyFailure(bridgeFailure(503, { code: "secret_store_error" }));
  assert.equal(secrets.code, "secret_store_error");
});

test("a genuinely ambiguous outcome is never downgraded by the bridge body", async () => {
  // The bridge reports a real unknown outcome with 502 and says so in the body.
  const reported = await schemaApplyFailure(bridgeFailure(502, { code: "outcome_unknown" }));
  assert.equal(reported.code, "outcome_unknown");

  // A body that is not ours at all — an edge or proxy failure — must fall back to
  // the conservative status mapping rather than being trusted.
  const unparseable = await schemaApplyFailure(bridgeFailure(409, undefined));
  assert.equal(unparseable.code, "outcome_unknown");

  // A code outside the closed deterministic set is not honoured either, so the
  // set cannot be widened by whatever a response happens to claim.
  const unknownCode = await schemaApplyFailure(bridgeFailure(409, { code: "lock_conflict" }));
  assert.equal(unknownCode.code, "outcome_unknown");

  // The bridge's own non-OpsError bodies are outside the set too, so they take
  // the status mapping: 401 is decided, and an unrecognised body on an ambiguous
  // status stays ambiguous.
  const rejected = await schemaApplyFailure(bridgeFailure(401, { code: "unauthorized" }));
  assert.equal(rejected.code, "provider_error");
  const ambiguous = await schemaApplyFailure(bridgeFailure(409, { code: "unauthorized" }));
  assert.equal(ambiguous.code, "outcome_unknown");
});

test("the deterministic body rule does not apply to a third-party provider endpoint", async () => {
  // Same body, same status, but an arbitrary provider host: a 409 mid-mutation
  // there really is ambiguous, and no provider owes us this vocabulary.
  const client = new NeonPostgresOperationsClient(
    {
      baseUrl: "https://provider.example.test",
      scopeId: "provider-scope",
      credential: { resolve: async () => "unused" },
      fetch: async () => ({
        ok: false,
        status: 409,
        headers: { get: () => "opaque-request" },
        json: async () => ({ code: "provider_error" }),
      }),
    },
    bridgeConfiguration([]),
    new Redactor(),
  );
  await assert.rejects(client.waitUntilReady("project"), (error: unknown) => {
    assert.ok(error instanceof OpsError);
    assert.equal(error.code, "outcome_unknown");
    return true;
  });
});

// Step 4 stopped live on `outcome_unknown: Provider request failed with status
// 409` against a bucket it had itself created. Cloudflare answers an existing
// bucket with 409, the direct transport reads any 409 as ambiguous — correctly,
// for an arbitrary provider — and the adopt branch required `provider_error`, so
// the one status that means "already there" could never reach it.
function r2WithExistingBucket(statusForCreate: number, buckets: readonly string[], listOk = true) {
  const calls: string[] = [];
  const transport = {
    baseUrl: "https://r2.example.test",
    scopeId: "account-scope",
    credential: { resolve: async () => "local-r2-credential" },
    fetch: async (url: string, init: { method: string }) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      if (init.method === "POST") {
        return { ok: false, status: statusForCreate, headers: { get: () => null }, json: async () => ({}) };
      }
      if (!listOk) {
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => "r2-list-request" },
        json: async () => ({ result: { buckets: buckets.map((name) => ({ name })) } }),
      };
    },
  };
  return { client: new CloudflareR2OperationsClient(transport as never, bridgeConfiguration([]), new Redactor()), calls };
}

test("an R2 bucket the account already holds is adopted whatever status the create returned", async () => {
  // 409 is the live case. 400 is the same conflict under Cloudflare's other
  // spelling of error 10004, so neither may depend on the create's classification.
  for (const status of [409, 400, 500]) {
    const { client, calls } = r2WithExistingBucket(status, ["lead-photos"]);
    const adopted = await client.configurePrivateStorage({
      projectId: "neon-project", bucketId: "lead-photos", visibility: "private",
    });
    assert.equal(adopted.providerRequestId, "r2-list-request");
    assert.deepEqual(calls, [
      "POST /client/v4/accounts/account-scope/r2/buckets",
      "GET /client/v4/accounts/account-scope/r2/buckets",
    ]);
  }
});

test("a failed R2 create that did not leave the bucket keeps its original error", async () => {
  // The confirming read is what resolves the ambiguity, so when it finds nothing
  // the create's own code must survive untouched — an unknown stays unknown
  // rather than being reported as a decided failure.
  const { client } = r2WithExistingBucket(409, ["some-other-bucket"]);
  await assert.rejects(
    client.configurePrivateStorage({ projectId: "neon-project", bucketId: "lead-photos", visibility: "private" }),
    (error: unknown) => {
      assert.ok(error instanceof OpsError);
      assert.equal(error.code, "outcome_unknown");
      return true;
    },
  );

  const refused = r2WithExistingBucket(403, ["some-other-bucket"]);
  await assert.rejects(
    refused.client.configurePrivateStorage({ projectId: "neon-project", bucketId: "lead-photos", visibility: "private" }),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );

  // When the confirming read fails too it proves nothing, so the create's error
  // stands rather than the read's — otherwise a bad credential would be reported
  // as whatever the second call happened to return.
  const unreadable = r2WithExistingBucket(409, ["lead-photos"], false);
  await assert.rejects(
    unreadable.client.configurePrivateStorage({ projectId: "neon-project", bucketId: "lead-photos", visibility: "private" }),
    (error: unknown) => {
      assert.ok(error instanceof OpsError);
      assert.equal(error.code, "outcome_unknown");
      assert.equal(error.details.provider_status, 409);
      return true;
    },
  );
});

// Step 7 failed live with `Unrecognized key: "providerRequestId"`. Hosting
// results name their request id `hostingRequestId`, set by the bridge, and the
// canonical schemas are strict — so the key the transport adds to every response
// is rejected. createDeploymentTarget and assignDomain build their result by hand
// and map the id across, which is why steps 6 and 8 passed while every hosting
// call that returns the bridge body as-is failed.
test("hosting results drop the request id the transport adds, so strict schemas accept them", async () => {
  const hostingBody = (extra: Record<string, unknown>) => ({
    hostingRequestId: "bridge-hosting-request",
    ...extra,
  });
  const bridge = (body: Record<string, unknown>) => ({
    baseUrl: "https://bridge.example.test",
    scopeId: "provider-scope",
    controlPlaneBridge: true,
    credential: { resolve: async () => "local-bridge-credential" },
    // Mirrors PrivateProviderHttp: the transport appends providerRequestId.
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "transport-request-id" },
      json: async () => body,
    }),
  });

  const client = (body: Record<string, unknown>) => new VercelOperationsClient(
    { baseUrl: "https://vercel.example.test", scopeId: "team-scope", credential: { resolve: async () => "unused" } },
    bridge(body) as never,
    new Redactor(),
  );

  const bound = await client(hostingBody({
    targetHandle: "target", scope: "production", bindings: [],
  })).bindEnvironment({
    targetHandle: "target",
    dataProjectHandle: "neon-project",
    dataProjectName: "lh2-disposable-disposable-lab",
    ownership,
    scope: "production",
    bindings: [{ name: "DATABASE_URL", valueClass: "server_secret", source: { kind: "secret_label", secretLabel: "db" } }],
  } as never);
  assert.equal(Object.hasOwn(bound as object, "providerRequestId"), false);
  assert.equal((bound as { hostingRequestId: string }).hostingRequestId, "bridge-hosting-request");

  const promoted = await client(hostingBody({
    targetHandle: "target", releaseHandle: "release", active: true,
  })).promoteRelease({ targetHandle: "target", releaseHandle: "release", hostname: "tenant.example.test" });
  assert.equal(Object.hasOwn(promoted as object, "providerRequestId"), false);

  const scheduled = await client(hostingBody({
    targetHandle: "target", releaseHandle: "release", schedules: [], manifestDigest: DIGEST,
  })).registerSchedules({ targetHandle: "target", releaseHandle: "release", schedules: [], manifestDigest: DIGEST });
  assert.equal(Object.hasOwn(scheduled as object, "providerRequestId"), false);

  // The bridge's own id must survive: dropping it would lose the only handle on
  // the hosting request.
  assert.equal((scheduled as { hostingRequestId: string }).hostingRequestId, "bridge-hosting-request");
});

// Neon answers 423 Locked on a branch operation issued right after
// POST /projects, because the project is still initialising. Onboarding `uitop`
// lost the ownership marker to exactly that, and the loss is unrecoverable: an
// unmarked project reads back as foreign, so its name is taken and it can never
// be adopted.
test("the Neon ownership marker survives a project that is still locked", async () => {
  const posts: string[] = [];
  let markerAttempts = 0;
  const transport = {
    baseUrl: "https://neon.example.test",
    scopeId: "org-scope",
    credential: { resolve: async () => "local-neon-credential" },
    fetch: async (url: string, init: { method: string }) => {
      const pathname = new URL(url).pathname;
      if (init.method === "GET") {
        return { ok: true, status: 200, headers: { get: () => "req" }, json: async () => ({ projects: [] }) };
      }
      posts.push(pathname);
      if (pathname.endsWith("/roles")) {
        markerAttempts += 1;
        // Locked twice, then the project finishes initialising.
        if (markerAttempts < 3) {
          return { ok: false, status: 423, headers: { get: () => "req" }, json: async () => ({}) };
        }
        return { ok: true, status: 200, headers: { get: () => "req" }, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => "req" },
        json: async () => ({ project: { id: "neon-uitop", name: "lh2-disposable-uitop" }, branch: { id: "br-main" } }),
      };
    },
  };
  const client = new NeonPostgresOperationsClient(transport as never, bridgeConfiguration([]), new Redactor());
  const created = await client.createOrAdoptProject({
    organizationId: "org-scope",
    deterministicName: "lh2-disposable-uitop",
    regionId: "aws-eu-central-1",
    tierId: "neon-free",
    computeId: "shared",
    ownership,
  });
  assert.equal(created.resourceId, "neon-uitop");
  assert.equal(created.adopted, false);
  assert.equal(markerAttempts, 3, "the marker write must be retried while the project is locked");
  // Exactly one project was created; only the marker was repeated.
  assert.equal(posts.filter((path) => path.endsWith("/v2/projects")).length, 1);
});

test("a deterministic refusal of the ownership marker is not retried", async () => {
  let markerAttempts = 0;
  const transport = {
    baseUrl: "https://neon.example.test",
    scopeId: "org-scope",
    credential: { resolve: async () => "local-neon-credential" },
    fetch: async (url: string, init: { method: string }) => {
      const pathname = new URL(url).pathname;
      if (init.method === "GET") {
        return { ok: true, status: 200, headers: { get: () => "req" }, json: async () => ({ projects: [] }) };
      }
      if (pathname.endsWith("/roles")) {
        markerAttempts += 1;
        return { ok: false, status: 400, headers: { get: () => "req" }, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => "req" },
        json: async () => ({ project: { id: "neon-uitop", name: "lh2-disposable-uitop" }, branch: { id: "br-main" } }),
      };
    },
  };
  const client = new NeonPostgresOperationsClient(transport as never, bridgeConfiguration([]), new Redactor());
  await assert.rejects(client.createOrAdoptProject({
    organizationId: "org-scope",
    deterministicName: "lh2-disposable-uitop",
    regionId: "aws-eu-central-1",
    tierId: "neon-free",
    computeId: "shared",
    ownership,
  }));
  assert.equal(markerAttempts, 1, "a 400 is decided, so repeating it would only waste time");
});

test("S26 concrete clients reject non-HTTPS transport configuration", () => {
  assert.throws(
    () => new NeonPostgresOperationsClient({ baseUrl: "http://provider.example.test", scopeId: "provider-scope", credential: { resolve: async () => "unused" } }, bridgeConfiguration([])),
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
    siteUrl: "https://tenant.example.test",
    tenantSlug: "disposable-lab",
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
    // The tenant's own origin travels with the binding: IDENTITY_BASE_URL is
    // derived from it, so it may not be left to a control-plane-wide setting.
    site_url: "https://tenant.example.test",
    // As does the tenant the deployment serves: APP_TENANT_ID is derived from
    // it, and without it the machine-ingest path answers 503 for every notebook.
    tenant_slug: "disposable-lab",
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

test("creating a Neon project writes the ownership marker onto it", async () => {
  const calls: Call[] = [];
  const neon = new NeonPostgresOperationsClient(configuration(calls), bridgeConfiguration(calls));
  await neon.createOrAdoptProject({
    organizationId: "neon-owner", deterministicName: "lh2-disposable-disposable-lab",
    regionId: "aws-eu-central-1", tierId: "neon-free", computeId: "shared", ownership,
  });

  // Without this role the project reads back as foreign on the next
  // inspection, which blocks every step after its own creation.
  const marker = calls.find((call) => call.url.endsWith("/roles"));
  assert.ok(marker, "project creation must write an ownership marker");
  assert.deepEqual(JSON.parse(marker.body!), {
    role: { name: `lh2_owner_${"a".repeat(32)}` },
  });
});

test("a malformed ownership digest cannot produce a marker name", () => {
  assert.throws(
    () => neonOwnershipRoleName("not-a-digest"),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
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
  assert.equal(calls[1]!.url, "https://provider.example.test/api/v2/projects");
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

test("an owned Vercel project is adopted without a second create", async () => {
  const calls: Call[] = [];
  const direct = configuration(calls);
  direct.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const pathname = new URL(url).pathname;
    const value = pathname.endsWith("/v9/projects/lh2-disposable-disposable-lab")
      ? {
        id: "existing-target",
        name: "lh2-disposable-disposable-lab",
        autoAssignCustomDomains: false,
        previewDeploymentsDisabled: true,
      }
      : pathname.endsWith("/v9/projects/existing-target/env")
        ? { envs: [{ key: "LH2_OWNERSHIP_MARKER_DIGEST", value: ownership.digest }] }
        : {};
    return { ok: true, status: 200, headers: { get: () => "req_adopt" }, json: async () => value };
  };
  const result = await new VercelOperationsClient(direct, bridgeConfiguration([]))
    .createDeploymentTarget({
      deterministicName: "lh2-disposable-disposable-lab",
      workspaceClass: "disposable",
      runtimeProfileId: "runtime-v1",
      ownership,
      automaticPromotionEnabled: false,
      isolatedPreviewsEnabled: false,
    });
  assert.equal(result.adopted, true);
  assert.equal(result.targetHandle, "existing-target");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
});

test("a foreign Vercel project with the deterministic name is never adopted", async () => {
  const calls: Call[] = [];
  const direct = configuration(calls);
  direct.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const pathname = new URL(url).pathname;
    const value = pathname.endsWith("/env")
      ? { envs: [{ key: "LH2_OWNERSHIP_MARKER_DIGEST", value: `sha256:${"f".repeat(64)}` }] }
      : { id: "foreign-target", name: "lh2-disposable-disposable-lab" };
    return { ok: true, status: 200, headers: { get: () => "req_foreign" }, json: async () => value };
  };
  const client = new VercelOperationsClient(direct, bridgeConfiguration([]));
  await assert.rejects(
    client.createDeploymentTarget({
      deterministicName: "lh2-disposable-disposable-lab",
      workspaceClass: "disposable",
      runtimeProfileId: "runtime-v1",
      ownership,
      automaticPromotionEnabled: false,
      isolatedPreviewsEnabled: false,
    }),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
});

test("an owned Vercel project is normalized to staged production before adoption", async () => {
  const calls: Call[] = [];
  const direct = configuration(calls);
  direct.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const pathname = new URL(url).pathname;
    const value = pathname.endsWith("/env")
      ? { envs: [{ key: "LH2_OWNERSHIP_MARKER_DIGEST", value: ownership.digest }] }
      : init.method === "PATCH"
        ? { id: "existing-target", autoAssignCustomDomains: false, previewDeploymentsDisabled: true }
        : {
          id: "existing-target",
          name: "lh2-disposable-disposable-lab",
          autoAssignCustomDomains: true,
          previewDeploymentsDisabled: false,
        };
    return { ok: true, status: 200, headers: { get: () => "req_normalize" }, json: async () => value };
  };
  const result = await new VercelOperationsClient(direct, bridgeConfiguration([]))
    .createDeploymentTarget({
      deterministicName: "lh2-disposable-disposable-lab",
      workspaceClass: "disposable",
      runtimeProfileId: "runtime-v1",
      ownership,
      automaticPromotionEnabled: false,
      isolatedPreviewsEnabled: false,
    });
  assert.equal(result.adopted, true);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "PATCH"]);
  assert.deepEqual(JSON.parse(calls[2]!.body!), {
    autoAssignCustomDomains: false,
    previewDeploymentsDisabled: true,
  });
});

test("an existing domain binding on the same Vercel target is adopted", async () => {
  const calls: Call[] = [];
  const direct = configuration(calls);
  direct.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "req_domain_adopt" },
      json: async () => ({ name: "disposable.example.test", verified: true }),
    };
  };
  const result = await new VercelOperationsClient(direct, bridgeConfiguration([])).assignDomain({
    targetHandle: "existing-target",
    hostname: "disposable.example.test",
    ownership,
    certificateMode: "provider_managed",
  });
  assert.equal(result.assigned, true);
  assert.equal(result.certificateReady, true);
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});
