import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  canonicalJson,
  type JsonValue,
} from "../core/canonical.js";
import { OpsError, assertOps } from "../core/errors.js";
import { Redactor } from "../core/redaction.js";
import { Registry } from "../state/registry.js";
import { REGISTRY_SCHEMA_VERSION } from "../state/schema.js";

const FORMAT = "lh2-registry-backup.v1" as const;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

interface BackupEnvelope {
  readonly format: typeof FORMAT;
  readonly created_at: string;
  readonly owner_uuid: string;
  readonly registry_schema_version: number;
  readonly registry_version: number;
  readonly kdf: {
    readonly algorithm: "scrypt";
    readonly salt_base64: string;
    readonly n: number;
    readonly r: number;
    readonly p: number;
    readonly key_length: number;
  };
  readonly cipher: {
    readonly algorithm: "aes-256-gcm";
    readonly iv_base64: string;
    readonly auth_tag_base64: string;
  };
  readonly ciphertext_base64: string;
  readonly ciphertext_digest: string;
}

export interface BackupResult {
  readonly path: string;
  readonly digest: string;
  readonly createdAt: string;
  readonly registryVersion: number;
}

export interface RestoreResult {
  readonly path: string;
  readonly ownerUuid: string;
  readonly registryVersion: number;
  readonly backupCreatedAt: string;
}

export class RegistryBackupService {
  readonly #redactor: Redactor;

  constructor(redactor = new Redactor()) {
    this.#redactor = redactor;
  }

  async createEncryptedBackup(
    registry: Registry,
    outputPath: string,
    passphrase: string,
    now = new Date(),
  ): Promise<BackupResult> {
    validatePassphrase(passphrase);
    this.#redactor.registerSecret(passphrase);
    assertOps(!existsSync(outputPath), "recovery_conflict", "Backup output already exists");
    mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });

    const snapshotPath = join(
      tmpdir(),
      `lh2-registry-snapshot-${process.pid}-${randomBytes(8).toString("hex")}.sqlite`,
    );
    const artifactTemp = join(
      dirname(outputPath),
      `.lh2-backup-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
    );
    let plaintext: Buffer | undefined;
    let key: Buffer | undefined;
    try {
      await registry.createSnapshot(snapshotPath);
      chmodSync(snapshotPath, 0o600);
      plaintext = readFileSync(snapshotPath);
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      key = await deriveKey(passphrase, salt);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const createdAt = now.toISOString();
      const aad = Buffer.from(
        `${FORMAT}\0${registry.ownerUuid}\0${createdAt}`,
        "utf8",
      );
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const envelope: BackupEnvelope = {
        format: FORMAT,
        created_at: createdAt,
        owner_uuid: registry.ownerUuid,
        registry_schema_version: REGISTRY_SCHEMA_VERSION,
        registry_version: registry.registryVersion,
        kdf: {
          algorithm: "scrypt",
          salt_base64: salt.toString("base64"),
          n: SCRYPT_N,
          r: SCRYPT_R,
          p: SCRYPT_P,
          key_length: KEY_LENGTH,
        },
        cipher: {
          algorithm: "aes-256-gcm",
          iv_base64: iv.toString("base64"),
          auth_tag_base64: cipher.getAuthTag().toString("base64"),
        },
        ciphertext_base64: ciphertext.toString("base64"),
        ciphertext_digest: sha256Buffer(ciphertext),
      };
      const artifact = Buffer.from(
        `${canonicalJson(envelope as unknown as JsonValue)}\n`,
        "utf8",
      );
      writeFileSync(artifactTemp, artifact, { flag: "wx", mode: 0o600 });
      renameSync(artifactTemp, outputPath);
      chmodSync(outputPath, 0o600);
      const digest = sha256Buffer(artifact);
      registry.recordBackup(digest, now);
      return {
        path: outputPath,
        digest,
        createdAt,
        registryVersion: envelope.registry_version,
      };
    } catch (error) {
      if (existsSync(artifactTemp)) rmSync(artifactTemp, { force: true });
      throw this.#redactor.sanitizeError(error);
    } finally {
      plaintext?.fill(0);
      key?.fill(0);
      rmSync(snapshotPath, { force: true });
    }
  }

  async restoreEncryptedBackup(
    inputPath: string,
    outputPath: string,
    expectedOwnerUuid: string,
    passphrase: string,
  ): Promise<RestoreResult> {
    validatePassphrase(passphrase);
    this.#redactor.registerSecret(passphrase);
    assertOps(!existsSync(outputPath), "recovery_conflict", "Restore output already exists");
    const envelope = parseEnvelope(readFileSync(inputPath, "utf8"));
    assertOps(
      envelope.owner_uuid === expectedOwnerUuid,
      "backup_invalid",
      "Backup owner UUID does not match",
    );
    assertOps(
      envelope.registry_schema_version === REGISTRY_SCHEMA_VERSION,
      "backup_invalid",
      "Unsupported registry backup schema",
    );

    const ciphertext = Buffer.from(envelope.ciphertext_base64, "base64");
    assertOps(
      sha256Buffer(ciphertext) === envelope.ciphertext_digest,
      "backup_invalid",
      "Backup ciphertext digest does not match",
    );
    const salt = Buffer.from(envelope.kdf.salt_base64, "base64");
    const iv = Buffer.from(envelope.cipher.iv_base64, "base64");
    const authTag = Buffer.from(envelope.cipher.auth_tag_base64, "base64");
    validateCryptoParameters(envelope, salt, iv, authTag);

    let key: Buffer | undefined;
    let plaintext: Buffer | undefined;
    mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
    const restoreTemp = join(
      dirname(outputPath),
      `.lh2-restore-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      key = await deriveKey(passphrase, salt);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(
        Buffer.from(
          `${FORMAT}\0${envelope.owner_uuid}\0${envelope.created_at}`,
          "utf8",
        ),
      );
      decipher.setAuthTag(authTag);
      try {
        plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
      } catch {
        throw new OpsError(
          "backup_decryption_failed",
          "Backup authentication failed",
        );
      }
      writeFileSync(restoreTemp, plaintext, { flag: "wx", mode: 0o600 });
      const restored = new Registry(restoreTemp, expectedOwnerUuid, this.#redactor);
      try {
        const integrity = restored
          .unsafeDatabaseForTests()
          .prepare("PRAGMA integrity_check")
          .get() as { integrity_check?: unknown } | undefined;
        assertOps(
          integrity?.integrity_check === "ok",
          "backup_invalid",
          "Restored SQLite registry failed integrity check",
        );
        restored.verifyAuditChain();
        assertOps(
          restored.registryVersion === envelope.registry_version,
          "backup_invalid",
          "Restored registry version does not match backup metadata",
        );
      } finally {
        restored.close();
      }
      renameSync(restoreTemp, outputPath);
      chmodSync(outputPath, 0o600);
      return {
        path: outputPath,
        ownerUuid: expectedOwnerUuid,
        registryVersion: envelope.registry_version,
        backupCreatedAt: envelope.created_at,
      };
    } catch (error) {
      rmSync(restoreTemp, { force: true });
      const safe = this.#redactor.sanitizeError(error);
      if (
        safe.code === "provider_error" ||
        safe.code === "redaction_violation"
      ) {
        throw new OpsError("backup_invalid", safe.message, safe.details);
      }
      throw safe;
    } finally {
      key?.fill(0);
      plaintext?.fill(0);
    }
  }
}

