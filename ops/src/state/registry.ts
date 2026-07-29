import { randomBytes } from "node:crypto";
import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";

import { canonicalJson, sha256Digest, type JsonValue } from "../core/canonical.js";
import { OpsError, assertOps } from "../core/errors.js";
import { Redactor } from "../core/redaction.js";
import { validateApplyRequestSchema, validatePlanSchema } from "../core/schemas.js";
import {
  validatePlanSemantics,
  validateProviderSnapshots,
  type ValidatePlanOptions,
} from "../core/semantic-validation.js";
import {
  assertOperationTransition,
  assertStepTransition,
  assertTenantTransition,
} from "../core/state-machines.js";
import {
  ONBOARDING_STEP_KINDS,
  type ApplyRequest,
  type OperationState,
  type PlanEnvelope,
  type ProviderSnapshot,
  type StartOperationResult,
  type StepState,
  type TenantLifecycle,
} from "../core/types.js";
import { REGISTRY_SCHEMA_SQL, REGISTRY_SCHEMA_VERSION } from "./schema.js";

const GENESIS_HASH = `sha256:${"0".repeat(64)}`;
const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1_000;

type Row = Record<string, SQLInputValue>;

export interface AuditEvent {
  readonly actor: string;
  readonly eventKind: string;
  readonly planId?: string | undefined;
  readonly operationId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly stateTransition?: string | undefined;
  readonly providerRequestId?: string | undefined;
  readonly detail?: JsonValue | undefined;
}

export interface OperationRecord {
  readonly operationId: string;
  readonly kind: "tenant_onboarding" | "release";
  readonly scope: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly idempotencyKey: string;
  readonly state: OperationState;
  readonly errorCode: string | null;
  readonly redactedErrorSummary: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface StepRecord {
  readonly ordinal: number;
  readonly kind: string;
  readonly state: StepState;
  readonly attempt: number;
  readonly providerRequestId: string | null;
  readonly redactedError: string | null;
}

export interface ResourceReference {
  readonly tenantId: string;
  readonly providerKind: "supabase" | "vercel" | "dns" | "smtp" | "source_repository";
  readonly resourceKind: string;
  readonly providerOwnerId: string;
  readonly resourceId: string;
  readonly deterministicName: string;
  readonly ownershipMarkerDigest: string;
  readonly observedLifecycle: string;
}

export interface TenantReference {
  readonly tenantId: string;
  readonly slug: string;
}

export interface TenantRecord extends TenantReference {
  readonly companyName: string;
  readonly workspaceClass: "internal" | "disposable" | "external";
  readonly desiredLifecycle: TenantLifecycle;
  readonly observedLifecycle: TenantLifecycle;
  readonly releaseChannel: "internal" | "canary" | "stable";
  readonly regionId: string;
  readonly supabaseTierId: string;
  readonly supabaseComputeId: string;
  readonly vercelTierId: string;
  readonly backupProfileId: string;
  readonly cronSlot: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SecretReference {
  readonly scope: "platform" | "tenant";
  readonly tenantId?: string | undefined;
  readonly secretName: string;
  readonly keychainServiceLabel: string;
  readonly keychainAccountLabel: string;
  readonly version: number;
  readonly rotatedAt: string;
}

export interface BackupMetadata {
  readonly digest: string | null;
  readonly createdAt: string | null;
}

export class Registry {
  readonly #database: DatabaseSync;
  readonly #redactor: Redactor;

