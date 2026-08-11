import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DisposableOnboardingCore,
  DisposableOnboardingPlanner,
  FakeOnboardingProviderBundle,
  FakeSupabaseProvider,
  MCP_TOOL_CONTRACT_DIGEST,
  OpsError,
  ProviderPreflightService,
  Registry,
  RegistryOwnerOperationsAdapter,
  SERVER_VERSION,
  StrictSupabaseAdapter,
  R2ObjectStorageAdapter,
  StrictAuthAdapter,
  StrictDomainAdapter,
  StrictHostingAdapter,
  StrictSmtpAdapter,
  StrictSourceRepositoryAdapter,
  ownerToolSchemas,
  type ApplyRequest,
  type FailureRule,
  type OnboardingProviders,
  type SupabaseInspectionRequest,
} from "../src/index.js";
import {
  OWNER_UUID,
  TEST_NOW,
  disposableBusinessInputs,
  disposableProfile,
} from "./fixtures.js";

function runtime(
  registry: Registry,
  providers: OnboardingProviders = new FakeOnboardingProviderBundle(),
) {
  const clock = () => TEST_NOW;
  const profile = disposableProfile();
  const preflight = new ProviderPreflightService(providers, profile, { clock });
  const planner = new DisposableOnboardingPlanner(
    registry,
    profile,
    preflight,
    clock,
  );
  const core = new DisposableOnboardingCore(
    registry,
    providers,
    planner,
    clock,
  );
  return { core, planner };
}

function strictProviders(
  ports: FakeOnboardingProviderBundle,
): OnboardingProviders {
  return {
    data: new StrictSupabaseAdapter(ports.data),
    objectStorage: new R2ObjectStorageAdapter(ports.objectStorage),
    hosting: new StrictHostingAdapter(ports.hosting),
    identity: new StrictAuthAdapter(ports.identity),
    email: new StrictSmtpAdapter(ports.email),
    domain: new StrictDomainAdapter(ports.domain),
    sourceRepository: new StrictSourceRepositoryAdapter(
      ports.sourceRepository,
    ),
  };
}

function authorization(
  plan: {
    readonly plan_id: string;
    readonly plan_digest: string;
    readonly expected_registry_version: number;
  },
  expectedRegistryVersion = plan.expected_registry_version,
) {
  return {
    server_version: SERVER_VERSION,
    tool_contract_digest: MCP_TOOL_CONTRACT_DIGEST,
    plan_id: plan.plan_id,
    plan_digest: plan.plan_digest,
    expected_registry_version: expectedRegistryVersion,
    idempotency_key: "p4b-disposable-onboarding-0001",
  };
}

