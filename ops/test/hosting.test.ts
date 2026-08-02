import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CANONICAL_TENANT_SCHEDULES,
  FakeHostingProvider,
  HOSTING_CAPABILITIES,
  HOSTING_CAPABILITY_CONTRACT,
  HOSTING_CAPABILITY_METHODS,
  HOSTING_PLAN_SCHEMA_VERSION,
  HOSTING_RESULT_SHAPES,
  OpsError,
  Redactor,
  asJsonValue,
  buildHostingCapabilityPlan,
  canonicalJson,
  hostingPlanDigest,
  normalizeSchedules,
  planDigest,
  scheduleManifestDigest,
  type DeploymentTargetResult,
  type HostingControlPlanePort,
  type HostingPlanInput,
  type HostingValueBinding,
  type JsonValue,
  type OwnershipMarker,
  type ReleaseBuildResult,
} from "../src/index.js";
import { makeOnboardingPlan } from "./fixtures.js";

const OPS_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REVISION_A = "1".repeat(40);
const REVISION_B = "2".repeat(40);

/**
 * Synthetic canaries in the style of `security.test.ts`. They are not
 * credentials for anything; they exist so a test can prove that a value the
 * adapter genuinely handled never reaches a result.
 */
const SECRET_MATERIAL = {
  "lh2-platform/tenant/s09-lab/database.url": "s09-canary-database-3f1c9ab2",
  "lh2-platform/tenant/s09-lab/auth.session": "s09-canary-session-70b4e5d1",
  "schedule-invoke-token": "s09-canary-generated-c8d02f64",
} as const;
const CANARIES = Object.values(SECRET_MATERIAL);

const OWNERSHIP: OwnershipMarker = {
  managedBy: "lh2-platform-ops",
  tenantSlug: "s09-lab",
  workspaceClass: "disposable",
  contractVersion: "p2.v1",
  registryOwnerId: "11111111-1111-4111-8111-111111111111",
  digest: `sha256:${"a".repeat(64)}`,
};

const BINDINGS: readonly HostingValueBinding[] = [
  {
    name: "DATABASE_URL",
    valueClass: "server_secret",
    source: {
      kind: "secret_label",
      secretLabel: "lh2-platform/tenant/s09-lab/database.url",
    },
  },
  {
    name: "AUTH_SESSION_SECRET",
    valueClass: "server_secret",
    source: {
      kind: "secret_label",
      secretLabel: "lh2-platform/tenant/s09-lab/auth.session",
    },
  },
  {
    name: "SCHEDULE_INVOKE_TOKEN",
    valueClass: "server_secret",
    source: { kind: "generated_secret", generatorId: "schedule-invoke-token" },
  },
  {
    name: "APP_BASE_URL",
    valueClass: "server_public",
    source: { kind: "derived_from_plan", planFieldRef: "domain.hostname" },
  },
  {
    name: "PUBLIC_API_BASE_URL",
    valueClass: "public_build",
    source: { kind: "derived_from_plan", planFieldRef: "domain.hostname" },
  },
];

function planInput(): HostingPlanInput {
  return {
    tenantSlug: "s09-lab",
    workspaceClass: "disposable",
    deterministicName: "lh2-disposable-s09-lab",
    hostname: "s09-lab.example-platform.test",
    runtimeProfileId: "web-node22-1x",
    buildRecipeId: "spa-plus-http-handlers-v1",
    revisionId: REVISION_A,
    bindings: BINDINGS,
    schedules: CANONICAL_TENANT_SCHEDULES,
    runtimeCheckIds: ["api_health", "schedule_registration", "preview_isolation"],
    rollbackReasonCode: "verification_failed",
    ownershipMarkerDigest: OWNERSHIP.digest,
  };
}

/* ------------------------------------------------------------------ *
 * Structural helpers
 * ------------------------------------------------------------------ */

const FORBIDDEN_KEYS: readonly RegExp[] = [
  /vercel/i,
  /^team_?id$/i,
  /^project_?id$/i,
  /^deployment_?id$/i,
  /^build_?id$/i,
  /^crons?$/i,
  /function_?region/i,
  /^alias(es)?$/i,
  /^edge_?config/i,
];

const FORBIDDEN_VALUES: readonly RegExp[] = [
  /vercel/i,
  /\bteam_[A-Za-z0-9]{10,}/,
  /\bprj_[A-Za-z0-9]{10,}/,
  /\bdpl_[A-Za-z0-9]{10,}/,
  /\bvc_[A-Za-z0-9]{10,}/,
  /\bsbp_[A-Za-z0-9]{10,}/,
];

interface Visited {
  readonly path: string;
  readonly key: string | null;
  readonly value: unknown;
}

function walk(value: unknown, path = "$", key: string | null = null): Visited[] {
  const here: Visited[] = [{ path, key, value }];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      here.push(...walk(entry, `${path}[${index}]`, null));
    });
    return here;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      here.push(...walk(child, `${path}.${childKey}`, childKey));
    }
  }
  return here;
}

