import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";

import { OpsError } from "./errors.js";
import type { ApplyRequest, PlanEnvelope, PlanKind } from "./types.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRootCandidates = [
  resolve(moduleDirectory, "../../.."),
  resolve(moduleDirectory, "../../../.."),
];
const repositoryRoot =
  repositoryRootCandidates.find((candidate) =>
    existsSync(resolve(candidate, "docs/platform-ops/contracts")),
  ) ?? repositoryRootCandidates[0]!;
const contractsDirectory = resolve(repositoryRoot, "docs/platform-ops/contracts");
const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

function loadSchema(fileName: string): object {
  return JSON.parse(readFileSync(resolve(contractsDirectory, fileName), "utf8")) as object;
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictTypes: false,
  validateFormats: true,
});
addFormats(ajv);

const validators: Readonly<Record<PlanKind | "apply", ValidateFunction>> = {
  tenant_onboarding: ajv.compile(loadSchema("onboarding-plan.v1.schema.json")),
  release: ajv.compile(loadSchema("release-plan.v1.schema.json")),
  apply: ajv.compile(loadSchema("apply-request.v1.schema.json")),
};

const catalogValidator = ajv.compile(
  loadSchema("catalog-snapshot.v1.schema.json"),
);
const tenantRecoveryValidator = ajv.compile(
  loadSchema("tenant-recovery.v1.schema.json"),
);

function safeErrors(errors: ErrorObject[] | null | undefined): readonly object[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message,
  }));
}

function validate<T>(kind: keyof typeof validators, value: unknown): asserts value is T {
  const validator = validators[kind];
  if (!validator(value)) {
    throw new OpsError(
      "schema_validation_failed",
      `${kind} contract schema validation failed`,
      { errors: safeErrors(validator.errors) },
    );
  }
}

export function validatePlanSchema(
  kind: PlanKind,
  value: unknown,
): asserts value is PlanEnvelope {
  validate<PlanEnvelope>(kind, value);
}

export function validateApplyRequestSchema(
  value: unknown,
): asserts value is ApplyRequest {
  validate<ApplyRequest>("apply", value);
}

export function validateCatalogSchema(value: unknown): void {
  if (!catalogValidator(value)) {
    throw new OpsError(
      "schema_validation_failed",
      "catalog contract schema validation failed",
      { errors: safeErrors(catalogValidator.errors) },
    );
  }
}

export function validateTenantRecoverySchema(value: unknown): void {
  if (!tenantRecoveryValidator(value)) {
    throw new OpsError(
      "schema_validation_failed",
      "tenant recovery contract schema validation failed",
      { errors: safeErrors(tenantRecoveryValidator.errors) },
    );
  }
}
