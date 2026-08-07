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

test("registry migration v1 to v2 preserves rows and maps only capability vocabulary", () => {
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
      ).get()!.schema_version, 2);
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
    } finally {
      registry.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