/**
 * Structural, not textual: every node is checked for a vendor-shaped key, a
 * vendor-shaped value, and — the part a grep cannot do — a prototype other than
 * plain object/array, which is what an SDK type instance would have.
 */
function assertCanonical(value: unknown, label: string): void {
  for (const node of walk(value)) {
    if (node.key !== null) {
      for (const pattern of FORBIDDEN_KEYS) {
        assert.equal(
          pattern.test(node.key),
          false,
          `${label}: vendor-shaped key at ${node.path} matched ${pattern}`,
        );
      }
    }
    if (typeof node.value === "string") {
      for (const pattern of FORBIDDEN_VALUES) {
        assert.equal(
          pattern.test(node.value),
          false,
          `${label}: vendor-shaped value at ${node.path} matched ${pattern}`,
        );
      }
    }
    if (node.value !== null && typeof node.value === "object") {
      const prototype = Object.getPrototypeOf(node.value);
      assert.ok(
        prototype === Object.prototype || prototype === Array.prototype,
        `${label}: non-plain object at ${node.path} — an SDK type may have leaked`,
      );
    }
    assert.notEqual(
      typeof node.value,
      "function",
      `${label}: function at ${node.path} is not canonical data`,
    );
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(value)),
    value,
    `${label}: value is not pure JSON`,
  );
}

function sourceFiles(...directories: readonly string[]): readonly string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "dist") continue;
        visit(full);
        continue;
      }
      if (entry.endsWith(".ts")) found.push(full);
    }
  };
  for (const directory of directories) visit(join(OPS_ROOT, directory));
  return found.sort();
}

