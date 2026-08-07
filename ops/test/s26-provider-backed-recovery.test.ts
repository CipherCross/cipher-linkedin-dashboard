import assert from "node:assert/strict";
import test from "node:test";

import {
  createS26Runtime,
  FakeDomainProvider,
  FakeHostingProvider,
  FakeIdentityProvider,
  FakeNeonDataProvider,
  FakeObjectStorageProvider,
  FakeSmtpProvider,
  FakeSourceRepositoryProvider,
  Registry,
  S26ProviderBackedOperations,
  TenantRecoveryService,
  toTenantRecoveryManifest,
  validateTenantRecoverySchema,
  type DataRecoveryPort,
  type HostingRecoveryPort,
  type IdentityRecoveryPort,
  type ObjectStorageRecoveryPort,
  type RecoveryArtifact,
  type RecoveryCaptureRequest,
  type RecoveryRestoreRequest,
  type RecoveryVerification,
  type S26OperationsApiBundle,
} from "../src/index.js";
import { OWNER_UUID, TEST_NOW, disposableBusinessInputs, disposableProfile } from "./fixtures.js";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CAPTURED_AT = "2030-01-01T00:10:00.000Z";
const VERIFIED_AT = "2030-01-01T00:20:00.000Z";

abstract class RecoveryContract {
  readonly captured: RecoveryCaptureRequest[] = [];
  readonly restored: RecoveryRestoreRequest[] = [];
  readonly verified: RecoveryRestoreRequest[] = [];
  readonly #coverage: RecoveryArtifact["coverage"];
  readonly #reconstructionApproved: boolean;

  constructor(
    coverage: readonly RecoveryArtifact["coverage"][number][],
    reconstructionApproved = false,
  ) {
    this.#coverage = coverage;
    this.#reconstructionApproved = reconstructionApproved;
  }

  async captureRecovery(request: RecoveryCaptureRequest): Promise<RecoveryArtifact> {
    this.captured.push(request);
    return {
      providerRequestId: `req_capture_${this.captured.length}`,
      artifactId: `artifact_${this.captured.length}`,
      manifestDigest: DIGEST,
      ownershipMarkerDigest: request.ownership.digest,
      coverage: this.#coverage,
      itemCount: 1,
      capturedAt: CAPTURED_AT,
      reconstructionApproved: this.#reconstructionApproved,
    };
  }

  async restoreRecovery(request: RecoveryRestoreRequest) {
    this.restored.push(request);
    return { providerRequestId: `req_restore_${this.restored.length}` };
  }

  async verifyRecovery(request: RecoveryRestoreRequest): Promise<RecoveryVerification> {
    this.verified.push(request);
    return {
      providerRequestId: `req_verify_${this.verified.length}`,
      coverage: this.#coverage,
      passed: true,
      checkedAt: VERIFIED_AT,
    };
  }
}

