/**
 * S10 — parity between the concrete hosting adapter and the canonical fake.
 *
 * The adapter cannot be exercised against a live provider, so parity is proven
 * two ways at once:
 *
 *  1. the adapter runs over an in-memory `HostingVendorClient` that deliberately
 *     hands back vendor-shaped resource IDs, so anything that leaked one would
 *     be visible in a canonical result;
 *  2. the same canonical requests are driven through `FakeHostingProvider` and
 *     the two result sets are compared field by field.
 *
 * The schedule assertions parse `frontend/vercel.json` rather than restating the
 * four schedules a third time, and a mutated manifest is used to prove the
 * assertion can actually fail.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CANONICAL_BUILD_RECIPE_ID,
  CANONICAL_ENVIRONMENT_NAME_MAPPING,
  CANONICAL_PUBLIC_BUILD_VALUE_NAMES,
  CANONICAL_RUNTIME_PROFILE_ID,
  CANONICAL_TENANT_ENVIRONMENT,
  CANONICAL_TENANT_SCHEDULES,
  DisposableOnboardingPlanner,
  DisposableOnboardingCore,
  FakeAuthProvider,
  FakeDomainProvider,
  FakeHostingProvider,
  FakeOnboardingProviderBundle,
  FakeSmtpProvider,
  FakeSourceRepositoryProvider,
  FakeSupabaseProvider,
  HOSTING_CAPABILITY_METHODS,
  HOSTING_RESULT_SCHEMAS,
  HOSTING_RESULT_SHAPES,
  LEGACY_PUBLIC_BUILD_VALUE_NAMES,
  OnboardingExecutor,
  OpsError,
  ProviderPreflightService,
  Redactor,
  Registry,
  StrictHostingAdapter,
  VercelHostingAdapter,
  buildTenantEnvironmentBindings,
  normalizeSchedules,
  parseReleaseScheduleManifest,
  scheduleManifestDigest,
  hostingEnvironmentBindingDigest,
  splitManifestPath,
  type DeploymentTargetResult,
  type DomainAssignmentResult,
  type EnvironmentBindingResult,
  type HostingControlPlanePort,
  type HostingProvider,
  type HostingSchedule,
  type HostingValueResolver,
  type HostingValueSource,
  type HostingVendorCapabilities,
  type HostingVendorClient,
  type HostingVendorDomain,
  type HostingVendorEnvironmentValue,
  type HostingVendorRelease,
  type HostingVendorReleaseRequest,
  type HostingVendorRuntimeCheck,
  type HostingVendorSchedule,
  type HostingVendorTarget,
  type HostingVendorTargetRequest,
  type HostingVerificationReport,
  type OnboardingProviders,
  type OwnershipMarker,
  type ReleaseBuildResult,
  type ResourceReference,
  type RolloutResult,
  type ScheduleRegistrationResult,
} from "../src/index.js";
import {
  OWNER_UUID,
  TEST_NOW,
  catalogResolver,
  disposableBusinessInputs,
  disposableProfile,
  executionContext,
  makeApplyRequest,
  makeOnboardingPlan,
  observedSnapshots,
} from "./fixtures.js";

const OPS_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ROUTING_MANIFEST = join(REPOSITORY_ROOT, "frontend", "vercel.json");
const REVISION_A = "1".repeat(40);
/** The tenant's own origin, which IDENTITY_BASE_URL is bound to. */
const SITE_URL = "https://tenant.example.test";
const REVISION_B = "2".repeat(40);
const HOSTNAME = "s10-lab.example-platform.test";
const TARGET_NAME = "lh2-disposable-s10-lab";

/**
 * Synthetic canaries in the `security.test.ts` style. They are inputs to a leak
 * detector, not credentials, and the vendor-shaped prefixes exist so a result
 * carrying a provider resource ID would be caught.
 */
const CANARY_SECRET = "s10-canary-secret-4b71e0c9";
const CANARY_PUBLIC = "s10-canary-public-11ade372";
const VENDOR_TARGET_PREFIX = "prj";
const VENDOR_RELEASE_PREFIX = "dpl";

const OWNERSHIP: OwnershipMarker = {
  managedBy: "lh2-platform-ops",
  tenantSlug: "s10-lab",
  workspaceClass: "disposable",
  contractVersion: "p2.v1",
  registryOwnerId: OWNER_UUID,
  digest: `sha256:${"a".repeat(64)}`,
};

const FOREIGN_OWNERSHIP: OwnershipMarker = {
  ...OWNERSHIP,
  digest: `sha256:${"b".repeat(64)}`,
};

const BINDINGS = buildTenantEnvironmentBindings({ tenantSlug: "s10-lab" });
const ENVIRONMENT_BINDING_DIGEST = hostingEnvironmentBindingDigest(
  BINDINGS.map((binding) => ({
    name: binding.name,
    valueClass: binding.valueClass,
    source: binding.source,
  })),
);
const PUBLIC_VALUE_NAMES = [
  ...CANONICAL_PUBLIC_BUILD_VALUE_NAMES,
  ...LEGACY_PUBLIC_BUILD_VALUE_NAMES,
].sort();
const MANIFEST_DIGEST = scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES);

/* ------------------------------------------------------------------ *
 * The in-memory vendor transport
 * ------------------------------------------------------------------ */