/** Extracts module specifiers rather than grepping for a word. */
function importSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+[^;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+[^;]*?\bfrom\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

/* ------------------------------------------------------------------ *
 * Canonical contract
 * ------------------------------------------------------------------ */

test("all seven hosting capabilities are reachable through the canonical port", async () => {
  const provider = new FakeHostingProvider();
  const port: HostingControlPlanePort = provider;

  assert.equal(HOSTING_CAPABILITIES.length, 7);
  assert.deepEqual([...HOSTING_CAPABILITIES], [
    "tenant_deployment",
    "environment_binding",
    "pinned_build",
    "domain_assignment",
    "schedule_registration",
    "release_rollout",
    "deployment_verification",
  ]);

  const reached = new Set<string>();
  for (const capability of HOSTING_CAPABILITIES) {
    const methods = HOSTING_CAPABILITY_METHODS[capability];
    assert.ok(methods.length > 0, `${capability} has no port method`);
    for (const method of methods) {
      assert.equal(
        typeof port[method],
        "function",
        `${capability} is not reachable through ${method}`,
      );
      reached.add(method);
    }
  }

  // Every capability method the port declares belongs to a capability: the map
  // and the interface cannot drift apart in either direction.
  const declared = Object.keys(HOSTING_RESULT_SHAPES).filter(
    (name) => name !== "inspect",
  );
  assert.deepEqual([...reached].sort(), declared.sort());

  // Rollback is its own reachable operation, not a flag on promote.
  assert.ok(reached.has("promoteRelease") && reached.has("rollbackRelease"));
});

test("the canonical hosting plan carries no vendor identifier and no SDK type", () => {
  const plan = buildHostingCapabilityPlan(planInput());
  assertCanonical(plan, "hosting plan");

  const spec = plan as Record<string, JsonValue>;
  assert.equal(spec.capability_contract, HOSTING_CAPABILITY_CONTRACT);
  assert.equal(spec.hosting_plan_schema_version, HOSTING_PLAN_SCHEMA_VERSION);

  const steps = spec.steps as readonly Record<string, JsonValue>[];
  assert.deepEqual(
    steps.map((step) => step.method),
    [
      "createDeploymentTarget",
      "bindEnvironment",
      "buildRelease",
      "assignDomain",
      "registerSchedules",
      "promoteRelease",
      "rollbackRelease",
      "verifyDeployment",
    ],
    "the plan must cover deployment, env, build, domain, schedules, promote and rollback",
  );
  assert.deepEqual(
    [...new Set(steps.map((step) => step.capability))].sort(),
    [...HOSTING_CAPABILITIES].sort(),
  );

  // The plan describes bindings by source, never by value.
  const environment = spec.environment as Record<string, JsonValue>;
  for (const binding of environment.bindings as readonly Record<string, JsonValue>[]) {
    const source = binding.source as Record<string, JsonValue>;
    assert.ok(
      ["secret_label", "generated_secret", "derived_from_plan"].includes(
        String(source.kind),
      ),
    );
    assert.equal(Object.hasOwn(source, "value"), false);
    assert.equal(Object.hasOwn(binding, "value"), false);
  }
  const redactor = new Redactor(CANARIES);
  redactor.assertSecretFree(plan, "canonical hosting plan");

  // A short revision is not a pinned revision.
  assert.throws(
    () => buildHostingCapabilityPlan({ ...planInput(), revisionId: "abc123" }),
    (error: unknown) => error instanceof OpsError && error.code === "invalid_plan",
  );
});

test("schedule registration round-trips the four known schedules canonically", async () => {
  assert.equal(CANONICAL_TENANT_SCHEDULES.length, 4);
  assert.deepEqual(
    CANONICAL_TENANT_SCHEDULES.map((schedule) => [
      schedule.routePath,
      schedule.queryParameters,
      schedule.expression,
    ]),
    [
      ["/api/classify", {}, "0 6 * * *"],
      ["/api/notify-replies", {}, "30 6 * * *"],
      ["/api/briefing", { kind: "weekly" }, "0 7 * * 1"],
      ["/api/briefing", { kind: "daily" }, "30 7 * * 1-5"],
    ],
  );
  for (const schedule of CANONICAL_TENANT_SCHEDULES) {
    assert.equal(schedule.timezone, "UTC");
    assert.equal(schedule.expressionFormat, "cron5");
    assert.equal(schedule.expression.trim().split(/\s+/).length, 5);
  }

  const provider = new FakeHostingProvider();
  const { targetHandle, release } = await provision(provider);

  const digest = scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES);
  const shuffled = [...CANONICAL_TENANT_SCHEDULES].reverse();
  assert.equal(
    scheduleManifestDigest(shuffled),
    digest,
    "the manifest digest must not depend on registration order",
  );

  const registration = await provider.registerSchedules({
    targetHandle,
    releaseHandle: release.releaseHandle,
    schedules: shuffled,
    manifestDigest: digest,
  });
  assertCanonical(registration, "schedule registration result");
  assert.deepEqual(
    registration.registered,
    normalizeSchedules(CANONICAL_TENANT_SCHEDULES),
    "what goes in comes back out, in canonical order",
  );
  assert.equal(registration.manifestDigest, digest);
  assert.equal(registration.manifestDigest, release.scheduleManifestDigest);

  // A manifest digest that disagrees with the submitted set is refused.
  await assert.rejects(
    provider.registerSchedules({
      targetHandle,
      releaseHandle: release.releaseHandle,
      schedules: CANONICAL_TENANT_SCHEDULES.slice(0, 3),
      manifestDigest: digest,
    }),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
  // Schedules cannot be attached to something that was never built.
  await assert.rejects(
    provider.registerSchedules({
      targetHandle,
      releaseHandle: "hrel_never_built",
      schedules: CANONICAL_TENANT_SCHEDULES,
      manifestDigest: digest,
    }),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
});

test("rollback is expressible and distinguishable from promote", async () => {
  const provider = new FakeHostingProvider();
  const { targetHandle, release: first } = await provision(provider);
  const second = await provider.buildRelease({
    targetHandle,
    revisionId: REVISION_B,
    buildRecipeId: "spa-plus-http-handlers-v1",
    publicValueNames: ["PUBLIC_API_BASE_URL"],
    scheduleManifestDigest: scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES),
  });

  const promoteFirst = await provider.promoteRelease({
    targetHandle,
    releaseHandle: first.releaseHandle,
  });
  assert.equal(promoteFirst.rolloutKind, "promote");
  assert.equal(promoteFirst.previousReleaseHandle, null);
  assert.equal(promoteFirst.reasonCode, null);
  assert.equal(promoteFirst.rolloutSequence, 1);

  const promoteSecond = await provider.promoteRelease({
    targetHandle,
    releaseHandle: second.releaseHandle,
  });
  assert.equal(promoteSecond.previousReleaseHandle, first.releaseHandle);
  assert.equal(promoteSecond.rolloutSequence, 2);

  const rollback = await provider.rollbackRelease({
    targetHandle,
    releaseHandle: first.releaseHandle,
    supersededReleaseHandle: second.releaseHandle,
    reasonCode: "verification_failed",
  });
  assertCanonical(rollback, "rollback result");
  assert.equal(rollback.rolloutKind, "rollback");
  assert.equal(rollback.activeReleaseHandle, first.releaseHandle);
  assert.equal(rollback.previousReleaseHandle, second.releaseHandle);
  assert.equal(rollback.reasonCode, "verification_failed");
  assert.equal(rollback.rolloutSequence, 3);
  assert.notEqual(rollback.rolloutHandle, promoteSecond.rolloutHandle);
  assert.equal(provider.activeReleaseHandle(targetHandle), first.releaseHandle);

  // Promote and rollback share a result shape but never a kind.
  assert.deepEqual(
    Object.keys(promoteSecond).sort(),
    Object.keys(rollback).sort(),
  );
  assert.notEqual(promoteSecond.rolloutKind, rollback.rolloutKind);

  // Rollback is constrained: only to a release that was actually active, only
  // from the release that is actually active, and never to itself.
  await assert.rejects(
    provider.rollbackRelease({
      targetHandle,
      releaseHandle: "hrel_never_active",
      supersededReleaseHandle: first.releaseHandle,
      reasonCode: "verification_failed",
    }),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
  await assert.rejects(
    provider.rollbackRelease({
      targetHandle,
      releaseHandle: second.releaseHandle,
      supersededReleaseHandle: second.releaseHandle,
      reasonCode: "verification_failed",
    }),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );

  // The reverse direction is closed too: a rollback cannot be smuggled in as a
  // promote, so the two operations stay genuinely distinct.
  await assert.rejects(
    provider.promoteRelease({ targetHandle, releaseHandle: second.releaseHandle }),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
  assert.equal(provider.activeReleaseHandle(targetHandle), first.releaseHandle);
  // Re-issuing the promotion that is already active still resumes cleanly.
  const resumed = await provider.promoteRelease({
    targetHandle,
    releaseHandle: first.releaseHandle,
  });
  assert.equal(resumed.rolloutKind, "promote");
  assert.equal(resumed.rolloutSequence, 1, "resume must not append a rollout");

  const fresh = new FakeHostingProvider();
  const other = await provision(fresh);
  await assert.rejects(
    fresh.rollbackRelease({
      targetHandle: other.targetHandle,
      releaseHandle: other.release.releaseHandle,
      supersededReleaseHandle: other.release.releaseHandle,
      reasonCode: "verification_failed",
    }),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
    "nothing promoted means nothing to roll back",
  );
});

/* ------------------------------------------------------------------ *
 * Fake adapter
 * ------------------------------------------------------------------ */

test("the fake satisfies the whole contract with no provider and no credentials", async () => {
  const credentialVariables = [
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_ID",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEON_API_KEY",
    "DATABASE_URL",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ];
  const saved = new Map<string, string | undefined>();
  for (const name of credentialVariables) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    const provider = new FakeHostingProvider([], {
      secretMaterial: SECRET_MATERIAL,
    });
    const input = planInput();

    const inspection = await provider.inspect({
      deterministicName: input.deterministicName,
      workspaceClass: input.workspaceClass,
      runtimeProfileId: input.runtimeProfileId,
      requiredScheduleCount: CANONICAL_TENANT_SCHEDULES.length,
      requiredServerValueCount: 4,
      requiredPublicValueCount: 1,
      ownership: OWNERSHIP,
    });
    assertCanonical(inspection, "inspection");
    assert.equal(inspection.controlPlaneAccessible, true);
    assert.equal(inspection.deterministicNameAvailable, true);
    assert.equal(inspection.rollbackSupported, true);
    assert.equal(inspection.scheduleCapacityAvailable, true);

    const { targetHandle, release, target } = await provision(provider);
    assert.equal(target.adopted, false);
    assert.equal(target.automaticPromotionEnabled, false);
    assert.equal(target.isolatedPreviewsEnabled, false);
    assert.equal(provider.targetCount, 1);
    assert.equal(provider.releaseCount(targetHandle), 1);

    await provider.registerSchedules({
      targetHandle,
      releaseHandle: release.releaseHandle,
      schedules: CANONICAL_TENANT_SCHEDULES,
      manifestDigest: scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES),
    });
    await provider.promoteRelease({
      targetHandle,
      releaseHandle: release.releaseHandle,
    });

    const report = await provider.verifyDeployment({
      targetHandle,
      expectedActiveReleaseHandle: release.releaseHandle,
      expectedHostname: input.hostname,
      expectedRevisionId: REVISION_A,
      expectedSchedules: CANONICAL_TENANT_SCHEDULES,
      runtimeCheckIds: input.runtimeCheckIds,
    });
    assert.equal(report.status, "passed");

    // Re-creating the same target adopts rather than duplicating.
    const adopted = await provider.createDeploymentTarget({
      deterministicName: input.deterministicName,
      workspaceClass: input.workspaceClass,
      runtimeProfileId: input.runtimeProfileId,
      ownership: OWNERSHIP,
      automaticPromotionEnabled: false,
      isolatedPreviewsEnabled: false,
    });
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.targetHandle, targetHandle);
    assert.equal(provider.targetCount, 1);

    // A different ownership marker is never adopted.
    await assert.rejects(
      provider.createDeploymentTarget({
        deterministicName: input.deterministicName,
        workspaceClass: input.workspaceClass,
        runtimeProfileId: input.runtimeProfileId,
        ownership: { ...OWNERSHIP, digest: `sha256:${"f".repeat(64)}` },
        automaticPromotionEnabled: false,
        isolatedPreviewsEnabled: false,
      }),
      (error: unknown) => error instanceof OpsError && error.code === "provider_error",
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("hosting fake injects failures before, after and with unknown outcome", async () => {
  const request = {
    deterministicName: "lh2-disposable-s09-lab",
    workspaceClass: "disposable" as const,
    runtimeProfileId: "web-node22-1x",
    ownership: OWNERSHIP,
    automaticPromotionEnabled: false as const,
    isolatedPreviewsEnabled: false as const,
  };

  const before = new FakeHostingProvider([
    { method: "createDeploymentTarget", call: 1, timing: "before_effect" },
  ]);
  await assert.rejects(
    before.createDeploymentTarget(request),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
  assert.equal(before.targetCount, 0, "before_effect must leave no resource behind");

  const after = new FakeHostingProvider([
    { method: "createDeploymentTarget", call: 1, timing: "after_effect" },
  ]);
  await assert.rejects(
    after.createDeploymentTarget(request),
    (error: unknown) => error instanceof OpsError && error.code === "provider_error",
  );
  assert.equal(after.targetCount, 1, "after_effect must leave the resource behind");
  const reconciled = await after.createDeploymentTarget(request);
  assert.equal(reconciled.adopted, true);
  assert.equal(after.targetCount, 1, "retry must adopt, not create a second target");

  const unknown = new FakeHostingProvider([
    { method: "createDeploymentTarget", call: 1, timing: "outcome_unknown" },
  ]);
  await assert.rejects(
    unknown.createDeploymentTarget(request),
    (error: unknown) => {
      assert.ok(error instanceof OpsError);
      assert.equal(error.code, "outcome_unknown");
      return true;
    },
  );
  assert.equal(unknown.targetCount, 1);
  assert.equal((await unknown.createDeploymentTarget(request)).adopted, true);
  assert.equal(unknown.targetCount, 1);

  // The same three timings apply to a rollout, which is the effect that most
  // needs a truthful outcome-unknown.
  for (const timing of ["before_effect", "after_effect", "outcome_unknown"] as const) {
    const provider = new FakeHostingProvider([
      { method: "promoteRelease", call: 1, timing },
    ]);
    const { targetHandle, release } = await provision(provider);
    await assert.rejects(
      provider.promoteRelease({ targetHandle, releaseHandle: release.releaseHandle }),
      (error: unknown) =>
        error instanceof OpsError &&
        error.code === (timing === "outcome_unknown" ? "outcome_unknown" : "provider_error"),
    );
    assert.equal(
      provider.activeReleaseHandle(targetHandle),
      timing === "before_effect" ? null : release.releaseHandle,
      `${timing} must be visible in the resulting state`,
    );
    const retried = await provider.promoteRelease({
      targetHandle,
      releaseHandle: release.releaseHandle,
    });
    assert.equal(retried.rolloutSequence, 1, "resume must not stack a second rollout");
  }
});

test("environment binding never returns a secret value on any code path", async () => {
  const redactor = new Redactor(CANARIES);
  const provider = new FakeHostingProvider([], { secretMaterial: SECRET_MATERIAL });
  const input = planInput();
  const { targetHandle, release } = await provision(provider);

  assert.ok(
    provider.resolvedSecretCount >= 3,
    "the fake must genuinely resolve secret material, or this proves nothing",
  );

  const binding = await provider.bindEnvironment({
    targetHandle,
    scope: "production",
    bindings: BINDINGS,
  });
  assertCanonical(binding, "environment binding result");
  redactor.assertSecretFree(binding, "environment binding result");
  assert.deepEqual(
    binding.bindings.map((entry) => [entry.name, entry.valueClass, entry.sourceKind]),
    [
      ["DATABASE_URL", "server_secret", "secret_label"],
      ["AUTH_SESSION_SECRET", "server_secret", "secret_label"],
      ["SCHEDULE_INVOKE_TOKEN", "server_secret", "generated_secret"],
      ["APP_BASE_URL", "server_public", "derived_from_plan"],
      ["PUBLIC_API_BASE_URL", "public_build", "derived_from_plan"],
    ],
  );
  for (const entry of binding.bindings) {
    assert.equal(Object.hasOwn(entry, "value"), false);
    assert.equal(Object.hasOwn(entry, "secretLabel"), false);
  }

  // Not just this result: every result the port can produce, plus verification,
  // plus the plan, must be free of the material the adapter handled.
  const outputs: unknown[] = [
    binding,
    await provider.bindEnvironment({
      targetHandle,
      scope: "production",
      bindings: BINDINGS,
    }),
    release,
    await provider.assignDomain({
      targetHandle,
      hostname: input.hostname,
      ownership: OWNERSHIP,
      certificateMode: "provider_managed",
    }),
    await provider.registerSchedules({
      targetHandle,
      releaseHandle: release.releaseHandle,
      schedules: CANONICAL_TENANT_SCHEDULES,
      manifestDigest: scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES),
    }),
    await provider.promoteRelease({
      targetHandle,
      releaseHandle: release.releaseHandle,
    }),
    await provider.verifyDeployment({
      targetHandle,
      expectedActiveReleaseHandle: release.releaseHandle,
      expectedHostname: input.hostname,
      expectedRevisionId: REVISION_A,
      expectedSchedules: CANONICAL_TENANT_SCHEDULES,
      runtimeCheckIds: input.runtimeCheckIds,
    }),
    buildHostingCapabilityPlan(input),
  ];
  for (const [index, output] of outputs.entries()) {
    const serialized = JSON.stringify(output);
    for (const canary of CANARIES) {
      assert.equal(
        serialized.includes(canary),
        false,
        `output ${index} leaked handled secret material`,
      );
    }
    redactor.assertSecretFree(output, `hosting output ${index}`);
  }

  // The error path is the other place a value escapes.
  // Call 2, because provisioning already binds once: the failure must land on
  // the explicit call below, not inside the helper.
  const failing = new FakeHostingProvider(
    [{ method: "bindEnvironment", call: 2, timing: "after_effect" }],
    { secretMaterial: SECRET_MATERIAL },
  );
  const failingTarget = await provision(failing);
  await assert.rejects(
    failing.bindEnvironment({
      targetHandle: failingTarget.targetHandle,
      scope: "production",
      bindings: BINDINGS,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OpsError);
      const serialized = `${error.message}${JSON.stringify(error.details ?? {})}`;
      for (const canary of CANARIES) {
        assert.equal(serialized.includes(canary), false);
      }
      return true;
    },
  );
});

/* ------------------------------------------------------------------ *
 * Parity and verification shape
 * ------------------------------------------------------------------ */

test("every canonical result has the provider-independent shape S10 must match", async () => {
  const provider = new FakeHostingProvider([], { secretMaterial: SECRET_MATERIAL });
  const input = planInput();
  const { targetHandle, release, target, domain } = await provision(provider);
  const binding = await provider.bindEnvironment({
    targetHandle,
    scope: "production",
    bindings: BINDINGS,
  });
  const schedules = await provider.registerSchedules({
    targetHandle,
    releaseHandle: release.releaseHandle,
    schedules: CANONICAL_TENANT_SCHEDULES,
    manifestDigest: scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES),
  });
  const promote = await provider.promoteRelease({
    targetHandle,
    releaseHandle: release.releaseHandle,
  });
  const second = await provider.buildRelease({
    targetHandle,
    revisionId: REVISION_B,
    buildRecipeId: input.buildRecipeId,
    publicValueNames: ["PUBLIC_API_BASE_URL"],
    scheduleManifestDigest: scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES),
  });
  await provider.promoteRelease({
    targetHandle,
    releaseHandle: second.releaseHandle,
  });
  const rollback = await provider.rollbackRelease({
    targetHandle,
    releaseHandle: release.releaseHandle,
    supersededReleaseHandle: second.releaseHandle,
    reasonCode: "verification_failed",
  });
  const inspection = await provider.inspect({
    deterministicName: input.deterministicName,
    workspaceClass: input.workspaceClass,
    runtimeProfileId: input.runtimeProfileId,
    requiredScheduleCount: 4,
    requiredServerValueCount: 4,
    requiredPublicValueCount: 1,
    ownership: OWNERSHIP,
  });
  const verification = await provider.verifyDeployment({
    targetHandle,
    expectedActiveReleaseHandle: release.releaseHandle,
    expectedHostname: input.hostname,
    expectedRevisionId: REVISION_A,
    expectedSchedules: CANONICAL_TENANT_SCHEDULES,
    runtimeCheckIds: input.runtimeCheckIds,
  });

  const observed: Record<string, unknown> = {
    inspect: inspection,
    createDeploymentTarget: target,
    bindEnvironment: binding,
    buildRelease: release,
    assignDomain: domain,
    registerSchedules: schedules,
    promoteRelease: promote,
    rollbackRelease: rollback,
    verifyDeployment: verification,
  };
  for (const [method, expectedKeys] of Object.entries(HOSTING_RESULT_SHAPES)) {
    const result = observed[method];
    assert.ok(result !== undefined, `${method} produced no result`);
    assert.deepEqual(
      Object.keys(result as object).sort(),
      [...expectedKeys].sort(),
      `${method} result shape drifted from the parity contract`,
    );
    assertCanonical(result, `${method} result`);
  }
});

test("verification reports runtime, schedules, domain and build metadata", async () => {
  const input = planInput();
  const provider = new FakeHostingProvider([], {
    failingRuntimeCheckIds: ["preview_isolation"],
  });
  const { targetHandle, release } = await provision(provider);

  // Nothing promoted yet: the report is complete and honest, not empty.
  const before = await provider.verifyDeployment({
    targetHandle,
    expectedActiveReleaseHandle: release.releaseHandle,
    expectedHostname: input.hostname,
    expectedRevisionId: REVISION_A,
    expectedSchedules: CANONICAL_TENANT_SCHEDULES,
    runtimeCheckIds: input.runtimeCheckIds,
  });
  assert.equal(before.status, "failed");
  assert.equal(before.runtime.reachable, false);
  assert.equal(before.runtime.activeReleaseHandle, null);
  assert.deepEqual(before.schedules.missingScheduleIds, [
    "briefing.daily",
    "briefing.weekly",
    "classify.daily",
    "notify_replies.sweep",
  ]);
  assert.equal(before.domain.servesActiveRelease, false);
  assert.equal(before.build.releaseHandle, null);
  assert.equal(before.rollout.rolloutKind, null);

  await provider.registerSchedules({
    targetHandle,
    releaseHandle: release.releaseHandle,
    schedules: CANONICAL_TENANT_SCHEDULES,
    manifestDigest: scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES),
  });
  await provider.promoteRelease({
    targetHandle,
    releaseHandle: release.releaseHandle,
  });

  const after = await provider.verifyDeployment({
    targetHandle,
    expectedActiveReleaseHandle: release.releaseHandle,
    expectedHostname: input.hostname,
    expectedRevisionId: REVISION_A,
    expectedSchedules: CANONICAL_TENANT_SCHEDULES,
    runtimeCheckIds: input.runtimeCheckIds,
  });
  assertCanonical(after, "verification report");

  // Runtime.
  assert.equal(after.runtime.reachable, true);
  assert.equal(after.runtime.activeReleaseMatchesExpected, true);
  assert.deepEqual(after.runtime.failedCheckIds, ["preview_isolation"]);
  assert.deepEqual(after.runtime.passedCheckIds, [
    "api_health",
    "schedule_registration",
  ]);
  // A failing runtime check keeps the whole report failed.
  assert.equal(after.status, "failed");

  // Schedules.
  assert.deepEqual(
    after.schedules.registered,
    normalizeSchedules(CANONICAL_TENANT_SCHEDULES),
  );
  assert.deepEqual(after.schedules.missingScheduleIds, []);
  assert.deepEqual(after.schedules.unexpectedScheduleIds, []);
  assert.equal(after.schedules.manifestMatchesRelease, true);
  assert.equal(
    after.schedules.manifestDigest,
    scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES),
  );

  // Domain.
  assert.equal(after.domain.hostname, input.hostname);
  assert.equal(after.domain.assigned, true);
  assert.equal(after.domain.certificateReady, true);
  assert.equal(after.domain.matchesExpected, true);
  assert.equal(after.domain.servesActiveRelease, true);

  // Build metadata.
  assert.equal(after.build.releaseHandle, release.releaseHandle);
  assert.equal(after.build.revisionId, REVISION_A);
  assert.equal(after.build.revisionPinned, true);
  assert.equal(after.build.revisionMatchesExpected, true);
  assert.equal(after.build.buildRecipeId, input.buildRecipeId);
  assert.deepEqual(after.build.publicValueNames, ["PUBLIC_API_BASE_URL"]);
  assert.equal(after.build.artifactDigest, release.artifactDigest);

  // Rollout.
  assert.equal(after.rollout.rolloutKind, "promote");
  assert.equal(after.rollout.rolloutSequence, 1);

  // A green run is reachable when every runtime check passes.
  const green = new FakeHostingProvider();
  const ready = await provision(green);
  await green.registerSchedules({
    targetHandle: ready.targetHandle,
    releaseHandle: ready.release.releaseHandle,
    schedules: CANONICAL_TENANT_SCHEDULES,
    manifestDigest: scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES),
  });
  await green.promoteRelease({
    targetHandle: ready.targetHandle,
    releaseHandle: ready.release.releaseHandle,
  });
  const passed = await green.verifyDeployment({
    targetHandle: ready.targetHandle,
    expectedActiveReleaseHandle: ready.release.releaseHandle,
    expectedHostname: input.hostname,
    expectedRevisionId: REVISION_A,
    expectedSchedules: CANONICAL_TENANT_SCHEDULES,
    runtimeCheckIds: input.runtimeCheckIds,
  });
  assert.equal(passed.status, "passed");

  // Rolling back without re-registering the schedule set is drift, and the
  // report says so rather than reporting success.
  const drifted = await green.buildRelease({
    targetHandle: ready.targetHandle,
    revisionId: REVISION_B,
    buildRecipeId: input.buildRecipeId,
    publicValueNames: ["PUBLIC_API_BASE_URL"],
    scheduleManifestDigest: scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES),
  });
  await green.promoteRelease({
    targetHandle: ready.targetHandle,
    releaseHandle: drifted.releaseHandle,
  });
  const afterRollbackDrift = await green.verifyDeployment({
    targetHandle: ready.targetHandle,
    expectedActiveReleaseHandle: drifted.releaseHandle,
    expectedHostname: input.hostname,
    expectedRevisionId: REVISION_B,
    expectedSchedules: CANONICAL_TENANT_SCHEDULES,
    runtimeCheckIds: input.runtimeCheckIds,
  });
  assert.equal(afterRollbackDrift.schedules.manifestMatchesRelease, false);
  assert.equal(afterRollbackDrift.status, "failed");
});

