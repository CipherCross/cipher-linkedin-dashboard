import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DisposableOnboardingCore,
  DisposableOnboardingPlanner,
  FakeOnboardingProviderBundle,
  ONBOARDING_STEP_KINDS,
  OpsError,
  ProviderPreflightService,
  Registry,
  RegistryBackupService,
} from "../src/index.js";
import {
  disposableBusinessInputs,
  disposableProfile,
} from "./fixtures.js";

const OWNER_UUID = "11111111-1111-4111-8111-111111111111";
const FIXTURE_NOW = new Date("2026-08-07T14:46:13.317Z");
const FIXTURE_PLAN_ID = "pln_5fa149c9e209cd9aa2c9f7e8";
const FIXTURE_PLAN_DIGEST =
  "sha256:5c3df59773c1e302ab3e2cf983dc4a6afe5d99321198f3d6660b7911b78bbc18";
const FIXTURE_IDEMPOTENCY_KEY = "s26-disposable-lab-20260807-01";

async function fixtureCore(
  rules: ConstructorParameters<typeof FakeOnboardingProviderBundle>[0] = {},
) {
  const registry = new Registry(":memory:", OWNER_UUID);
  const profile = disposableProfile();
  const providers = new FakeOnboardingProviderBundle(rules);
  const preflight = new ProviderPreflightService(providers, profile, {
    clock: () => FIXTURE_NOW,
  });
  const planner = new DisposableOnboardingPlanner(
    registry,
    profile,
    preflight,
    () => FIXTURE_NOW,
  );
  const core = new DisposableOnboardingCore(
    registry,
    providers,
    planner,
    () => FIXTURE_NOW,
  );
  const planned = await core.planOnboarding(disposableBusinessInputs());
  assert.equal(planned.preflight.status, "passed");
  assert.deepEqual(planned.preflight.blockers, []);
  assert.equal(planned.envelope.plan_id, FIXTURE_PLAN_ID);
  assert.equal(planned.envelope.plan_digest, FIXTURE_PLAN_DIGEST);
  assert.equal(planned.envelope.expected_registry_version, 1);
  const spec = planned.envelope.spec as Record<string, unknown>;
  return {
    core,
    plan: planned.envelope,
    providers,
    registry,
    tenantId: String((spec.resources as Record<string, unknown>).tenant_id),
  };
}

function fixtureRequest(expectedRegistryVersion = 1) {
  return {
    contract_version: "p2.v1" as const,
    operation_kind: "tenant_onboarding" as const,
    plan_id: FIXTURE_PLAN_ID,
    plan_digest: FIXTURE_PLAN_DIGEST,
    expected_registry_version: expectedRegistryVersion,
    idempotency_key: FIXTURE_IDEMPOTENCY_KEY,
  };
}

async function runAllSteps(
  bundle: Awaited<ReturnType<typeof fixtureCore>>,
) {
  const results = [];
  let request = fixtureRequest();
  for (let ordinal = 1; ordinal <= ONBOARDING_STEP_KINDS.length; ordinal += 1) {
    const result = await bundle.core.applyOrResume(request);
    assert.equal(result.executedOrdinal, ordinal);
    results.push(result);
    request = {
      ...request,
      expected_registry_version: bundle.registry.registryVersion,
    };
  }
  return results;
}

test("S26 deterministic fake plan completes the disposable onboarding fixture", async () => {
  const bundle = await fixtureCore();
  try {
    const results = await runAllSteps(bundle);
    const operationId = results.at(-1)!.operationId;
    const operation = bundle.registry.getOperation(operationId);
    const steps = bundle.registry.listSteps(operationId);

    assert.equal(operation?.state, "succeeded");
    assert.equal(bundle.registry.getTenantLifecycle(bundle.tenantId), "active");
    assert.deepEqual(
      steps.map((step) => step.kind),
      [...ONBOARDING_STEP_KINDS],
    );
    assert.ok(steps.every((step) => step.state === "succeeded"));
    assert.equal(bundle.providers.data.projectCount, 1);
    assert.equal(bundle.providers.hosting.targetCount, 1);
    assert.equal(
      bundle.providers.identity.callCount("createCompanyAdminAndInvite"),
      1,
    );
    assert.equal(bundle.registry.countResourceReferences(bundle.tenantId), 4);
    const repeated = await bundle.core.applyOrResume(
      fixtureRequest(bundle.registry.registryVersion),
    );
    assert.equal(repeated.executedOrdinal, null);
    assert.equal(repeated.state, "succeeded");
    const spec = bundle.plan.spec as Record<string, unknown>;
    assert.deepEqual(
      (spec.recovery as { coverage: readonly string[] }).coverage,
      [
        "database_schema_data",
        "auth_configuration_identities",
        "storage_metadata",
        "private_storage_objects_or_reconstruction",
        "deployment_configuration_metadata",
      ],
    );
    assert.ok(
      (spec.smoke_tests as readonly { id: string }[]).some(
        (smoke) => smoke.id === "rls_role_boundaries",
      ),
    );
    bundle.registry.verifyAuditChain();
  } finally {
    bundle.registry.close();
  }
});

