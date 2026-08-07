import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DisposableOnboardingPlanner,
  FakeAuthProvider,
  FakeDomainProvider,
  FakeSmtpProvider,
  FakeSourceRepositoryProvider,
  FakeSupabaseProvider,
  FakeHostingProvider,
  MCP_TOOL_CONTRACT_DIGEST,
  OnboardingExecutor,
  ProviderPreflightService,
  Registry,
  executionContextFromPlan,
  p4cBusinessInputs,
  p4cProfile,
  type DeploymentVerificationRequest,
  type OnboardingProviders,
} from "../src/index.js";
import { OWNER_UUID } from "./fixtures.js";

const TEST_CLOCK = new Date();

test("P4-C reviewed SDK ports keep the owner boundary closed", () => {
  const sourceRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../src",
  );
  const sdkSource = readFileSync(
    resolve(sourceRoot, "providers/p4c-sdk.js"),
    "utf8",
  );
  const interfaceSource = readFileSync(
    resolve(sourceRoot, "providers/interfaces.js"),
    "utf8",
  );
  const mcpPolicy = readFileSync(
    resolve(sourceRoot, "mcp/policy.js"),
    "utf8",
  );

  for (const forbidden of [
    /\bfetch\s*\(/,
    /node:child_process/,
    /\bprocess\.env\b/,
    /\bexec(?:File)?\s*\(/,
    /\bspawn\s*\(/,
    /\.deleteAProject\s*\(/,
    /\.deleteProject\s*\(/,
    /\.deleteDeployment\s*\(/,
    /\.removeProjectDomain\s*\(/,
    /\brollbackMigrations\s*\(/,
    /\bmigration[_ -]?repair\b/i,
    /\bdown[_ -]?migration\b/i,
    /\breplaceDomainsByDomainRecords\s*\(/,
    /\bcreateRecord\s*\(/,
  ]) {
    assert.doesNotMatch(sdkSource, forbidden);
  }
  assert.doesNotMatch(
    interfaceSource,
    /(?:payload|query|command|url|environmentValue):\s*unknown/i,
  );
  assert.match(sdkSource, /BASELINE_SHA256/);
  assert.match(sdkSource, /DELTA_054_SHA256/);
  assert.match(sdkSource, /supabase\.runAQuery/);
  assert.equal(
    MCP_TOOL_CONTRACT_DIGEST,
    "sha256:55771543b381922330bb1dcdf957759d7287667026b55a259835bc688283c183",
  );
  assert.match(mcpPolicy, /tenant_preflight/);
});

test("P4-C plan is pinned to one disposable tenant and disabled integrations", async () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const providers = {
      data: new FakeSupabaseProvider(),
      identity: new FakeAuthProvider(),
      objectStorage: new FakeSupabaseProvider(),
      hosting: new FakeHostingProvider(),
      email: new FakeSmtpProvider(),
      domain: new FakeDomainProvider(),
      sourceRepository: new FakeSourceRepositoryProvider(),
    };
    const clock = () => TEST_CLOCK;
    const profile = p4cProfile();
    const preflight = new ProviderPreflightService(providers, profile, {
      clock,
    });
    const planner = new DisposableOnboardingPlanner(
      registry,
      profile,
      preflight,
      clock,
    );
    const result = await planner.dryRun(p4cBusinessInputs());
    assert.equal(result.envelope.state, "valid");
    const spec = result.envelope.spec as Record<string, unknown>;
    const resources = spec.resources as Record<string, unknown>;
    const environment = spec.environment_policy as Record<string, unknown>;
    const capabilities = spec.capability_budgets as readonly Record<
      string,
      unknown
    >[];
    assert.equal(resources.production_hostname, "p4c-lab.app.ciphercross.dev");
    assert.equal(resources.data_project_name, "lh2-disposable-p4c-lab");
    assert.equal(resources.hosting_project_name, "lh2-disposable-p4c-lab");
    assert.deepEqual(environment.preview_secret_names, []);
    assert.equal(environment.production_secret_scope, "production_only");
    assert.ok(capabilities.every((candidate) => candidate.enabled === false));

    const wrongTenant = await planner.preflight({
      ...p4cBusinessInputs(),
      tenant_slug: "another-lab",
    });
    assert.equal(wrongTenant.status, "blocked");
  } finally {
    registry.close();
  }
});

test("smoke ownership is complete and admin invite remains the following step", async () => {
  const events: string[] = [];
  class RecordingSupabase extends FakeSupabaseProvider {
    override async runSmokeTests(projectId: string, ids: readonly string[]) {
      events.push(`supabase:${ids.join(",")}`);
      return super.runSmokeTests(projectId, ids);
    }
  }
  class RecordingAuth extends FakeAuthProvider {
    override async runSmokeTests(projectId: string, ids: readonly string[]) {
      events.push(`auth:${ids.join(",")}`);
      return super.runSmokeTests(projectId, ids);
    }

    override async createCompanyAdminAndInvite(request: {
      readonly projectId: string;
      readonly adminEmail: string;
    }) {
      events.push("admin-invite");
      return super.createCompanyAdminAndInvite(request);
    }
  }
  class RecordingSmtp extends FakeSmtpProvider {
    override async runSmokeTests(projectId: string, ids: readonly string[]) {
      events.push(`smtp:${ids.join(",")}`);
      return super.runSmokeTests(projectId, ids);
    }
  }
  class RecordingHosting extends FakeHostingProvider {
    override async verifyDeployment(request: DeploymentVerificationRequest) {
      events.push(`hosting:${request.runtimeCheckIds.join(",")}`);
      return super.verifyDeployment(request);
    }
  }

  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const providers: OnboardingProviders = {
      data: new RecordingSupabase(),
      identity: new RecordingAuth(),
      objectStorage: new RecordingSupabase(),
      hosting: new RecordingHosting(),
      email: new RecordingSmtp(),
      domain: new FakeDomainProvider(),
      sourceRepository: new FakeSourceRepositoryProvider(),
    };
    const clock = () => TEST_CLOCK;
    const profile = p4cProfile();
    const preflight = new ProviderPreflightService(providers, profile, {
      clock,
    });
    const planner = new DisposableOnboardingPlanner(
      registry,
      profile,
      preflight,
      clock,
    );
    const planned = await planner.planAndStore(p4cBusinessInputs());
    const request = {
      contract_version: "p2.v1" as const,
      operation_kind: "tenant_onboarding" as const,
      plan_id: planned.envelope.plan_id,
      plan_digest: planned.envelope.plan_digest,
      expected_registry_version: planned.envelope.expected_registry_version,
      idempotency_key: "p4c-smoke-ordering-test-0001",
    };
    const started = registry.startOrResumeOperation(
      request,
      "p4c-test",
      planned.preflight.snapshots,
      TEST_CLOCK,
    );
    const context = executionContextFromPlan(
      planned.envelope,
      started.operationId,
      started.fencingToken,
      registry.ownerUuid,
    );
    const executor = new OnboardingExecutor(registry, providers);
    for (let ordinal = 1; ordinal <= 11; ordinal += 1) {
      const result = await executor.executeNext(context);
      assert.equal(result.ordinal, ordinal);
    }
    assert.equal(events.includes("admin-invite"), false);
    assert.deepEqual(events, [
      "supabase:schema_ledger,rls_role_boundaries,private_storage_delivery",
      "auth:auth_anonymous_denied,auth_inactive_denied,auth_member_allowed",
      "smtp:smtp_delivery",
      "hosting:api_health,cron_configuration,preview_isolation,runtime_project_ref",
    ]);
    const invite = await executor.executeNext(context);
    assert.equal(invite.ordinal, 12);
    assert.equal(events.at(-1), "admin-invite");
  } finally {
    registry.close();
  }
});
