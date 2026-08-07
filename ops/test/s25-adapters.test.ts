import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeHostingProvider,
  FakeOnboardingProviderBundle,
  FakeIdentityProvider,
  FakeNeonDataProvider,
  FakeObjectStorageProvider,
  FakeSmtpProvider,
  FakeDomainProvider,
  FakeSourceRepositoryProvider,
  OnboardingExecutor,
  IdentityOperationsAdapter,
  NeonDataAdapter,
  OpsError,
  R2ObjectStorageAdapter,
  Redactor,
  Registry,
  StrictHostingAdapter,
  type DataInspectionRequest,
  type HostingOperationsApi,
  type IdentityOperationsApi,
  type NeonOperationsApi,
  type ObjectStorageOperationsApi,
} from "../src/index.js";
import {
  OWNER_UUID,
  TEST_NOW,
  executionContext,
  makeApplyRequest,
  makeOnboardingPlan,
  observedSnapshots,
  catalogResolver,
} from "./fixtures.js";

const ownership = {
  managedBy: "lh2-platform-ops" as const,
  tenantSlug: "disposable-lab",
  workspaceClass: "disposable" as const,
  contractVersion: "p2.v1" as const,
  registryOwnerId: "11111111-1111-4111-8111-111111111111",
  digest: `sha256:${"1".repeat(64)}`,
};

const dataRequest: DataInspectionRequest = {
  organizationId: "neon-owner-scope",
  deterministicName: "lh2-disposable-disposable-lab",
  regionId: "eu-central-1",
  tierId: "neon-free",
  computeId: "shared",
  backupProfileId: "neon-daily-7d",
  ownership,
};

test("S25 neutral API contracts accept interchangeable fake adapters", async () => {
  const dataApi: NeonOperationsApi = new FakeNeonDataProvider();
  const identityApi: IdentityOperationsApi = new FakeIdentityProvider();
  const storageApi: ObjectStorageOperationsApi = new FakeObjectStorageProvider();
  const hostingApi: HostingOperationsApi = new FakeHostingProvider();

  const redactor = new Redactor();
  const data = new NeonDataAdapter(dataApi, redactor);
  const identity = new IdentityOperationsAdapter(identityApi, redactor);
  const storage = new R2ObjectStorageAdapter(storageApi, redactor);
  const hosting = new StrictHostingAdapter(hostingApi, redactor);

  assert.equal((await data.inspect(dataRequest)).organizationAccessible, true);
  const resource = await data.createOrAdoptProject({
    organizationId: dataRequest.organizationId,
    deterministicName: dataRequest.deterministicName,
    regionId: dataRequest.regionId,
    tierId: dataRequest.tierId,
    computeId: dataRequest.computeId,
    ownership,
  });
  const adopted = await data.createOrAdoptProject({
    organizationId: dataRequest.organizationId,
    deterministicName: dataRequest.deterministicName,
    regionId: dataRequest.regionId,
    tierId: dataRequest.tierId,
    computeId: dataRequest.computeId,
    ownership,
  });
  assert.equal(resource.adopted, false);
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.resourceId, resource.resourceId);

  assert.equal(
    (await identity.inspect({
      templateSetId: "template-v1",
      siteUrl: "https://disposable-lab.example.test",
      redirectUrls: ["https://disposable-lab.example.test/auth/callback"],
      releaseCompatibilityId: "release-v1",
    })).inviteFlowSupported,
    true,
  );
  assert.match(
    (await storage.configurePrivateStorage({
      projectId: resource.resourceId,
      bucketId: "lead-photos",
      visibility: "private",
    })).providerRequestId,
    /^req_/,
  );
  assert.equal(typeof (await hosting.inspect({
    deterministicName: dataRequest.deterministicName,
    workspaceClass: "disposable",
    runtimeProfileId: "web-node22-1x",
    requiredScheduleCount: 4,
    requiredServerValueCount: 10,
    requiredPublicValueCount: 4,
    ownership,
  })), "object");
});

