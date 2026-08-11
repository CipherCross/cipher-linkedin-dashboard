import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Registry } from "../src/index.js";

const OWNER_UUID = "11111111-1111-4111-8111-111111111111";
const TENANT_UUID = "22222222-2222-4222-8222-222222222222";
const DIGEST = `sha256:${"a".repeat(64)}`;

test("registry migration to v3 preserves rows and maps capability and step vocabulary", () => {
  const directory = mkdtempSync(join(tmpdir(), "lh2-ops-registry-migration-"));
  const path = join(directory, "registry.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE registry_meta (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        registry_version INTEGER NOT NULL,
        owner_uuid TEXT NOT NULL UNIQUE,
        last_backup_digest TEXT,
        last_backup_at TEXT
      );
      INSERT INTO registry_meta VALUES (1, 1, 7, '${OWNER_UUID}', NULL, NULL);
      CREATE TABLE tenants (
        tenant_id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        company_name TEXT NOT NULL,
        workspace_class TEXT NOT NULL,
        desired_lifecycle TEXT NOT NULL,
        observed_lifecycle TEXT NOT NULL,
        release_channel TEXT NOT NULL,
        region_id TEXT NOT NULL,
        supabase_tier_id TEXT NOT NULL,
        supabase_compute_id TEXT NOT NULL,
        vercel_tier_id TEXT NOT NULL,
        backup_profile_id TEXT NOT NULL,
        catalog_refs_json TEXT NOT NULL,
        cron_slot INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tenants VALUES (
        '${TENANT_UUID}', 'migration-lab', 'Migration Lab', 'disposable',
        'planned', 'planned', 'canary', 'eu-west', 'data-standard',
        'data-compute-small', 'hosting-standard', 'backup-standard', '[]', 2,
        '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
      );
      CREATE TABLE resource_refs (
        tenant_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
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
      CREATE TABLE operations (
        operation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL,
        plan_id TEXT,
        plan_digest TEXT,
        expected_registry_version INTEGER,
        approval_actor TEXT NOT NULL,
        approval_at TEXT NOT NULL,
        error_code TEXT,
        redacted_error_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO operations VALUES (
        'op-legacy', 'tenant_onboarding', 'migration-lab', 'key-1', 'succeeded',
        NULL, NULL, NULL, 'owner-cli', '2030-01-01T00:00:00.000Z', NULL, NULL,
        '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', NULL
      );
      CREATE TABLE operation_steps (
        operation_id TEXT NOT NULL REFERENCES operations(operation_id),
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'reserve_tenant','supabase_project','tenant_schema','storage_auth_smtp',
          'platform_support','vercel_project','production_env','domain_binding',
          'tenant_build','production_deployment','smoke_suite','company_admin',
          'finalize_tenant'
        )),
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        provider_request_id TEXT,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        redacted_error TEXT,
        PRIMARY KEY(operation_id, ordinal)
      );
      INSERT INTO operation_steps VALUES
        ('op-legacy', 1, 'reserve_tenant', 'succeeded', 1, NULL, NULL, '2030-01-01T00:00:00.000Z', NULL, NULL),
        ('op-legacy', 2, 'supabase_project', 'succeeded', 1, NULL, NULL, '2030-01-01T00:00:00.000Z', NULL, NULL),
        ('op-legacy', 4, 'storage_auth_smtp', 'succeeded', 1, NULL, NULL, '2030-01-01T00:00:00.000Z', NULL, NULL),
        ('op-legacy', 6, 'vercel_project', 'succeeded', 1, NULL, NULL, '2030-01-01T00:00:00.000Z', NULL, NULL);
      INSERT INTO resource_refs VALUES
        ('${TENANT_UUID}', 'supabase', 'project', 'opaque-data-owner', 'opaque-data-resource', 'data-name', '${DIGEST}', 'ready', '2030-01-01T00:00:00.000Z'),
        ('${TENANT_UUID}', 'vercel', 'project', 'opaque-hosting-owner', 'opaque-hosting-resource', 'hosting-name', '${DIGEST}', 'ready', '2030-01-01T00:00:00.000Z'),
        ('${TENANT_UUID}', 'smtp', 'delivery', 'opaque-email-owner', 'opaque-email-resource', 'email-name', '${DIGEST}', 'ready', '2030-01-01T00:00:00.000Z'),
        ('${TENANT_UUID}', 'source_repository', 'revision', 'opaque-source-owner', 'opaque-source-resource', 'source-name', '${DIGEST}', 'ready', '2030-01-01T00:00:00.000Z');
    `);
  } finally {
    database.close();
  }

  try {
    const registry = new Registry(path, OWNER_UUID);
    try {
      assert.equal(registry.unsafeDatabaseForTests().prepare(
        "SELECT schema_version FROM registry_meta WHERE singleton_id = 1",
      ).get()!.schema_version, 3);
      assert.equal(registry.registryVersion, 7);
      assert.deepEqual(registry.getTenant("migration-lab"), {
        tenantId: TENANT_UUID,
        slug: "migration-lab",
        companyName: "Migration Lab",
        workspaceClass: "disposable",
        desiredLifecycle: "planned",
        observedLifecycle: "planned",
        releaseChannel: "canary",
        regionId: "eu-west",
        dataTierId: "data-standard",
        dataComputeId: "data-compute-small",
        hostingTierId: "hosting-standard",
        backupProfileId: "backup-standard",
        cronSlot: 2,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      });
      assert.deepEqual(
        registry.listResourceReferences(TENANT_UUID).map((reference) => reference.providerKind),
        ["data", "email", "hosting", "source_repository"],
      );
      assert.equal(
        registry.getResourceReference(TENANT_UUID, "data", "project")!.resourceId,
        "opaque-data-resource",
      );
      assert.equal(
        registry.getResourceReference(TENANT_UUID, "hosting", "project")!.resourceId,
        "opaque-hosting-resource",
      );

      // The step vocabulary moved to provider-neutral names. A registry that
      // kept the old CHECK rejected every apply on its first persisted step.
      assert.deepEqual(
        registry.unsafeDatabaseForTests()
          .prepare("SELECT ordinal, kind FROM operation_steps ORDER BY ordinal")
          .all()
          .map((row) => `${row.ordinal}:${row.kind}`),
        [
          "1:reserve_tenant",
          "2:data_project",
          "4:object_storage_identity_email",
          "6:hosting_project",
        ],
      );
    } finally {
      registry.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
