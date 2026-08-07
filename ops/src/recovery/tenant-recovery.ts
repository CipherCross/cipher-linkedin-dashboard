import { canonicalJson, sha256Digest } from "../core/canonical.js";
import { asJsonValue } from "../core/semantic-validation.js";
import { OpsError, assertOps } from "../core/errors.js";
import { Redactor } from "../core/redaction.js";
import type {
  OwnershipMarker,
  RecoveryArtifact,
  RecoveryCaptureRequest,
  RecoveryCoverage,
  RecoveryRestoreRequest,
  TenantRecoveryProviders,
} from "../providers/interfaces.js";

const REQUIRED_COVERAGE: readonly RecoveryCoverage[] = [
  "database_schema_data",
  "auth_configuration_identities",
  "storage_metadata",
  "private_storage_objects_or_reconstruction",
  "deployment_configuration_metadata",
];

export interface RegistryRecoveryEvidence {
  readonly digest: string;
  readonly registryVersion: number;
  readonly createdAt: string;
}

export interface TenantRecoverySnapshot {
  readonly format: "tenant-recovery.v1";
  readonly tenantSlug: string;
  readonly sourceResourceIds: Readonly<{
    data: string;
    identity: string;
    objectStorage: string;
    hosting: string;
  }>;
  readonly artifacts: Readonly<{
    data: RecoveryArtifact;
    identity: RecoveryArtifact;
    objectStorage: RecoveryArtifact;
    hosting: RecoveryArtifact;
  }>;
  readonly registry: RegistryRecoveryEvidence;
  readonly coverage: readonly RecoveryCoverage[];
  readonly capturedAt: string;
  readonly manifestDigest: string;
}

export interface CaptureTenantRecoveryRequest {
  readonly tenantSlug: string;
  readonly sourceResourceIds: TenantRecoverySnapshot["sourceResourceIds"];
  readonly recoveryTargetName: string;
  readonly ownership: OwnershipMarker;
  /** Evidence from the encrypted local RegistryBackupService artifact. */
  readonly registry: RegistryRecoveryEvidence;
}

export interface RestoreTenantRecoveryRequest {
  readonly snapshot: TenantRecoverySnapshot;
  readonly targetResourceIds: TenantRecoverySnapshot["sourceResourceIds"];
  readonly ownership: OwnershipMarker;
}

export interface TenantRecoveryRestoreResult {
  readonly manifestDigest: string;
  readonly restoredCoverage: readonly RecoveryCoverage[];
  readonly verifiedAt: string;
}

/**
 * JSON boundary for the strict published schema. Internally the TypeScript
 * surface uses normal camelCase; persisted/reviewed artifacts use the same
 * snake_case convention as the other operations contracts.
 */
export function toTenantRecoveryManifest(snapshot: TenantRecoverySnapshot): object {
  const artifact = (value: RecoveryArtifact) => ({
    provider_request_id: value.providerRequestId,
    artifact_id: value.artifactId,
    manifest_digest: value.manifestDigest,
    coverage: value.coverage,
    item_count: value.itemCount,
    captured_at: value.capturedAt,
    reconstruction_approved: value.reconstructionApproved,
  });
  return {
    format: snapshot.format,
    tenant_slug: snapshot.tenantSlug,
    source_resource_ids: {
      data: snapshot.sourceResourceIds.data,
      identity: snapshot.sourceResourceIds.identity,
      object_storage: snapshot.sourceResourceIds.objectStorage,
      hosting: snapshot.sourceResourceIds.hosting,
    },
    artifacts: {
      data: artifact(snapshot.artifacts.data),
      identity: artifact(snapshot.artifacts.identity),
      object_storage: artifact(snapshot.artifacts.objectStorage),
      hosting: artifact(snapshot.artifacts.hosting),
    },
    registry: {
      digest: snapshot.registry.digest,
      registry_version: snapshot.registry.registryVersion,
      created_at: snapshot.registry.createdAt,
    },
    coverage: snapshot.coverage,
    captured_at: snapshot.capturedAt,
    manifest_digest: snapshot.manifestDigest,
  };
}