function vendorId(prefix: string, value: string): string {
  // Assembled at runtime: no long vendor-shaped literal appears in this source,
  // but the value the adapter receives is vendor-shaped enough for the canonical
  // sweep below to catch it if it ever escaped.
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export interface InMemoryVendorOptions {
  readonly scheduleManifestJson?: string;
  readonly failingCheckIds?: readonly string[];
  readonly ownedTargets?: Readonly<Record<string, string>>;
}

class InMemoryHostingVendorClient implements HostingVendorClient {
  readonly targets = new Map<string, HostingVendorTarget>();
  readonly environment = new Map<string, HostingVendorEnvironmentValue[]>();
  readonly releases = new Map<string, HostingVendorRelease>();
  readonly domains = new Map<string, HostingVendorDomain>();
  readonly active = new Map<string, string>();
  readonly #options: InMemoryVendorOptions;

  constructor(options: InMemoryVendorOptions = {}) {
    this.#options = options;
    for (const [name, digest] of Object.entries(options.ownedTargets ?? {})) {
      this.targets.set(name, {
        targetId: vendorId(VENDOR_TARGET_PREFIX, name),
        name,
        lifecycle: "ready",
        automaticPromotionEnabled: false,
        isolatedPreviewsEnabled: false,
        ownershipMarkerDigest: digest,
      });
    }
  }

  async describeCapabilities(): Promise<HostingVendorCapabilities> {
    return {
      controlPlaneAccessible: true,
      runtimeProfileIds: [CANONICAL_RUNTIME_PROFILE_ID],
      maximumSchedules: 20,
      serverValueBindingSupported: true,
      publicValueBindingSupported: true,
      pinnedRevisionBuildSupported: true,
      customDomainSupported: true,
      rollbackSupported: true,
      automaticPromotionCanBeDisabled: true,
      isolatedPreviewsSupported: true,
      validUntil: "2030-01-01T00:30:00.000Z",
    };
  }

  async findTarget(name: string): Promise<HostingVendorTarget | undefined> {
    return this.targets.get(name);
  }

  async createTarget(
    request: HostingVendorTargetRequest,
  ): Promise<HostingVendorTarget> {
    const target: HostingVendorTarget = {
      targetId: vendorId(VENDOR_TARGET_PREFIX, request.name),
      name: request.name,
      lifecycle: "ready",
      automaticPromotionEnabled: false,
      isolatedPreviewsEnabled: false,
      ownershipMarkerDigest: request.ownershipMarkerDigest,
    };
    this.targets.set(request.name, target);
    return target;
  }

  async putEnvironmentValues(
    targetId: string,
    values: readonly HostingVendorEnvironmentValue[],
  ): Promise<void> {
    this.environment.set(targetId, [...values]);
  }

  async createRelease(
    request: HostingVendorReleaseRequest,
  ): Promise<HostingVendorRelease> {
    const releaseId = vendorId(
      VENDOR_RELEASE_PREFIX,
      `${request.targetId}:${request.revisionId}`,
    );
    const release: HostingVendorRelease = {
      releaseId,
      targetId: request.targetId,
      revisionId: request.revisionId,
      state: "ready",
      artifactDigest: `sha256:${createHash("sha256")
        .update(`${request.revisionId}:${request.buildRecipeId}`)
        .digest("hex")}`,
    };
    this.releases.set(releaseId, release);
    return release;
  }

  async readReleaseSchedules(
    _revisionId: string,
  ): Promise<readonly HostingVendorSchedule[]> {
    return parseReleaseScheduleManifest(
      this.#options.scheduleManifestJson ??
        readFileSync(ROUTING_MANIFEST, "utf8"),
    );
  }

  async findDomain(
    targetId: string,
    hostname: string,
  ): Promise<HostingVendorDomain | undefined> {
    // Returned regardless of which target holds it: the adapter is the layer
    // that must refuse a hostname bound elsewhere.
    void targetId;
    return this.domains.get(hostname);
  }

  async attachDomain(
    targetId: string,
    hostname: string,
  ): Promise<HostingVendorDomain> {
    const bound = { hostname, targetId, certificateReady: true };
    this.domains.set(hostname, bound);
    return bound;
  }

  async activateRelease(targetId: string, releaseId: string): Promise<void> {
    this.active.set(targetId, releaseId);
  }

  async activeReleaseId(targetId: string): Promise<string | null> {
    return this.active.get(targetId) ?? null;
  }

  async runRuntimeChecks(
    _targetId: string,
    _releaseId: string,
    checkIds: readonly string[],
  ): Promise<readonly HostingVendorRuntimeCheck[]> {
    const failing = new Set(this.#options.failingCheckIds ?? []);
    return checkIds.map((checkId) => ({
      checkId,
      passed: !failing.has(checkId),
    }));
  }
}

class RecordingResolver implements HostingValueResolver {
  readonly resolved: string[] = [];

  async resolve(source: HostingValueSource): Promise<string> {
    if (source.kind === "secret_label") {
      const value = source.secretLabel.endsWith("public_key")
        ? CANARY_PUBLIC
        : CANARY_SECRET;
      this.resolved.push(value);
      return value;
    }
    if (source.kind === "generated_secret") {
      this.resolved.push(CANARY_SECRET);
      return CANARY_SECRET;
    }
    return `https://${HOSTNAME}`;
  }
}

function makeAdapter(
  options: InMemoryVendorOptions = {},
): {
  readonly adapter: VercelHostingAdapter;
  readonly client: InMemoryHostingVendorClient;
  readonly resolver: RecordingResolver;
} {
  const client = new InMemoryHostingVendorClient(options);
  const resolver = new RecordingResolver();
  return {
    adapter: new VercelHostingAdapter(client, resolver, {
      redactor: new Redactor([CANARY_SECRET]),
    }),
    client,
    resolver,
  };
}

/* ------------------------------------------------------------------ *
 * A single canonical sequence, driven through any port
 * ------------------------------------------------------------------ */

interface CapabilityResults {
  readonly target: DeploymentTargetResult;
  readonly binding: EnvironmentBindingResult;
  readonly release: ReleaseBuildResult;
  readonly domain: DomainAssignmentResult;
  readonly schedules: ScheduleRegistrationResult;
  readonly promote: RolloutResult;
  readonly secondRelease: ReleaseBuildResult;
  readonly secondPromote: RolloutResult;
  readonly rollback: RolloutResult;
  readonly verification: HostingVerificationReport;
}

async function driveCapabilities(
  port: HostingControlPlanePort,
): Promise<CapabilityResults> {
  const target = await port.createDeploymentTarget({
    deterministicName: TARGET_NAME,
    workspaceClass: "disposable",
    runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
    ownership: OWNERSHIP,
    automaticPromotionEnabled: false,
    isolatedPreviewsEnabled: false,
  });
  const binding = await port.bindEnvironment({
    targetHandle: target.targetHandle,
    scope: "production",
    siteUrl: SITE_URL,
    bindings: BINDINGS,
  });
  const release = await port.buildRelease({
    targetHandle: target.targetHandle,
    revisionId: REVISION_A,
    buildRecipeId: CANONICAL_BUILD_RECIPE_ID,
    publicValueNames: PUBLIC_VALUE_NAMES,
    environmentBindingDigest: ENVIRONMENT_BINDING_DIGEST,
    scheduleManifestDigest: MANIFEST_DIGEST,
  });
  const domain = await port.assignDomain({
    targetHandle: target.targetHandle,
    hostname: HOSTNAME,
    ownership: OWNERSHIP,
    certificateMode: "provider_managed",
  });
  const schedules = await port.registerSchedules({
    targetHandle: target.targetHandle,
    releaseHandle: release.releaseHandle,
    schedules: CANONICAL_TENANT_SCHEDULES,
    manifestDigest: MANIFEST_DIGEST,
  });
  const promote = await port.promoteRelease({ hostname: "tenant.example.test",
    targetHandle: target.targetHandle,
    releaseHandle: release.releaseHandle,
  });
  const verification = await port.verifyDeployment({
    targetHandle: target.targetHandle,
    expectedActiveReleaseHandle: release.releaseHandle,
    expectedHostname: HOSTNAME,
    expectedRevisionId: REVISION_A,
    expectedSchedules: CANONICAL_TENANT_SCHEDULES,
    runtimeCheckIds: ["api_health", "preview_isolation"],
  });
  const secondRelease = await port.buildRelease({
    targetHandle: target.targetHandle,
    revisionId: REVISION_B,
    buildRecipeId: CANONICAL_BUILD_RECIPE_ID,
    publicValueNames: PUBLIC_VALUE_NAMES,
    environmentBindingDigest: ENVIRONMENT_BINDING_DIGEST,
    scheduleManifestDigest: MANIFEST_DIGEST,
  });
  const secondPromote = await port.promoteRelease({ hostname: "tenant.example.test",
    targetHandle: target.targetHandle,
    releaseHandle: secondRelease.releaseHandle,
  });
  const rollback = await port.rollbackRelease({
    targetHandle: target.targetHandle,
    releaseHandle: release.releaseHandle,
    supersededReleaseHandle: secondRelease.releaseHandle,
    reasonCode: "verification_failed",
  });
  return {
    target,
    binding,
    release,
    domain,
    schedules,
    promote,
    secondRelease,
    secondPromote,
    rollback,
    verification,
  };
}

/**
 * The artifact digest is the one field a provider genuinely observes rather
 * than derives from canonical inputs, so it is compared by shape while every
 * other field is compared by value.
 */
function withoutArtifactDigest(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, entry) =>
      key === "artifactDigest" ? undefined : entry,
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Structural sweep
 * ------------------------------------------------------------------ */

const FORBIDDEN_KEYS: readonly RegExp[] = [
  /vercel/i,
  /^team_?id$/i,
  /^project_?id$/i,
  /^target_?id$/i,
  /^deployment_?id$/i,
  /^release_?id$/i,
  /^build_?id$/i,
  /^crons?$/i,
];

const FORBIDDEN_VALUES: readonly RegExp[] = [
  /vercel/i,
  /\bteam_[A-Za-z0-9]{10,}/,
  /\bprj_[A-Za-z0-9]{10,}/,
  /\bdpl_[A-Za-z0-9]{10,}/,
];

function walk(value: unknown, path = "$", key: string | null = null): {
  readonly path: string;
  readonly key: string | null;
  readonly value: unknown;
}[] {
  const here = [{ path, key, value }];
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
 * Registry provider kinds and preflight snapshot providers are canonical
 * capability vocabulary. They are removed from the generic structural sweep
 * only because the sweep is specifically about vendor-shaped values.
 */
function withoutRegistryVocabulary(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, entry) =>
      key === "providerKind" || key === "provider" ? undefined : entry,
    ),
  );
}

