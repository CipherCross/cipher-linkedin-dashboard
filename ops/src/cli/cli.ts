import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OpsError, assertOps } from "../core/errors.js";
import { Redactor, safeJson } from "../core/redaction.js";
import type { ApplyRequest, ProviderSnapshot } from "../core/types.js";
import { MCP_TOOL_CONTRACT_DIGEST } from "../mcp/policy.js";
import { SERVER_VERSION } from "../mcp/schemas.js";
import { RegistryBackupService } from "../recovery/backup.js";
import {
  createP4COwnerOperations,
  p4cBusinessInputs,
} from "../runtime/p4c-runtime.js";
import { createConfiguredS26Runtime } from "../runtime/s26-config.js";
import { MacOsKeychainSecretStore } from "../secrets/keychain.js";
import { readSecretNoEcho } from "../secrets/no-echo.js";
import { SecretBootstrapService } from "../secrets/service.js";
import {
  labelsForSecret,
  type SecretLocator,
  type SecretStore,
} from "../secrets/types.js";
import { Registry } from "../state/registry.js";
import {
  defaultRegistryPath,
  readRegistryOwnerUuid,
} from "../state/location.js";

export interface CliDependencies {
  readonly stdout?: ((value: string) => void) | undefined;
  readonly stderr?: ((value: string) => void) | undefined;
  readonly readSecret?: ((prompt: string) => Promise<string>) | undefined;
  readonly makeSecretStore?:
    | ((redactor: Redactor) => SecretStore)
    | undefined;
  readonly redactor?: Redactor | undefined;
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const redactor = dependencies.redactor ?? new Redactor();
  const stdout = dependencies.stdout ?? ((value) => process.stdout.write(`${value}\n`));
  const stderr = dependencies.stderr ?? ((value) => process.stderr.write(`${value}\n`));
  const readSecret = dependencies.readSecret ?? readSecretNoEcho;
  const makeSecretStore =
    dependencies.makeSecretStore ??
    ((policy: Redactor) => new MacOsKeychainSecretStore(policy));

