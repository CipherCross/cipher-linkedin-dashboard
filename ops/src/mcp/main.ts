#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { Redactor, safeJson } from "../core/redaction.js";
import { createP4COwnerOperations } from "../runtime/p4c-runtime.js";
import { createConfiguredS26Runtime } from "../runtime/s26-config.js";
import { RegistryOwnerOperationsAdapter } from "./adapter.js";
import { createOwnerMcpServer } from "./server.js";
import {
  defaultRegistryPath,
  readRegistryOwnerUuid,
} from "../state/location.js";
import { Registry } from "../state/registry.js";

function argumentsForRuntime(argv: readonly string[]): {
  readonly registryPath: string;
  readonly p4c: boolean;
  readonly s26: boolean;
  readonly s26ConfigPath: string | null;
} {
  let path = defaultRegistryPath();
  let p4c = false;
  let s26 = false;
  let s26ConfigPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--p4c") {
      p4c = true;
      continue;
    }
    if (argv[index] === "--s26") {
      s26 = true;
      continue;
    }
    if (argv[index] === "--s26-config" && argv[index + 1] !== undefined) {
      s26ConfigPath = resolve(argv[index + 1]!);
      index += 1;
      continue;
    }
    if (argv[index] === "--registry" && argv[index + 1] !== undefined) {
      path = resolve(argv[index + 1]!);
      index += 1;
      continue;
    }
    throw new Error("Usage: lh2-owner-mcp [--registry PATH] [--p4c|--s26 --s26-config PATH]");
  }
  if (p4c && s26) throw new Error("--p4c and --s26 are mutually exclusive");
  if (s26 && s26ConfigPath === null) throw new Error("--s26 requires --s26-config PATH");
  if (!s26 && s26ConfigPath !== null) throw new Error("--s26-config requires --s26");
  return { registryPath: path, p4c, s26, s26ConfigPath };
}

const redactor = new Redactor();

try {
  const runtime = argumentsForRuntime(process.argv.slice(2));
  const path = runtime.registryPath;
  const registry = new Registry(
    path,
    readRegistryOwnerUuid(path),
    redactor,
  );
  const operations = runtime.s26
    ? createConfiguredS26Runtime(registry, runtime.s26ConfigPath!, redactor).ownerOperations
    : runtime.p4c
      ? await createP4COwnerOperations(
        resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."),
        registry,
        redactor,
      )
      : new RegistryOwnerOperationsAdapter(registry);
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