function assertCanonical(value: unknown, label: string): void {
  for (const node of walk(value)) {
    if (node.key !== null) {
      for (const pattern of FORBIDDEN_KEYS) {
        assert.equal(
          pattern.test(node.key),
          false,
          `${label}: vendor-shaped key at ${node.path}`,
        );
      }
    }
    if (typeof node.value === "string") {
      for (const pattern of FORBIDDEN_VALUES) {
        assert.equal(
          pattern.test(node.value),
          false,
          `${label}: vendor-shaped value at ${node.path}`,
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
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(value)),
    value,
    `${label}: value is not pure JSON`,
  );
}

/* ================================================================== *
 * Adapter contract
 * ================================================================== */

test("the hosting adapter satisfies the canonical port and every result shape", async () => {
  const { adapter } = makeAdapter();
  for (const methods of Object.values(HOSTING_CAPABILITY_METHODS)) {
    for (const method of methods) {
      assert.equal(
        typeof (adapter as unknown as Record<string, unknown>)[method],
        "function",
        `adapter is missing ${method}`,
      );
    }
  }
  assert.equal(typeof adapter.inspect, "function");

  const inspection = await adapter.inspect({
    deterministicName: TARGET_NAME,
    workspaceClass: "disposable",
    runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
    requiredScheduleCount: CANONICAL_TENANT_SCHEDULES.length,
    requiredServerValueCount: 12,
    requiredPublicValueCount: 4,
    ownership: OWNERSHIP,
  });
  const results = await driveCapabilities(adapter);
  const observed: Readonly<Record<string, unknown>> = {
    inspect: inspection,
    createDeploymentTarget: results.target,
    bindEnvironment: results.binding,
    buildRelease: results.release,
    assignDomain: results.domain,
    registerSchedules: results.schedules,
    promoteRelease: results.promote,
    rollbackRelease: results.rollback,
    verifyDeployment: results.verification,
  };
  for (const [method, expectedKeys] of Object.entries(HOSTING_RESULT_SHAPES)) {
    assert.deepEqual(
      Object.keys(observed[method] as object).sort(),
      [...expectedKeys].sort(),
      `${method} result does not match HOSTING_RESULT_SHAPES`,
    );
    assertCanonical(observed[method], `adapter.${method}`);
  }
});

test("the strict hosting schemas and HOSTING_RESULT_SHAPES agree in both directions", () => {
  for (const [method, expectedKeys] of Object.entries(HOSTING_RESULT_SHAPES)) {
    const schema = HOSTING_RESULT_SCHEMAS[
      method as keyof typeof HOSTING_RESULT_SCHEMAS
    ];
    assert.ok(schema, `no strict schema for ${method}`);
    assert.deepEqual(
      Object.keys(schema.shape).sort(),
      [...expectedKeys].sort(),
      `strict schema for ${method} drifted from HOSTING_RESULT_SHAPES`,
    );
  }
  assert.deepEqual(
    Object.keys(HOSTING_RESULT_SCHEMAS).sort(),
    Object.keys(HOSTING_RESULT_SHAPES).sort(),
  );
});

test("the strict hosting adapter accepts canonical results and rejects an extra field", async () => {
  const { adapter } = makeAdapter();
  const strict = new StrictHostingAdapter(adapter);
  const results = await driveCapabilities(strict);
  assert.equal(results.verification.status, "passed");

  class LeakyPort implements HostingControlPlanePort {
    constructor(readonly inner: HostingProvider) {}
    inspect = (request: Parameters<HostingProvider["inspect"]>[0]) =>
      this.inner.inspect(request);
    createDeploymentTarget = async (
      request: Parameters<HostingProvider["createDeploymentTarget"]>[0],
    ) => ({
      ...(await this.inner.createDeploymentTarget(request)),
      projectId: vendorId(VENDOR_TARGET_PREFIX, "leak"),
    });
    bindEnvironment = (
      request: Parameters<HostingProvider["bindEnvironment"]>[0],
    ) => this.inner.bindEnvironment(request);
    buildRelease = (request: Parameters<HostingProvider["buildRelease"]>[0]) =>
      this.inner.buildRelease(request);
    assignDomain = (request: Parameters<HostingProvider["assignDomain"]>[0]) =>
      this.inner.assignDomain(request);
    registerSchedules = (
      request: Parameters<HostingProvider["registerSchedules"]>[0],
    ) => this.inner.registerSchedules(request);
    promoteRelease = (
      request: Parameters<HostingProvider["promoteRelease"]>[0],
    ) => this.inner.promoteRelease(request);
    rollbackRelease = (
      request: Parameters<HostingProvider["rollbackRelease"]>[0],
    ) => this.inner.rollbackRelease(request);
    verifyDeployment = (
      request: Parameters<HostingProvider["verifyDeployment"]>[0],
    ) => this.inner.verifyDeployment(request);
  }

  const leaky = new StrictHostingAdapter(new LeakyPort(makeAdapter().adapter));
  await assert.rejects(
    leaky.createDeploymentTarget({
      deterministicName: TARGET_NAME,
      workspaceClass: "disposable",
      runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
      ownership: OWNERSHIP,
      automaticPromotionEnabled: false,
      isolatedPreviewsEnabled: false,
    }),
    (error: unknown) =>
      error instanceof OpsError && error.code === "provider_error",
  );
});

/* ================================================================== *
 * Capability parity, adapter versus fake
 * ================================================================== */

test("adapter and fake produce the same canonical results for the same requests", async () => {
  const { adapter } = makeAdapter();
  const fake = new FakeHostingProvider([], {
    secretMaterial: {
      [`lh2-platform/tenant/s10-lab/data.public_key`]: CANARY_PUBLIC,
      [`lh2-platform/tenant/s10-lab/data.admin_key`]: CANARY_SECRET,
    },
  });
  const fromAdapter = await driveCapabilities(adapter);
  const fromFake = await driveCapabilities(fake);

  // Pinned build: everything the canonical contract fixes is equal; the artifact
  // digest is provider-observed build metadata and is compared by shape.
  assert.deepEqual(
    withoutArtifactDigest(fromAdapter.release),
    withoutArtifactDigest(fromFake.release),
    "pinned build parity",
  );
  for (const digest of [
    fromAdapter.release.artifactDigest,
    fromFake.release.artifactDigest,
  ]) {
    assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  }
  assert.equal(fromAdapter.release.revisionId, REVISION_A);
  assert.equal(fromAdapter.release.revisionPinned, true);
  assert.equal(fromAdapter.release.buildRecipeId, CANONICAL_BUILD_RECIPE_ID);
  assert.deepEqual(fromAdapter.release.publicValueNames, PUBLIC_VALUE_NAMES);

  // Environment binding: names, classes, source kinds and the digest over them.
  assert.deepEqual(fromAdapter.binding, fromFake.binding, "environment parity");
  assert.deepEqual(
    fromAdapter.binding.bindings.map((entry) => entry.name),
    BINDINGS.map((entry) => entry.name),
  );

  // Domain assignment: hostname, certificate mode, ownership-marker digest.
  assert.deepEqual(fromAdapter.domain, fromFake.domain, "domain parity");
  assert.equal(fromAdapter.domain.certificateMode, "provider_managed");
  assert.equal(
    fromAdapter.domain.ownershipMarkerDigest,
    OWNERSHIP.digest,
  );

  // Target, schedules and both rollout directions.
  assert.deepEqual(fromAdapter.target, fromFake.target, "target parity");
  assert.deepEqual(fromAdapter.schedules, fromFake.schedules, "schedule parity");
  assert.deepEqual(fromAdapter.promote, fromFake.promote, "promote parity");
  assert.deepEqual(fromAdapter.rollback, fromFake.rollback, "rollback parity");
  assert.deepEqual(
    withoutArtifactDigest(fromAdapter.verification),
    withoutArtifactDigest(fromFake.verification),
    "verification parity",
  );

  // Verification reports runtime, schedules, domain and build metadata.
  const report = fromAdapter.verification;
  assert.equal(report.status, "passed");
  assert.equal(report.runtime.reachable, true);
  assert.deepEqual(report.runtime.failedCheckIds, []);
  assert.deepEqual(report.schedules.missingScheduleIds, []);
  assert.deepEqual(report.schedules.unexpectedScheduleIds, []);
  assert.equal(report.schedules.manifestMatchesRelease, true);
  assert.equal(report.domain.hostname, HOSTNAME);
  assert.equal(report.domain.servesActiveRelease, true);
  assert.equal(report.build.revisionMatchesExpected, true);
  assert.equal(report.build.revisionPinned, true);
});

test("promote and rollback stay distinguishable and equally constrained", async () => {
  for (const port of [makeAdapter().adapter, new FakeHostingProvider()] as const) {
    const results = await driveCapabilities(port);
    assert.equal(results.promote.rolloutKind, "promote");
    assert.equal(results.promote.reasonCode, null);
    assert.equal(results.rollback.rolloutKind, "rollback");
    assert.equal(results.rollback.reasonCode, "verification_failed");
    assert.ok(results.rollback.rolloutSequence > results.secondPromote.rolloutSequence);
    assert.equal(
      results.rollback.previousReleaseHandle,
      results.secondRelease.releaseHandle,
    );

    // Rolling back to the release that is already active is not a rollback.
    await assert.rejects(
      port.rollbackRelease({
        targetHandle: results.target.targetHandle,
        releaseHandle: results.release.releaseHandle,
        supersededReleaseHandle: results.release.releaseHandle,
        reasonCode: "verification_failed",
      }),
      (error: unknown) =>
        error instanceof OpsError && error.code === "provider_error",
    );
    // The withdrawn release must be the currently active one.
    await assert.rejects(
      port.rollbackRelease({
        targetHandle: results.target.targetHandle,
        releaseHandle: results.secondRelease.releaseHandle,
        supersededReleaseHandle: results.secondRelease.releaseHandle,
        reasonCode: "verification_failed",
      }),
      (error: unknown) =>
        error instanceof OpsError && error.code === "provider_error",
    );
    // Returning to an already-superseded release through promote is refused.
    await assert.rejects(
      port.promoteRelease({ hostname: "tenant.example.test",
        targetHandle: results.target.targetHandle,
        releaseHandle: results.secondRelease.releaseHandle,
      }),
      (error: unknown) =>
        error instanceof OpsError && error.code === "provider_error",
    );
  }

  // Nothing promoted yet: there is nothing to roll back.
  for (const port of [makeAdapter().adapter, new FakeHostingProvider()] as const) {
    const target = await port.createDeploymentTarget({
      deterministicName: TARGET_NAME,
      workspaceClass: "disposable",
      runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
      ownership: OWNERSHIP,
      automaticPromotionEnabled: false,
      isolatedPreviewsEnabled: false,
    });
    await assert.rejects(
      port.rollbackRelease({
        targetHandle: target.targetHandle,
        releaseHandle: "hrel_absent",
        supersededReleaseHandle: "hrel_other",
        reasonCode: "verification_failed",
      }),
      (error: unknown) =>
        error instanceof OpsError && error.code === "provider_error",
    );
  }
});

test("the adapter refuses a target and a domain whose ownership marker does not match", async () => {
  const { adapter } = makeAdapter({
    ownedTargets: { [TARGET_NAME]: FOREIGN_OWNERSHIP.digest },
  });
  await assert.rejects(
    adapter.createDeploymentTarget({
      deterministicName: TARGET_NAME,
      workspaceClass: "disposable",
      runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
      ownership: OWNERSHIP,
      automaticPromotionEnabled: false,
      isolatedPreviewsEnabled: false,
    }),
    (error: unknown) =>
      error instanceof OpsError &&
      error.code === "provider_error" &&
      /ownership marker mismatch/.test(error.message),
  );

  const owned = makeAdapter().adapter;
  const target = await owned.createDeploymentTarget({
    deterministicName: TARGET_NAME,
    workspaceClass: "disposable",
    runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
    ownership: OWNERSHIP,
    automaticPromotionEnabled: false,
    isolatedPreviewsEnabled: false,
  });
  await assert.rejects(
    owned.assignDomain({
      targetHandle: target.targetHandle,
      hostname: HOSTNAME,
      ownership: FOREIGN_OWNERSHIP,
      certificateMode: "provider_managed",
    }),
    (error: unknown) =>
      error instanceof OpsError &&
      /ownership marker mismatch/.test(error.message),
  );
});

test("an interrupted apply adopts the existing target rather than duplicating it", async () => {
  const { adapter, client } = makeAdapter();
  const request = {
    deterministicName: TARGET_NAME,
    workspaceClass: "disposable" as const,
    runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
    ownership: OWNERSHIP,
    automaticPromotionEnabled: false as const,
    isolatedPreviewsEnabled: false as const,
  };
  const first = await adapter.createDeploymentTarget(request);
  assert.equal(first.adopted, false);
  const second = await adapter.createDeploymentTarget(request);
  assert.equal(second.adopted, true);
  assert.equal(second.targetHandle, first.targetHandle);
  assert.equal(client.targets.size, 1);

  // A fresh adapter process reconciles by deterministic name and ownership
  // marker and lands on the same canonical handle.
  const resumed = new VercelHostingAdapter(client, new RecordingResolver());
  const third = await resumed.createDeploymentTarget(request);
  assert.equal(third.adopted, true);
  assert.equal(third.targetHandle, first.targetHandle);
  assert.equal(client.targets.size, 1);
});

/* ================================================================== *
 * Schedule parity against the live routing manifest
 * ================================================================== */

function manifestSchedules(json: string): readonly string[] {
  return parseReleaseScheduleManifest(json)
    .map((entry) =>
      JSON.stringify([
        entry.routePath,
        Object.entries({ ...entry.queryParameters }).sort(),
        entry.expression,
      ]),
    )
    .sort();
}

function canonicalScheduleShapes(
  schedules: readonly HostingSchedule[],
): readonly string[] {
  return schedules
    .map((entry) =>
      JSON.stringify([
        entry.routePath,
        Object.entries({ ...entry.queryParameters }).sort(),
        entry.expression,
      ]),
    )
    .sort();
}

test("the four schedules match the canonical set and the live routing manifest", () => {
  const manifestJson = readFileSync(ROUTING_MANIFEST, "utf8");
  const fromManifest = manifestSchedules(manifestJson);
  assert.equal(fromManifest.length, 4);
  assert.equal(CANONICAL_TENANT_SCHEDULES.length, 4);
  assert.deepEqual(
    fromManifest,
    canonicalScheduleShapes(CANONICAL_TENANT_SCHEDULES),
    "frontend/vercel.json and CANONICAL_TENANT_SCHEDULES disagree",
  );

  // The query string is a parameter, not part of the route name.
  assert.deepEqual(splitManifestPath("/api/briefing?kind=weekly"), {
    routePath: "/api/briefing",
    queryParameters: { kind: "weekly" },
  });

  // Order-independent, so the manifest may list them in any order.
  assert.deepEqual(
    canonicalScheduleShapes(normalizeSchedules(CANONICAL_TENANT_SCHEDULES)),
    canonicalScheduleShapes([...CANONICAL_TENANT_SCHEDULES].reverse()),
  );
});

test("a divergence in any one of the four schedules fails the assertion", () => {
  const manifest = JSON.parse(readFileSync(ROUTING_MANIFEST, "utf8")) as {
    crons: { path: string; schedule: string }[];
  };
  for (let index = 0; index < manifest.crons.length; index += 1) {
    for (const mutate of [
      (entry: { path: string; schedule: string }) => ({
        ...entry,
        schedule: "0 0 * * *",
      }),
      (entry: { path: string; schedule: string }) => ({
        ...entry,
        path: `${entry.path}${entry.path.includes("?") ? "&" : "?"}drift=1`,
      }),
    ]) {
      const mutated = {
        ...manifest,
        crons: manifest.crons.map((entry, position) =>
          position === index ? mutate(entry) : entry,
        ),
      };
      assert.notDeepEqual(
        manifestSchedules(JSON.stringify(mutated)),
        canonicalScheduleShapes(CANONICAL_TENANT_SCHEDULES),
        `mutating schedule ${index} must break the parity assertion`,
      );
    }
  }
  // A manifest that drops one schedule is caught too.
  assert.notDeepEqual(
    manifestSchedules(JSON.stringify({ crons: manifest.crons.slice(1) })),
    canonicalScheduleShapes(CANONICAL_TENANT_SCHEDULES),
  );
});

test("the adapter refuses to register schedules the pinned release does not declare", async () => {
  const manifest = JSON.parse(readFileSync(ROUTING_MANIFEST, "utf8")) as {
    crons: { path: string; schedule: string }[];
  };
  const drifted = JSON.stringify({
    ...manifest,
    crons: manifest.crons.map((entry, index) =>
      index === 0 ? { ...entry, schedule: "0 0 * * *" } : entry,
    ),
  });
  const { adapter } = makeAdapter({ scheduleManifestJson: drifted });
  const target = await adapter.createDeploymentTarget({
    deterministicName: TARGET_NAME,
    workspaceClass: "disposable",
    runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
    ownership: OWNERSHIP,
    automaticPromotionEnabled: false,
    isolatedPreviewsEnabled: false,
  });
  await adapter.bindEnvironment({
    targetHandle: target.targetHandle,
    scope: "production",
    siteUrl: SITE_URL,
    bindings: BINDINGS,
  });
  const release = await adapter.buildRelease({
    targetHandle: target.targetHandle,
    revisionId: REVISION_A,
    buildRecipeId: CANONICAL_BUILD_RECIPE_ID,
    publicValueNames: PUBLIC_VALUE_NAMES,
    environmentBindingDigest: ENVIRONMENT_BINDING_DIGEST,
    scheduleManifestDigest: MANIFEST_DIGEST,
  });
  await assert.rejects(
    adapter.registerSchedules({
      targetHandle: target.targetHandle,
      releaseHandle: release.releaseHandle,
      schedules: CANONICAL_TENANT_SCHEDULES,
      manifestDigest: MANIFEST_DIGEST,
    }),
    (error: unknown) =>
      error instanceof OpsError &&
      /does not declare the schedules/.test(error.message),
  );
});

/* ================================================================== *
 * Environment name contract
 * ================================================================== */

test("the closed S26 environment contract emits exactly one reviewed descriptor per value", () => {
  const canonicalNames = CANONICAL_TENANT_ENVIRONMENT.map((entry) => entry.name);
  assert.equal(new Set(canonicalNames).size, canonicalNames.length);
  assert.deepEqual(CANONICAL_ENVIRONMENT_NAME_MAPPING, []);
  assert.equal(canonicalNames.some((name) => /supabase|object_storage|r2/i.test(name)), false);
  const bindings = buildTenantEnvironmentBindings({ tenantSlug: "s10-lab" });
  assert.deepEqual(
    bindings.map((entry) => entry.name).sort(),
    [...canonicalNames].sort(),
  );
  assert.equal(bindings.some((entry) => entry.source.kind === "secret_label"), false);
});

test("environment binding writes values but returns none, and no label either", async () => {
  const { adapter, client, resolver } = makeAdapter();
  const target = await adapter.createDeploymentTarget({
    deterministicName: TARGET_NAME,
    workspaceClass: "disposable",
    runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
    ownership: OWNERSHIP,
    automaticPromotionEnabled: false,
    isolatedPreviewsEnabled: false,
  });
  const binding = await adapter.bindEnvironment({
    targetHandle: target.targetHandle,
    scope: "production",
    siteUrl: SITE_URL,
    bindings: BINDINGS,
  });

  // The adapter genuinely handled secret material: a fake that never held one
  // would prove nothing.
  assert.ok(resolver.resolved.filter((value) => value === CANARY_SECRET).length >= 4);
  const written = [...client.environment.values()].flat();
  assert.equal(written.length, BINDINGS.length);
  assert.ok(written.some((value) => value.value === CANARY_SECRET));
  assert.ok(written.some((value) => value.secret === true));

  // Server-side values are written encrypted; public build values are not.
  for (const value of written) {
    const declared = BINDINGS.find((entry) => entry.name === value.name)!;
    assert.equal(value.secret, declared.valueClass === "server_secret");
  }

  const serialized = JSON.stringify(binding);
  assert.equal(serialized.includes(CANARY_SECRET), false);
  assert.equal(serialized.includes(CANARY_PUBLIC), false);
  for (const entry of BINDINGS) {
    if (entry.source.kind === "secret_label") {
      assert.equal(
        serialized.includes(entry.source.secretLabel),
        false,
        "a key-store label reached the canonical result",
      );
    }
  }
  for (const descriptor of binding.bindings) {
    assert.deepEqual(Object.keys(descriptor).sort(), [
      "name",
      "sourceKind",
      "valueClass",
    ]);
  }
  new Redactor([CANARY_SECRET, CANARY_PUBLIC]).assertSecretFree(
    binding,
    "adapter environment binding",
  );
});

test("no canary reaches an adapter result, error or verification report", async () => {
  const { adapter } = makeAdapter({ failingCheckIds: ["api_health"] });
  const redactor = new Redactor([CANARY_SECRET, CANARY_PUBLIC]);
  const results = await driveCapabilities(adapter);
  for (const [label, value] of Object.entries(results)) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes(CANARY_SECRET), false, label);
    assert.equal(serialized.includes(CANARY_PUBLIC), false, label);
    redactor.assertSecretFree(value, `adapter ${label}`);
    assertCanonical(value, `adapter ${label}`);
  }
  assert.equal(results.verification.status, "failed");
  assert.deepEqual(results.verification.runtime.failedCheckIds, ["api_health"]);

  // The error path is swept too.
  class LeakyResolver implements HostingValueResolver {
    async resolve(): Promise<string> {
      throw new OpsError("provider_error", `binding failed: ${CANARY_SECRET}`, {
        value: CANARY_SECRET,
      });
    }
  }
  const leaky = new VercelHostingAdapter(
    new InMemoryHostingVendorClient(),
    new LeakyResolver(),
    { redactor },
  );
  const target = await leaky.createDeploymentTarget({
    deterministicName: TARGET_NAME,
    workspaceClass: "disposable",
    runtimeProfileId: CANONICAL_RUNTIME_PROFILE_ID,
    ownership: OWNERSHIP,
    automaticPromotionEnabled: false,
    isolatedPreviewsEnabled: false,
  });
  await assert.rejects(
    leaky.bindEnvironment({
      targetHandle: target.targetHandle,
      scope: "production",
      siteUrl: SITE_URL,
      bindings: BINDINGS,
    }),
    (error: unknown) => {
      const safe = redactor.sanitizeError(error);
      assert.equal(JSON.stringify(safe).includes(CANARY_SECRET), false);
      return true;
    },
  );
});

