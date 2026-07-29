#!/usr/bin/env node

import { resolve } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { Redactor, safeJson } from "../core/redaction.js";
import { RegistryOwnerOperationsAdapter } from "./adapter.js";
import { createOwnerMcpServer } from "./server.js";
import {
  defaultRegistryPath,
  readRegistryOwnerUuid,
} from "../state/location.js";
import { Registry } from "../state/registry.js";

function registryPath(argv: readonly string[]): string {
  if (argv.length === 0) return defaultRegistryPath();
  if (argv.length === 2 && argv[0] === "--registry" && argv[1] !== undefined) {
    return resolve(argv[1]);
  }
  throw new Error("Usage: lh2-owner-mcp [--registry PATH]");
}

const redactor = new Redactor();

try {
  const path = registryPath(process.argv.slice(2));
  const registry = new Registry(
    path,
    readRegistryOwnerUuid(path),
    redactor,
  );
  const operations = new RegistryOwnerOperationsAdapter(registry);
  const handle = serveStdio(
    () => createOwnerMcpServer(operations, redactor),
    {
      onerror(error) {
        const safe = redactor.sanitizeError(error);
        process.stderr.write(
          `${safeJson({ error: { code: safe.code, message: safe.message } }, redactor)}\n`,
        );
      },
    },
  );
  process.once("SIGINT", () => {
    void handle.close().finally(() => {
      registry.close();
      process.exitCode = 130;
    });
  });
  process.once("SIGTERM", () => {
    void handle.close().finally(() => {
      registry.close();
      process.exitCode = 143;
    });
  });
} catch (error) {
  const safe = redactor.sanitizeError(error);
  process.stderr.write(
    `${safeJson({ error: { code: safe.code, message: safe.message } }, redactor)}\n`,
  );
  process.exitCode = 1;
}