test("S25 adapters reject ambiguous ownership and preserve deterministic adoption", async () => {
  const data = new NeonDataAdapter(new FakeNeonDataProvider());
  const request = {
    organizationId: dataRequest.organizationId,
    deterministicName: dataRequest.deterministicName,
    regionId: dataRequest.regionId,
    tierId: dataRequest.tierId,
    computeId: dataRequest.computeId,
    ownership,
  };
  await data.createOrAdoptProject(request);
  await assert.rejects(
    data.createOrAdoptProject({
      ...request,
      ownership: { ...ownership, digest: `sha256:${"2".repeat(64)}` },
    }),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
});

test("S25 outcome-unknown adapter effects retain the request ID for resume", async () => {
  const data = new NeonDataAdapter(
    new FakeNeonDataProvider([
      { method: "createOrAdoptProject", call: 1, timing: "outcome_unknown" },
    ]),
  );
  await assert.rejects(
    data.createOrAdoptProject({
      organizationId: dataRequest.organizationId,
      deterministicName: dataRequest.deterministicName,
      regionId: dataRequest.regionId,
      tierId: dataRequest.tierId,
      computeId: dataRequest.computeId,
      ownership,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OpsError);
      assert.equal(error.code, "outcome_unknown");
      assert.match(String(error.details.provider_request_id), /^req_/);
      return true;
    },
  );
  const resumed = await data.createOrAdoptProject({
    organizationId: dataRequest.organizationId,
    deterministicName: dataRequest.deterministicName,
    regionId: dataRequest.regionId,
    tierId: dataRequest.tierId,
    computeId: dataRequest.computeId,
    ownership,
  });
  assert.equal(resumed.adopted, true);
});

test("S25 executor persists an unknown action ID on the quarantined step", async () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const plan = makeOnboardingPlan();
    registry.savePlan(plan, { catalogs: catalogResolver(), now: TEST_NOW });
    const started = registry.startOrResumeOperation(
      makeApplyRequest(plan),
      "s25-test",
      observedSnapshots(),
      TEST_NOW,
    );
    const providers = {
      data: new FakeNeonDataProvider([
        { method: "createOrAdoptProject", call: 1, timing: "outcome_unknown" },
      ]),
      identity: new FakeIdentityProvider(),
      objectStorage: new FakeObjectStorageProvider(),
      hosting: new FakeHostingProvider(),
      email: new FakeSmtpProvider(),
      domain: new FakeDomainProvider(),
      sourceRepository: new FakeSourceRepositoryProvider(),
    };
    const executor = new OnboardingExecutor(registry, providers);
    const context = executionContext(plan, started.operationId, started.fencingToken);
    await executor.executeNext(context);
    await assert.rejects(() => executor.executeNext(context));
    const step = registry.listSteps(started.operationId)[1]!;
    assert.equal(step.state, "outcome_unknown");
    assert.match(step.providerRequestId ?? "", /^req_/);
    assert.equal(registry.getTenantLifecycle(context.tenantId), "quarantined");
  } finally {
    registry.close();
  }
});

test("S25 canonical adapter results and errors are secret-free", async () => {
  const secret = "s25-provider-secret-canary";
  class LeakyDataApi extends FakeNeonDataProvider {
    override async inspect(request: DataInspectionRequest) {
      return { ...(await super.inspect(request)), leaked: secret };
    }
  }
  const adapter = new NeonDataAdapter(new LeakyDataApi(), new Redactor([secret]));
  await assert.rejects(
    adapter.inspect(dataRequest),
    (error: unknown) => {
      assert.ok(error instanceof OpsError);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
});

test("S25 fake runtime bundle is wired by canonical capability names", () => {
  const bundle = new FakeOnboardingProviderBundle();
  assert.deepEqual(
    Object.keys(bundle).sort(),
    [
      "data",
      "domain",
      "email",
      "hosting",
      "identity",
      "objectStorage",
      "sourceRepository",
    ].sort(),
  );
});