/* ================================================================== *
 * Interchangeability inside the onboarding executor
 * ================================================================== */

function bundleWith(hosting: HostingProvider): OnboardingProviders {
  return {
    data: new FakeSupabaseProvider(),
    identity: new FakeAuthProvider(),
    objectStorage: new FakeSupabaseProvider(),
    hosting,
    email: new FakeSmtpProvider(),
    domain: new FakeDomainProvider(),
    sourceRepository: new FakeSourceRepositoryProvider(),
  };
}

async function runOnboarding(
  hosting: HostingProvider,
): Promise<readonly ResourceReference[]> {
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
    const executor = new OnboardingExecutor(registry, bundleWith(hosting));
    const context = executionContext(
      plan,
      started.operationId,
      started.fencingToken,
    );
    for (let ordinal = 1; ordinal <= 13; ordinal += 1) {
      assert.equal((await executor.executeNext(context)).ordinal, ordinal);
    }
    assert.equal(registry.getOperation(started.operationId)?.state, "succeeded");
    registry.verifyAuditChain();
    return (
      [
        ["data", "project"],
        ["hosting", "project"],
        ["hosting", "build"],
        ["hosting", "deployment"],
      ] as const
    ).map((entry) => {
      const reference = registry.getResourceReference(
        context.tenantId,
        entry[0],
        entry[1],
      );
      assert.ok(reference, `${entry[0]}/${entry[1]} reference is missing`);
      return reference;
    });
  } finally {
    registry.close();
  }
}