/* ------------------------------------------------------------------ *
 * Regression and compatibility
 * ------------------------------------------------------------------ */

test("canonical digests are stable and no existing schema version moved", () => {
  // The hosting plan is deterministic for identical inputs and is pinned, so a
  // silent change to the canonical shape cannot pass unnoticed.
  const first = buildHostingCapabilityPlan(planInput());
  const second = buildHostingCapabilityPlan({
    ...planInput(),
    schedules: [...CANONICAL_TENANT_SCHEDULES].reverse(),
  });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(
    hostingPlanDigest(first),
    "sha256:5aa71612191baae630cb976b04c75b9a484a5b16bcc637cbb9e9b8d077686e6a",
  );

  // S09 introduces a new contract; it does not bump an existing one.
  assert.equal(HOSTING_CAPABILITY_CONTRACT, "hosting.capability.v1");
  assert.equal(HOSTING_PLAN_SCHEMA_VERSION, 1);
  assert.equal(scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES), "sha256:688baed28906755e59c836917b63626a44d00b2c544a7a82fe98b2cafe492ebc");

  // The onboarding plan surface is untouched: same contract version, same
  // schema version, same digest for the same inputs.
  const plan = makeOnboardingPlan();
  assert.equal(plan.contract_version, "p2.v1");
  assert.equal(plan.plan_schema_version, 1);
  assert.equal(plan.plan_digest, planDigest(asJsonValue(plan.spec)));
  assert.equal(plan.plan_digest, "sha256:60c003918ec508fb3136c51cd827b4778bfa5f9dfd2b6c5a3b597a0243c3e045");
});