  constructor(
    path: string,
    ownerUuid: string,
    redactor = new Redactor(),
  ) {
    this.#redactor = redactor;
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL");
      this.#database.exec("PRAGMA synchronous = FULL");
    }
    this.#database.exec(REGISTRY_SCHEMA_SQL);
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO registry_meta
          (singleton_id, schema_version, registry_version, owner_uuid)
         VALUES (1, ?, 0, ?)`,
      )
      .run(REGISTRY_SCHEMA_VERSION, ownerUuid);
    const meta = this.#meta();
    assertOps(
      meta.schema_version === REGISTRY_SCHEMA_VERSION,
      "unsupported_contract",
      `Unsupported registry schema ${String(meta.schema_version)}`,
    );
    assertOps(
      meta.owner_uuid === ownerUuid,
      "invalid_plan",
      "Registry owner UUID does not match",
    );
  }

  close(): void {
    this.#database.close();
  }

  get ownerUuid(): string {
    return String(this.#meta().owner_uuid);
  }

  get registryVersion(): number {
    return Number(this.#meta().registry_version);
  }

  getPlan(planId: string): PlanEnvelope | undefined {
    const row = this.#selectOne(
      "SELECT envelope_json, state FROM plans WHERE plan_id = ?",
      planId,
    );
    if (row === undefined) return undefined;
    const envelope = JSON.parse(String(row.envelope_json)) as PlanEnvelope;
    return {
      ...envelope,
      state: String(row.state) as PlanEnvelope["state"],
    };
  }

  findReusablePlan(
    kind: PlanEnvelope["plan_kind"],
    digest: string,
    now = new Date(),
  ): PlanEnvelope | undefined {
    const row = this.#selectOne(
      `SELECT envelope_json, state FROM plans
       WHERE kind = ? AND digest = ? AND expected_registry_version = ?
         AND state IN ('valid', 'blocked') AND expires_at > ?
       ORDER BY generated_at DESC LIMIT 1`,
      kind,
      digest,
      this.registryVersion,
      now.toISOString(),
    );
    if (row === undefined) return undefined;
    const envelope = JSON.parse(String(row.envelope_json)) as PlanEnvelope;
    return {
      ...envelope,
      state: String(row.state) as PlanEnvelope["state"],
    };
  }

  get backupMetadata(): BackupMetadata {
    const meta = this.#meta();
    return {
      digest:
        meta.last_backup_digest === null ? null : String(meta.last_backup_digest),
      createdAt: meta.last_backup_at === null ? null : String(meta.last_backup_at),
    };
  }

  async createSnapshot(path: string): Promise<void> {
    await backup(this.#database, path);
  }

  recordBackup(digest: string, createdAt: Date, actor = "owner-cli"): void {
    assertOps(
      /^sha256:[0-9a-f]{64}$/.test(digest),
      "backup_invalid",
      "Backup digest must be a SHA-256 digest",
    );
    this.#mutate(() => {
      this.#database
        .prepare(
          `UPDATE registry_meta
           SET last_backup_digest = ?, last_backup_at = ?
           WHERE singleton_id = 1`,
        )
        .run(digest, createdAt.toISOString());
      this.#appendAudit({
        actor,
        eventKind: "registry_backup_recorded",
        detail: { digest, created_at: createdAt.toISOString() },
      });
    });
  }

  savePlan(
    value: unknown,
    validation: Omit<ValidatePlanOptions, "registryOwnerId">,
    actor = "owner",
  ): PlanEnvelope {
    this.#redactor.assertSecretFree(value, "plan");
    const kind = this.#planKind(value);
    validatePlanSchema(kind, value);
    validatePlanSemantics(value, {
      ...validation,
      registryOwnerId: this.ownerUuid,
    });
    const expectedAfterSave = this.registryVersion + 1;
    assertOps(
      value.expected_registry_version === expectedAfterSave,
      "registry_version_conflict",
      "Plan expected registry version must equal the version after it is persisted",
      { expected: expectedAfterSave, received: value.expected_registry_version },
    );
    this.#mutate(() => {
      assertOps(
        this.#selectOne("SELECT plan_id FROM plans WHERE plan_id = ?", value.plan_id) ===
          undefined,
        "invalid_plan",
        `Plan ${value.plan_id} already exists`,
      );
      this.#database
        .prepare(
          `INSERT INTO plans (
            plan_id, kind, schema_version, contract_version, digest,
            canonical_spec_json, envelope_json, generated_at, expires_at,
            expected_registry_version, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.plan_id,
          value.plan_kind,
          value.plan_schema_version,
          value.contract_version,
          value.plan_digest,
          canonicalJson(value.spec),
          canonicalJson(value as unknown as JsonValue),
          value.generated_at,
          value.expires_at,
          value.expected_registry_version,
          value.state,
        );
      this.#appendAudit({
        actor,
        eventKind: "plan_stored",
        planId: value.plan_id,
        stateTransition: `none->${value.state}`,
        detail: {
          kind: value.plan_kind,
          digest: value.plan_digest,
          expected_registry_version: value.expected_registry_version,
        },
      });
    });
    return value;
  }

  startOrResumeOperation(
    requestValue: unknown,
    actor: string,
    observedSnapshots: readonly ProviderSnapshot[] = [],
    now = new Date(),
  ): StartOperationResult {
    this.#redactor.assertSecretFree(requestValue, "apply request");
    this.#redactor.assertSecretFree(observedSnapshots, "provider snapshots");
    validateApplyRequestSchema(requestValue);
    const request = requestValue;
    const plan = this.#getPlan(request.plan_id);
    this.#validateRequestAgainstPlan(request, plan, now);

    const scope = this.#scopeForPlan(plan);
    const existing = this.#selectOne(
      `SELECT * FROM operations WHERE kind = ? AND scope = ? AND idempotency_key = ?`,
      request.operation_kind,
      scope,
      request.idempotency_key,
    );
    if (existing !== undefined) {
      assertOps(
        existing.plan_digest === request.plan_digest,
        "idempotency_conflict",
        "Idempotency key was already used for a different plan digest",
      );
      if (request.operation_id !== undefined) {
        assertOps(
          request.operation_id === existing.operation_id,
          "idempotency_conflict",
          "Resume operation ID does not match the idempotent operation",
        );
      }
      return this.#resumeExisting(existing, request, actor, now);
    }

    assertOps(
      request.operation_id === undefined,
      "idempotency_conflict",
      "Unknown operation_id cannot be resumed",
    );
    assertOps(
      plan.state === "valid",
      plan.state === "consumed" ? "plan_already_consumed" : "plan_invalidated",
      `Plan state ${plan.state} cannot be applied`,
    );
    assertOps(
      plan.expected_registry_version === this.registryVersion &&
        request.expected_registry_version === this.registryVersion,
      "registry_version_conflict",
      "Registry version changed after planning",
      {
        current: this.registryVersion,
        planned: plan.expected_registry_version,
        requested: request.expected_registry_version,
      },
    );
    validateProviderSnapshots(plan, observedSnapshots, now);

    const operationId = `op_${randomBytes(20).toString("hex")}`;
    let fencingToken = 0;
    this.#mutate(() => {
      const currentPlan = this.#getPlan(request.plan_id);
      assertOps(currentPlan.state === "valid", "plan_already_consumed", "Plan was consumed");
      const timestamp = now.toISOString();
      this.#database
        .prepare(
          `INSERT INTO operations (
            operation_id, kind, scope, plan_id, plan_digest, idempotency_key,
            state, actor, approval_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
        )
        .run(
          operationId,
          request.operation_kind,
          scope,
          request.plan_id,
          request.plan_digest,
          request.idempotency_key,
          actor,
          timestamp,
          timestamp,
          timestamp,
        );
      this.#database
        .prepare(
          `UPDATE plans
           SET state = 'consumed', consumed_operation_id = ?, consumed_idempotency_key = ?
           WHERE plan_id = ?`,
        )
        .run(operationId, request.idempotency_key, request.plan_id);
      fencingToken = this.#acquireLockInTransaction(
        this.#lockNameForScope(scope),
        operationId,
        now,
      );
      if (plan.plan_kind === "tenant_onboarding") {
        this.#reserveTenant(plan, timestamp);
        for (let index = 0; index < ONBOARDING_STEP_KINDS.length; index += 1) {
          this.#database
            .prepare(
              `INSERT INTO operation_steps
                (operation_id, ordinal, kind, state, updated_at)
               VALUES (?, ?, ?, 'pending', ?)`,
            )
            .run(operationId, index + 1, ONBOARDING_STEP_KINDS[index]!, timestamp);
        }
      }
      this.#appendAudit({
        actor,
        eventKind: "operation_started",
        planId: request.plan_id,
        operationId,
        idempotencyKey: request.idempotency_key,
        stateTransition: "pending->running",
        detail: { scope, fencing_token: fencingToken },
      });
    });
    return { operationId, state: "running", fencingToken, resumed: false };
  }

  heartbeatLock(
    lockName: string,
    operationId: string,
    fencingToken: number,
    now = new Date(),
    ttlMs = DEFAULT_LOCK_TTL_MS,
  ): void {
    this.#mutate(() => {
      this.#assertFence(lockName, operationId, fencingToken, now);
      this.#database
        .prepare("UPDATE locks SET heartbeat_at = ?, expires_at = ? WHERE lock_name = ?")
        .run(now.toISOString(), new Date(now.getTime() + ttlMs).toISOString(), lockName);
      this.#appendAudit({
        actor: "operations-core",
        eventKind: "lock_heartbeat",
        operationId,
        detail: { lock_name: lockName, fencing_token: fencingToken },
      });
    });
  }

  transitionStep(
    operationId: string,
    ordinal: number,
    to: StepState,
    fencingToken: number,
    options: {
      readonly actor?: string;
      readonly providerRequestId?: string;
      readonly redactedError?: string;
      readonly now?: Date;
    } = {},
  ): void {
    this.#redactor.assertSecretFree(
      options.providerRequestId,
      "provider request ID",
    );
    const now = options.now ?? new Date();
    this.#mutate(() => {
      const operation = this.#requireOperationRow(operationId);
      this.#assertFence(
        this.#lockNameForScope(String(operation.scope)),
        operationId,
        fencingToken,
        now,
      );
      const step = this.#selectOne(
        "SELECT * FROM operation_steps WHERE operation_id = ? AND ordinal = ?",
        operationId,
        ordinal,
      );
      assertOps(step, "invalid_plan", `Unknown operation step ${ordinal}`);
      const from = String(step.state) as StepState;
      assertStepTransition(from, to);
      const attempt = Number(step.attempt) + (to === "running" ? 1 : 0);
      const completedAt = to === "succeeded" ? now.toISOString() : null;
      const startedAt =
        to === "running" && step.started_at === null
          ? now.toISOString()
          : (step.started_at ?? null);
      this.#database
        .prepare(
          `UPDATE operation_steps SET
             state = ?, attempt = ?, provider_request_id = COALESCE(?, provider_request_id),
             started_at = ?, updated_at = ?, completed_at = ?,
             redacted_error = ?
           WHERE operation_id = ? AND ordinal = ?`,
        )
        .run(
          to,
          attempt,
          options.providerRequestId ?? null,
          startedAt,
          now.toISOString(),
          completedAt,
          options.redactedError === undefined
            ? null
            : this.#redactor.redactString(options.redactedError),
          operationId,
          ordinal,
        );
      this.#appendAudit({
        actor: options.actor ?? "operations-core",
        eventKind: "step_state_changed",
        operationId,
        stateTransition: `${from}->${to}`,
        providerRequestId: options.providerRequestId,
        detail: { ordinal, kind: String(step.kind), attempt },
      });
    });
  }

  transitionOperation(
    operationId: string,
    to: OperationState,
    fencingToken: number,
    options: {
      readonly actor?: string;
      readonly errorCode?: string;
      readonly redactedErrorSummary?: string;
      readonly now?: Date;
    } = {},
  ): void {
    const now = options.now ?? new Date();
    this.#mutate(() => {
      const operation = this.#requireOperationRow(operationId);
      this.#assertFence(
        this.#lockNameForScope(String(operation.scope)),
        operationId,
        fencingToken,
        now,
      );
      const from = String(operation.state) as OperationState;
      const kind = String(operation.kind) as "tenant_onboarding" | "release";
      assertOperationTransition(from, to, kind);
      const completed =
        to === "succeeded" || to === "partially_succeeded" ? now.toISOString() : null;
      this.#database
        .prepare(
          `UPDATE operations SET state = ?, error_code = ?, redacted_error_summary = ?,
             updated_at = ?, completed_at = ?
           WHERE operation_id = ?`,
        )
        .run(
          to,
          options.errorCode ?? null,
          options.redactedErrorSummary === undefined
            ? null
            : this.#redactor.redactString(options.redactedErrorSummary),
          now.toISOString(),
          completed,
          operationId,
        );
      this.#appendAudit({
        actor: options.actor ?? "operations-core",
        eventKind: "operation_state_changed",
        operationId,
        stateTransition: `${from}->${to}`,
        detail: options.errorCode === undefined ? {} : { error_code: options.errorCode },
      });
    });
  }

  transitionTenant(
    tenantId: string,
    to: TenantLifecycle,
    operationId: string,
    fencingToken: number,
    now = new Date(),
  ): void {
    this.#mutate(() => {
      const operation = this.#requireOperationRow(operationId);
      this.#assertFence(
        this.#lockNameForScope(String(operation.scope)),
        operationId,
        fencingToken,
        now,
      );
      const tenant = this.#selectOne("SELECT * FROM tenants WHERE tenant_id = ?", tenantId);
      assertOps(tenant, "invalid_plan", `Unknown tenant ${tenantId}`);
      const from = String(tenant.observed_lifecycle) as TenantLifecycle;
      assertTenantTransition(from, to);
      if (to === "active" && tenant.workspace_class === "external") {
        const collision = this.#selectOne(
          `SELECT tenant_id FROM tenants
           WHERE tenant_id <> ? AND workspace_class = 'external'
             AND observed_lifecycle = 'active' AND cron_slot = ?`,
          tenantId,
          Number(tenant.cron_slot),
        );
        assertOps(
          collision === undefined,
          "catalog_invalid",
          `Cron slot ${String(tenant.cron_slot)} is already used by an active external tenant`,
        );
      }
      this.#database
        .prepare(
          "UPDATE tenants SET desired_lifecycle = ?, observed_lifecycle = ?, updated_at = ? WHERE tenant_id = ?",
        )
        .run(to, to, now.toISOString(), tenantId);
      this.#appendAudit({
        actor: "operations-core",
        eventKind: "tenant_state_changed",
        operationId,
        stateTransition: `${from}->${to}`,
        detail: { tenant_id: tenantId },
      });
    });
  }

  saveResourceReference(
    reference: ResourceReference,
    operationId: string,
    fencingToken: number,
    providerRequestId?: string,
    now = new Date(),
  ): void {
    this.#redactor.assertSecretFree(reference, "provider resource reference");
    this.#redactor.assertSecretFree(providerRequestId, "provider request ID");
    this.#mutate(() => {
      const operation = this.#requireOperationRow(operationId);
      this.#assertFence(
        this.#lockNameForScope(String(operation.scope)),
        operationId,
        fencingToken,
        now,
      );
      this.#database
        .prepare(
          `INSERT INTO resource_refs (
            tenant_id, provider_kind, resource_kind, provider_owner_id, resource_id,
            deterministic_name, ownership_marker_digest, observed_lifecycle, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, provider_kind, resource_kind) DO UPDATE SET
            resource_id = excluded.resource_id,
            deterministic_name = excluded.deterministic_name,
            ownership_marker_digest = excluded.ownership_marker_digest,
            observed_lifecycle = excluded.observed_lifecycle,
            observed_at = excluded.observed_at`,
        )
        .run(
          reference.tenantId,
          reference.providerKind,
          reference.resourceKind,
          reference.providerOwnerId,
          reference.resourceId,
          reference.deterministicName,
          reference.ownershipMarkerDigest,
          reference.observedLifecycle,
          now.toISOString(),
        );
      this.#appendAudit({
        actor: "operations-core",
        eventKind: "resource_reference_saved",
        operationId,
        providerRequestId,
        detail: {
          tenant_id: reference.tenantId,
          provider_kind: reference.providerKind,
          resource_kind: reference.resourceKind,
          resource_id: reference.resourceId,
        },
      });
    });
  }

  getOperation(operationId: string): OperationRecord | undefined {
    const row = this.#selectOne("SELECT * FROM operations WHERE operation_id = ?", operationId);
    if (row === undefined) return undefined;
    return this.#operationRecord(row);
  }

  getTenantBySlug(slug: string): TenantReference | undefined {
    const row = this.#selectOne(
      "SELECT tenant_id, slug FROM tenants WHERE slug = ?",
      slug,
    );
    if (row === undefined) return undefined;
    return {
      tenantId: String(row.tenant_id),
      slug: String(row.slug),
    };
  }

  listTenants(filters: {
    readonly lifecycle?: TenantLifecycle;
    readonly workspaceClass?: TenantRecord["workspaceClass"];
  } = {}): readonly TenantRecord[] {
    const conditions: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (filters.lifecycle !== undefined) {
      conditions.push("observed_lifecycle = ?");
      parameters.push(filters.lifecycle);
    }
    if (filters.workspaceClass !== undefined) {
      conditions.push("workspace_class = ?");
      parameters.push(filters.workspaceClass);
    }
    const where =
      conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
    return this.#database
      .prepare(`SELECT * FROM tenants${where} ORDER BY slug`)
      .all(...parameters)
      .map((row) => this.#tenantRecord(row));
  }

  getTenant(slug: string): TenantRecord | undefined {
    const row = this.#selectOne("SELECT * FROM tenants WHERE slug = ?", slug);
    return row === undefined ? undefined : this.#tenantRecord(row);
  }

  listResourceReferences(tenantId: string): readonly ResourceReference[] {
    return this.#database
      .prepare(
        `SELECT * FROM resource_refs
         WHERE tenant_id = ?
         ORDER BY provider_kind, resource_kind`,
      )
      .all(tenantId)
      .map((row) => this.#resourceReference(row));
  }

  saveSecretReference(
    input: Omit<SecretReference, "version" | "rotatedAt">,
    actor = "owner-cli",
    now = new Date(),
  ): SecretReference {
    this.#redactor.assertSecretFree(input, "secret reference");
    assertOps(
      (input.scope === "platform" && input.tenantId === undefined) ||
        (input.scope === "tenant" && input.tenantId !== undefined),
      "secret_invalid",
      "Secret reference scope and tenant do not match",
    );
    let saved!: SecretReference;
    this.#mutate(() => {
      const tenantId = input.tenantId ?? null;
      const existing = this.#selectOne(
        `SELECT version FROM secret_refs
         WHERE scope = ? AND tenant_id IS ? AND secret_name = ?`,
        input.scope,
        tenantId,
        input.secretName,
      );
      const version = Number(existing?.version ?? 0) + 1;
      const rotatedAt = now.toISOString();
      if (existing === undefined) {
        this.#database
          .prepare(
            `INSERT INTO secret_refs (
               scope, tenant_id, secret_name, keychain_service_label,
               keychain_account_label, version, rotated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.scope,
            tenantId,
            input.secretName,
            input.keychainServiceLabel,
            input.keychainAccountLabel,
            version,
            rotatedAt,
          );
      } else {
        this.#database
          .prepare(
            `UPDATE secret_refs
             SET keychain_service_label = ?, keychain_account_label = ?,
                 version = ?, rotated_at = ?
             WHERE scope = ? AND tenant_id IS ? AND secret_name = ?`,
          )
          .run(
            input.keychainServiceLabel,
            input.keychainAccountLabel,
            version,
            rotatedAt,
            input.scope,
            tenantId,
            input.secretName,
          );
      }
      saved = {
        ...input,
        version,
        rotatedAt,
      };
      this.#appendAudit({
        actor,
        eventKind: "secret_reference_rotated",
        detail: {
          scope: input.scope,
          tenant_id: input.tenantId ?? null,
          secret_name: input.secretName,
          keychain_service_label: input.keychainServiceLabel,
          keychain_account_label: input.keychainAccountLabel,
          version,
        },
      });
    });
    return saved;
  }

  listSecretReferences(): readonly SecretReference[] {
    return this.#database
      .prepare(
        `SELECT * FROM secret_refs
         ORDER BY scope, COALESCE(tenant_id, ''), secret_name`,
      )
      .all()
      .map((row) => ({
        scope: String(row.scope) as SecretReference["scope"],
        ...(row.tenant_id === null
          ? {}
          : { tenantId: String(row.tenant_id) }),
        secretName: String(row.secret_name),
        keychainServiceLabel: String(row.keychain_service_label),
        keychainAccountLabel: String(row.keychain_account_label),
        version: Number(row.version),
        rotatedAt: String(row.rotated_at),
      }));
  }

  listSteps(operationId: string): readonly StepRecord[] {
    return this.#database
      .prepare("SELECT * FROM operation_steps WHERE operation_id = ? ORDER BY ordinal")
      .all(operationId)
      .map((row) => ({
        ordinal: Number(row.ordinal),
        kind: String(row.kind),
        state: String(row.state) as StepState,
        attempt: Number(row.attempt),
        providerRequestId:
          row.provider_request_id === null ? null : String(row.provider_request_id),
        redactedError:
          row.redacted_error === null ? null : String(row.redacted_error),
      }));
  }

  countResourceReferences(tenantId: string): number {
    const row = this.#selectOne(
      "SELECT COUNT(*) AS count FROM resource_refs WHERE tenant_id = ?",
      tenantId,
    );
    return Number(row?.count ?? 0);
  }

  getTenantLifecycle(tenantId: string): TenantLifecycle | undefined {
    const row = this.#selectOne(
      "SELECT observed_lifecycle FROM tenants WHERE tenant_id = ?",
      tenantId,
    );
    return row === undefined
      ? undefined
      : (String(row.observed_lifecycle) as TenantLifecycle);
  }

  getResourceReference(
    tenantId: string,
    providerKind: ResourceReference["providerKind"],
    resourceKind: string,
  ): ResourceReference | undefined {
    const row = this.#selectOne(
      `SELECT * FROM resource_refs
       WHERE tenant_id = ? AND provider_kind = ? AND resource_kind = ?`,
      tenantId,
      providerKind,
      resourceKind,
    );
    if (row === undefined) return undefined;
    return this.#resourceReference(row);
  }

  verifyAuditChain(): void {
    const rows = this.#database
      .prepare("SELECT * FROM audit_entries ORDER BY sequence")
      .all();
    let previousHash = GENESIS_HASH;
    for (const row of rows) {
      assertOps(
        row.previous_hash === previousHash,
        "audit_integrity_error",
        `Audit previous hash mismatch at sequence ${String(row.sequence)}`,
      );
      const payload = this.#auditPayload(row);
      const calculated = sha256Digest(canonicalJson(payload));
      assertOps(
        row.entry_hash === calculated,
        "audit_integrity_error",
        `Audit entry hash mismatch at sequence ${String(row.sequence)}`,
      );
      previousHash = calculated;
    }
  }

  unsafeDatabaseForTests(): DatabaseSync {
    return this.#database;
  }

  #planKind(value: unknown): "tenant_onboarding" | "release" {
    assertOps(
      typeof value === "object" && value !== null && "plan_kind" in value,
      "schema_validation_failed",
      "Plan kind is required",
    );
    const kind = (value as { plan_kind?: unknown }).plan_kind;
    assertOps(
      kind === "tenant_onboarding" || kind === "release",
      "unsupported_contract",
      "Unsupported plan kind",
    );
    return kind;
  }

  #meta(): Row {
    return this.#database
      .prepare("SELECT * FROM registry_meta WHERE singleton_id = 1")
      .get() as Row;
  }

  #selectOne(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#database.prepare(sql).get(...params) as Row | undefined;
  }

  #getPlan(planId: string): PlanEnvelope {
    const plan = this.getPlan(planId);
    assertOps(plan, "invalid_plan", `Unknown plan ${planId}`);
    return plan;
  }

  #validateRequestAgainstPlan(
    request: ApplyRequest,
    plan: PlanEnvelope,
    now: Date,
  ): void {
    assertOps(
      request.contract_version === plan.contract_version &&
        request.operation_kind === plan.plan_kind,
      "unsupported_contract",
      "Apply request does not match plan contract",
    );
    assertOps(
      request.plan_digest === plan.plan_digest,
      "plan_digest_mismatch",
      "Apply request digest does not match plan",
    );
    assertOps(
      now.getTime() < Date.parse(plan.expires_at),
      "plan_expired",
      "Plan has expired",
    );
  }

  #scopeForPlan(plan: PlanEnvelope): string {
    const spec = plan.spec as Record<string, unknown>;
    if (plan.plan_kind === "tenant_onboarding") {
      const inputs = spec.inputs as Record<string, unknown>;
      return `tenant:${String(inputs.tenant_slug)}`;
    }
    return `release:${String(spec.release_id)}`;
  }

  #lockNameForScope(scope: string): string {
    return scope;
  }

  #resumeExisting(
    row: Row,
    request: ApplyRequest,
    actor: string,
    now: Date,
  ): StartOperationResult {
    const operationId = String(row.operation_id);
    const state = String(row.state) as OperationState;
    const lockName = this.#lockNameForScope(String(row.scope));
    const lock = this.#selectOne("SELECT * FROM locks WHERE lock_name = ?", lockName);
    if (state !== "failed" && state !== "quarantined") {
      return {
        operationId,
        state,
        fencingToken: Number(lock?.fencing_token ?? 0),
        resumed: true,
      };
    }
    assertOps(
      request.expected_registry_version === this.registryVersion,
      "registry_version_conflict",
      "Resume requires the current registry version",
    );
    let fencingToken = 0;
    this.#mutate(() => {
      fencingToken = this.#acquireLockInTransaction(lockName, operationId, now);
      this.#database
        .prepare(
          "UPDATE operations SET state = 'running', error_code = NULL, redacted_error_summary = NULL, updated_at = ? WHERE operation_id = ?",
        )
        .run(now.toISOString(), operationId);
      this.#appendAudit({
        actor,
        eventKind: "operation_resumed",
        planId: request.plan_id,
        operationId,
        idempotencyKey: request.idempotency_key,
        stateTransition: `${state}->running`,
        detail: { fencing_token: fencingToken },
      });
    });
    return { operationId, state: "running", fencingToken, resumed: true };
  }

  #reserveTenant(plan: PlanEnvelope, timestamp: string): void {
    const spec = plan.spec as Record<string, unknown>;
    const inputs = spec.inputs as Record<string, unknown>;
    const resources = spec.resources as Record<string, unknown>;
    this.#database
      .prepare(
        `INSERT INTO tenants (
          tenant_id, slug, company_name, workspace_class, desired_lifecycle,
          observed_lifecycle, release_channel, region_id, supabase_tier_id,
          supabase_compute_id, vercel_tier_id, backup_profile_id, catalog_refs_json,
          cron_slot, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'planned', 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(resources.tenant_id),
        String(inputs.tenant_slug),
        String(inputs.company_name),
        String(inputs.workspace_class),
        String(inputs.release_channel),
        String(inputs.supabase_region_id),
        String(inputs.supabase_tier_id),
        String(inputs.supabase_compute_id),
        String(inputs.vercel_tier_id),
        String(inputs.backup_profile_id),
        canonicalJson(spec.catalogs as JsonValue),
        Number(resources.cron_slot),
        timestamp,
        timestamp,
      );
    for (const rawBudget of spec.capability_budgets as readonly Record<
      string,
      unknown
    >[]) {
      this.#database
        .prepare(
          `INSERT INTO capability_budgets (
            tenant_id, capability_catalog_id, enabled, unit, soft_limit,
            hard_limit, period, overage_action
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          String(resources.tenant_id),
          String(rawBudget.capability),
          rawBudget.enabled === true ? 1 : 0,
          String(rawBudget.unit),
          Number(rawBudget.soft_limit),
          Number(rawBudget.hard_limit),
          String(rawBudget.period),
          String(rawBudget.overage_action),
        );
    }
    const recovery = spec.recovery as Record<string, unknown>;
    this.#database
      .prepare(
        `INSERT INTO recovery_profiles (
          tenant_id, backup_profile_id, backup_catalog_id, rpo_hours,
          rto_business_hours, business_timezone, business_calendar, coverage_json,
          provider_backup_interval_hours, encrypted_export_interval_hours,
          restore_drill_interval_days
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(resources.tenant_id),
        String(recovery.profile_id),
        String(inputs.backup_profile_id),
        Number(recovery.rpo_hours),
        Number(recovery.rto_business_hours),
        String(recovery.business_timezone),
        "monday-friday",
        canonicalJson(recovery.coverage as JsonValue),
        Number(recovery.provider_backup_interval_hours),
        Number(recovery.encrypted_export_interval_hours),
        Number(recovery.restore_drill_interval_days),
      );
  }

  #acquireLockInTransaction(
    lockName: string,
    operationId: string,
    now: Date,
    ttlMs = DEFAULT_LOCK_TTL_MS,
  ): number {
    const current = this.#selectOne("SELECT * FROM locks WHERE lock_name = ?", lockName);
    if (
      current !== undefined &&
      current.owner_operation_id !== operationId &&
      Date.parse(String(current.expires_at)) > now.getTime()
    ) {
      throw new OpsError("lock_conflict", `Lock ${lockName} is held by another operation`);
    }
    const fencingToken = Number(current?.fencing_token ?? 0) + 1;
    const timestamp = now.toISOString();
    const expiry = new Date(now.getTime() + ttlMs).toISOString();
    this.#database
      .prepare(
        `INSERT INTO locks (
          lock_name, owner_operation_id, fencing_token, acquired_at, expires_at, heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(lock_name) DO UPDATE SET
          owner_operation_id = excluded.owner_operation_id,
          fencing_token = excluded.fencing_token,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at,
          heartbeat_at = excluded.heartbeat_at`,
      )
      .run(lockName, operationId, fencingToken, timestamp, expiry, timestamp);
    return fencingToken;
  }

  #assertFence(
    lockName: string,
    operationId: string,
    fencingToken: number,
    now: Date,
  ): void {
    const lock = this.#selectOne("SELECT * FROM locks WHERE lock_name = ?", lockName);
    assertOps(
      lock !== undefined &&
        lock.owner_operation_id === operationId &&
        Number(lock.fencing_token) === fencingToken &&
        Date.parse(String(lock.expires_at)) > now.getTime(),
      "lock_fence_lost",
      `Fencing token is stale for ${lockName}`,
    );
  }

  #requireOperationRow(operationId: string): Row {
    const operation = this.#selectOne(
      "SELECT * FROM operations WHERE operation_id = ?",
      operationId,
    );
    assertOps(operation, "invalid_plan", `Unknown operation ${operationId}`);
    return operation;
  }

  #operationRecord(row: Row): OperationRecord {
    return {
      operationId: String(row.operation_id),
      kind: String(row.kind) as OperationRecord["kind"],
      scope: String(row.scope),
      planId: String(row.plan_id),
      planDigest: String(row.plan_digest),
      idempotencyKey: String(row.idempotency_key),
      state: String(row.state) as OperationState,
      errorCode: row.error_code === null ? null : String(row.error_code),
      redactedErrorSummary:
        row.redacted_error_summary === null
          ? null
          : String(row.redacted_error_summary),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt:
        row.completed_at === null ? null : String(row.completed_at),
    };
  }

  #tenantRecord(row: Row): TenantRecord {
    return {
      tenantId: String(row.tenant_id),
      slug: String(row.slug),
      companyName: String(row.company_name),
      workspaceClass: String(row.workspace_class) as TenantRecord["workspaceClass"],
      desiredLifecycle: String(row.desired_lifecycle) as TenantLifecycle,
      observedLifecycle: String(row.observed_lifecycle) as TenantLifecycle,
      releaseChannel: String(row.release_channel) as TenantRecord["releaseChannel"],
      regionId: String(row.region_id),
      supabaseTierId: String(row.supabase_tier_id),
      supabaseComputeId: String(row.supabase_compute_id),
      vercelTierId: String(row.vercel_tier_id),
      backupProfileId: String(row.backup_profile_id),
      cronSlot: Number(row.cron_slot),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  #resourceReference(row: Row): ResourceReference {
    return {
      tenantId: String(row.tenant_id),
      providerKind: String(row.provider_kind) as ResourceReference["providerKind"],
      resourceKind: String(row.resource_kind),
      providerOwnerId: String(row.provider_owner_id),
      resourceId: String(row.resource_id),
      deterministicName: String(row.deterministic_name),
      ownershipMarkerDigest: String(row.ownership_marker_digest),
      observedLifecycle: String(row.observed_lifecycle),
    };
  }

  #appendAudit(event: AuditEvent): void {
    const previous = this.#selectOne(
      "SELECT sequence, entry_hash FROM audit_entries ORDER BY sequence DESC LIMIT 1",
    );
    const sequence = Number(previous?.sequence ?? 0) + 1;
    const previousHash = String(previous?.entry_hash ?? GENESIS_HASH);
    const timestamp = new Date().toISOString();
    const detail = this.#redactor.redact(event.detail ?? {}) as JsonValue;
    const payload = {
      sequence,
      previous_hash: previousHash,
      timestamp,
      actor: this.#redactor.redactString(event.actor),
      event_kind: this.#redactor.redactString(event.eventKind),
      plan_id:
        event.planId === undefined
          ? null
          : this.#redactor.redactString(event.planId),
      operation_id:
        event.operationId === undefined
          ? null
          : this.#redactor.redactString(event.operationId),
      idempotency_key:
        event.idempotencyKey === undefined
          ? null
          : this.#redactor.redactString(event.idempotencyKey),
      state_transition:
        event.stateTransition === undefined
          ? null
          : this.#redactor.redactString(event.stateTransition),
      provider_request_id:
        event.providerRequestId === undefined
          ? null
          : this.#redactor.redactString(event.providerRequestId),
      detail,
    } satisfies JsonValue;
    const entryHash = sha256Digest(canonicalJson(payload));
    this.#database
      .prepare(
        `INSERT INTO audit_entries (
          sequence, previous_hash, entry_hash, timestamp, actor, event_kind,
          plan_id, operation_id, idempotency_key, state_transition,
          provider_request_id, detail_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sequence,
        previousHash,
        entryHash,
        timestamp,
        payload.actor,
        payload.event_kind,
        payload.plan_id,
        payload.operation_id,
        payload.idempotency_key,
        payload.state_transition,
        payload.provider_request_id,
        canonicalJson(detail),
      );
  }

  #auditPayload(row: Row): JsonValue {
    return {
      sequence: Number(row.sequence),
      previous_hash: String(row.previous_hash),
      timestamp: String(row.timestamp),
      actor: String(row.actor),
      event_kind: String(row.event_kind),
      plan_id: row.plan_id === null ? null : String(row.plan_id),
      operation_id: row.operation_id === null ? null : String(row.operation_id),
      idempotency_key:
        row.idempotency_key === null ? null : String(row.idempotency_key),
      state_transition:
        row.state_transition === null ? null : String(row.state_transition),
      provider_request_id:
        row.provider_request_id === null ? null : String(row.provider_request_id),
      detail: JSON.parse(String(row.detail_json)) as JsonValue,
    };
  }

  #mutate(work: () => void): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.#database
        .prepare(
          "UPDATE registry_meta SET registry_version = registry_version + 1 WHERE singleton_id = 1",
        )
        .run();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