test("the adapter and the fake are interchangeable in the onboarding executor", async () => {
  const fromFake = await runOnboarding(new FakeHostingProvider());
  const fromAdapter = await runOnboarding(makeAdapter().adapter);
  assert.deepEqual(
    fromAdapter,
    fromFake,
    "the same plan must drive both providers to the same registry state",
  );
  for (const reference of fromAdapter) {
    assertCanonical(
      withoutRegistryVocabulary(reference),
      `resource reference ${reference.resourceKind}`,
    );
  }
  // Resource kind is a capability boundary; handles and ownership markers are
  // canonical and contain no vendor response fragments.
  assert.deepEqual(
    fromAdapter.map((reference) => reference.providerKind),
    ["data", "hosting", "hosting", "hosting"],
    "registry provider vocabulary is capability-neutral",
  );
  for (const reference of fromAdapter.slice(1)) {
    assert.match(
      reference.resourceId,
      /^h(tgt|rel|roll)_[0-9a-f]{20}$/,
      "the registry must hold a canonical handle, not a provider resource ID",
    );
  }
  // The strict boundary is equally satisfied by both.
  const strict = await runOnboarding(
    new StrictHostingAdapter(makeAdapter().adapter),
  );
  assert.deepEqual(strict, fromFake);
});

test("preflight and planning run identically over the adapter and the fake", async () => {
  async function preflight(hosting: HostingProvider) {
    const registry = new Registry(":memory:", OWNER_UUID);
    try {
      const providers = bundleWith(hosting);
      const clock = () => TEST_NOW;
      const profile = disposableProfile();
      const service = new ProviderPreflightService(providers, profile, { clock });
      const planner = new DisposableOnboardingPlanner(
        registry,
        profile,
        service,
        clock,
      );
      const core = new DisposableOnboardingCore(registry, providers, planner, clock);
      const report = await core.preflight(disposableBusinessInputs());
      const dryRun = await core.dryRunPlan(disposableBusinessInputs());
      return {
        status: report.status,
        snapshots: report.snapshots,
        prerequisites: report.prerequisites,
        planDigest: dryRun.envelope.plan_digest,
      };
    } finally {
      registry.close();
    }
  }
  const fromFake = await preflight(new FakeHostingProvider());
  const fromAdapter = await preflight(makeAdapter().adapter);
  assert.equal(fromFake.status, "passed");
  assert.deepEqual(fromAdapter, fromFake);
  assertCanonical(
    withoutRegistryVocabulary(fromAdapter.snapshots),
    "preflight snapshots",
  );
  assert.deepEqual(
    fromAdapter.snapshots.map((snapshot) => snapshot.provider),
    ["data", "hosting", "domain", "email", "source_repository"],
    "preflight snapshot vocabulary is capability-neutral",
  );
});