test("S26 finalization cannot commit a split step, tenant, and operation state", async () => {
  const bundle = await fixtureCore();
  try {
    let request = fixtureRequest();
    let operationId = "";
    for (let ordinal = 1; ordinal <= 12; ordinal += 1) {
      const result = await bundle.core.applyOrResume(request);
      assert.equal(result.executedOrdinal, ordinal);
      operationId = result.operationId;
      request = {
        ...request,
        expected_registry_version: bundle.registry.registryVersion,
      };
    }
    bundle.registry.unsafeDatabaseForTests().exec(`
      CREATE TEMP TRIGGER reject_operation_completion
      BEFORE UPDATE OF state ON operations
      WHEN NEW.state = 'succeeded'
      BEGIN
        SELECT RAISE(ABORT, 'injected-finalization-failure');
      END;
    `);

    await assert.rejects(bundle.core.applyOrResume(request));
    const finalStep = bundle.registry.listSteps(operationId)[12]!;
    assert.equal(finalStep.state, "failed");
    assert.equal(bundle.registry.getTenantLifecycle(bundle.tenantId), "quarantined");
    assert.equal(bundle.registry.getOperation(operationId)?.state, "failed");
    assert.notEqual(finalStep.state, "succeeded");
    bundle.registry.verifyAuditChain();
  } finally {
    bundle.registry.close();
  }
});

test("S26 outcome-unknown apply quarantines and reviewed resume does not duplicate", async () => {
  const bundle = await fixtureCore({
    data: [
      {
        method: "createOrAdoptProject",
        call: 1,
        timing: "outcome_unknown",
      },
    ],
  });
  try {
    const first = await bundle.core.applyOrResume(fixtureRequest());
    await assert.rejects(
      bundle.core.applyOrResume(
        fixtureRequest(bundle.registry.registryVersion),
      ),
      (error: unknown) => error instanceof OpsError && error.code === "outcome_unknown",
    );

    const failedStep = bundle.registry.listSteps(first.operationId)[1]!;
    assert.equal(failedStep.state, "outcome_unknown");
    assert.match(failedStep.providerRequestId ?? "", /^req_/);
    assert.equal(bundle.registry.getTenantLifecycle(bundle.tenantId), "quarantined");
    assert.equal(bundle.providers.data.projectCount, 1);

    const resumed = await bundle.core.applyOrResume(
      fixtureRequest(bundle.registry.registryVersion),
    );
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.executedOrdinal, 2);
    assert.equal(bundle.providers.data.projectCount, 1);

    let request = fixtureRequest(bundle.registry.registryVersion);
    for (let ordinal = 3; ordinal <= ONBOARDING_STEP_KINDS.length; ordinal += 1) {
      const result = await bundle.core.applyOrResume(request);
      assert.equal(result.executedOrdinal, ordinal);
      request = {
        ...request,
        expected_registry_version: bundle.registry.registryVersion,
      };
    }
    assert.equal(bundle.registry.getOperation(first.operationId)?.state, "succeeded");
    assert.equal(bundle.registry.getTenantLifecycle(bundle.tenantId), "active");
    assert.equal(bundle.providers.data.projectCount, 1);
    assert.equal(bundle.registry.countResourceReferences(bundle.tenantId), 4);

    const resumedAudits = bundle.registry
      .unsafeDatabaseForTests()
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_entries WHERE event_kind = 'operation_resumed'",
      )
      .get() as { count: number };
    assert.equal(Number(resumedAudits.count), 1);
    bundle.registry.verifyAuditChain();
  } finally {
    bundle.registry.close();
  }
});

test("S26 registry backup restore preserves the fixture tenant outcome and audit", async () => {
  const bundle = await fixtureCore();
  const directory = mkdtempSync(join(tmpdir(), "lh2-s26-restore-"));
  const backupPath = join(directory, "registry.lh2backup");
  const restorePath = join(directory, "replacement.sqlite");
  try {
    const results = await runAllSteps(bundle);
    const operationId = results.at(-1)!.operationId;
    const backupPassphrase = randomBytes(32).toString("base64url");
    const backup = await new RegistryBackupService().createEncryptedBackup(
      bundle.registry,
      backupPath,
      backupPassphrase,
      FIXTURE_NOW,
    );
    const restored = await new RegistryBackupService().restoreEncryptedBackup(
      backupPath,
      restorePath,
      OWNER_UUID,
      backupPassphrase,
    );
    assert.equal(restored.registryVersion, backup.registryVersion);
    assert.equal(restored.path, restorePath);

    const replacement = new Registry(restorePath, OWNER_UUID);
    try {
      replacement.verifyAuditChain();
      assert.equal(replacement.getTenantLifecycle(bundle.tenantId), "active");
      assert.ok(
        replacement
          .listSteps(operationId)
          .every((step) => step.state === "succeeded"),
      );
    } finally {
      replacement.close();
    }
  } finally {
    bundle.registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
