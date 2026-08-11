import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OpsError,
  Registry,
  assertOperationTransition,
  assertPlanTransition,
  assertStepTransition,
  assertTenantTransition,
} from "../src/index.js";
import {
  OWNER_UUID,
  TEST_NOW,
  catalogResolver,
  makeApplyRequest,
  makeOnboardingPlan,
  makeReleasePlan,
  observedSnapshots,
} from "./fixtures.js";

function errorCode(error: unknown, code: OpsError["code"]): boolean {
  return error instanceof OpsError && error.code === code;
}

test("closed state machines allow contract transitions and reject forbidden ones", () => {
  assert.doesNotThrow(() => assertPlanTransition("valid", "consumed"));
  assert.doesNotThrow(() => assertTenantTransition("active", "suspended"));
  assert.doesNotThrow(() =>
    assertOperationTransition("failed", "running", "tenant_onboarding"),
  );
  assert.doesNotThrow(() => assertStepTransition("outcome_unknown", "running"));

  assert.throws(
    () => assertTenantTransition("active", "retained"),
    (error: unknown) => errorCode(error, "invalid_state_transition"),
  );
  assert.throws(
    () => assertOperationTransition("running", "partially_succeeded", "tenant_onboarding"),
    (error: unknown) => errorCode(error, "invalid_state_transition"),
  );
  assert.throws(
    () => assertStepTransition("succeeded", "running"),
    (error: unknown) => errorCode(error, "invalid_state_transition"),
  );
});

test("a healthy running operation may resume after its lock lease lapses", () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const plan = makeOnboardingPlan();
    registry.savePlan(plan, { catalogs: catalogResolver(), now: TEST_NOW });
    const request = makeApplyRequest(plan);
    const started = registry.startOrResumeOperation(request, "owner", observedSnapshots(), TEST_NOW);
    assert.equal(started.state, "running");

    // Within the lease, a retry stays read-only and keeps the same token.
    const soon = new Date(TEST_NOW.getTime() + 30_000);
    const held = registry.startOrResumeOperation(request, "owner", observedSnapshots(), soon);
    assert.deepEqual(held, { ...started, resumed: true });
    const versionAfterHeldRetry = registry.registryVersion;

    // Past the lease, the operation is still ours and still running, so it must
    // be able to carry on. This used to hand back the stale token, which
    // #assertFence then rejected because the lock had expired — so every later
    // resume of a HEALTHY operation failed lock_fence_lost for good. Only an
    // operation whose steps kept failing escaped, because the failed branch
    // re-acquires the lease.
    const lapsed = new Date(TEST_NOW.getTime() + 6 * 60 * 1_000);
    const renewed = registry.startOrResumeOperation(request, "owner", observedSnapshots(), lapsed);
    assert.equal(renewed.operationId, started.operationId);
    assert.equal(renewed.state, "running");
    assert.ok(
      renewed.fencingToken > started.fencingToken,
      "a renewed lease must bump the fencing token so a stale writer is fenced out",
    );
    assert.ok(registry.registryVersion > versionAfterHeldRetry, "renewal is a write");

    // The renewed token really is usable, which is the whole point.
    assert.doesNotThrow(() => registry.transitionStep(
      renewed.operationId,
      1,
      "running",
      renewed.fencingToken,
      { now: lapsed },
    ));
    registry.verifyAuditChain();
  } finally {
    registry.close();
  }
});

test("apply is atomic and idempotent; consumed plans cannot be reused", () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const plan = makeOnboardingPlan();
    registry.savePlan(plan, { catalogs: catalogResolver(), now: TEST_NOW });
    assert.equal(registry.registryVersion, 1);

    const request = makeApplyRequest(plan);
    const first = registry.startOrResumeOperation(
      request,
      "owner",
      observedSnapshots(),
      TEST_NOW,
    );
    assert.equal(first.resumed, false);
    assert.equal(first.state, "running");
    assert.equal(first.fencingToken, 1);
    assert.equal(registry.registryVersion, 2);
    assert.equal(registry.listSteps(first.operationId).length, 13);
    const database = registry.unsafeDatabaseForTests();
    assert.equal(
      Number(database.prepare("SELECT COUNT(*) AS count FROM capability_budgets").get()!.count),
      7,
    );
    assert.equal(
      Number(database.prepare("SELECT COUNT(*) AS count FROM recovery_profiles").get()!.count),
      1,
    );

    const retry = registry.startOrResumeOperation(
      request,
      "owner",
      observedSnapshots(),
      TEST_NOW,
    );
    assert.deepEqual(retry, { ...first, resumed: true });
    assert.equal(registry.registryVersion, 2, "read-only retry must not bump version");

    assert.throws(
      () =>
        registry.startOrResumeOperation(
          makeApplyRequest(plan, { idempotency_key: "onboard-acme-different-key" }),
          "owner",
          observedSnapshots(),
          TEST_NOW,
        ),
      (error: unknown) => errorCode(error, "plan_already_consumed"),
    );
    assert.equal(registry.registryVersion, 2);
    registry.verifyAuditChain();
  } finally {
    registry.close();
  }
});