test("the fake bundle still runs with no provider credentials present", async () => {
  const scrubbed = [
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_SERVICE_ROLE_KEY",
    "AWS_ACCESS_KEY_ID",
    "ANTHROPIC_API_KEY",
  ];
  const saved = new Map(scrubbed.map((name) => [name, process.env[name]]));
  for (const name of scrubbed) delete process.env[name];
  try {
    const bundle = new FakeOnboardingProviderBundle();
    const results = await driveCapabilities(bundle.hosting);
    assert.equal(results.verification.status, "passed");
    assert.equal(bundle.hosting.targetCount, 1);
  } finally {
    for (const [name, value] of saved) {
      if (value !== undefined) process.env[name] = value;
    }
  }
});

/* ================================================================== *
 * Static assertions
 * ================================================================== */

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

test("the new hosting sources import nothing vendor-specific", () => {
  const allowed: Readonly<Record<string, readonly string[]>> = {
    "src/providers/hosting-tenant.ts": ["./hosting.js"],
    "src/providers/hosting-vercel.ts": [
      "node:crypto",
      "../core/canonical.js",
      "../core/errors.js",
      "../core/redaction.js",
      "./hosting.js",
    ],
    "src/providers/fake-bundle.ts": [
      "./fakes.js",
      "./hosting-fake.js",
      "./interfaces.js",
    ],
  };
  for (const [relative, permitted] of Object.entries(allowed)) {
    const specifiers = [
      ...new Set(importSpecifiers(readFileSync(join(OPS_ROOT, relative), "utf8"))),
    ].sort();
    assert.deepEqual(
      specifiers,
      [...permitted].sort(),
      `${relative} imports outside its allowlist`,
    );
  }
});