class RecoverableNeonApi extends FakeNeonDataProvider implements DataRecoveryPort {
  readonly #recovery = new (class extends RecoveryContract {
    constructor() { super(["database_schema_data"]); }
  })();
  get recovery() { return this.#recovery; }
  captureRecovery(request: RecoveryCaptureRequest) { return this.#recovery.captureRecovery(request); }
  restoreRecovery(request: RecoveryRestoreRequest) { return this.#recovery.restoreRecovery(request); }
  verifyRecovery(request: RecoveryRestoreRequest) { return this.#recovery.verifyRecovery(request); }
}

class RecoverableBetterAuthApi extends FakeIdentityProvider implements IdentityRecoveryPort {
  readonly #recovery = new (class extends RecoveryContract {
    constructor() { super(["auth_configuration_identities"]); }
  })();
  get recovery() { return this.#recovery; }
  captureRecovery(request: RecoveryCaptureRequest) { return this.#recovery.captureRecovery(request); }
  restoreRecovery(request: RecoveryRestoreRequest) { return this.#recovery.restoreRecovery(request); }
  verifyRecovery(request: RecoveryRestoreRequest) { return this.#recovery.verifyRecovery(request); }
}

class RecoverableR2Api extends FakeObjectStorageProvider implements ObjectStorageRecoveryPort {
  readonly #recovery = new (class extends RecoveryContract {
    constructor() { super(["storage_metadata", "private_storage_objects_or_reconstruction"]); }
  })();
  get recovery() { return this.#recovery; }
  captureRecovery(request: RecoveryCaptureRequest) { return this.#recovery.captureRecovery(request); }
  restoreRecovery(request: RecoveryRestoreRequest) { return this.#recovery.restoreRecovery(request); }
  verifyRecovery(request: RecoveryRestoreRequest) { return this.#recovery.verifyRecovery(request); }
}

class RecoverableVercelApi extends FakeHostingProvider implements HostingRecoveryPort {
  readonly #recovery = new (class extends RecoveryContract {
    constructor() { super(["deployment_configuration_metadata"]); }
  })();
  get recovery() { return this.#recovery; }
  captureRecovery(request: RecoveryCaptureRequest) { return this.#recovery.captureRecovery(request); }
  restoreRecovery(request: RecoveryRestoreRequest) { return this.#recovery.restoreRecovery(request); }
  verifyRecovery(request: RecoveryRestoreRequest) { return this.#recovery.verifyRecovery(request); }
}

function providerContracts(): S26OperationsApiBundle {
  return {
    data: new RecoverableNeonApi(),
    identity: new RecoverableBetterAuthApi(),
    objectStorage: new RecoverableR2Api(),
    hosting: new RecoverableVercelApi(),
    email: new FakeSmtpProvider(),
    domain: new FakeDomainProvider(),
    sourceRepository: new FakeSourceRepositoryProvider(),
  };
}

function ownership() {
  return {
    managedBy: "lh2-platform-ops" as const,
    tenantSlug: "disposable-lab",
    workspaceClass: "disposable" as const,
    contractVersion: "p2.v1" as const,
    registryOwnerId: OWNER_UUID,
    digest: DIGEST,
  };
}

test("S26 provider-backed composition wires named Neon, Better Auth, R2, Vercel and prerequisite adapters without P4-C", async () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const contracts = providerContracts();
    const composed = new S26ProviderBackedOperations(contracts);
    assert.deepEqual(Object.keys(composed.onboarding).sort(), [
      "data", "domain", "email", "hosting", "identity", "objectStorage", "sourceRepository",
    ]);
    const runtime = createS26Runtime(
      registry,
      disposableProfile(),
      contracts,
      undefined,
      () => TEST_NOW,
    );
    const result = await runtime.ownerOperations.call(
      "tenant_preflight",
      disposableBusinessInputs(),
    );
    assert.equal((result as { status: string }).status, "passed");
  } finally {
    registry.close();
  }
});

test("S26 provider-neutral recovery captures and restores every tenant surface with encrypted-registry evidence", async () => {
  const contracts = providerContracts();
  const service = new TenantRecoveryService(new S26ProviderBackedOperations(contracts).recovery);
  const snapshot = await service.capture({
    tenantSlug: "disposable-lab",
    sourceResourceIds: {
      data: "neon-project-opaque",
      identity: "better-auth-tenant-opaque",
      objectStorage: "r2-bucket-opaque",
      hosting: "vercel-target-opaque",
    },
    recoveryTargetName: "lh2-disposable-disposable-lab-recovery",
    ownership: ownership(),
    registry: {
      digest: DIGEST,
      registryVersion: 42,
      createdAt: CAPTURED_AT,
    },
  });
  assert.deepEqual(snapshot.coverage, [
    "auth_configuration_identities",
    "database_schema_data",
    "deployment_configuration_metadata",
    "private_storage_objects_or_reconstruction",
    "storage_metadata",
  ]);
  assert.match(snapshot.manifestDigest, /^sha256:[0-9a-f]{64}$/);
  const manifest = toTenantRecoveryManifest(snapshot);
  validateTenantRecoverySchema(manifest);
  assert.throws(
    () => validateTenantRecoverySchema({ ...manifest, provider_payload: {} }),
    /tenant recovery contract schema validation failed/,
  );

  const restored = await service.restoreAndVerify({
    snapshot,
    targetResourceIds: {
      data: "neon-recovery-project-opaque",
      identity: "better-auth-recovery-opaque",
      objectStorage: "r2-recovery-bucket-opaque",
      hosting: "vercel-recovery-target-opaque",
    },
    ownership: ownership(),
  });
  assert.equal(restored.manifestDigest, snapshot.manifestDigest);
  assert.equal(restored.verifiedAt, VERIFIED_AT);
  const recoveryContracts = [
    (contracts.data as RecoverableNeonApi).recovery,
    (contracts.identity as RecoverableBetterAuthApi).recovery,
    (contracts.objectStorage as RecoverableR2Api).recovery,
    (contracts.hosting as RecoverableVercelApi).recovery,
  ];
  for (const backend of recoveryContracts) {
    assert.equal(backend.captured.length, 1);
    assert.equal(backend.restored.length, 1);
    assert.equal(backend.verified.length, 1);
  }
});

test("S26 recovery rejects an ownership-mismatched artifact before any restore", async () => {
  class WrongOwnerNeon extends RecoverableNeonApi {
    override async captureRecovery(request: RecoveryCaptureRequest): Promise<RecoveryArtifact> {
      return { ...(await super.captureRecovery(request)), ownershipMarkerDigest: `sha256:${"b".repeat(64)}` };
    }
  }
  const contracts = providerContracts();
  const service = new TenantRecoveryService(new S26ProviderBackedOperations({ ...contracts, data: new WrongOwnerNeon() }).recovery);
  await assert.rejects(
    service.capture({
      tenantSlug: "disposable-lab",
      sourceResourceIds: { data: "data", identity: "identity", objectStorage: "storage", hosting: "hosting" },
      recoveryTargetName: "lh2-disposable-disposable-lab-recovery",
      ownership: ownership(),
      registry: { digest: DIGEST, registryVersion: 42, createdAt: CAPTURED_AT },
    }),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "recovery_conflict",
  );
});