  try {
    const parsed = parseArgs(argv);
    if (parsed.command === "help") {
      stdout(usage());
      return 0;
    }
    const registryPath = resolve(parsed.options.get("registry") ?? defaultRegistryPath());

    if (parsed.command === "registry:init") {
      assertOnly(parsed, ["registry", "owner-id"]);
      const ownerUuid = parsed.options.get("owner-id") ?? randomUUID();
      assertUuid(ownerUuid);
      assertOps(
        !existsSync(registryPath),
        "recovery_conflict",
        "Registry already exists",
      );
      mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
      const registry = new Registry(registryPath, ownerUuid, redactor);
      registry.close();
      chmodSync(registryPath, 0o600);
      emit(stdout, redactor, {
        status: "initialized",
        registryPath,
        ownerUuid,
      });
      return 0;
    }

    if (parsed.command === "registry:restore") {
      assertOnly(parsed, ["registry", "input", "owner-id"]);
      const input = requiredOption(parsed, "input");
      const ownerUuid = requiredOption(parsed, "owner-id");
      assertUuid(ownerUuid);
      const passphrase = await readSecret("Recovery passphrase: ");
      redactor.registerSecret(passphrase);
      const backup = new RegistryBackupService(redactor);
      const result = await backup.restoreEncryptedBackup(
        resolve(input),
        registryPath,
        ownerUuid,
        passphrase,
      );
      const registry = new Registry(registryPath, ownerUuid, redactor);
      try {
        const store = makeSecretStore(redactor);
        const secrets = new SecretBootstrapService(registry, store, redactor);
        await secrets.set(
          { scope: "platform", name: "registry.backup_passphrase" },
          passphrase,
          "owner-cli-recovery",
        );
        emit(stdout, redactor, {
          status: "restored",
          ...result,
          registryVersion: registry.registryVersion,
          nextActions: [
            "rotate Supabase and Vercel platform tokens",
            "relink required tenant secret labels",
            "run read-only provider reconcile when P4 adapters are available",
          ],
        });
      } finally {
        registry.close();
      }
      return 0;
    }

    const ownerUuid =
      parsed.options.get("owner-id") ?? readRegistryOwnerUuid(registryPath);
    assertUuid(ownerUuid);
    const registry = new Registry(registryPath, ownerUuid, redactor);
    try {
      switch (parsed.command) {
        case "registry:status":
          assertOnly(parsed, ["registry", "owner-id"]);
          registry.verifyAuditChain();
          emit(stdout, redactor, {
            status: "ok",
            registryPath,
            ownerUuid: registry.ownerUuid,
            registryVersion: registry.registryVersion,
            backup: registry.backupMetadata,
            secretReferenceCount: registry.listSecretReferences().length,
          });
          return 0;
        case "registry:audit-verify":
          assertOnly(parsed, ["registry", "owner-id"]);
          registry.verifyAuditChain();
          emit(stdout, redactor, { status: "ok", auditChain: "verified" });
          return 0;
        case "registry:backup": {
          assertOnly(parsed, ["registry", "owner-id", "output"]);
          const output = resolve(requiredOption(parsed, "output"));
          const store = makeSecretStore(redactor);
          const passphrase = await store.get(
            labelsForSecret({
              scope: "platform",
              name: "registry.backup_passphrase",
            }),
          );
          redactor.registerSecret(passphrase);
          const result = await new RegistryBackupService(
            redactor,
          ).createEncryptedBackup(registry, output, passphrase);
          emit(stdout, redactor, { status: "created", ...result });
          return 0;
        }
        case "secrets:set": {
          assertOnly(parsed, ["registry", "owner-id", "scope", "name", "tenant"]);
          const locator = secretLocator(parsed);
          const value = await readSecret("Secret value: ");
          redactor.registerSecret(value);
          const service = new SecretBootstrapService(
            registry,
            makeSecretStore(redactor),
            redactor,
          );
          const result = await service.set(locator, value);
          emit(stdout, redactor, { status: "stored", ...result });
          return 0;
        }
        case "secrets:check": {
          assertOnly(parsed, ["registry", "owner-id", "scope", "name", "tenant"]);
          const locator = secretLocator(parsed) as SecretLocator;
          const service = new SecretBootstrapService(
            registry,
            makeSecretStore(redactor),
            redactor,
          );
          emit(stdout, redactor, {
            status: "checked",
            ...(await service.check(locator)),
          });
          return 0;
        }
        case "operation:get": {
          assertOnly(parsed, ["registry", "owner-id", "id"]);
          const operationId = requiredOption(parsed, "id");
          const operation = registry.getOperation(operationId);
          assertOps(operation, "invalid_plan", "Unknown operation");
          emit(stdout, redactor, {
            operation,
            steps: registry.listSteps(operationId),
          });
          return 0;
        }
        case "operation:start": {
          assertOnly(parsed, ["registry", "owner-id", "request", "snapshots"]);
          const request = readJson(requiredOption(parsed, "request")) as ApplyRequest;
          const snapshots =
            parsed.options.get("snapshots") === undefined
              ? []
              : (readJson(parsed.options.get("snapshots")!) as ProviderSnapshot[]);
          const result = registry.startOrResumeOperation(
            request,
            "owner-cli",
            snapshots,
          );
          emit(stdout, redactor, result);
          return 0;
        }
        case "tenant:preflight":
        case "tenant:plan": {
          assertOnly(parsed, runtimeOptions());
          const operations = await ownerOperations(parsed, registry, redactor, makeSecretStore(redactor));
          const toolName =
            parsed.command === "tenant:preflight"
              ? "tenant_preflight"
              : "tenant_plan_onboarding";
          emit(
            stdout,
            redactor,
            await operations.call(toolName, p4cBusinessInputs()),
          );
          return 0;
        }
        case "tenant:apply":
        case "tenant:resume": {
          assertOnly(parsed, [
            ...runtimeOptions(),
            "plan-id",
            "plan-digest",
            "expected-registry-version",
            "idempotency-key",
            "operation-id",
          ]);
          const expectedRegistryVersion = Number(
            requiredOption(parsed, "expected-registry-version"),
          );
          assertOps(
            Number.isSafeInteger(expectedRegistryVersion) &&
              expectedRegistryVersion >= 0,
            "cli_usage",
            "--expected-registry-version must be a non-negative integer",
          );
          const authorization = {
            server_version: SERVER_VERSION,
            tool_contract_digest: MCP_TOOL_CONTRACT_DIGEST,
            plan_id: requiredOption(parsed, "plan-id"),
            plan_digest: requiredOption(parsed, "plan-digest"),
            expected_registry_version: expectedRegistryVersion,
            idempotency_key: requiredOption(parsed, "idempotency-key"),
          };
          const operations = await ownerOperations(parsed, registry, redactor, makeSecretStore(redactor));
          const input =
            parsed.command === "tenant:apply"
              ? { authorization }
              : {
                  authorization,
                  operation_id: requiredOption(parsed, "operation-id"),
                };
          emit(
            stdout,
            redactor,
            await operations.call(
              parsed.command === "tenant:apply"
                ? "tenant_apply_onboarding"
                : "tenant_resume_operation",
              input,
            ),
          );
          return 0;
        }
        case "tenant:verify": {
          assertOnly(parsed, [...runtimeOptions(), "operation-id"]);
          const operationId = requiredOption(parsed, "operation-id");
          const operations = await ownerOperations(parsed, registry, redactor, makeSecretStore(redactor));
          emit(stdout, redactor, {
            operation: await operations.call("operation_get", {
              operation_id: operationId,
            }),
            tenant: await operations.call("tenant_get", {
              tenant_slug: "p4c-lab",
            }),
          });
          return 0;
        }
        default:
          throw new OpsError("cli_usage", "Unsupported command");
      }
    } finally {
      registry.close();
    }
  } catch (error) {
    const safe = redactor.sanitizeError(error);
    stderr(
      safeJson(
        {
          error: {
            code: safe.code,
            message: safe.message,
            details: safe.details,
          },
        },
        redactor,
      ),
    );
    return safe.code === "cli_usage" ? 2 : 1;
  }
}