test("the new sources carry no secret, credential or vendor resource ID", () => {
  const forbidden: readonly [RegExp, string][] = [
    [/postgres(?:ql)?:\/\//i, "connection string"],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/, "bearer token"],
    [/\bsbp_[A-Za-z0-9]{16,}/, "provider access token"],
    [/\bAKIA[0-9A-Z]{16}\b/, "cloud access key"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
    [/\bteam_[A-Za-z0-9]{16,}/, "vendor team ID"],
    [/\bprj_[A-Za-z0-9]{16,}/, "vendor project ID"],
    [/\bdpl_[A-Za-z0-9]{16,}/, "vendor deployment ID"],
  ];
  for (const relative of [
    "src/providers/hosting-tenant.ts",
    "src/providers/hosting-vercel.ts",
    "src/providers/fake-bundle.ts",
    "test/hosting-parity.test.ts",
  ]) {
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

// Removed in S11 phase 1: test("S10 changed no database, frontend or agent
// file"). It diffed the working branch against main and failed if any
// postgres/, supabase/, frontend/ or sync-agent/ path appeared. That was S10's
// own blast-radius contract, and S10 has merged — from then on it could only
// fire on later branches doing the work they were commissioned to do, starting
// with S11 phase 1's driver. Repo-wide immutability is not this suite's job
// either way: postgres/tests/portable_migration_ledger_static_assertions.mjs
// owns it, and still enforces the half that is a real invariant (already-applied
// migrations and the published baseline set, the latter by digest).
