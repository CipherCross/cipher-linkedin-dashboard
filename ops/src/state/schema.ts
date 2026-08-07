export const REGISTRY_SCHEMA_VERSION = 2;

/**
 * v1 used provider names as registry vocabulary. v2 keeps provider IDs opaque
 * while storing the capability boundary that owns each resource. The migration
 * is local SQLite-only and never calls a provider.
 */
export const REGISTRY_MIGRATIONS = Object.freeze([
  {
    from: 1,
    to: 2,
    sql: `
      ALTER TABLE tenants RENAME COLUMN supabase_tier_id TO data_tier_id;
      ALTER TABLE tenants RENAME COLUMN supabase_compute_id TO data_compute_id;
      ALTER TABLE tenants RENAME COLUMN vercel_tier_id TO hosting_tier_id;

      ALTER TABLE resource_refs RENAME TO resource_refs_v1;
      CREATE TABLE resource_refs (
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        provider_kind TEXT NOT NULL CHECK (provider_kind IN (
          'data','identity','object_storage','hosting','domain','email','source_repository'
        )),
        resource_kind TEXT NOT NULL,
        provider_owner_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        deterministic_name TEXT NOT NULL,
        ownership_marker_digest TEXT NOT NULL,
        observed_lifecycle TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(provider_kind, provider_owner_id, resource_id),
        UNIQUE(tenant_id, provider_kind, resource_kind)
      );
      INSERT INTO resource_refs (
        tenant_id, provider_kind, resource_kind, provider_owner_id, resource_id,
        deterministic_name, ownership_marker_digest, observed_lifecycle, observed_at
      )
      SELECT tenant_id,
        CASE provider_kind
          WHEN 'supabase' THEN 'data'
          WHEN 'vercel' THEN 'hosting'
          WHEN 'dns' THEN 'domain'
          WHEN 'smtp' THEN 'email'
          WHEN 'source_repository' THEN 'source_repository'
          ELSE NULL
        END,
        resource_kind, provider_owner_id, resource_id, deterministic_name,
        ownership_marker_digest, observed_lifecycle, observed_at
      FROM resource_refs_v1;
      DROP TABLE resource_refs_v1;

      ALTER TABLE registry_meta RENAME TO registry_meta_v1;
      CREATE TABLE registry_meta (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = 2),
        registry_version INTEGER NOT NULL CHECK (registry_version >= 0),
        owner_uuid TEXT NOT NULL UNIQUE,
        last_backup_digest TEXT,
        last_backup_at TEXT,
        CHECK (last_backup_digest IS NULL OR last_backup_digest GLOB 'sha256:[0-9a-f]*')
      );
      INSERT INTO registry_meta (
        singleton_id, schema_version, registry_version, owner_uuid,
        last_backup_digest, last_backup_at
      )
      SELECT singleton_id, 2, registry_version, owner_uuid,
        last_backup_digest, last_backup_at
      FROM registry_meta_v1;
      DROP TABLE registry_meta_v1;
      CREATE INDEX IF NOT EXISTS refs_tenant_idx ON resource_refs(tenant_id);
    `,
  },
] as const);

export const REGISTRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS registry_meta (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 2),
  registry_version INTEGER NOT NULL CHECK (registry_version >= 0),
  owner_uuid TEXT NOT NULL UNIQUE,
  last_backup_digest TEXT,
  last_backup_at TEXT,
  CHECK (last_backup_digest IS NULL OR last_backup_digest GLOB 'sha256:[0-9a-f]*')
);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  workspace_class TEXT NOT NULL CHECK (workspace_class IN ('internal','disposable','external')),
  desired_lifecycle TEXT NOT NULL,
  observed_lifecycle TEXT NOT NULL,
  release_channel TEXT NOT NULL CHECK (release_channel IN ('internal','canary','stable')),
  region_id TEXT NOT NULL,
  data_tier_id TEXT NOT NULL,
  data_compute_id TEXT NOT NULL,
  hosting_tier_id TEXT NOT NULL,
  backup_profile_id TEXT NOT NULL,
  catalog_refs_json TEXT NOT NULL,
  cron_slot INTEGER NOT NULL CHECK (cron_slot BETWEEN 0 AND 4),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS tenants_slug_immutable
BEFORE UPDATE OF slug ON tenants
BEGIN
  SELECT RAISE(ABORT, 'tenant slug is immutable');
END;

CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tenant_onboarding','release')),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  contract_version TEXT NOT NULL CHECK (contract_version = 'p2.v1'),
  digest TEXT NOT NULL,
  canonical_spec_json TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  expected_registry_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft','valid','blocked','consumed','expired','invalidated')),
  consumed_operation_id TEXT,
  consumed_idempotency_key TEXT
);

CREATE TRIGGER IF NOT EXISTS plans_immutable_payload
BEFORE UPDATE OF kind, schema_version, contract_version, digest, canonical_spec_json,
  envelope_json, generated_at, expires_at, expected_registry_version ON plans
BEGIN
  SELECT RAISE(ABORT, 'plan payload is immutable');
