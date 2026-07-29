import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assertOps } from "../core/errors.js";

export function defaultRegistryPath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "LH2 Platform Ops",
    "registry.sqlite",
  );
}

export function readRegistryOwnerUuid(path: string): string {
  assertOps(existsSync(path), "cli_usage", "Registry does not exist");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT owner_uuid FROM registry_meta WHERE singleton_id = 1")
      .get() as { owner_uuid?: unknown } | undefined;
    assertOps(
      typeof row?.owner_uuid === "string",
      "backup_invalid",
      "Registry owner is missing",
    );
    return row.owner_uuid;
  } finally {
    database.close();
  }
}
