import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeOnboardingProviderBundle,
  FakeSupabaseProvider,
  OnboardingExecutor,
  OpsError,
  Registry,
} from "../src/index.js";
import {
  OWNER_UUID,
  TENANT_UUID,
  TEST_NOW,
  catalogResolver,
  executionContext,
  makeApplyRequest,
  makeOnboardingPlan,
  observedSnapshots,
} from "./fixtures.js";

test("provider fakes inject failures before and after effects deterministically", async () => {
  const request = {
    organizationId: "sb-org-1",
    deterministicName: "lh2-external-acme-team",
    regionId: "eu-west",
    tierId: "supabase-pro",
    computeId: "supabase-small",
    ownership: executionContext(
      makeOnboardingPlan(),
      "op_abcdefghijklmnopqrst",
      1,
    ).ownership,
  };
  const before = new FakeSupabaseProvider([
    { method: "createOrAdoptProject", call: 1, timing: "before_effect" },
  ]);
  await assert.rejects(
    before.createOrAdoptProject(request),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
  assert.equal(before.projectCount, 0);

  const after = new FakeSupabaseProvider([
    { method: "createOrAdoptProject", call: 1, timing: "after_effect" },
  ]);
  await assert.rejects(
    after.createOrAdoptProject(request),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
  assert.equal(after.projectCount, 1);
  const reconciled = await after.createOrAdoptProject(request);
  assert.equal(reconciled.adopted, true);
  assert.equal(after.projectCount, 1);
  await assert.rejects(
    after.createOrAdoptProject({
      ...request,
      ownership: { ...request.ownership, digest: `sha256:${"f".repeat(64)}` },
    }),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
});

test("outcome-unknown create reconciles by deterministic identity without duplicate resources", async () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const plan = makeOnboardingPlan();
    registry.savePlan(plan, { catalogs: catalogResolver(), now: TEST_NOW });
    const request = makeApplyRequest(plan);
    const started = registry.startOrResumeOperation(
      request,
      "owner",
      observedSnapshots(),
      TEST_NOW,
    );
    const providers = new FakeOnboardingProviderBundle({
      supabase: [
        {
          method: "createOrAdoptProject",
          call: 1,
          timing: "outcome_unknown",
        },
      ],
    });
    const executor = new OnboardingExecutor(registry, providers);
    let context = executionContext(plan, started.operationId, started.fencingToken);

    assert.equal((await executor.executeNext(context)).ordinal, 1);
    await assert.rejects(
      executor.executeNext(context),
      (error: unknown) => error instanceof OpsError && error.code === "outcome_unknown",
    );
    assert.equal(providers.supabase.projectCount, 1);
    assert.equal(registry.countResourceReferences(TENANT_UUID), 0);
    assert.equal(registry.getOperation(started.operationId)?.state, "failed");
    assert.equal(registry.getTenantLifecycle(TENANT_UUID), "quarantined");

    const resumed = registry.startOrResumeOperation(
      {
        ...request,
        operation_id: started.operationId,
        expected_registry_version: registry.registryVersion,
      },
      "owner",
      observedSnapshots(),
      TEST_NOW,
    );
    assert.equal(resumed.fencingToken, 2);
    context = executionContext(plan, resumed.operationId, resumed.fencingToken);
    assert.equal((await executor.executeNext(context)).ordinal, 2);
    assert.equal(providers.supabase.projectCount, 1, "retry must adopt, not create a second project");
    assert.equal(registry.countResourceReferences(TENANT_UUID), 1);

    assert.throws(
      () =>
        registry.transitionStep(
          resumed.operationId,
          3,
          "running",
          started.fencingToken,
          { now: TEST_NOW },
        ),
      (error: unknown) => error instanceof OpsError && error.code === "lock_fence_lost",
    );
    registry.verifyAuditChain();
  } finally {
    registry.close();
  }
});

test("full fake onboarding finishes in order and invites admin only after smoke tests", async () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const plan = makeOnboardingPlan();
    registry.savePlan(plan, { catalogs: catalogResolver(), now: TEST_NOW });
    const started = registry.startOrResumeOperation(
      makeApplyRequest(plan),
      "owner",
      observedSnapshots(),
      TEST_NOW,
    );
    const providers = new FakeOnboardingProviderBundle();
    let executor = new OnboardingExecutor(registry, providers);
    const context = executionContext(plan, started.operationId, started.fencingToken);

    for (let ordinal = 1; ordinal <= 13; ordinal += 1) {
      const result = await executor.executeNext(context);
      assert.equal(result.ordinal, ordinal);
      if (ordinal === 9) {
        executor = new OnboardingExecutor(registry, providers);
      }
      if (ordinal < 12) {
        assert.equal(
          providers.auth.callCount("createCompanyAdminAndInvite"),
          0,
        );
      }
    }

    assert.equal(registry.getOperation(started.operationId)?.state, "succeeded");
    assert.equal(registry.getTenantLifecycle(TENANT_UUID), "active");
    assert.equal(providers.supabase.projectCount, 1);
    assert.equal(providers.vercel.projectCount, 1);
    assert.equal(providers.auth.callCount("createCompanyAdminAndInvite"), 1);
    assert.equal(registry.countResourceReferences(TENANT_UUID), 4);
    assert.ok(
      registry.listSteps(started.operationId).every((step) => step.state === "succeeded"),
    );
    registry.verifyAuditChain();
  } finally {
    registry.close();
  }
});