function validatePassphrase(passphrase: string): void {
  assertOps(
    passphrase.length >= 16 && !/[\r\n\0]/.test(passphrase),
    "secret_invalid",
    "Backup passphrase must be at least 16 single-line characters",
  );
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_LENGTH,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
}

function sha256Buffer(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseEnvelope(raw: string): BackupEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpsError("backup_invalid", "Backup is not valid JSON");
  }
  assertOps(
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
    "backup_invalid",
    "Backup envelope must be an object",
  );
  const value = parsed as Record<string, unknown>;
  const expectedKeys = [
    "cipher",
    "ciphertext_base64",
    "ciphertext_digest",
    "created_at",
    "format",
    "kdf",
    "owner_uuid",
    "registry_schema_version",
    "registry_version",
  ];
  assertOps(
    Object.keys(value).sort().join(",") === expectedKeys.join(","),
    "backup_invalid",
    "Backup envelope has unsupported fields",
  );
  assertOps(value.format === FORMAT, "backup_invalid", "Unsupported backup format");
  assertOps(
    typeof value.created_at === "string" &&
      Number.isFinite(Date.parse(value.created_at)),
    "backup_invalid",
    "Backup timestamp is invalid",
  );
  assertOps(
    typeof value.owner_uuid === "string" &&
      typeof value.registry_schema_version === "number" &&
      Number.isInteger(value.registry_schema_version) &&
      typeof value.registry_version === "number" &&
      Number.isInteger(value.registry_version) &&
      typeof value.ciphertext_base64 === "string" &&
      typeof value.ciphertext_digest === "string" &&
      typeof value.kdf === "object" &&
      value.kdf !== null &&
      typeof value.cipher === "object" &&
      value.cipher !== null,
    "backup_invalid",
    "Backup envelope fields are invalid",
  );
  const kdf = value.kdf as Record<string, unknown>;
  const cipher = value.cipher as Record<string, unknown>;
  assertOps(
    Object.keys(kdf).sort().join(",") ===
      "algorithm,key_length,n,p,r,salt_base64" &&
      Object.keys(cipher).sort().join(",") ===
        "algorithm,auth_tag_base64,iv_base64" &&
      kdf.algorithm === "scrypt" &&
      typeof kdf.salt_base64 === "string" &&
      typeof kdf.n === "number" &&
      typeof kdf.r === "number" &&
      typeof kdf.p === "number" &&
      typeof kdf.key_length === "number" &&
      cipher.algorithm === "aes-256-gcm" &&
      typeof cipher.iv_base64 === "string" &&
      typeof cipher.auth_tag_base64 === "string",
    "backup_invalid",
    "Backup cryptographic fields are invalid",
  );
  return value as unknown as BackupEnvelope;
}

function validateCryptoParameters(
  envelope: BackupEnvelope,
  salt: Buffer,
  iv: Buffer,
  authTag: Buffer,
): void {
  assertOps(
    envelope.kdf.algorithm === "scrypt" &&
      envelope.kdf.n === SCRYPT_N &&
      envelope.kdf.r === SCRYPT_R &&
      envelope.kdf.p === SCRYPT_P &&
      envelope.kdf.key_length === KEY_LENGTH &&
      envelope.cipher.algorithm === "aes-256-gcm" &&
      salt.length === 16 &&
      iv.length === 12 &&
      authTag.length === 16 &&
      /^sha256:[0-9a-f]{64}$/.test(envelope.ciphertext_digest),
    "backup_invalid",
    "Backup cryptographic parameters are invalid",
  );
}
