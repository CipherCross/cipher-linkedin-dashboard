import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MemorySecretStore,
  OpsError,
  Redactor,
  Registry,
  RegistryBackupService,
  SecretBootstrapService,
} from "../src/index.js";
import {
  OWNER_UUID,
  TEST_NOW,
  catalogResolver,
  makeOnboardingPlan,
} from "./fixtures.js";

const RECOVERY_PASSPHRASE = "p3b-recovery-passphrase-19b2";
const ROTATED_SUPABASE_TOKEN = "rotated-supabase-token-4bca";
const ROTATED_VERCEL_TOKEN = "rotated-vercel-token-28d1";

test("encrypted backup and replacement-Mac recovery rehearsal preserve registry integrity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lh2-ops-recovery-"));
  const sourcePath = join(directory, "source.sqlite");
  const backupPath = join(directory, "registry.lh2backup");
  const restoredPath = join(directory, "replacement-mac.sqlite");
  const redactor = new Redactor([
    RECOVERY_PASSPHRASE,
    ROTATED_SUPABASE_TOKEN,
    ROTATED_VERCEL_TOKEN,
  ]);
  try {
    const source = new Registry(sourcePath, OWNER_UUID, redactor);
    const plan = makeOnboardingPlan();
    source.savePlan(plan, { catalogs: catalogResolver(), now: TEST_NOW });
    const backedUpVersion = source.registryVersion;
    const backup = new RegistryBackupService(redactor);
    const created = await backup.createEncryptedBackup(
      source,
      backupPath,
      RECOVERY_PASSPHRASE,
      TEST_NOW,
    );
    assert.equal(created.registryVersion, backedUpVersion);
    assert.equal(source.backupMetadata.digest, created.digest);
    assert.equal(source.registryVersion, backedUpVersion + 1);
    source.close();

    const artifact = readFileSync(backupPath);
    assert.equal(artifact.includes(Buffer.from("SQLite format 3")), false);
    assert.equal(artifact.includes(Buffer.from(plan.plan_id)), false);
    assert.equal(artifact.includes(Buffer.from(RECOVERY_PASSPHRASE)), false);

    const restored = await backup.restoreEncryptedBackup(
      backupPath,
      restoredPath,
      OWNER_UUID,
      RECOVERY_PASSPHRASE,
    );
    assert.equal(restored.registryVersion, backedUpVersion);
    const replacementRegistry = new Registry(restoredPath, OWNER_UUID, redactor);
    try {
      replacementRegistry.verifyAuditChain();
      assert.equal(replacementRegistry.registryVersion, backedUpVersion);

      const replacementKeychain = new MemorySecretStore();
      const secrets = new SecretBootstrapService(
        replacementRegistry,
        replacementKeychain,
        redactor,
      );
      await secrets.set(
        { scope: "platform", name: "registry.backup_passphrase" },
        RECOVERY_PASSPHRASE,
        "replacement-mac",
        TEST_NOW,
      );
      await secrets.set(
        { scope: "platform", name: "supabase.management_token" },
        ROTATED_SUPABASE_TOKEN,
        "replacement-mac",
        TEST_NOW,
      );
      await secrets.set(
        { scope: "platform", name: "vercel.team_token" },
        ROTATED_VERCEL_TOKEN,
        "replacement-mac",
        TEST_NOW,
      );
      assert.deepEqual(
        replacementRegistry
          .listSecretReferences()
          .map((reference) => reference.secretName)
          .sort(),
        [
          "registry.backup_passphrase",
          "supabase.management_token",
          "vercel.team_token",
        ],
      );
      replacementRegistry.verifyAuditChain();
      const persisted = readFileSync(restoredPath);
      assert.equal(persisted.includes(Buffer.from(RECOVERY_PASSPHRASE)), false);
      assert.equal(persisted.includes(Buffer.from(ROTATED_SUPABASE_TOKEN)), false);
      assert.equal(persisted.includes(Buffer.from(ROTATED_VERCEL_TOKEN)), false);
    } finally {
      replacementRegistry.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wrong passphrase and overwrite attempts fail closed without leaking secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lh2-ops-recovery-fail-"));
  const sourcePath = join(directory, "source.sqlite");
  const backupPath = join(directory, "registry.lh2backup");
  const restoredPath = join(directory, "restored.sqlite");
  const redactor = new Redactor([RECOVERY_PASSPHRASE]);
  try {
    const source = new Registry(sourcePath, OWNER_UUID, redactor);
    source.savePlan(makeOnboardingPlan(), {
      catalogs: catalogResolver(),
      now: TEST_NOW,
    });
    const backup = new RegistryBackupService(redactor);
    await backup.createEncryptedBackup(
      source,
      backupPath,
      RECOVERY_PASSPHRASE,
      TEST_NOW,
    );
    source.close();

    await assert.rejects(
      backup.restoreEncryptedBackup(
        backupPath,
        restoredPath,
        OWNER_UUID,
        "wrong-passphrase-long-enough",
      ),
      (error: unknown) => {
        assert.ok(error instanceof OpsError);
        assert.equal(error.code, "backup_decryption_failed");
        assert.equal(JSON.stringify(error).includes(RECOVERY_PASSPHRASE), false);
        return true;
      },
    );

    const restored = await backup.restoreEncryptedBackup(
      backupPath,
      restoredPath,
      OWNER_UUID,
      RECOVERY_PASSPHRASE,
    );
    assert.equal(restored.path, restoredPath);
    await assert.rejects(
      backup.restoreEncryptedBackup(
        backupPath,
        restoredPath,
        OWNER_UUID,
        RECOVERY_PASSPHRASE,
      ),
      (error: unknown) =>
        error instanceof OpsError && error.code === "recovery_conflict",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