/**
 * Provider-neutral orchestration for the recovery scope required by S26.
 * Provider adapters own byte movement and provider calls; this class accepts
 * only typed opaque artifacts, validates complete coverage, and never exposes
 * bytes, connection strings, identity credentials, deployment configuration
 * values, or raw provider responses.
 */
export class TenantRecoveryService {
  readonly #providers: TenantRecoveryProviders;
  readonly #redactor: Redactor;

  constructor(providers: TenantRecoveryProviders, redactor = new Redactor()) {
    this.#providers = providers;
    this.#redactor = redactor;
  }

  async capture(
    input: CaptureTenantRecoveryRequest,
  ): Promise<TenantRecoverySnapshot> {
    this.#redactor.assertSecretFree(input, "tenant recovery capture request");
    this.#assertRegistryEvidence(input.registry);
    const requests: Record<keyof TenantRecoverySnapshot["sourceResourceIds"], RecoveryCaptureRequest> = {
      data: this.#captureRequest(input, input.sourceResourceIds.data),
      identity: this.#captureRequest(input, input.sourceResourceIds.identity),
      objectStorage: this.#captureRequest(input, input.sourceResourceIds.objectStorage),
      hosting: this.#captureRequest(input, input.sourceResourceIds.hosting),
    };
    const [data, identity, objectStorage, hosting] = await Promise.all([
      this.#capture("data", () => this.#providers.data.captureRecovery(requests.data)),
      this.#capture("identity", () => this.#providers.identity.captureRecovery(requests.identity)),
      this.#capture("objectStorage", () => this.#providers.objectStorage.captureRecovery(requests.objectStorage)),
      this.#capture("hosting", () => this.#providers.hosting.captureRecovery(requests.hosting)),
    ]);
    const coverage = coverageOf([data, identity, objectStorage, hosting]);
    assertCoverage(coverage);
    const capturedAt = latestTimestamp([data, identity, objectStorage, hosting]);
    const unsigned = {
      format: "tenant-recovery.v1" as const,
      tenantSlug: input.tenantSlug,
      sourceResourceIds: input.sourceResourceIds,
      artifacts: { data, identity, objectStorage, hosting },
      registry: input.registry,
      coverage,
      capturedAt,
    };
    const snapshot: TenantRecoverySnapshot = {
      ...unsigned,
      manifestDigest: sha256Digest(canonicalJson(asJsonValue(unsigned))),
    };
    this.#redactor.assertSecretFree(snapshot, "tenant recovery snapshot");
    return snapshot;
  }

  async restoreAndVerify(
    input: RestoreTenantRecoveryRequest,
  ): Promise<TenantRecoveryRestoreResult> {
    this.#redactor.assertSecretFree(input, "tenant recovery restore request");
    this.#assertSnapshot(input.snapshot);
    const snapshot = input.snapshot;
    const requests: Record<keyof TenantRecoverySnapshot["sourceResourceIds"], RecoveryRestoreRequest> = {
      data: this.#restoreRequest(snapshot, input.targetResourceIds.data, snapshot.artifacts.data, input.ownership),
      identity: this.#restoreRequest(snapshot, input.targetResourceIds.identity, snapshot.artifacts.identity, input.ownership),
      objectStorage: this.#restoreRequest(snapshot, input.targetResourceIds.objectStorage, snapshot.artifacts.objectStorage, input.ownership),
      hosting: this.#restoreRequest(snapshot, input.targetResourceIds.hosting, snapshot.artifacts.hosting, input.ownership),
    };
    await this.#restore("data", () => this.#providers.data.restoreRecovery(requests.data));
    await this.#restore("identity", () => this.#providers.identity.restoreRecovery(requests.identity));
    await this.#restore("objectStorage", () => this.#providers.objectStorage.restoreRecovery(requests.objectStorage));
    await this.#restore("hosting", () => this.#providers.hosting.restoreRecovery(requests.hosting));
    const reports = await Promise.all([
      this.#verify("data", () => this.#providers.data.verifyRecovery(requests.data)),
      this.#verify("identity", () => this.#providers.identity.verifyRecovery(requests.identity)),
      this.#verify("objectStorage", () => this.#providers.objectStorage.verifyRecovery(requests.objectStorage)),
      this.#verify("hosting", () => this.#providers.hosting.verifyRecovery(requests.hosting)),
    ]);
    assertOps(reports.every((report) => report.passed), "provider_error", "Tenant recovery verification failed");
    const recovered = coverageOf(reports);
    assertCoverage(recovered);
    return {
      manifestDigest: snapshot.manifestDigest,
      restoredCoverage: recovered,
      verifiedAt: latestTimestamp(reports),
    };
  }