test("P4-B source has no raw provider or destructive execution path", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
  const source = [
    "providers/adapters.js",
    "core/provider-preflight.js",
    "core/onboarding-planner.js",
    "core/onboarding-core.js",
  ]
    .map((path) => readFileSync(resolve(root, path), "utf8"))
    .join("\n");
  for (const forbidden of [
    /\bfetch\s*\(/,
    /node:child_process/,
    /\bprocess\.env\b/,
    /\bexec(?:File)?\s*\(/,
    /\bspawn\s*\(/,
    /\bsupabase\s+db\s+push\b/i,
    /\b(?:drop|delete)\s+(?:project|database|table)\b/i,
    /\bdown[_ -]?migration\b/i,
    /\bmigration[_ -]?repair\b/i,
    /\bsecretStore\.get\s*\(/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("strict provider adapters reject non-allowlisted provider response fields", async () => {
  class ExtraFieldSupabase extends FakeSupabaseProvider {
    override async inspect(request: SupabaseInspectionRequest) {
      return {
        ...(await super.inspect(request)),
        raw_provider_response: "must-not-cross-adapter",
      };
    }
  }

  const adapter = new StrictSupabaseAdapter(new ExtraFieldSupabase());
  const inputs = disposableBusinessInputs();
  const request = {
    organizationId: "sb-org-1",
    deterministicName: "lh2-disposable-disposable-lab",
    regionId: inputs.region_id,
    tierId: inputs.data_tier_id,
    computeId: inputs.data_compute_id,
    backupProfileId: inputs.backup_profile_id,
    ownership: {
      managedBy: "lh2-platform-ops" as const,
      tenantSlug: inputs.tenant_slug,
      workspaceClass: "disposable" as const,
      contractVersion: "p2.v1" as const,
      registryOwnerId: OWNER_UUID,
      digest: `sha256:${"1".repeat(64)}`,
    },
  };
  await assert.rejects(
    adapter.inspect(request),
    (error: unknown) =>
      error instanceof OpsError && error.code === "provider_error",
  );
});

test("disposable dry-run is deterministic and provider snapshots are read-only", async () => {
    const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const providerPorts = new FakeOnboardingProviderBundle();
    const { planner } = runtime(registry, strictProviders(providerPorts));
    const first = await planner.dryRun(disposableBusinessInputs());
    const second = await planner.dryRun(disposableBusinessInputs());

    assert.equal(first.envelope.plan_digest, second.envelope.plan_digest);
    assert.deepEqual(first.envelope.spec, second.envelope.spec);
    assert.equal(first.envelope.state, "valid");
    assert.equal(first.preflight.snapshots.length, 5);
    assert.deepEqual(
      first.preflight.snapshots.map((snapshot) => snapshot.provider),
      ["data", "hosting", "domain", "email", "source_repository"],
    );
    assert.equal(registry.registryVersion, 0);
    assert.equal(providerPorts.data.projectCount, 0);
    assert.equal(providerPorts.hosting.targetCount, 0);
  } finally {
    registry.close();
  }
});

test("fixed MCP schemas drive preflight, plan and resumable disposable onboarding", async () => {
  assert.equal(
    MCP_TOOL_CONTRACT_DIGEST,
    "sha256:55771543b381922330bb1dcdf957759d7287667026b55a259835bc688283c183",
  );
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const providerPorts = new FakeOnboardingProviderBundle();
    const { core } = runtime(registry, strictProviders(providerPorts));
    const adapter = new RegistryOwnerOperationsAdapter(
      registry,
      () => [],
      core,
    );
    const inputs = disposableBusinessInputs();
    const preflight = ownerToolSchemas.tenant_preflight.output.parse(
      await adapter.call("tenant_preflight", inputs),
    );
    assert.equal(preflight.status, "passed");
    assert.equal(preflight.prerequisites.length, 9);
    assert.equal(registry.registryVersion, 0);

    const planned = ownerToolSchemas.tenant_plan_onboarding.output.parse(
      await adapter.call("tenant_plan_onboarding", inputs),
    );
    assert.equal(planned.plan.state, "valid");
    assert.equal(planned.plan.effects.length, 13);
    assert.equal(planned.plan.expected_registry_version, 1);
    assert.equal(registry.registryVersion, 1);
    const plannedAgain =
      ownerToolSchemas.tenant_plan_onboarding.output.parse(
        await adapter.call("tenant_plan_onboarding", inputs),
      );
    assert.equal(plannedAgain.plan.plan_id, planned.plan.plan_id);
    assert.equal(registry.registryVersion, 1);

    const applyInput = { authorization: authorization(planned.plan) };
    let result:
      | ReturnType<
          typeof ownerToolSchemas.tenant_apply_onboarding.output.parse
        >
      | undefined;
    for (let ordinal = 1; ordinal <= 13; ordinal += 1) {
      result = ownerToolSchemas.tenant_apply_onboarding.output.parse(
        await adapter.call("tenant_apply_onboarding", applyInput),
      );
      assert.equal(
        registry.listSteps(result.operation_id)[ordinal - 1]!.state,
        "succeeded",
      );
    }
    assert.equal(result?.state, "succeeded");
    assert.equal(providerPorts.data.projectCount, 1);
    assert.equal(providerPorts.hosting.targetCount, 1);
    assert.equal(
      providerPorts.identity.effectCount("createCompanyAdminAndInvite"),
      1,
    );
  } finally {
    registry.close();
  }
});

const injectedEffects = [
  ["data", "createOrAdoptProject"],
  ["data", "waitUntilReady"],
  ["data", "applySchema"],
  ["objectStorage", "configurePrivateStorage"],
  ["identity", "configure"],
  ["email", "configure"],
  ["identity", "createDisabledSupportMembership"],
  ["hosting", "createDeploymentTarget"],
  ["hosting", "bindEnvironment"],
  ["hosting", "assignDomain"],
  ["hosting", "buildRelease"],
  ["hosting", "registerSchedules"],
  ["hosting", "promoteRelease"],
  ["data", "runSmokeTests"],
  ["identity", "runSmokeTests"],
  ["objectStorage", "runSmokeTests"],
  ["email", "runSmokeTests"],
  ["hosting", "verifyDeployment"],
  ["identity", "createCompanyAdminAndInvite"],
] as const;

test("failure after every provider effect quarantines and resumes without duplicates", async () => {
  for (const [providerName, method] of injectedEffects) {
    const registry = new Registry(":memory:", OWNER_UUID);
    try {
      const rules = {
        [providerName]: [
          { method, call: 1, timing: "after_effect" },
        ] satisfies readonly FailureRule[],
        // FakeObjectStorage historically inherits data failures for the old
        // combined Supabase port. Smoke now has a distinct R2 owner, so a data
        // failure must not be injected a second time into that separate call.
        ...(providerName === "data" ? { objectStorage: [] } : {}),
      };
      const providerPorts = new FakeOnboardingProviderBundle(rules);
      const { core } = runtime(registry, strictProviders(providerPorts));
      const planned = await core.planOnboarding(disposableBusinessInputs());
      const request: ApplyRequest = {
        contract_version: "p2.v1",
        operation_kind: "tenant_onboarding",
        plan_id: planned.envelope.plan_id,
        plan_digest: planned.envelope.plan_digest,
        expected_registry_version:
          planned.envelope.expected_registry_version,
        idempotency_key: "p4b-failure-resume-0001",
      };

      let operationId: string | undefined;
      await assert.rejects(
        async () => {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const result = await core.applyOrResume(request);
            operationId = result.operationId;
          }
        },
        (error: unknown) =>
          error instanceof OpsError && error.code === "provider_error",
        `${providerName}.${method} must fail after its first effect`,
      );
      assert.ok(operationId);
      assert.equal(registry.getOperation(operationId)?.state, "failed");
      assert.equal(
        registry.getTenant(
          disposableBusinessInputs().tenant_slug,
        )?.observedLifecycle,
        "quarantined",
      );

      const resumeRequest: ApplyRequest = {
        ...request,
        operation_id: operationId,
        expected_registry_version: registry.registryVersion,
      };
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const resumed = await core.applyOrResume(resumeRequest);
        if (resumed.state === "succeeded") break;
      }
      assert.equal(registry.getOperation(operationId)?.state, "succeeded");
      assert.equal(providerPorts.data.projectCount, 1);
      assert.equal(providerPorts.hosting.targetCount, 1);
      assert.ok(
        providerPorts.identity.effectCount("createCompanyAdminAndInvite") <= 1,
      );
      registry.verifyAuditChain();
    } finally {
      registry.close();
    }
  }
});
