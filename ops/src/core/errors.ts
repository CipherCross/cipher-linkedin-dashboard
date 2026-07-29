export type OpsErrorCode =
  | "audit_integrity_error"
  | "backup_decryption_failed"
  | "backup_invalid"
  | "catalog_invalid"
  | "cli_usage"
  | "idempotency_conflict"
  | "invalid_plan"
  | "invalid_state_transition"
  | "lock_conflict"
  | "lock_fence_lost"
  | "outcome_unknown"
  | "plan_already_consumed"
  | "plan_digest_mismatch"
  | "plan_expired"
  | "plan_invalidated"
  | "provider_error"
  | "provider_snapshot_drift"
  | "recovery_conflict"
  | "redaction_violation"
  | "registry_version_conflict"
  | "schema_validation_failed"
  | "secret_input_required"
  | "secret_invalid"
  | "secret_store_error"
  | "unsupported_contract";

export class OpsError extends Error {
  readonly code: OpsErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: OpsErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "OpsError";
    this.code = code;
    this.details = details;
  }
}

export function assertOps(
  condition: unknown,
  code: OpsErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): asserts condition {
  if (!condition) {
    throw new OpsError(code, message, details);
  }
}