/* ------------------------------------------------------------------ *
 * Static assertions
 * ------------------------------------------------------------------ */

test("the vendor SDK is imported by exactly one file", () => {
  const files = sourceFiles("src", "test");
  const importers = files.filter((file) =>
    importSpecifiers(readFileSync(file, "utf8")).some(
      (specifier) => specifier === "@vercel/sdk" || specifier.startsWith("@vercel/sdk/"),
    ),
  );
  assert.deepEqual(
    importers.map((file) => file.slice(OPS_ROOT.length)),
    ["src/providers/p4c-sdk.ts"],
  );
});

test("canonical hosting sources import nothing vendor-specific", () => {
  const allowed: Readonly<Record<string, readonly string[]>> = {
    "src/providers/hosting.ts": [
      "../core/canonical.js",
      "../core/errors.js",
      "./interfaces.js",
    ],
    "src/providers/hosting-fake.ts": [
      "node:crypto",
      "../core/canonical.js",
      "../core/errors.js",
      "./fakes.js",
      "./hosting.js",
    ],
  };
  for (const [relative, permitted] of Object.entries(allowed)) {
    const source = readFileSync(join(OPS_ROOT, relative), "utf8");
    const specifiers = [...new Set(importSpecifiers(source))].sort();
    assert.deepEqual(
      specifiers,
      [...permitted].sort(),
      `${relative} imports outside its allowlist`,
    );
  }
});

