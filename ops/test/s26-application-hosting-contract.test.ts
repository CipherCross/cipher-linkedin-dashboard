import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_PUBLIC_BUILD_VALUE_NAMES,
  CANONICAL_TENANT_ENVIRONMENT,
  HOSTING_ENVIRONMENT_CONTRACT,
  S26_APPLICATION_HOSTING_PROFILE,
  buildHostingCapabilityPlan,
  buildTenantEnvironmentBindings,
  hostingEnvironmentBindingDigest,
  hostingPlanDigest,
  tenantEnvironmentContractDigest,
} from "../src/index.js";

const TENANT_SLUG = "s26-lab";
const BINDINGS = buildTenantEnvironmentBindings({ tenantSlug: TENANT_SLUG });

function descriptorDigest(
  descriptors: readonly {
    readonly name: string;
    readonly valueClass: string;
    readonly source: (typeof BINDINGS)[number]["source"];
  }[],
): string {
  return hostingEnvironmentBindingDigest(descriptors);
}

test("S26 v3 contract binds the four least-privilege Neon URLs, Better Auth, a sender, and exact feature flags", () => {
  assert.equal(HOSTING_ENVIRONMENT_CONTRACT, "hosting.environment.v3");
  assert.equal(S26_APPLICATION_HOSTING_PROFILE, "s26.application-hosting.v1");
  assert.deepEqual(
    CANONICAL_TENANT_ENVIRONMENT.map((entry) => [entry.name, entry.valueClass, entry.source.kind]),
    [
      ["NEON_DATABASE_URL", "server_secret", "derived_from_owned_resource"],
      ["NEON_AI_DATABASE_URL", "server_secret", "derived_from_owned_resource"],
      ["NEON_MACHINE_DATABASE_URL", "server_secret", "derived_from_owned_resource"],
      ["IDENTITY_STORE_DATABASE_URL", "server_secret", "derived_from_owned_resource"],
      ["IDENTITY_SESSION_SECRET", "server_secret", "generated_secret"],
      ["CRON_SECRET", "server_secret", "generated_secret"],
      ["NOTIFY_SECRET", "server_secret", "generated_secret"],
      ["MCP_SECRET", "server_secret", "generated_secret"],
      ["IDENTITY_BASE_URL", "server_public", "derived_from_plan"],
      ["NEON_READS_DEFAULT", "server_public", "derived_from_plan"],
      ["NEON_WRITES_DEFAULT", "server_public", "derived_from_plan"],
      ["NEON_AI_PATH_DEFAULT", "server_public", "derived_from_plan"],
      ["NEON_PHOTOS_DEFAULT", "server_public", "derived_from_plan"],
      // v3. Without a sender the application cannot mail a reset link, and the
      // reset link is the only route into an invited account.
      ["RESEND_API_KEY", "server_secret", "derived_from_owned_resource"],
      ["RESEND_FROM_IDENTITY", "server_public", "derived_from_owned_resource"],
      ["VITE_AUTH_PATH", "public_build", "derived_from_plan"],
    ],
  );
  assert.deepEqual(CANONICAL_PUBLIC_BUILD_VALUE_NAMES, ["VITE_AUTH_PATH"]);
  assert.equal(
    CANONICAL_TENANT_ENVIRONMENT.some((entry) => /r2|object_storage|access_key/i.test(entry.name)),
    false,
  );
  assert.equal(
    BINDINGS.some((binding) => binding.source.kind === "secret_label"),
    false,
  );
});

test("names, classifications, and exact source references are immutable through plan and build digests", () => {
  const descriptors = BINDINGS.map((binding) => ({
    name: binding.name,
    valueClass: binding.valueClass,
    source: binding.source,
  }));
  const digest = descriptorDigest(descriptors);
  assert.equal(digest, tenantEnvironmentContractDigest({ tenantSlug: TENANT_SLUG }));
  for (const mutate of [
    (entries: typeof descriptors) => [{ ...entries[0]!, name: "NEON_RUNTIME_URL" }, ...entries.slice(1)],
    (entries: typeof descriptors) => [{ ...entries[0]!, valueClass: "server_public" }, ...entries.slice(1)],
    (entries: typeof descriptors) => [{
      ...entries[0]!,
      source: { kind: "derived_from_owned_resource" as const, resourceRef: "data.roles.changed" },
    }, ...entries.slice(1)],
  ]) {
    assert.notEqual(descriptorDigest(mutate(descriptors)), digest);
  }

  const plan = buildHostingCapabilityPlan({
    tenantSlug: TENANT_SLUG,
    workspaceClass: "disposable",
    deterministicName: "lh2-disposable-s26-lab",
    hostname: "s26-lab.example.test",
    runtimeProfileId: "web-node22-1x",
    buildRecipeId: "spa-plus-http-handlers-v1",
    revisionId: "a".repeat(40),
    bindings: BINDINGS,
    schedules: [],
    runtimeCheckIds: ["api_health"],
    rollbackReasonCode: "verification_failed",
    ownershipMarkerDigest: `sha256:${"a".repeat(64)}`,
  });
  const planRecord = plan as unknown as Record<string, unknown>;
  const release = planRecord.release as Record<string, unknown>;
  const environment = planRecord.environment as Record<string, unknown>;
  assert.equal(release.environment_binding_digest, digest);
  assert.deepEqual(environment.bindings, expectBindingsForPlan());
  assert.match(hostingPlanDigest(plan), /^sha256:[a-f0-9]{64}$/);
});

test("the initials-only photo posture is explicit and recovery-safe", () => {
  const photos = CANONICAL_TENANT_ENVIRONMENT.find((entry) => entry.name === "NEON_PHOTOS_DEFAULT");
  assert.deepEqual(photos, {
    name: "NEON_PHOTOS_DEFAULT",
    valueClass: "server_public",
    source: { kind: "derived_from_plan", planFieldRef: "application.neon_photos_default" },
  });
  const recoveryMetadata = BINDINGS.map((binding) => ({
    name: binding.name,
    value_class: binding.valueClass,
    source: binding.source,
  }));
  const serialized = JSON.stringify(recoveryMetadata);
  assert.doesNotMatch(serialized, /secret_label|r2|object_storage|access_key|secret_access/i);
  assert.match(serialized, /NEON_PHOTOS_DEFAULT/);
});

function expectBindingsForPlan() {
  return BINDINGS.map((binding) => ({
    name: binding.name,
    value_class: binding.valueClass,
    source: binding.source.kind === "generated_secret"
      ? { kind: binding.source.kind, generator_id: binding.source.generatorId }
      : binding.source.kind === "derived_from_plan"
        ? { kind: binding.source.kind, plan_field_ref: binding.source.planFieldRef }
        : binding.source.kind === "derived_from_owned_resource"
          ? { kind: binding.source.kind, resource_ref: binding.source.resourceRef }
          : (() => { throw new Error("closed S26 profile must not use secret labels"); })(),
  }));
}