  #captureRequest(input: CaptureTenantRecoveryRequest, sourceResourceId: string): RecoveryCaptureRequest {
    return { tenantSlug: input.tenantSlug, sourceResourceId, recoveryTargetName: input.recoveryTargetName, ownership: input.ownership };
  }

  #restoreRequest(snapshot: TenantRecoverySnapshot, targetResourceId: string, artifact: RecoveryArtifact, ownership: OwnershipMarker): RecoveryRestoreRequest {
    return { tenantSlug: snapshot.tenantSlug, targetResourceId, artifact, ownership };
  }

  async #capture(label: string, action: () => Promise<RecoveryArtifact>): Promise<RecoveryArtifact> {
    try {
      const artifact = await action();
      this.#redactor.assertSecretFree(artifact, `${label} recovery artifact`);
      return artifact;
    } catch (error) {
      throw this.#redactor.sanitizeError(error);
    }
  }

  async #restore(label: string, action: () => Promise<unknown>): Promise<void> {
    try {
      const result = await action();
      this.#redactor.assertSecretFree(result, `${label} recovery restore result`);
    } catch (error) {
      throw this.#redactor.sanitizeError(error);
    }
  }

  async #verify(label: string, action: () => Promise<{ readonly coverage: readonly RecoveryCoverage[]; readonly passed: boolean; readonly checkedAt: string }>): Promise<{ readonly coverage: readonly RecoveryCoverage[]; readonly passed: boolean; readonly checkedAt: string }> {
    try {
      const report = await action();
      this.#redactor.assertSecretFree(report, `${label} recovery verification`);
      return report;
    } catch (error) {
      throw this.#redactor.sanitizeError(error);
    }
  }

  #assertRegistryEvidence(registry: RegistryRecoveryEvidence): void {
    assertOps(/^sha256:[0-9a-f]{64}$/.test(registry.digest), "backup_invalid", "Encrypted registry backup digest is invalid");
    assertOps(Number.isSafeInteger(registry.registryVersion) && registry.registryVersion >= 0, "backup_invalid", "Encrypted registry backup version is invalid");
    assertOps(Number.isFinite(Date.parse(registry.createdAt)), "backup_invalid", "Encrypted registry backup timestamp is invalid");
  }

  #assertSnapshot(snapshot: TenantRecoverySnapshot): void {
    this.#assertRegistryEvidence(snapshot.registry);
    assertCoverage(snapshot.coverage);
    const { manifestDigest: _digest, ...unsigned } = snapshot;
    assertOps(
      sha256Digest(canonicalJson(asJsonValue(unsigned))) === snapshot.manifestDigest,
      "backup_invalid",
      "Tenant recovery manifest digest does not match",
    );
  }
}

function coverageOf(items: readonly { readonly coverage: readonly RecoveryCoverage[] }[]): readonly RecoveryCoverage[] {
  return [...new Set(items.flatMap((item) => item.coverage))].sort() as readonly RecoveryCoverage[];
}

function assertCoverage(coverage: readonly RecoveryCoverage[]): void {
  assertOps(
    REQUIRED_COVERAGE.every((item) => coverage.includes(item)),
    "backup_invalid",
    "Tenant recovery coverage is incomplete",
  );
}

function latestTimestamp(items: readonly { readonly capturedAt?: string; readonly checkedAt?: string }[]): string {
  const values = items.map((item) => item.capturedAt ?? item.checkedAt ?? "");
  assertOps(values.every((value) => Number.isFinite(Date.parse(value))), "provider_error", "Provider recovery timestamp is invalid");
  return [...values].sort().at(-1)!;
}