test("new hosting sources carry no secret, credential or vendor resource ID", () => {
  const forbidden: readonly [RegExp, string][] = [
    [/postgres(?:ql)?:\/\//i, "connection string"],
    [/\b[A-Za-z0-9+/]{20,}={0,2}\s*(?:#|\/\/)?\s*(?:api[_-]?key|token)\b/i, "inline key"],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/, "bearer token"],
    [/\bsbp_[A-Za-z0-9]{16,}/, "provider access token"],
    [/\bAKIA[0-9A-Z]{16}\b/, "cloud access key"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
    [/\bteam_[A-Za-z0-9]{16,}/, "vendor team ID"],
    [/\bprj_[A-Za-z0-9]{16,}/, "vendor project ID"],
    [/\bdpl_[A-Za-z0-9]{16,}/, "vendor deployment ID"],
  ];
  const files = [
    "src/providers/hosting.ts",
    "src/providers/hosting-fake.ts",
    "test/hosting.test.ts",
  ];
  for (const relative of files) {
    const source = readFileSync(join(OPS_ROOT, relative), "utf8");
    for (const [pattern, label] of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${relative} appears to contain a ${label}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * Shared provisioning helper
 * ------------------------------------------------------------------ */

async function provision(provider: FakeHostingProvider): Promise<{
  readonly targetHandle: string;
  readonly target: DeploymentTargetResult;
  readonly release: ReleaseBuildResult;
  readonly domain: Awaited<ReturnType<FakeHostingProvider["assignDomain"]>>;
}> {
  const input = planInput();
  const target = await provider.createDeploymentTarget({
    deterministicName: input.deterministicName,
    workspaceClass: input.workspaceClass,
    runtimeProfileId: input.runtimeProfileId,
    ownership: OWNERSHIP,
    automaticPromotionEnabled: false,
    isolatedPreviewsEnabled: false,
  });
  await provider.bindEnvironment({
    targetHandle: target.targetHandle,
    scope: "production",
    bindings: BINDINGS,
  });
  const release = await provider.buildRelease({
    targetHandle: target.targetHandle,
    revisionId: input.revisionId,
    buildRecipeId: input.buildRecipeId,
    publicValueNames: ["PUBLIC_API_BASE_URL"],
    scheduleManifestDigest: scheduleManifestDigest(input.schedules),
  });
  const domain = await provider.assignDomain({
    targetHandle: target.targetHandle,
    hostname: input.hostname,
    ownership: OWNERSHIP,
    certificateMode: "provider_managed",
  });
  return { targetHandle: target.targetHandle, target, release, domain };
}