END;

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tenant_onboarding','release')),
  scope TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  plan_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending','running','waiting_provider','failed','quarantined',
    'succeeded','partially_succeeded'
  )),
  actor TEXT NOT NULL,
  approval_at TEXT NOT NULL,
  error_code TEXT,
  redacted_error_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(kind, scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS operation_steps (
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'reserve_tenant','data_project','tenant_schema','object_storage_identity_email',
    'platform_support','hosting_project','production_env','domain_binding',
    'tenant_build','production_deployment','smoke_suite','company_admin',
    'finalize_tenant'
  )),
  state TEXT NOT NULL CHECK (state IN (
    'pending','running','waiting_provider','failed','outcome_unknown',
    'succeeded','not_applicable'
  )),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  provider_request_id TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  redacted_error TEXT,
  PRIMARY KEY(operation_id, ordinal)
);

CREATE TABLE IF NOT EXISTS resource_refs (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  provider_kind TEXT NOT NULL CHECK (provider_kind IN (
    'data','identity','object_storage','hosting','domain','email','source_repository'
  )),
  resource_kind TEXT NOT NULL,
  provider_owner_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  deterministic_name TEXT NOT NULL,
  ownership_marker_digest TEXT NOT NULL,
  observed_lifecycle TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(provider_kind, provider_owner_id, resource_id),
  UNIQUE(tenant_id, provider_kind, resource_kind)
);

CREATE TABLE IF NOT EXISTS locks (
  lock_name TEXT PRIMARY KEY,
  owner_operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS releases (
  release_id TEXT PRIMARY KEY,
  bundle_digest TEXT NOT NULL,
  git_sha TEXT NOT NULL,
  compatibility_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('internal','canary','stable')),
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS release_targets (
  release_id TEXT NOT NULL REFERENCES releases(release_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  observed_versions_json TEXT NOT NULL,
  target_versions_json TEXT NOT NULL,
  state TEXT NOT NULL,
  last_step TEXT,
  redacted_error TEXT,
  PRIMARY KEY(release_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS capability_budgets (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  capability_catalog_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  unit TEXT NOT NULL,
  soft_limit INTEGER NOT NULL CHECK (soft_limit >= 0),
  hard_limit INTEGER NOT NULL CHECK (hard_limit >= soft_limit),
  period TEXT NOT NULL,
  overage_action TEXT NOT NULL CHECK (overage_action IN (
    'pause_and_alert','queue_and_alert','disable_and_alert'
  )),
  usage_snapshot_at TEXT,
  PRIMARY KEY(tenant_id, capability_catalog_id)
);

CREATE TABLE IF NOT EXISTS recovery_profiles (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),
  backup_profile_id TEXT NOT NULL,
  backup_catalog_id TEXT NOT NULL,
  rpo_hours INTEGER NOT NULL CHECK (rpo_hours BETWEEN 1 AND 24),
  rto_business_hours INTEGER NOT NULL CHECK (rto_business_hours BETWEEN 1 AND 8),
  business_timezone TEXT NOT NULL,
  business_calendar TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  provider_backup_interval_hours INTEGER NOT NULL,
  encrypted_export_interval_hours INTEGER NOT NULL,
  restore_drill_interval_days INTEGER NOT NULL,
  last_successful_backup_at TEXT,
  last_successful_export_at TEXT,
  last_successful_drill_at TEXT
);

CREATE TABLE IF NOT EXISTS secret_refs (
  scope TEXT NOT NULL CHECK (scope IN ('platform','tenant')),
  tenant_id TEXT REFERENCES tenants(tenant_id),
  secret_name TEXT NOT NULL,
  keychain_service_label TEXT NOT NULL,
  keychain_account_label TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  rotated_at TEXT,
  PRIMARY KEY(scope, tenant_id, secret_name),
  CHECK (
    (scope = 'platform' AND tenant_id IS NULL) OR
    (scope = 'tenant' AND tenant_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS secret_refs_scope_name_idx
ON secret_refs(scope, COALESCE(tenant_id, ''), secret_name);

CREATE TABLE IF NOT EXISTS audit_entries (
  sequence INTEGER PRIMARY KEY,
  previous_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL UNIQUE,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  plan_id TEXT,
  operation_id TEXT,
  idempotency_key TEXT,
  state_transition TEXT,
  provider_request_id TEXT,
  detail_json TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_entries_no_update
BEFORE UPDATE ON audit_entries
BEGIN
  SELECT RAISE(ABORT, 'audit entries are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_entries_no_delete
BEFORE DELETE ON audit_entries
BEGIN
  SELECT RAISE(ABORT, 'audit entries are append-only');
END;

CREATE INDEX IF NOT EXISTS plans_state_expires_idx ON plans(state, expires_at);
CREATE INDEX IF NOT EXISTS operations_plan_idx ON operations(plan_id);
CREATE INDEX IF NOT EXISTS operations_state_idx ON operations(state, updated_at);
CREATE INDEX IF NOT EXISTS steps_state_idx ON operation_steps(operation_id, state, ordinal);
CREATE INDEX IF NOT EXISTS refs_tenant_idx ON resource_refs(tenant_id);
CREATE INDEX IF NOT EXISTS locks_expiry_idx ON locks(expires_at);
CREATE INDEX IF NOT EXISTS audit_operation_idx ON audit_entries(operation_id, sequence);
`;