interface ParsedArgs {
  readonly command: string;
  readonly options: ReadonlyMap<string, string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    return { command: "help", options: new Map() };
  }
  assertOps(argv.length >= 2, "cli_usage", "A command group and action are required");
  const command = `${argv[0]}:${argv[1]}`;
  const options = new Map<string, string>();
  for (let index = 2; index < argv.length;) {
    const flag = argv[index];
    if (flag === "--p4c" || flag === "--s26") {
      const name = flag.slice(2);
      assertOps(!options.has(name), "cli_usage", `Duplicate --${name} option`);
      options.set(name, "true");
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    assertOps(
      flag?.startsWith("--") && flag.length > 2 && value !== undefined,
      "cli_usage",
      "Options must use --name value pairs",
    );
    const name = flag!.slice(2);
    assertOps(!options.has(name), "cli_usage", `Duplicate --${name} option`);
    options.set(name, value);
    index += 2;
  }
  return { command, options };
}

function assertOnly(parsed: ParsedArgs, allowed: readonly string[]): void {
  for (const name of parsed.options.keys()) {
    assertOps(allowed.includes(name), "cli_usage", `Unknown --${name} option`);
  }
}

function requiredOption(parsed: ParsedArgs, name: string): string {
  const value = parsed.options.get(name);
  assertOps(value !== undefined && value.length > 0, "cli_usage", `--${name} is required`);
  return value;
}

function runtimeOptions(): readonly string[] {
  return ["registry", "owner-id", "p4c", "s26", "s26-config"];
}

async function ownerOperations(
  parsed: ParsedArgs,
  registry: Registry,
  redactor: Redactor,
  store: SecretStore,
) {
  const p4c = parsed.options.has("p4c");
  const s26 = parsed.options.has("s26");
  assertOps(!(p4c && s26), "cli_usage", "--p4c and --s26 are mutually exclusive");
  assertOps(p4c || s26, "cli_usage", "An explicit --p4c or --s26 runtime is required");
  if (s26) {
    return createConfiguredS26Runtime(registry, requiredOption(parsed, "s26-config"), redactor, store).ownerOperations;
  }
  assertOps(parsed.options.get("s26-config") === undefined, "cli_usage", "--s26-config requires --s26");
  return createP4COwnerOperations(repositoryRoot(), registry, redactor, store);
}

function secretLocator(parsed: ParsedArgs): {
  readonly scope: "platform" | "tenant";
  readonly name: string;
  readonly tenantSlug?: string;
} {
  const scope = requiredOption(parsed, "scope");
  assertOps(
    scope === "platform" || scope === "tenant",
    "cli_usage",
    "--scope must be platform or tenant",
  );
  const tenantSlug = parsed.options.get("tenant");
  return {
    scope,
    name: requiredOption(parsed, "name"),
    ...(tenantSlug === undefined ? {} : { tenantSlug }),
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    throw new OpsError("cli_usage", "JSON input file is invalid");
  }
}

function assertUuid(value: string): void {
  assertOps(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
    "cli_usage",
    "Owner ID must be a UUID",
  );
}

function emit(
  output: (value: string) => void,
  redactor: Redactor,
  value: unknown,
): void {
  redactor.assertSecretFree(value, "CLI output");
  output(safeJson(value, redactor));
}

function usage(): string {
  return [
    "lh2-ops registry init [--registry PATH] [--owner-id UUID]",
    "lh2-ops registry status [--registry PATH]",
    "lh2-ops registry audit-verify [--registry PATH]",
    "lh2-ops registry backup --output FILE [--registry PATH]",
    "lh2-ops registry restore --input FILE --owner-id UUID [--registry PATH]",
    "lh2-ops secrets set --scope platform|tenant --name NAME [--tenant SLUG]",
    "lh2-ops secrets check --scope platform|tenant --name NAME [--tenant SLUG]",
    "lh2-ops operation get --id OPERATION_ID [--registry PATH]",
    "lh2-ops operation start --request FILE [--snapshots FILE] [--registry PATH]",
    "lh2-ops tenant preflight --p4c|--s26 --s26-config PATH [--registry PATH]",
    "lh2-ops tenant plan --p4c|--s26 --s26-config PATH [--registry PATH]",
    "lh2-ops tenant apply --p4c|--s26 --s26-config PATH --plan-id ID --plan-digest SHA256 --expected-registry-version N --idempotency-key KEY",
    "lh2-ops tenant resume --p4c|--s26 --s26-config PATH --operation-id ID --plan-id ID --plan-digest SHA256 --expected-registry-version N --idempotency-key KEY",
    "lh2-ops tenant verify --p4c|--s26 --s26-config PATH --operation-id ID [--registry PATH]",
    "",
    "Secret values are accepted only through an interactive no-echo prompt.",
  ].join("\n");
}

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}