test("same scope/key with another plan digest is an idempotency conflict", () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const firstPlan = makeOnboardingPlan();
    registry.savePlan(firstPlan, { catalogs: catalogResolver(), now: TEST_NOW });
    const key = "stable-idempotency-key-0001";
    registry.startOrResumeOperation(
      makeApplyRequest(firstPlan, { idempotency_key: key }),
      "owner",
      observedSnapshots(),
      TEST_NOW,
    );

    const secondPlan = makeOnboardingPlan({
      planId: "pln_zyxwvutsrqponmlkjihg",
      expectedRegistryVersion: 3,
      mutateSpec(spec) {
        const cost = spec.cost as Record<string, unknown>;
        cost.usage_ceiling_minor = 12000;
      },
    });
    registry.savePlan(secondPlan, { catalogs: catalogResolver(), now: TEST_NOW });
    assert.throws(
      () =>
        registry.startOrResumeOperation(
          makeApplyRequest(secondPlan, { idempotency_key: key }),
          "owner",
          observedSnapshots(),
          TEST_NOW,
        ),
      (error: unknown) => errorCode(error, "idempotency_conflict"),
    );
  } finally {
    registry.close();
  }
});

test("provider snapshot drift blocks apply without changing registry", () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const plan = makeOnboardingPlan();
    registry.savePlan(plan, { catalogs: catalogResolver(), now: TEST_NOW });
    const drifted = observedSnapshots().map((snapshot) =>
      snapshot.provider === "hosting"
        ? { ...snapshot, digest: `sha256:${"f".repeat(64)}` }
        : snapshot,
    );
    assert.throws(
      () =>
        registry.startOrResumeOperation(
          makeApplyRequest(plan),
          "owner",
          drifted,
          TEST_NOW,
        ),
      (error: unknown) => errorCode(error, "provider_snapshot_drift"),
    );
    assert.equal(registry.registryVersion, 1);
  } finally {
    registry.close();
  }
});

test("a concurrent plan for the same tenant fails with lock_conflict and rolls back", () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const firstPlan = makeOnboardingPlan();
    registry.savePlan(firstPlan, { catalogs: catalogResolver(), now: TEST_NOW });
    registry.startOrResumeOperation(
      makeApplyRequest(firstPlan),
      "owner",
      observedSnapshots(),
      TEST_NOW,
    );

    const competingPlan = makeOnboardingPlan({
      planId: "pln_competingplanabcdefgh",
      expectedRegistryVersion: 3,
    });
    registry.savePlan(competingPlan, { catalogs: catalogResolver(), now: TEST_NOW });
    assert.throws(
      () =>
        registry.startOrResumeOperation(
          makeApplyRequest(competingPlan, {
            idempotency_key: "competing-operation-key",
          }),
          "owner",
          observedSnapshots(),
          TEST_NOW,
        ),
      (error: unknown) => errorCode(error, "lock_conflict"),
    );
    assert.equal(registry.registryVersion, 3, "failed transaction must not bump version");
  } finally {
    registry.close();
  }
});

test("release plans share digest/version/idempotency core and may partially succeed", () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const plan = makeReleasePlan();
    registry.savePlan(plan, { now: TEST_NOW });
    const request = makeApplyRequest(plan, {
      idempotency_key: "release-2030-idempotency-key",
    });
    const started = registry.startOrResumeOperation(request, "owner", [], TEST_NOW);
    registry.transitionOperation(
      started.operationId,
      "partially_succeeded",
      started.fencingToken,
      { now: TEST_NOW },
    );
    assert.equal(
      registry.getOperation(started.operationId)?.state,
      "partially_succeeded",
    );
    const retry = registry.startOrResumeOperation(request, "owner", [], TEST_NOW);
    assert.equal(retry.operationId, started.operationId);
    assert.equal(retry.state, "partially_succeeded");
    registry.verifyAuditChain();
  } finally {
    registry.close();
  }
});

test("audit is hash-linked and append-only", () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const plan = makeOnboardingPlan();
    registry.savePlan(plan, { catalogs: catalogResolver(), now: TEST_NOW });
    registry.verifyAuditChain();
    const database = registry.unsafeDatabaseForTests();
    assert.throws(() =>
      database.prepare("UPDATE audit_entries SET actor = 'tampered' WHERE sequence = 1").run(),
    );
    assert.throws(() =>
      database.prepare("DELETE FROM audit_entries WHERE sequence = 1").run(),
    );
    registry.verifyAuditChain();
  } finally {
    registry.close();
  }
});

test("SQLite registry version and audit survive a close/reopen cycle", () => {
  const directory = mkdtempSync(join(tmpdir(), "lh2-ops-registry-"));
  const path = join(directory, "registry.sqlite");
  try {
    const first = new Registry(path, OWNER_UUID);
    const plan = makeOnboardingPlan();
    first.savePlan(plan, { catalogs: catalogResolver(), now: TEST_NOW });
    first.close();

    const reopened = new Registry(path, OWNER_UUID);
    try {
      assert.equal(reopened.registryVersion, 1);
      reopened.verifyAuditChain();
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
