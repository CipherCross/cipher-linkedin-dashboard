import { hashPassword } from "better-auth/crypto";
import { Pool, type PoolClient, type QueryResult } from "@neondatabase/serverless";

import { OpsError } from "../core/errors.js";
import { canonicalJson, sha256Digest, type JsonValue } from "../core/canonical.js";
import { CANONICAL_SMOKE_TEST_IDS } from "../core/smoke-tests.js";
import {
  CANONICAL_TENANT_ENVIRONMENT,
} from "../providers/hosting-tenant.js";
import {
  CANONICAL_TENANT_SCHEDULES,
  hostingEnvironmentBindingDigest,
  scheduleManifestDigest,
} from "../providers/hosting.js";
import { neonOwnershipRoleName } from "../providers/neon-ownership.js";
import type { S26BridgeBackend } from "../bridge/s26-control-plane-service.js";
import type { S26BridgeRoute } from "../providers/s26-bridge-contract.js";
import {
  IDENTITY_STORE_PRESENCE_SQL,
  IDENTITY_SURFACE_PRESENCE_SQL,
  applyPinnedPortablePostgres,
  runPinnedPortableSmoke,
  runPinnedRestoreVerification,
} from "./pinned-postgres.js";

import supportMembershipSql from "../../../postgres/control-plane/s26/identity_support_membership.sql";
import initialAdminSql from "../../../postgres/control-plane/s26/identity_initial_admin.sql";

type JsonRecord = Readonly<Record<string, unknown>>;

interface StoredRecoveryArtifact {
  readonly version: "s26-worker-recovery.v1";
  readonly capability: "data" | "identity" | "objectStorage" | "hosting";
  readonly artifactId: string;
  readonly sourceResourceId: string;
  readonly ownershipMarkerDigest: string;
  readonly capturedAt: string;
  readonly payload: JsonRecord;
}

interface EmailDeliveryMarker {
  readonly version: "s26-email-delivery.v1";
  readonly state: "pending" | "delivered";
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly providerRequestId?: string;
}

function isRecoveryCapability(value: string): value is StoredRecoveryArtifact["capability"] {
  return value === "data" || value === "identity" || value === "objectStorage" || value === "hosting";
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpsError("provider_error", `${label} is not an object`);
  }
  return value as JsonRecord;
}

function stringField(value: JsonRecord, name: string): string {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0) {
    throw new OpsError("provider_error", `Required ${name} is absent`);
  }
  return field;
}

function stringArray(value: JsonRecord, name: string): readonly string[] {
  const field = value[name];
  if (!Array.isArray(field) || field.some((entry) => typeof entry !== "string")) {
    throw new OpsError("provider_error", `Required ${name} list is absent`);
  }
  return field as readonly string[];
}

function numberField(value: JsonRecord, name: string): number {
  const field = value[name];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new OpsError("provider_error", `Required ${name} is absent`);
  }
  return field;
}

function numberArray(value: JsonRecord, name: string): readonly number[] {
  const field = value[name];
  if (!Array.isArray(field) || field.some((entry) => typeof entry !== "number" || !Number.isInteger(entry))) {
    throw new OpsError("provider_error", `Required ${name} list is absent`);
  }
  return field;
}

function requireBinding(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OpsError("secret_input_required", `Required Worker binding ${name} is not installed`);
  }
  return value;
}

function configured(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireConfigured(value: string | undefined, name: string): string {
  if (!configured(value)) {
    throw new OpsError("provider_readiness_blocked", `Required non-secret Worker configuration ${name} is not approved`);
  }
  return value;
}

function generateHighEntropySecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Snapshot validity caps the plan's own expiry, and apply executes one step per
 * call with a fresh preflight each time. A window shorter than the contract's
 * 30-minute maximum cannot fit a thirteen-step onboarding, so it matches that
 * maximum rather than undercutting it.
 */
function validUntil(): string {
  return new Date(Date.now() + 30 * 60_000).toISOString();
}

/**
 * The zone a tenant hostname belongs to.
 *
 * The planner derives the hostname as `<tenant_slug>.<platform_domain>`
 * (`onboarding-planner.ts`), so the zone is exactly the hostname without its
 * first label. A name with no zone left after that label is refused rather than
 * probed, so an apex or single-label hostname can never be read as a zone.
 */
function parentZone(hostname: string): string {
  const separator = hostname.indexOf(".");
  const zone = separator === -1 ? "" : hostname.slice(separator + 1);
  if (!zone.includes(".")) {
    throw new OpsError("unsupported_contract", "Tenant hostname has no parent zone");
  }
  return zone;
}

function schedulePath(schedule: JsonRecord): string {
  const route = stringField(schedule, "routePath");
  const query = record(schedule.queryParameters, "schedule query parameters");
  const pairs = Object.entries(query).map(([name, value]) => {
    if (typeof value !== "string") throw new OpsError("provider_error", "Schedule query parameter is invalid");
    return [name, value] as [string, string];
  }).sort(([left], [right]) => left.localeCompare(right));
  if (pairs.length === 0) return route;
  return `${route}?${new URLSearchParams(pairs).toString()}`;
}

function canonicalCronSet(): readonly { readonly path: string; readonly schedule: string }[] {
  return CANONICAL_TENANT_SCHEDULES.map((entry) => {
    const pairs = Object.entries(entry.queryParameters)
      .map(([name, value]) => [name, value] as [string, string])
      .sort(([left], [right]) => left.localeCompare(right));
    const path = pairs.length === 0
      ? entry.routePath
      : `${entry.routePath}?${new URLSearchParams(pairs).toString()}`;
    return { path, schedule: entry.expression };
  });
}

function observedCrons(value: JsonRecord): readonly { readonly path: string; readonly schedule: string }[] {
  const cronValue = value.crons;
  const entries = Array.isArray(cronValue)
    ? cronValue
    : typeof cronValue === "object" && cronValue !== null && !Array.isArray(cronValue)
      && Array.isArray((cronValue as Record<string, unknown>).definitions)
      ? (cronValue as Record<string, unknown>).definitions as readonly unknown[]
      : [];
  return entries.map((entry) => {
    const cron = record(entry, "Vercel cron");
    return { path: stringField(cron, "path"), schedule: stringField(cron, "schedule") };
  });
}

function projectCronDeploymentId(value: JsonRecord): string | null {
  if (typeof value.crons !== "object" || value.crons === null || Array.isArray(value.crons)) return null;
  const deploymentId = (value.crons as Record<string, unknown>).deploymentId;
  return typeof deploymentId === "string" ? deploymentId : null;
}

function expectedCrons(value: JsonRecord): readonly { readonly id: string; readonly path: string; readonly schedule: string; readonly source: JsonRecord }[] {
  if (!Array.isArray(value.expected_schedules) && !Array.isArray(value.schedules)) return [];
  const schedules = (Array.isArray(value.expected_schedules) ? value.expected_schedules : value.schedules) as unknown[];
  return schedules.map((entry) => {
    const schedule = record(entry, "schedule");
    return {
      id: stringField(schedule, "scheduleId"),
      path: schedulePath(schedule),
      schedule: stringField(schedule, "expression"),
      source: schedule,
    };
  });
}

function cronsMatch(
  expected: readonly { readonly path: string; readonly schedule: string }[],
  observed: readonly { readonly path: string; readonly schedule: string }[],
): boolean {
  const shape = (entry: { readonly path: string; readonly schedule: string }) => `${entry.path}\n${entry.schedule}`;
  return JSON.stringify(expected.map(shape).sort()) === JSON.stringify(observed.map(shape).sort());
}

function scheduleManifestDigestOf(
  schedules: readonly { readonly source: JsonRecord }[],
): string {
  const canonical: JsonValue = [...schedules]
    .sort((left, right) => stringField(left.source, "scheduleId").localeCompare(stringField(right.source, "scheduleId")))
    .map(({ source }) => {
      const query = record(source.queryParameters, "schedule query parameters");
      const queryParameters: Record<string, string> = {};
      for (const [name, value] of Object.entries(query).sort(([left], [right]) => left.localeCompare(right))) {
        if (typeof value !== "string") throw new OpsError("provider_error", "Schedule query parameter is invalid");
        queryParameters[name] = value;
      }
      return {
        schedule_id: stringField(source, "scheduleId"),
        method: stringField(source, "method"),
        route_path: stringField(source, "routePath"),
        query_parameters: queryParameters,
        expression: stringField(source, "expression"),
        expression_format: stringField(source, "expressionFormat"),
        timezone: stringField(source, "timezone"),
      };
    });
  return sha256Digest(canonicalJson(canonical));
}

function requestId(response: Response): string {
  return response.headers.get("x-request-id")
    ?? response.headers.get("x-vercel-id")
    ?? response.headers.get("cf-ray")
    ?? crypto.randomUUID();
}

async function readBoundedProviderJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > 1_048_576) {
    throw new OpsError("provider_error", "Provider response exceeded the fixed response limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 1_048_576) {
    throw new OpsError("provider_error", "Provider response exceeded the fixed response limit");
  }
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new OpsError("provider_error", "Provider response was not valid JSON");
  }
}

/**
 * The build settings that ARE the `spa-plus-http-handlers-v1` recipe.
 *
 * Kept beside the recipe rather than inside the request so the two cannot drift,
 * and matching the settings the P4-C path already used for the same application —
 * except for rootDirectory, which must name the subdirectory holding the app and
 * its `vercel.json`.
 */
/**
 * Readiness polling budget for one bridge call.
 *
 * A Workers request cannot be held open for the minutes a real build takes, so
 * the budget stays bounded and the non-terminal state is reported as
 * `provider_readiness_blocked` for the operator to retry. Convergence comes from
 * the adopt path, not from waiting longer. The previous budget was 20 attempts at
 * one second — twenty seconds against a build that takes minutes.
 */
const POLL_ATTEMPTS = 25;
const POLL_INTERVAL_MS = 2_000;

const BUILD_RECIPE_PROJECT_SETTINGS = {
  framework: "vite",
  rootDirectory: "frontend",
  buildCommand: "npm run build",
  outputDirectory: "dist",
} as const;

/**
 * The provider's own machine-readable error token, when it left a bounded one.
 *
 * Deliberately excludes the human message: a provider often echoes parts of the
 * request back in it, and this value travels to the operator. A token matching
 * this shape carries no URL, credential, payload or free text.
 */
function providerErrorCode(value: JsonRecord): Readonly<Record<string, string>> {
  const nested = typeof value.error === "object" && value.error !== null
    ? (value.error as Record<string, unknown>).code
    : undefined;
  const candidate = typeof nested === "string" ? nested : value.code;
  return typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(candidate)
    ? { provider_error_code: candidate }
    : {};
}

async function providerJson(input: {
  readonly provider: string;
  readonly url: string;
  readonly token: string;
  readonly method?: "GET" | "POST" | "PATCH";
  readonly body?: JsonRecord;
  readonly fetcher?: typeof fetch;
  readonly idempotencyKey?: string;
}): Promise<{ readonly id: string; readonly value: JsonRecord; readonly status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(input.url, {
      method: input.method ?? "GET",
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/json",
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        ...(input.provider === "source-repository" ? { "user-agent": "lh2-s26-control-plane" } : {}),
        ...(input.provider === "resend" ? { "user-agent": "lh2-s26-control-plane" } : {}),
        ...(input.idempotencyKey === undefined ? {} : { "idempotency-key": input.idempotencyKey }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: controller.signal,
    });
  } catch {
    throw new OpsError("outcome_unknown", `${input.provider} request outcome is unknown`, {
      provider_request_id: crypto.randomUUID(),
    });
  } finally {
    clearTimeout(timeout);
  }
  const id = requestId(response);
  if (response.status === 408 || response.status === 409 || response.status === 423 || response.status === 429 || response.status >= 500) {
    throw new OpsError("outcome_unknown", `${input.provider} request outcome is unknown`, {
      provider_request_id: id,
    });
  }
  const value = record(await readBoundedProviderJson(response), `${input.provider} response`);
  if (!response.ok) {
    throw new OpsError("provider_error", `${input.provider} rejected the fixed operation`, {
      provider_request_id: id,
      status: response.status,
      // The provider's own short error token — Vercel puts it in error.code,
      // others at the top level. The body was already read and then thrown away,
      // so a deterministic refusal arrived with no reason attached at all: a
      // Vercel 400 said only "400". Only a bounded token is kept, never the
      // free-text message, which can quote request content back.
      ...providerErrorCode(value),
    });
  }
  return { id, value, status: response.status };
}

async function withDatabase<T>(
  connectionString: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 15_000,
    query_timeout: 15_000,
  });
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function databaseQuery(connectionString: string, text: string): Promise<QueryResult> {
  return withDatabase(connectionString, (client) => client.query(text));
}

function databaseFailure(error: unknown): OpsError {
  if (error instanceof OpsError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    return new OpsError("provider_error", "Postgres rejected the fixed operation");
  }
  return new OpsError("outcome_unknown", "Postgres operation outcome is unknown", {
    provider_request_id: crypto.randomUUID(),
  });
}

async function databaseMutation(connectionString: string, text: string): Promise<QueryResult> {
  try {
    return await databaseQuery(connectionString, text);
  } catch (error) {
    throw databaseFailure(error);
  }
}

async function bindingMutation<T>(provider: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new OpsError("outcome_unknown", `${provider} operation outcome is unknown`, {
      provider_request_id: crypto.randomUUID(),
    });
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sqlText(text: string): string {
  return text.split("\n").filter((line) => !line.startsWith("\\")).join("\n");
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export class S26WorkerBackend implements S26BridgeBackend {
  readonly #fetch: typeof fetch;
  readonly #generateSecret: () => string;

  constructor(
    private readonly env: Env,
    options: {
      readonly fetch?: typeof fetch;
      readonly generateSecret?: () => string;
    } = {},
  ) {
    this.#fetch = options.fetch ?? fetch;
    this.#generateSecret = options.generateSecret ?? generateHighEntropySecret;
  }

  async invoke(route: S26BridgeRoute, request: unknown): Promise<unknown> {
    const input = record(request, "bridge request");
    const key = `${route.capability}.${route.operation}`;
    switch (key) {
      case "data.inspect": return this.#dataInspect(input);
      case "data.portable-schema-apply": return this.#dataApply(input);
      case "data.smoke": return this.#dataSmoke(input);
      case "data.recovery-capture": return this.#dataRecoveryCapture(input, "data");
      case "data.recovery-restore": return this.#dataRecoveryRestore(input, "data");
      case "data.recovery-verify": return this.#dataRecoveryVerify(input, "data");
      case "identity.inspect": return this.#identityInspect(input);
      case "identity.configure": return this.#identityConfigure(input);
      case "identity.support-membership": return this.#identitySupport(input);
      case "identity.company-admin-invite": return this.#identityInvite(input);
      case "identity.smoke": return this.#identitySmoke(input);
      case "identity.recovery-capture": return this.#dataRecoveryCapture(input, "identity");
      case "identity.recovery-restore": return this.#dataRecoveryRestore(input, "identity");
      case "identity.recovery-verify": return this.#dataRecoveryVerify(input, "identity");
      case "objectStorage.smoke": return this.#objectSmoke(input);
      case "objectStorage.recovery-capture": return this.#objectRecoveryCapture(input);
      case "objectStorage.recovery-restore": return this.#objectRecoveryRestore(input);
      case "objectStorage.recovery-verify": return this.#objectRecoveryVerify(input);
      case "hosting.inspect": return this.#hostingInspect(input);
      case "hosting.environment-bind": return this.#hostingEnvironment(input);
      case "hosting.build": return this.#hostingBuild(input);
      case "hosting.schedules": return this.#hostingSchedules(input);
      case "hosting.promote": return this.#hostingRollout(input, "promote");
      case "hosting.rollback": return this.#hostingRollout(input, "rollback");
      case "hosting.verify": return this.#hostingVerify(input);
      case "hosting.recovery-capture": return this.#hostingRecoveryCapture(input);
      case "hosting.recovery-restore": return this.#hostingRecoveryRestore(input);
      case "hosting.recovery-verify": return this.#hostingRecoveryVerify(input);
      case "smtp.inspect": return this.#smtpInspect(input);
      case "smtp.configure": return this.#smtpConfigure(input);
      case "smtp.smoke": return this.#smtpSmoke(input);
      case "domain.inspect": return this.#domainInspect(input);
      case "sourceRepository.inspect": return this.#sourceInspect(input);
      default: throw new OpsError("unsupported_contract", "Bridge backend route is unsupported");
    }
  }

  async #neon(path: string, method: "GET" | "POST" = "GET", body?: JsonRecord) {
    return providerJson({
      provider: "neon",
      url: `${this.env.NEON_API_BASE_URL}${path}`,
      token: requireBinding(this.env.NEON_API_TOKEN, "NEON_API_TOKEN"),
      method,
      fetcher: this.#fetch,
      ...(body === undefined ? {} : { body }),
    });
  }

  async #connectionUri(projectId: string, roleName: string, branchId?: string): Promise<string> {
    const query = new URLSearchParams({
      database_name: this.env.NEON_DATABASE_NAME,
      role_name: roleName,
      pooled: "false",
      ...(branchId === undefined ? {} : { branch_id: branchId }),
    });
    const response = await this.#neon(`/projects/${encodeURIComponent(projectId)}/connection_uri?${query.toString()}`);
    return stringField(response.value, "uri");
  }

  #ownerConnectionUri(projectId: string, branchId?: string): Promise<string> {
    return this.#connectionUri(projectId, this.env.NEON_OWNER_ROLE_NAME, branchId);
  }

  async #neonOwnershipMarkerPresent(projectId: string, ownershipMarkerDigest: string): Promise<boolean> {
    const expected = neonOwnershipRoleName(ownershipMarkerDigest);
    const branches = await this.#neon(`/projects/${encodeURIComponent(projectId)}/branches`);
    const list = Array.isArray(branches.value.branches) ? branches.value.branches : [];
    for (const entry of list) {
      const branchId = stringField(record(entry, "Neon branch"), "id");
      const roles = await this.#neon(
        `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/roles`,
      );
      const names = (Array.isArray(roles.value.roles) ? roles.value.roles : [])
        .map((role) => record(role, "Neon role").name);
      if (names.includes(expected)) return true;
    }
    return false;
  }

  async #dataInspect(input: JsonRecord): Promise<unknown> {
    if (stringField(input, "organization_id") !== this.env.NEON_ORGANIZATION_ID) {
      throw new OpsError("provider_error", "Neon organization scope mismatch");
    }
    const name = stringField(input, "deterministic_name");
    const query = new URLSearchParams({ org_id: this.env.NEON_ORGANIZATION_ID, search: name, limit: "100" });
    const response = await this.#neon(`/projects?${query.toString()}`);
    const projects = Array.isArray(response.value.projects) ? response.value.projects : [];
    const existing = projects.map((entry) => record(entry, "Neon project")).find((project) => project.name === name);
    // Neon has no metadata field on a project, so ownership is carried by a
    // role written onto the project at creation. Organization membership and a
    // matching name are not evidence on their own: without the marker the
    // project stays foreign, and with it our own resource is adoptable instead
    // of blocking every step that follows its creation.
    const owned = existing === undefined
      ? false
      : await this.#neonOwnershipMarkerPresent(
        stringField(existing, "id"),
        stringField(input, "ownership_marker_digest"),
      );
    return {
      organizationAccessible: true,
      deterministicNameAvailable: existing === undefined,
      existingResourceOwned: owned,
      regionAvailable: configured(this.env.NEON_REGION_ID) && stringField(input, "region_id") === this.env.NEON_REGION_ID && (existing === undefined || existing.region_id === input.region_id),
      tierAvailable: configured(this.env.NEON_TIER_ID) && stringField(input, "tier_id") === this.env.NEON_TIER_ID,
      computeAvailable: configured(this.env.NEON_COMPUTE_ID) && stringField(input, "compute_id") === this.env.NEON_COMPUTE_ID,
      backupCompatible: configured(this.env.NEON_BACKUP_PROFILE_ID) && stringField(input, "backup_profile_id") === this.env.NEON_BACKUP_PROFILE_ID,
      // Local contract completion is represented by one closed deployment
      // selection. Provider inspection remains read-only and must still pass
      // every concrete scope, catalog, ownership, and release check.
      authConfigurationSupported: String(this.env.S26_APPLICATION_DATA_PLANE_READY) === "true",
      validUntil: validUntil(),
    };
  }

  async #dataApply(input: JsonRecord): Promise<unknown> {
    const projectId = stringField(input, "project_id");
    try {
      await applyPinnedPortablePostgres({
        ownerConnectionUri: await this.#ownerConnectionUri(projectId),
        baselineVersion: numberField(input, "baseline_version"),
        migrationVersions: numberArray(input, "migration_versions"),
        targetSchemaVersion: numberField(input, "target_schema_version"),
      });
    } catch (error) {
      throw databaseFailure(error);
    }
    return { providerRequestId: crypto.randomUUID() };
  }

  async #dataSmoke(input: JsonRecord): Promise<unknown> {
    // The closed suite's own vocabulary, shared with the executor that routes
    // it. An abbreviated private spelling here rejected every real request.
    const allowed = new Set<string>(CANONICAL_SMOKE_TEST_IDS.data);
    const requested = stringArray(input, "smoke_test_ids");
    if (requested.some((id) => !allowed.has(id))) {
      throw new OpsError("unsupported_contract", "Unknown smoke test ID");
    }
    try {
      await runPinnedPortableSmoke(
        await this.#ownerConnectionUri(stringField(input, "project_id")),
        requested,
      );
    } catch (error) {
      // A failed assertion is a Postgres exception, so without this it would
      // arrive as an unclassified error rather than a deterministic refusal.
      throw databaseFailure(error);
    }
    return { providerRequestId: crypto.randomUUID() };
  }

  async #dataRecoveryCapture(input: JsonRecord, capability: "data" | "identity"): Promise<unknown> {
    const projectId = stringField(input, "source_resource_id");
    const ownership = stringField(input, "ownership_marker_digest");
    const name = stringField(input, "recovery_target_name");
    const response = await this.#neon(`/projects/${encodeURIComponent(projectId)}/branches`, "POST", {
      branch: { name: `${name}-${capability}`, protected: true },
    });
    const branch = record(response.value.branch, "Neon branch");
    const artifact = await this.#storeRecovery(capability, projectId, ownership, {
      project_id: projectId,
      branch_id: stringField(branch, "id"),
    });
    return this.#artifactResponse(artifact, capability === "data" ? ["database_schema_data"] : ["auth_configuration_identities"], response.id);
  }

  async #dataRecoveryRestore(input: JsonRecord, capability: "data" | "identity"): Promise<unknown> {
    const artifact = await this.#loadRecovery(capability, input);
    const targetProjectId = stringField(input, "target_resource_id");
    if (targetProjectId !== artifact.sourceResourceId) {
      throw new OpsError("recovery_conflict", "Neon branch restore is restricted to its source project");
    }
    const branches = await this.#neon(`/projects/${encodeURIComponent(targetProjectId)}/branches?limit=100`);
    const list = Array.isArray(branches.value.branches) ? branches.value.branches : [];
    const target = list.map((entry) => record(entry, "Neon branch")).find((branch) => branch.default === true);
    if (target === undefined) throw new OpsError("provider_error", "Neon default branch is absent");
    const response = await this.#neon(
      `/projects/${encodeURIComponent(targetProjectId)}/branches/${encodeURIComponent(stringField(target, "id"))}/restore`,
      "POST",
      { source_branch_id: stringField(artifact.payload, "branch_id"), preserve_under_name: `pre-s26-restore-${Date.now()}` },
    );
    return { providerRequestId: response.id };
  }

  async #dataRecoveryVerify(input: JsonRecord, capability: "data" | "identity"): Promise<unknown> {
    const artifact = await this.#loadRecovery(capability, input);
    const projectId = stringField(input, "target_resource_id");
    await runPinnedRestoreVerification(await this.#ownerConnectionUri(projectId));
    return {
      providerRequestId: crypto.randomUUID(),
      coverage: capability === "data" ? ["database_schema_data"] : ["auth_configuration_identities"],
      passed: artifact.sourceResourceId === projectId,
      checkedAt: new Date().toISOString(),
    };
  }

  async #identityInspect(input: JsonRecord): Promise<unknown> {
    const site = new URL(stringField(input, "site_url"));
    const redirects = stringArray(input, "redirect_urls").map((value) => new URL(value));
    return {
      templateSetApproved: configured(this.env.BETTER_AUTH_TEMPLATE_SET_ID) && stringField(input, "template_set_id") === this.env.BETTER_AUTH_TEMPLATE_SET_ID,
      productionUrlsValid: site.protocol === "https:" && redirects.every((url) => url.protocol === "https:" && url.origin === site.origin),
      inviteFlowSupported: true,
      releaseCompatible: configured(this.env.RELEASE_COMPATIBILITY_ID) && stringField(input, "release_compatibility_id") === this.env.RELEASE_COMPATIBILITY_ID,
      validUntil: validUntil(),
    };
  }

  async #identityConfigure(input: JsonRecord): Promise<unknown> {
    const projectId = stringField(input, "project_id");
    const configured = await databaseQuery(
      await this.#ownerConnectionUri(projectId),
      IDENTITY_STORE_PRESENCE_SQL,
    );
    if (configured.rows[0]?.configured !== true) {
      throw new OpsError("provider_error", "Better Auth identity store is not installed");
    }
    await bindingMutation("R2", () => this.env.CONTROL_PLANE_OBJECTS.put(
      `${this.env.RECOVERY_OBJECT_PREFIX}/identity-config/${projectId}.json`,
      JSON.stringify({ site_url: input.site_url, redirect_urls: input.redirect_urls, template_set_id: input.template_set_id }),
      { httpMetadata: { contentType: "application/json" } },
    ));
    return { providerRequestId: crypto.randomUUID() };
  }

  async #identitySupport(input: JsonRecord): Promise<unknown> {
    await databaseMutation(
      await this.#ownerConnectionUri(stringField(input, "project_id")),
      sqlText(supportMembershipSql),
    );
    return { providerRequestId: crypto.randomUUID() };
  }

  async #identityInvite(input: JsonRecord): Promise<unknown> {
    const email = stringField(input, "admin_email").toLowerCase();
    const subject = crypto.randomUUID();
    const bootstrapPasswordBytes = new Uint8Array(32);
    crypto.getRandomValues(bootstrapPasswordBytes);
    const bootstrapPassword = [...bootstrapPasswordBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const passwordHash = await hashPassword(bootstrapPassword);
    const statement = sqlText(initialAdminSql)
      .replaceAll("__ADMIN_EMAIL__", sqlLiteral(email))
      .replaceAll("__ADMIN_SUBJECT__", sqlLiteral(subject))
      .replaceAll("__ADMIN_PASSWORD_HASH__", sqlLiteral(passwordHash));
    const projectId = stringField(input, "project_id");
    await databaseMutation(await this.#ownerConnectionUri(projectId), statement);
    // The admin row is idempotent in SQL. Email is reconciled separately with a
    // durable pending/delivered marker and the provider's idempotency key.
    const marker = `${this.env.RECOVERY_OBJECT_PREFIX}/identity-invite/${projectId}/${await sha256Hex(email)}.json`;
    // The generated bootstrap password is deliberately discarded. The approved
    // application-hosted Better Auth reset flow is the only way to set one.
    const providerRequestId = await this.#sendResendOnce(
      marker,
      email,
      "Your CipherCross dashboard invitation",
      `Open ${this.env.BETTER_AUTH_BASE_URL}/#/reset-password and request a password-reset link for this address.`,
    );
    return { providerRequestId };
  }

  async #identitySmoke(input: JsonRecord): Promise<unknown> {
    if (stringArray(input, "smoke_test_ids").some(
      (id) => !(CANONICAL_SMOKE_TEST_IDS.identity as readonly string[]).includes(id),
    )) {
      throw new OpsError("unsupported_contract", "Unknown identity smoke test ID");
    }
    const result = await databaseQuery(
      await this.#ownerConnectionUri(stringField(input, "project_id")),
      IDENTITY_SURFACE_PRESENCE_SQL,
    );
    const rows = result.rows;
    if (rows[0]?.identity_store !== true || rows[0]?.invite_path !== true) {
      throw new OpsError("provider_error", "Better Auth database surface is incomplete");
    }
    return { providerRequestId: crypto.randomUUID() };
  }

  async #objectSmoke(input: JsonRecord): Promise<unknown> {
    if (input.require_private_access_checks !== true) throw new OpsError("unsupported_contract", "Private object checks are required");
    const smokeTestIds = stringArray(input, "smoke_test_ids");
    if (smokeTestIds.some(
      (id) => !(CANONICAL_SMOKE_TEST_IDS.objectStorage as readonly string[]).includes(id),
    )) {
      throw new OpsError("unsupported_contract", "Unknown object-storage smoke test ID");
    }
    // The same key is deliberately reused. If a prior put/delete response was
    // lost, the retry reconciles that exact canary instead of leaking one more
    // object on every attempt.
    const key = `${this.env.RECOVERY_OBJECT_PREFIX}/smoke/${stringField(input, "project_id")}/${await sha256Hex([...smokeTestIds].sort().join("\n"))}`;
    await bindingMutation("R2", () => this.env.TENANT_LEAD_PHOTOS.put(key, new Uint8Array([0x53, 0x32, 0x36])));
    const observed = await this.env.TENANT_LEAD_PHOTOS.get(key);
    await bindingMutation("R2", () => this.env.TENANT_LEAD_PHOTOS.delete(key));
    if (observed === null) throw new OpsError("provider_error", "R2 binding smoke check failed");
    return { providerRequestId: crypto.randomUUID() };
  }

  async #objectRecoveryCapture(input: JsonRecord): Promise<unknown> {
    const source = stringField(input, "source_resource_id");
    const listed = await this.env.TENANT_LEAD_PHOTOS.list({ prefix: `tenant/${source}/`, limit: 1000 });
    if (listed.truncated) throw new OpsError("provider_error", "R2 recovery inventory exceeded the fixed object limit");
    const totalBytes = listed.objects.reduce((sum, object) => sum + object.size, 0);
    if (totalBytes > 100 * 1024 * 1024) {
      throw new OpsError("provider_error", "R2 recovery inventory exceeded the fixed byte limit");
    }
    const artifactId = crypto.randomUUID();
    const objects: Array<Record<string, unknown>> = [];
    for (const [index, listedObject] of listed.objects.entries()) {
      const sourceObject = await this.env.TENANT_LEAD_PHOTOS.get(listedObject.key);
      if (sourceObject === null || sourceObject.etag !== listedObject.etag) {
        throw new OpsError("recovery_conflict", "R2 source changed during recovery capture");
      }
      const snapshotKey = `${this.env.RECOVERY_OBJECT_PREFIX}/object-snapshots/${artifactId}/${index}`;
      const putOptions: R2PutOptions = {};
      if (sourceObject.httpMetadata !== undefined) putOptions.httpMetadata = sourceObject.httpMetadata;
      if (sourceObject.customMetadata !== undefined) putOptions.customMetadata = sourceObject.customMetadata;
      await bindingMutation("R2", () => this.env.CONTROL_PLANE_OBJECTS.put(snapshotKey, sourceObject.body, putOptions));
      objects.push({
        source_key: listedObject.key,
        snapshot_key: snapshotKey,
        source_etag: listedObject.etag,
        size: listedObject.size,
      });
    }
    const artifact = await this.#storeRecovery(
      "objectStorage",
      source,
      stringField(input, "ownership_marker_digest"),
      { objects },
      artifactId,
    );
    return this.#artifactResponse(artifact, ["storage_metadata", "private_storage_objects_or_reconstruction"], crypto.randomUUID());
  }

  async #objectRecoveryRestore(input: JsonRecord): Promise<unknown> {
    const artifact = await this.#loadRecovery("objectStorage", input);
    const target = stringField(input, "target_resource_id");
    const objects = Array.isArray(artifact.payload.objects) ? artifact.payload.objects : [];
    for (const entry of objects) {
      const object = record(entry, "R2 recovery object");
      const key = stringField(object, "source_key");
      const sourcePrefix = `tenant/${artifact.sourceResourceId}/`;
      if (!key.startsWith(sourcePrefix)) throw new OpsError("recovery_conflict", "R2 recovery source key is outside the captured tenant");
      const source = await this.env.CONTROL_PLANE_OBJECTS.get(stringField(object, "snapshot_key"));
      if (source === null) throw new OpsError("recovery_conflict", "R2 recovery source object is absent");
      const suffix = key.slice(sourcePrefix.length);
      const options: R2PutOptions = {};
      if (source.httpMetadata !== undefined) options.httpMetadata = source.httpMetadata;
      if (source.customMetadata !== undefined) options.customMetadata = source.customMetadata;
      await bindingMutation("R2", () => this.env.TENANT_LEAD_PHOTOS.put(`tenant/${target}/${suffix}`, source.body, options));
    }
    return { providerRequestId: crypto.randomUUID() };
  }

  async #objectRecoveryVerify(input: JsonRecord): Promise<unknown> {
    const artifact = await this.#loadRecovery("objectStorage", input);
    const target = stringField(input, "target_resource_id");
    const objects = Array.isArray(artifact.payload.objects) ? artifact.payload.objects : [];
    let passed = true;
    for (const entry of objects) {
      const object = record(entry, "R2 recovery object");
      const sourceKey = stringField(object, "source_key");
      const sourcePrefix = `tenant/${artifact.sourceResourceId}/`;
      if (!sourceKey.startsWith(sourcePrefix)) {
        passed = false;
        break;
      }
      const restored = await this.env.TENANT_LEAD_PHOTOS.head(`tenant/${target}/${sourceKey.slice(sourcePrefix.length)}`);
      if (restored === null || restored.size !== numberField(object, "size")) {
        passed = false;
        break;
      }
    }
    const listed = await this.env.TENANT_LEAD_PHOTOS.list({ prefix: `tenant/${target}/`, limit: 1000 });
    passed = passed && !listed.truncated && listed.objects.length === objects.length;
    return { providerRequestId: crypto.randomUUID(), coverage: ["storage_metadata", "private_storage_objects_or_reconstruction"], passed, checkedAt: new Date().toISOString() };
  }

  async #vercel(path: string, method: "GET" | "POST" | "PATCH" = "GET", body?: JsonRecord) {
    const separator = path.includes("?") ? "&" : "?";
    return providerJson({ provider: "vercel", url: `${this.env.VERCEL_API_BASE_URL}${path}${separator}teamId=${encodeURIComponent(this.env.VERCEL_TEAM_ID)}`, token: requireBinding(this.env.VERCEL_API_TOKEN, "VERCEL_API_TOKEN"), method, fetcher: this.#fetch, ...(body === undefined ? {} : { body }) });
  }

  async #hostingInspect(input: JsonRecord): Promise<unknown> {
    const name = stringField(input, "deterministic_name");
    let existingProject: JsonRecord | null = null;
    try { existingProject = (await this.#vercel(`/v9/projects/${encodeURIComponent(name)}`)).value; } catch (error) {
      if (!(error instanceof OpsError) || error.code !== "provider_error" || error.details.status !== 404) throw error;
    }
    let owned = existingProject === null;
    if (existingProject !== null) {
      const handle = stringField(existingProject, "id");
      const environment = await this.#vercel(`/v9/projects/${encodeURIComponent(handle)}/env`);
      const entries = Array.isArray(environment.value.envs) ? environment.value.envs : [];
      owned = entries
        .map((entry) => record(entry, "Vercel environment entry"))
        .some((entry) => entry.key === "LH2_OWNERSHIP_MARKER_DIGEST" && entry.value === input.ownership_marker_digest);
    }
    return { controlPlaneAccessible: true, deterministicNameAvailable: existingProject === null, existingTargetOwned: owned, runtimeProfileAvailable: input.runtime_profile_id === "web-node22-1x", serverValueBindingSupported: true, publicValueBindingSupported: true, pinnedRevisionBuildSupported: true, customDomainSupported: true, scheduleCapacityAvailable: numberField(input, "required_schedule_count") <= 4, rollbackSupported: true, automaticPromotionCanBeDisabled: true, isolatedPreviewsSupported: true, validUntil: validUntil() };
  }

  async #assertOwnedDataProject(projectId: string, deterministicName: string): Promise<void> {
    const response = await this.#neon(`/projects/${encodeURIComponent(projectId)}`);
    const project = record(response.value.project, "Neon project");
    if (
      stringField(project, "id") !== projectId
      || stringField(project, "name") !== deterministicName
      || stringField(project, "org_id") !== this.env.NEON_ORGANIZATION_ID
    ) {
      throw new OpsError("provider_error", "Neon project ownership or deterministic identity mismatch");
    }
  }

  async #ownedHostingEnvironment(
    target: string,
    ownershipMarkerDigest: string,
  ): Promise<{ readonly id: string; readonly value: JsonRecord; readonly status: number }> {
    const project = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}`);
    if (stringField(project.value, "id") !== target) {
      throw new OpsError("provider_error", "Vercel target identity mismatch");
    }
    const environment = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}/env`);
    const entries = Array.isArray(environment.value.envs) ? environment.value.envs : [];
    const owned = entries
      .map((entry) => record(entry, "Vercel environment entry"))
      .some((entry) => entry.key === "LH2_OWNERSHIP_MARKER_DIGEST" && entry.value === ownershipMarkerDigest);
    if (!owned) throw new OpsError("provider_error", "Vercel target ownership marker mismatch");
    return environment;
  }

  async #hostingEnvironment(input: JsonRecord): Promise<unknown> {
    const target = stringField(input, "target_handle");
    const descriptors = Array.isArray(input.bindings)
      ? input.bindings.map((entry) => record(entry, "Vercel binding descriptor"))
      : [];
    if (descriptors.length === 0) throw new OpsError("unsupported_contract", "Vercel binding descriptors are absent");

    const names = new Set<string>();
    for (const descriptor of descriptors) {
      const name = stringField(descriptor, "name");
      if (names.has(name)) throw new OpsError("unsupported_contract", `Vercel binding descriptor ${name} is duplicated`);
      names.add(name);
      const approved = this.#hostingValueSpec(name);
      const source = record(descriptor.source, `Vercel binding source for ${name}`);
      if (
        approved.valueClass !== stringField(descriptor, "value_class") ||
        approved.sourceKind !== stringField(descriptor, "source_kind") ||
        canonicalJson(source as JsonValue) !== canonicalJson(approved.source as JsonValue)
      ) {
        throw new OpsError("unsupported_contract", `Vercel binding descriptor ${name} does not match the fixed profile`);
      }
    }
    const expectedNames = CANONICAL_TENANT_ENVIRONMENT.map((entry) => entry.name).sort();
    if (JSON.stringify([...names].sort()) !== JSON.stringify(expectedNames)) {
      throw new OpsError(
        "unsupported_contract",
        "Vercel binding descriptors must be the complete closed S26 application profile",
      );
    }
    if (this.env.S26_APPLICATION_HOSTING_CONTRACT !== "hosting.environment.v2") {
      throw new OpsError("unsupported_contract", "Worker application hosting contract is not the reviewed S26 version");
    }
    if (String(this.env.S26_APPLICATION_DATA_PLANE_READY) !== "true") {
      throw new OpsError(
        "provider_readiness_blocked",
        "The S26 application data-plane contract is local-only and is not approved for provider application",
      );
    }

    const dataProjectId = stringField(input, "data_project_id");
    await this.#assertOwnedDataProject(dataProjectId, stringField(input, "data_project_name"));
    const existingResponse = await this.#ownedHostingEnvironment(
      target,
      stringField(input, "ownership_marker_digest"),
    );
    const applicationConnectionUris: Readonly<Record<string, string>> = {
      NEON_DATABASE_URL: await this.#connectionUri(
        dataProjectId,
        requireConfigured(this.env.NEON_APPLICATION_ROLE_NAME, "NEON_APPLICATION_ROLE_NAME"),
      ),
      NEON_AI_DATABASE_URL: await this.#connectionUri(
        dataProjectId,
        requireConfigured(this.env.NEON_AI_ROLE_NAME, "NEON_AI_ROLE_NAME"),
      ),
      NEON_MACHINE_DATABASE_URL: await this.#connectionUri(
        dataProjectId,
        requireConfigured(this.env.NEON_MACHINE_ROLE_NAME, "NEON_MACHINE_ROLE_NAME"),
      ),
      IDENTITY_STORE_DATABASE_URL: await this.#connectionUri(
        dataProjectId,
        requireConfigured(this.env.NEON_IDENTITY_STORE_ROLE_NAME, "NEON_IDENTITY_STORE_ROLE_NAME"),
      ),
    };
    const generated = new Map<string, string>();
    const generatedValue = (id: string): string => {
      const existing = generated.get(id);
      if (existing !== undefined) return existing;
      const value = this.#generateSecret();
      generated.set(id, value);
      return value;
    };

    const existingValues = Array.isArray(existingResponse.value.envs) ? existingResponse.value.envs : [];
    // Only a production entry counts as this binding being already present; a
    // preview-scoped value of the same name is a different binding.
    const existingByName = new Map<string, JsonRecord>();
    for (const rawEntry of existingValues) {
      const entry = record(rawEntry, "Vercel environment entry");
      const targets = Array.isArray(entry.target)
        ? entry.target.filter((target): target is string => typeof target === "string")
        : [];
      if (!targets.includes("production")) continue;
      const name = stringField(entry, "key");
      if (name === "LH2_OWNERSHIP_MARKER_DIGEST") continue;
      if (existingByName.has(name)) {
        throw new OpsError("provider_error", `Vercel production binding ${name} is duplicated`);
      }
      const expected = this.#hostingValueSpec(name);
      const expectedType = expected.valueClass === "server_secret" ? "sensitive" : "encrypted";
      if (entry.type !== expectedType || JSON.stringify([...targets].sort()) !== JSON.stringify(["production"])) {
        throw new OpsError("provider_error", `Vercel production binding ${name} has the wrong scope or type`);
      }
      existingByName.set(name, entry);
    }
    let lastRequestId = existingResponse.id;
    const resultBindings: Array<{ name: string; valueClass: string; sourceKind: string }> = [];
    for (const descriptor of descriptors) {
      const name = stringField(descriptor, "name");
      const valueClass = stringField(descriptor, "value_class");
      const sourceKind = stringField(descriptor, "source_kind");
      // A binding this target already carries is the retried case: the step's
      // outcome — the closed profile is bound to production — is already true
      // for that name. Re-writing it would mint a fresh generated secret on
      // every retry and silently rotate the tenant's credentials underneath a
      // release that was already promoted with the previous ones. Whether the
      // adopted values are the right ones stays the verification step's job;
      // a sensitive Vercel value cannot be read back and compared here.
      if (!existingByName.has(name)) {
        const approved = this.#hostingValue(name, applicationConnectionUris, generatedValue);
        const response = await this.#vercel(`/v10/projects/${encodeURIComponent(target)}/env`, "POST", {
          key: name,
          value: approved.value,
          type: valueClass === "server_secret" ? "sensitive" : "encrypted",
          target: ["production"],
        });
        lastRequestId = response.id;
      }
      resultBindings.push({ name, valueClass, sourceKind });
    }
    return {
      hostingRequestId: lastRequestId,
      targetHandle: target,
      scope: "production",
      bindings: resultBindings,
      bindingDigest: hostingEnvironmentBindingDigest(
        CANONICAL_TENANT_ENVIRONMENT.map((entry) => ({
          name: entry.name,
          valueClass: entry.valueClass,
          source: entry.source,
        })),
      ),
    };
  }

  #hostingValueSpec(name: string): {
    readonly valueClass: string;
    readonly sourceKind: string;
    readonly source: (typeof CANONICAL_TENANT_ENVIRONMENT)[number]["source"];
  } {
    const selected = CANONICAL_TENANT_ENVIRONMENT.find((entry) => entry.name === name);
    if (selected === undefined) throw new OpsError("unsupported_contract", `Vercel binding ${name} is not in the fixed profile`);
    return {
      valueClass: selected.valueClass,
      sourceKind: selected.source.kind,
      source: selected.source,
    };
  }

  #hostingValue(
    name: string,
    applicationConnectionUris: Readonly<Record<string, string>>,
    generatedValue: (id: string) => string,
  ): { readonly value: string; readonly valueClass: string; readonly sourceKind: string } {
    const selected = this.#hostingValueSpec(name);
    const generated: Readonly<Record<string, string>> = {
      IDENTITY_SESSION_SECRET: generatedValue("tenant.identity_session_secret"),
      CRON_SECRET: generatedValue("tenant.cron_secret"),
      NOTIFY_SECRET: generatedValue("tenant.notify_secret"),
      MCP_SECRET: generatedValue("tenant.mcp_secret"),
    };
    const planned: Readonly<Record<string, string>> = {
      IDENTITY_BASE_URL: requireConfigured(this.env.BETTER_AUTH_BASE_URL, "BETTER_AUTH_BASE_URL"),
      VITE_AUTH_PATH: "identity",
      NEON_READS_DEFAULT: "neon",
      NEON_WRITES_DEFAULT: "neon",
      NEON_AI_PATH_DEFAULT: "neon",
      NEON_PHOTOS_DEFAULT: "disabled",
    };
    const value = applicationConnectionUris[name] ?? generated[name] ?? planned[name];
    if (value === undefined) throw new OpsError("unsupported_contract", `Vercel binding ${name} is not in the fixed profile`);
    return { value, ...selected };
  }

  async #hostingBuild(input: JsonRecord): Promise<unknown> {
    const revision = stringField(input, "revision_id");
    const approvedRevision = requireConfigured(this.env.APPROVED_SOURCE_GIT_SHA, "APPROVED_SOURCE_GIT_SHA");
    if (!/^[0-9a-f]{40}$/.test(approvedRevision)) {
      throw new OpsError("provider_readiness_blocked", "Approved source revision is not a full owner-approved Git SHA");
    }
    if (revision !== approvedRevision) throw new OpsError("provider_snapshot_drift", "Source revision is not the approved pinned SHA");
    const buildRecipe = stringField(input, "build_recipe_id");
    if (buildRecipe !== this.env.VERCEL_BUILD_RECIPE_ID) throw new OpsError("unsupported_contract", "Vercel build recipe is not the fixed profile");
    const publicNames = [...stringArray(input, "public_value_names")].sort();
    const expectedPublicNames = CANONICAL_TENANT_ENVIRONMENT
      .filter((entry) => entry.valueClass === "public_build")
      .map((entry) => entry.name)
      .sort();
    if (JSON.stringify(publicNames) !== JSON.stringify(expectedPublicNames)) {
      throw new OpsError("unsupported_contract", "Vercel public build values are not the fixed profile");
    }
    const environmentBindingDigest = stringField(input, "environment_binding_digest");
    const expectedEnvironmentBindingDigest = hostingEnvironmentBindingDigest(
      CANONICAL_TENANT_ENVIRONMENT.map((entry) => ({
        name: entry.name,
        valueClass: entry.valueClass,
        source: entry.source,
      })),
    );
    if (environmentBindingDigest !== expectedEnvironmentBindingDigest) {
      throw new OpsError("provider_snapshot_drift", "Vercel environment binding digest is not the closed S26 profile");
    }
    const scheduleDigest = stringField(input, "schedule_manifest_digest");
    if (
      scheduleDigest !== requireConfigured(this.env.APPROVED_SCHEDULE_MANIFEST_DIGEST, "APPROVED_SCHEDULE_MANIFEST_DIGEST")
      || scheduleDigest !== scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES)
    ) {
      throw new OpsError("provider_snapshot_drift", "Vercel schedule manifest digest is not approved");
    }
    // A build this target already holds for the approved revision is the
    // retried case: the step's outcome — a verified release of that exact SHA
    // exists — is already true. Creating another one would leave a second
    // deployment behind and move the registry's build reference off the
    // release that step 10 may already have promoted.
    const target = stringField(input, "target_handle");
    const buildIdentityDigest = sha256Digest(canonicalJson({
      target_handle: target,
      revision_id: revision,
      build_recipe_id: buildRecipe,
      environment_binding_digest: environmentBindingDigest,
      schedule_manifest_digest: scheduleDigest,
    }));
    const adopted = await this.#existingDeployment(target, revision, buildIdentityDigest);
    const deployment = adopted ?? await (async () => {
      const project = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}`);
      const projectName = stringField(project.value, "name");
      const response = await this.#vercel("/v13/deployments", "POST", {
        name: projectName,
        project: target,
        // The project has automatic domain assignment disabled in step 6, so
        // this is a staged production build: it receives the production-only
        // bindings from step 7 without serving traffic before step 10.
        target: "production",
        gitSource: {
          type: "github",
          org: this.env.SOURCE_REPOSITORY_OWNER,
          repo: this.env.SOURCE_REPOSITORY_NAME,
          ref: revision,
          sha: revision,
        },
        meta: { lh2S26BuildDigest: buildIdentityDigest },
        // Step 6 creates the project through the API, which leaves it with no
        // build settings, and Vercel then refuses a deployment with
        // `400 missing_project_settings`. The settings must therefore travel with
        // the deployment. They are the approved build recipe's own definition —
        // the recipe id was already checked against VERCEL_BUILD_RECIPE_ID above,
        // so a different recipe cannot reach this.
        //
        // rootDirectory is `frontend` because that is where the app and, more
        // importantly, `frontend/vercel.json` live. That file declares the four
        // crons this step then waits for in #waitForProjectCrons, so a root of
        // null would build the wrong tree and never register a schedule.
        projectSettings: BUILD_RECIPE_PROJECT_SETTINGS,
      });
      const ready = await this.#waitForDeployment(stringField(response.value, "id"), response.id);
      this.#assertDeploymentIdentity(ready.value, revision, buildIdentityDigest);
      return ready;
    })();
    const release = stringField(deployment.value, "id");
    const gitSource = record(deployment.value.gitSource, "Vercel deployment git source");
    const observedRevision = gitSource.sha ?? gitSource.ref;
    if (observedRevision !== revision) {
      throw new OpsError("provider_snapshot_drift", "Vercel built a revision other than the approved pinned SHA");
    }
    return { hostingRequestId: deployment.id, releaseHandle: release, targetHandle: stringField(input, "target_handle"), revisionId: revision, revisionPinned: true, buildRecipeId: buildRecipe, publicValueNames: publicNames, environmentBindingDigest, scheduleManifestDigest: scheduleDigest, artifactDigest: sha256Digest(canonicalJson({ release, revision, environment_binding_digest: environmentBindingDigest })), status: "verified" };
  }

  async #hostingSchedules(input: JsonRecord): Promise<unknown> {
    const release = stringField(input, "release_handle");
    const target = stringField(input, "target_handle");
    const deployment = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}`);
    const expected = expectedCrons(input);
    const manifestDigest = stringField(input, "manifest_digest");
    if (
      scheduleManifestDigestOf(expected) !== manifestDigest
      || manifestDigest !== requireConfigured(this.env.APPROVED_SCHEDULE_MANIFEST_DIGEST, "APPROVED_SCHEDULE_MANIFEST_DIGEST")
    ) {
      throw new OpsError("provider_snapshot_drift", "Vercel schedule manifest digest is not the fixed approved set");
    }
    // Activation is deliberately NOT asserted here. This runs inside step 9,
    // whose deployment is staged on purpose, and Vercel attaches crons to the
    // release that actually serves production. The manifest digest above is the
    // real gate at this point; #hostingRollout waits for activation once the
    // release is promoted, and #hostingVerify compares the activated set against
    // the expected one and fails closed.
    if (projectCronDeploymentId(deployment.value) === release
      && !cronsMatch(expected, observedCrons(deployment.value))) {
      throw new OpsError("provider_error", "Vercel deployment cron manifest does not match the fixed schedule set");
    }
    return { hostingRequestId: deployment.id, targetHandle: target, releaseHandle: release, registered: input.schedules, manifestDigest };
  }

  /**
   * The newest READY deployment of this target that already carries the
   * approved revision, if one exists. The list endpoint's commit metadata only
   * selects candidates; the revision is confirmed on the same deployment
   * record, and by the same comparison, that a fresh build is confirmed with.
   */
  async #existingDeployment(
    target: string,
    revision: string,
    buildIdentityDigest: string,
  ): Promise<{ readonly id: string; readonly value: JsonRecord } | null> {
    const listed = await this.#vercel(
      `/v7/deployments?projectId=${encodeURIComponent(target)}&sha=${encodeURIComponent(revision)}&limit=20`,
    );
    const deployments = Array.isArray(listed.value.deployments) ? listed.value.deployments : [];
    for (const entry of deployments) {
      const candidate = record(entry, "Vercel deployment");
      const meta = typeof candidate.meta === "object" && candidate.meta !== null
        ? record(candidate.meta, "Vercel deployment metadata")
        : {};
      if (meta.lh2S26BuildDigest !== buildIdentityDigest) continue;
      const deployment = await this.#vercel(`/v13/deployments/${encodeURIComponent(stringField(candidate, "uid"))}?withGitRepoInfo=true`);
      if (["ERROR", "CANCELED", "BLOCKED"].includes(String(deployment.value.readyState))) continue;
      const ready = deployment.value.readyState === "READY"
        ? deployment
        : await this.#waitForDeployment(stringField(deployment.value, "id"), deployment.id);
      this.#assertDeploymentIdentity(ready.value, revision, buildIdentityDigest);
      return ready;
    }
    return null;
  }

  #assertDeploymentIdentity(
    deployment: JsonRecord,
    revision: string,
    buildIdentityDigest: string,
  ): void {
    const meta = record(deployment.meta, "Vercel deployment metadata");
    const gitSource = record(deployment.gitSource, "Vercel deployment git source");
    if (
      meta.lh2S26BuildDigest !== buildIdentityDigest
      || (gitSource.sha ?? gitSource.ref) !== revision
      || deployment.target !== "production"
    ) {
      throw new OpsError("provider_snapshot_drift", "Vercel deployment does not match the marked S26 build inputs");
    }
  }

  async #waitForDeployment(release: string, createRequestId: string): Promise<{ readonly id: string; readonly value: JsonRecord }> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const deployment = await this.#vercel(`/v13/deployments/${encodeURIComponent(release)}?withGitRepoInfo=true`);
      if (deployment.value.readyState === "READY") return deployment;
      if (deployment.value.readyState === "ERROR" || deployment.value.readyState === "CANCELED") {
        throw new OpsError("provider_error", "Vercel deployment did not reach READY", {
          provider_request_id: deployment.id,
        });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    // Running out of polling budget while the build is still progressing is NOT
    // an unknown outcome. The deployment exists, its id is known, and it carries
    // the build identity digest, so the next attempt adopts it through
    // #existingDeployment once it is READY with its crons registered. Reporting
    // `outcome_unknown` quarantined the operation for a build that was merely
    // still running — and a real Vite build takes minutes, so with the previous
    // 20-second budget a fresh build could essentially never be recorded.
    throw new OpsError("provider_readiness_blocked", "Vercel deployment is still building", {
      provider_request_id: createRequestId,
    });
  }

  /**
   * Points the tenant's hostname at this release.
   *
   * Vercel's own generated `*.vercel.app` aliases follow a promoted deployment by
   * themselves; a hostname added to the project explicitly does not, while
   * automatic assignment is off — and step 6 turns it off deliberately so the
   * step-9 build stays staged until here.
   *
   * The hostname is supplied by the caller and its binding is confirmed with the
   * same single-domain probe #vercelHostnameBoundInTeam uses. A first attempt
   * listed the project's domains instead and guessed the response key, so when
   * nothing matched it aliased nothing and step 10 still reported success — the
   * silent no-op left step 11 failing on the same four domain checks with no new
   * information. An absent binding is now a named failure instead.
   *
   * Re-aliasing a hostname that already resolves here is accepted, so this is
   * safe to repeat, which matters because step 10 adopts an already-promoted
   * release rather than promoting twice.
   */
  async #serveHostname(target: string, release: string, hostname: string): Promise<void> {
    try {
      await this.#vercel(
        `/v10/projects/${encodeURIComponent(target)}/domains/${encodeURIComponent(hostname)}`,
      );
    } catch (error) {
      if (error instanceof OpsError && error.code === "provider_error" && error.details.status === 404) {
        throw new OpsError("provider_error", "Vercel project does not carry the tenant hostname");
      }
      throw error;
    }
    await this.#vercel(
      `/v2/deployments/${encodeURIComponent(release)}/aliases`,
      "POST",
      { alias: hostname },
    );
  }

  async #hostingRollout(input: JsonRecord, kind: "promote" | "rollback"): Promise<unknown> {
    const target = stringField(input, "target_handle");
    const active = stringField(input, "release_handle");
    const project = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}`);
    const current = this.#latestDeploymentId(project.value);
    const previous = kind === "promote" ? current : stringField(input, "superseded_release_handle");
    // A release this target already serves is the retried case: the step's
    // outcome — production points at this release — is already true, so the
    // promotion is adopted rather than issued a second time. A rollback stays
    // explicit; it names the release it supersedes and is never inferred.
    const response = kind === "promote" && current === active
      ? project
      : await this.#vercel(
        `/v10/projects/${encodeURIComponent(target)}/promote/${encodeURIComponent(active)}`,
        "POST",
      );
    if (current !== active) await this.#waitForActiveRelease(target, active, response.id);
    // Making the release SERVE the target's own hostnames is step 10's effect,
    // and it was missing entirely. Step 6 sets autoAssignCustomDomains: false —
    // deliberately, and it asserts the flag took hold — so that step 9's build
    // stays staged "until step 10". Nothing then re-enabled it or aliased the
    // promoted release, so a custom hostname could never come to serve it. That
    // is what step 11 reported as domain.assigned / matchesExpected /
    // servesActiveRelease all false.
    //
    // The domains are read from the project rather than taken from the request:
    // step 8 already bound the hostname there, so the project is the authority on
    // what this release must answer for, and the promote contract stays unchanged.
    // Aliasing is explicit, so the project-level auto-assign flag stays off and
    // future builds keep staging as designed.
    if (kind === "promote") await this.#serveHostname(target, active, stringField(input, "expected_hostname"));
    return { hostingRequestId: response.id, targetHandle: target, rolloutHandle: response.id, rolloutKind: kind, activeReleaseHandle: active, previousReleaseHandle: previous, rolloutSequence: Date.now(), reasonCode: kind === "rollback" ? stringField(input, "reason_code") : null };
  }

  #latestDeploymentId(project: JsonRecord): string | null {
    if (typeof project.targets === "object" && project.targets !== null && !Array.isArray(project.targets)) {
      const production = (project.targets as Record<string, unknown>).production;
      if (typeof production === "object" && production !== null && !Array.isArray(production)) {
        const target = production as Record<string, unknown>;
        const id = target.id;
        const promoted = target.readySubstate === "PROMOTED"
          || target.aliasAssigned === true
          || (typeof target.aliasAssigned === "number" && Number.isFinite(target.aliasAssigned));
        // `targets.production` may point at the newest staged production
        // build before it serves traffic. Only its promoted/aliased state is
        // the step-10 postcondition.
        if (typeof id === "string" && promoted) return id;
      }
      return null;
    }
    if (typeof project.latestDeploymentId === "string") return project.latestDeploymentId;
    if (!Array.isArray(project.latestDeployments) || project.latestDeployments.length === 0) return null;
    const latest = record(project.latestDeployments[0], "Vercel latest deployment");
    return typeof latest.id === "string" ? latest.id : null;
  }

  async #waitForActiveRelease(
    target: string,
    release: string,
    promoteRequestId: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const project = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}`);
      if (this.#latestDeploymentId(project.value) === release) return;
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    // Step 10's own copy of the same problem. The requested release handle is
    // known and #hostingRollout adopts a target that already serves it, so a
    // promotion still propagating is in progress, not ambiguous.
    throw new OpsError("provider_readiness_blocked", "Vercel promotion is not active yet", {
      provider_request_id: promoteRequestId,
    });
  }

  /**
   * Recovery and verification retain only the closed descriptors and provider
   * metadata. Environment values are neither read into an artifact nor echoed.
   */
  #closedHostingEnvironmentMetadata(entries: readonly unknown[]): {
    readonly bindings: readonly {
      readonly name: string;
      readonly valueClass: string;
      readonly sourceKind: string;
      readonly type: string;
      readonly target: readonly string[];
    }[];
    readonly bindingDigest: string;
  } {
    const expected = new Map(CANONICAL_TENANT_ENVIRONMENT.map((entry) => [entry.name, entry]));
    const bindings = entries
      .map((entry) => record(entry, "Vercel environment entry"))
      .filter((entry) => entry.key !== "LH2_OWNERSHIP_MARKER_DIGEST")
      .map((entry) => {
        const name = stringField(entry, "key");
        const spec = expected.get(name);
        if (spec === undefined) {
          throw new OpsError("unsupported_contract", "Vercel environment contains a value outside the closed S26 profile");
        }
        return {
          name,
          valueClass: spec.valueClass,
          sourceKind: spec.source.kind,
          type: stringField(entry, "type"),
          target: Array.isArray(entry.target)
            ? entry.target.filter((item): item is string => typeof item === "string").sort()
            : [],
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    if (
      JSON.stringify(bindings.map((binding) => binding.name)) !==
      JSON.stringify([...expected.keys()].sort())
    ) {
      throw new OpsError("provider_error", "Vercel environment does not contain the complete closed S26 profile");
    }
    return {
      bindings,
      bindingDigest: hostingEnvironmentBindingDigest(
        bindings.map((binding) => {
          const spec = this.#hostingValueSpec(binding.name);
          return {
            name: binding.name,
            valueClass: binding.valueClass,
            source: spec.source,
          };
        }),
      ),
    };
  }

  /** Whether this project carries the hostname, via the proven single-domain probe. */
  async #projectHostnameBound(target: string, hostname: string): Promise<boolean> {
    try {
      await this.#vercel(
        `/v10/projects/${encodeURIComponent(target)}/domains/${encodeURIComponent(hostname)}`,
      );
      return true;
    } catch (error) {
      if (error instanceof OpsError && error.code === "provider_error" && error.details.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Whether the hostname actually answers over HTTPS.
   *
   * Unauthenticated and read-only: it carries no credential and reads no body,
   * only the status. It is the one check that speaks for the tenant's own users.
   */
  async #hostnameAnswers(hostname: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.#fetch(`https://${hostname}/`, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      return response.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #hostingVerify(input: JsonRecord): Promise<unknown> {
    const target = stringField(input, "target_handle");
    const expected = stringField(input, "expected_active_release_handle");
    const response = await this.#vercel(`/v13/deployments/${encodeURIComponent(expected)}?withGitRepoInfo=true`);
    const project = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}`);
    const environment = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}/env`);
    const ready = response.value.readyState === "READY";
    const expectedScheduleSet = expectedCrons(input);
    const providerCrons = observedCrons(project.value);
    const schedulesMatch = projectCronDeploymentId(project.value) === expected
      && cronsMatch(expectedScheduleSet, providerCrons);
    const missingScheduleIds = expectedScheduleSet
      .filter((candidate) => !providerCrons.some((observed) => observed.path === candidate.path && observed.schedule === candidate.schedule))
      .map((candidate) => candidate.id);
    const unexpectedScheduleIds = providerCrons
      .filter((observed) => !expectedScheduleSet.some((candidate) => observed.path === candidate.path && observed.schedule === candidate.schedule))
      .map((_, index) => `unexpected-${index + 1}`);
    const gitSource = response.value.gitSource === undefined ? null : record(response.value.gitSource, "Vercel git source");
    const expectedRevision = stringField(input, "expected_revision_id");
    const observedRevision = gitSource?.sha ?? gitSource?.ref;
    const revisionMatches = observedRevision === expectedRevision;
    const activeRelease = this.#latestDeploymentId(project.value);
    const activeMatches = activeRelease === expected;
    const expectedHostname = stringField(input, "expected_hostname");
    // The deployment object's `alias` array is a snapshot of what was assigned
    // when it was created, so an alias attached later — which is exactly what
    // step 10 does, because step 6 leaves automatic assignment off — never appears
    // in it. Reading it reported all four domain checks false while
    // https://<hostname>/ was in fact serving this release with HTTP 200.
    //
    // The binding is confirmed with the same single-domain probe used elsewhere,
    // and whether the hostname actually answers is settled by asking it. Between
    // them those two facts, plus the already-computed active-release check, say
    // what the four fields below claim — none of it from a snapshot field.
    const domainBound = await this.#projectHostnameBound(target, expectedHostname);
    const domainServes = domainBound && await this.#hostnameAnswers(expectedHostname);
    const domainMatches = domainBound;
    const environmentMetadata = this.#closedHostingEnvironmentMetadata(
      Array.isArray(environment.value.envs) ? environment.value.envs : [],
    );
    const publicValueNames = environmentMetadata.bindings
      .filter((entry) => entry.valueClass === "public_build")
      .map((entry) => entry.name);
    const environmentTypesMatch = environmentMetadata.bindings.every((entry) =>
      entry.type === (entry.valueClass === "server_secret" ? "sensitive" : "encrypted") &&
      JSON.stringify(entry.target) === JSON.stringify(["production"]),
    );
    const passed = ready && activeMatches && revisionMatches && schedulesMatch && domainMatches && environmentTypesMatch;
    const checkIds = stringArray(input, "runtime_check_ids");
    const manifestDigest = scheduleManifestDigestOf(expectedScheduleSet);
    return {
      hostingRequestId: response.id,
      targetHandle: target,
      status: passed ? "passed" : "failed",
      runtime: {
        reachable: ready,
        activeReleaseHandle: activeRelease,
        activeReleaseMatchesExpected: activeMatches,
        passedCheckIds: passed ? checkIds : [],
        failedCheckIds: passed ? [] : checkIds,
      },
      schedules: {
        registered: input.expected_schedules,
        expectedScheduleIds: expectedScheduleSet.map((entry) => entry.id),
        missingScheduleIds,
        unexpectedScheduleIds,
        manifestDigest,
        manifestMatchesRelease: schedulesMatch,
      },
      domain: {
        hostname: expectedHostname,
        assigned: domainBound,
        // Answering over HTTPS at all is the certificate working.
        certificateReady: domainBound && domainServes,
        matchesExpected: domainMatches,
        servesActiveRelease: domainBound && activeMatches && domainServes,
      },
      build: {
        releaseHandle: expected,
        revisionId: typeof observedRevision === "string" && /^[0-9a-f]{40}$/.test(observedRevision) ? observedRevision : null,
        revisionPinned: typeof observedRevision === "string" && /^[0-9a-f]{40}$/.test(observedRevision),
        revisionMatchesExpected: revisionMatches,
        buildRecipeId: "spa-plus-http-handlers-v1",
        artifactDigest: sha256Digest(canonicalJson({ release: expected, revision: expectedRevision })),
        publicValueNames,
        environmentBindingDigest: environmentMetadata.bindingDigest,
        scheduleManifestDigest: manifestDigest,
      },
      rollout: {
        rolloutKind: activeMatches ? "promote" : null,
        rolloutSequence: typeof response.value.createdAt === "number" ? response.value.createdAt : 0,
        previousReleaseHandle: null,
      },
    };
  }

  async #hostingRecoveryCapture(input: JsonRecord): Promise<unknown> {
    const source = stringField(input, "source_resource_id");
    const response = await this.#vercel(`/v9/projects/${encodeURIComponent(source)}`);
    const environment = await this.#vercel(`/v9/projects/${encodeURIComponent(source)}/env`);
    const entries = Array.isArray(environment.value.envs) ? environment.value.envs : [];
    const environmentMetadata = this.#closedHostingEnvironmentMetadata(entries);
    const artifact = await this.#storeRecovery("hosting", source, stringField(input, "ownership_marker_digest"), {
      project_id: source,
      latest_deployment_id: this.#latestDeploymentId(response.value),
      environment: environmentMetadata.bindings,
      environment_binding_digest: environmentMetadata.bindingDigest,
    });
    return this.#artifactResponse(artifact, ["deployment_configuration_metadata"], response.id);
  }

  async #hostingRecoveryRestore(input: JsonRecord): Promise<unknown> {
    const artifact = await this.#loadRecovery("hosting", input);
    const target = stringField(input, "target_resource_id");
    if (target !== artifact.sourceResourceId) {
      throw new OpsError("recovery_conflict", "Vercel recovery is restricted to its captured project");
    }
    const deployment = artifact.payload.latest_deployment_id;
    if (typeof deployment !== "string") throw new OpsError("recovery_conflict", "Vercel recovery artifact has no deployment");
    const response = await this.#vercel(`/v13/deployments/${encodeURIComponent(deployment)}/promote`, "POST", { projectId: target });
    return { providerRequestId: response.id };
  }

  async #hostingRecoveryVerify(input: JsonRecord): Promise<unknown> {
    const artifact = await this.#loadRecovery("hosting", input);
    const target = stringField(input, "target_resource_id");
    const response = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}`);
    const environment = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}/env`);
    const expectedEnvironment = Array.isArray(artifact.payload.environment) ? artifact.payload.environment : [];
    const observedEnvironment = this.#closedHostingEnvironmentMetadata(
      Array.isArray(environment.value.envs) ? environment.value.envs : [],
    );
    const expectedDigest = typeof artifact.payload.environment_binding_digest === "string"
      ? artifact.payload.environment_binding_digest
      : "";
    const metadataMatches = canonicalJson(expectedEnvironment as JsonValue)
      === canonicalJson(observedEnvironment.bindings as JsonValue);
    return { providerRequestId: response.id, coverage: ["deployment_configuration_metadata"], passed: target === artifact.sourceResourceId && this.#latestDeploymentId(response.value) === artifact.payload.latest_deployment_id && metadataMatches && expectedDigest === observedEnvironment.bindingDigest, checkedAt: new Date().toISOString() };
  }

  async #resend(
    path: string,
    method: "GET" | "POST" = "GET",
    body?: JsonRecord,
    idempotencyKey?: string,
  ) {
    return providerJson({
      provider: "resend",
      url: `${this.env.RESEND_API_BASE_URL}${path}`,
      token: requireBinding(this.env.RESEND_API_KEY, "RESEND_API_KEY"),
      method,
      fetcher: this.#fetch,
      ...(body === undefined ? {} : { body }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
  }

  async #smtpInspect(input: JsonRecord): Promise<unknown> {
    const profile = stringField(input, "smtp_profile_id");
    if (profile !== this.env.RESEND_SMTP_PROFILE_ID) throw new OpsError("unsupported_contract", "SMTP profile is not the fixed Resend profile");
    if (stringField(input, "sender_domain") !== this.env.RESEND_SENDER_DOMAIN) throw new OpsError("unsupported_contract", "SMTP sender domain is not the fixed Resend domain");
    if (stringField(input, "from_identity") !== this.env.RESEND_FROM_EMAIL) throw new OpsError("unsupported_contract", "SMTP from identity is not the fixed Resend identity");
    const response = await this.#resend("/domains");
    const domains = Array.isArray(response.value.data) ? response.value.data : [];
    const domain = domains.map((entry) => record(entry, "Resend domain")).find((entry) => entry.name === input.sender_domain);
    return { providerAccessible: true, customSmtp: true, senderIdentityVerified: domain?.status === "verified", credentialsAvailable: this.env.RESEND_API_KEY.length > 0, validUntil: validUntil() };
  }

  async #smtpConfigure(input: JsonRecord): Promise<unknown> {
    await this.#smtpInspect(input);
    const projectId = stringField(input, "project_id");
    await bindingMutation("R2", () => this.env.CONTROL_PLANE_OBJECTS.put(
      `${this.env.RECOVERY_OBJECT_PREFIX}/smtp-config/${projectId}.json`,
      JSON.stringify({
        profile_id: this.env.RESEND_SMTP_PROFILE_ID,
        sender_domain: this.env.RESEND_SENDER_DOMAIN,
        from_identity: this.env.RESEND_FROM_EMAIL,
      }),
      { httpMetadata: { contentType: "application/json" } },
    ));
    return { providerRequestId: crypto.randomUUID() };
  }

  async #sendResend(to: string, subject: string, text: string, idempotencyKey: string): Promise<string> {
    const response = await this.#resend(
      "/emails",
      "POST",
      { from: this.env.RESEND_FROM_IDENTITY, to: [to], subject, text },
      idempotencyKey,
    );
    return response.id;
  }

  async #sendResendOnce(
    markerKey: string,
    to: string,
    subject: string,
    text: string,
  ): Promise<string> {
    const object = await bindingMutation("R2", () => this.env.CONTROL_PLANE_OBJECTS.get(markerKey));
    let marker: EmailDeliveryMarker;
    if (object === null) {
      marker = {
        version: "s26-email-delivery.v1",
        state: "pending",
        idempotencyKey: `s26/${await sha256Hex(markerKey)}`,
        correlationId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      await bindingMutation("R2", () => this.env.CONTROL_PLANE_OBJECTS.put(
        markerKey,
        JSON.stringify(marker),
        { httpMetadata: { contentType: "application/json" } },
      ));
    } else {
      const raw = record(await object.json(), "R2 email-delivery marker");
      if (
        raw.version !== "s26-email-delivery.v1"
        || (raw.state !== "pending" && raw.state !== "delivered")
        || typeof raw.idempotencyKey !== "string"
        || typeof raw.correlationId !== "string"
        || typeof raw.createdAt !== "string"
        || !Number.isFinite(Date.parse(raw.createdAt))
      ) {
        throw new OpsError("provider_error", "R2 email-delivery marker is invalid");
      }
      marker = {
        version: raw.version,
        state: raw.state,
        idempotencyKey: raw.idempotencyKey,
        correlationId: raw.correlationId,
        createdAt: raw.createdAt,
        ...(typeof raw.providerRequestId === "string"
          ? { providerRequestId: raw.providerRequestId }
          : {}),
      };
    }

    if (marker.state === "delivered") {
      if (marker.providerRequestId === undefined) {
        throw new OpsError("provider_error", "Delivered email marker has no provider request ID");
      }
      return marker.providerRequestId;
    }
    // Resend retains idempotency keys for 24 hours. Stop an old ambiguous
    // delivery before that window can expire; reviewed recovery must decide it.
    if (Date.now() - Date.parse(marker.createdAt) >= 23 * 60 * 60_000) {
      throw new OpsError("outcome_unknown", "Email delivery remains ambiguous beyond the provider idempotency window", {
        provider_request_id: marker.correlationId,
      });
    }

    const providerRequestId = await this.#sendResend(
      to,
      subject,
      text,
      marker.idempotencyKey,
    );
    const delivered: EmailDeliveryMarker = {
      ...marker,
      state: "delivered",
      providerRequestId,
    };
    await bindingMutation("R2", () => this.env.CONTROL_PLANE_OBJECTS.put(
      markerKey,
      JSON.stringify(delivered),
      { httpMetadata: { contentType: "application/json" } },
    ));
    return providerRequestId;
  }

  async #smtpSmoke(input: JsonRecord): Promise<unknown> {
    const smokeTestIds = stringArray(input, "smoke_test_ids");
    if (smokeTestIds.some(
      (id) => !(CANONICAL_SMOKE_TEST_IDS.email as readonly string[]).includes(id),
    )) {
      throw new OpsError("unsupported_contract", "Unknown SMTP smoke test ID");
    }
    const recipient = requireBinding(this.env.RESEND_SMOKE_RECIPIENT, "RESEND_SMOKE_RECIPIENT");
    const projectId = stringField(input, "project_id");
    const marker = `${this.env.RECOVERY_OBJECT_PREFIX}/smtp-smoke/${projectId}/${await sha256Hex(`${recipient}\n${[...smokeTestIds].sort().join("\n")}`)}.json`;
    const id = await this.#sendResendOnce(
      marker,
      recipient,
      "S26 SMTP smoke",
      `S26 fixed smoke checks: ${smokeTestIds.join(", ")}`,
    );
    return { providerRequestId: id };
  }

  /** True when some project in the approved team already holds this hostname. */
  async #vercelHostnameBoundInTeam(hostname: string): Promise<boolean> {
    const projects = await this.#vercel("/v9/projects?limit=100");
    const list = Array.isArray(projects.value.projects) ? projects.value.projects : [];
    for (const entry of list) {
      const name = stringField(record(entry, "Vercel project"), "name");
      try {
        await this.#vercel(
          `/v10/projects/${encodeURIComponent(name)}/domains/${encodeURIComponent(hostname)}`,
        );
        return true;
      } catch (error) {
        if (!(error instanceof OpsError) || error.code !== "provider_error" || error.details.status !== 404) throw error;
      }
    }
    return false;
  }

  /**
   * True when the hostname's own zone is a domain of the approved team.
   *
   * Ownership is decided by presence, and presence is read from the status
   * alone: 200 is the domain, 404 is "not in this account". Nothing is read out
   * of the body, so no response key is guessed, and any other refusal (401/403)
   * still throws attributably instead of passing as "not owned".
   */
  async #vercelZoneInAccount(zone: string): Promise<boolean> {
    try {
      await this.#vercel(`/v5/domains/${encodeURIComponent(zone)}`);
      return true;
    } catch (error) {
      if (!(error instanceof OpsError) || error.code !== "provider_error" || error.details.status !== 404) throw error;
      return false;
    }
  }

  async #domainInspect(input: JsonRecord): Promise<unknown> {
    const hostname = stringField(input, "hostname");
    const senderDomain = stringField(input, "sender_domain");
    if (senderDomain !== this.env.RESEND_SENDER_DOMAIN) {
      throw new OpsError("unsupported_contract", "Domain inspection sender is outside the fixed Resend profile");
    }
    // Availability is a question about this exact hostname, and only the
    // binding answers it. `GET /v6/domains/{host}/config` cannot: its
    // `configuredBy` is a DNS-configuration enum (`A`/`CNAME`/`dns-01`/`http`),
    // never an owner, so comparing it to a team ID could not once be true, and
    // its `misconfigured` reports whether DNS already resolves to Vercel — which
    // a subdomain that does not exist yet never does. The single-domain project
    // probe is the proven shape, and it is what decides both fields.
    const owned = await this.#vercelHostnameBoundInTeam(hostname);
    // The zone is a separate question from the hostname. Vercel operates the
    // *.vercel.app zone itself, so no account owns it and every name in it is
    // reachable; for a custom hostname the zone must be a domain of this
    // account, and Vercel then manages its DNS, so binding the subdomain creates
    // the record. The zone is the hostname's parent because the planner derives
    // the hostname as one slug label in front of the platform domain.
    const zoneOwned = hostname.endsWith(".vercel.app")
      || await this.#vercelZoneInAccount(parentZone(hostname));
    const resend = await this.#resend("/domains");
    const domains = Array.isArray(resend.value.data) ? resend.value.data : [];
    const sender = domains
      .map((entry) => record(entry, "Resend domain"))
      .find((entry) => entry.name === senderDomain);
    return {
      zoneOwned,
      hostnameAvailable: !owned,
      existingBindingOwned: owned,
      senderDomainVerified: sender?.status === "verified",
      legalReviewApproved: input.workspace_class === "disposable",
      validUntil: validUntil(),
    };
  }

  async #sourceInspect(input: JsonRecord): Promise<unknown> {
    const sha = stringField(input, "source_git_sha");
    const approvedSha = this.env.APPROVED_SOURCE_GIT_SHA;
    const releaseConfigured = configured(approvedSha)
      && /^[0-9a-f]{40}$/.test(approvedSha)
      && configured(this.env.RELEASE_COMPATIBILITY_ID)
      && configured(this.env.APPROVED_APPLICATION_VERSION);
    if (!releaseConfigured || sha !== approvedSha) {
      return { revisionPresent: false, releaseCompatible: false, artifactPinned: false, validUntil: validUntil() };
    }
    try {
      const response = await providerJson({ provider: "source-repository", url: `${this.env.SOURCE_REPOSITORY_API_BASE_URL}/repos/${encodeURIComponent(this.env.SOURCE_REPOSITORY_OWNER)}/${encodeURIComponent(this.env.SOURCE_REPOSITORY_NAME)}/commits/${sha}`, token: requireBinding(this.env.SOURCE_REPOSITORY_TOKEN, "SOURCE_REPOSITORY_TOKEN"), fetcher: this.#fetch });
      const present = response.value.sha === sha;
      return {
        revisionPresent: present,
        releaseCompatible: present
          && stringField(input, "compatibility_entry_id") === this.env.RELEASE_COMPATIBILITY_ID
          && stringField(input, "application_version") === this.env.APPROVED_APPLICATION_VERSION,
        artifactPinned: present,
        validUntil: validUntil(),
      };
    } catch (error) {
      if (error instanceof OpsError && error.code === "provider_error" && error.details.status === 404) {
        return { revisionPresent: false, releaseCompatible: false, artifactPinned: false, validUntil: validUntil() };
      }
      throw error;
    }
  }

  async #storeRecovery(capability: StoredRecoveryArtifact["capability"], sourceResourceId: string, ownershipMarkerDigest: string, payload: JsonRecord, artifactId = crypto.randomUUID()): Promise<StoredRecoveryArtifact> {
    const artifact: StoredRecoveryArtifact = { version: "s26-worker-recovery.v1", capability, artifactId, sourceResourceId, ownershipMarkerDigest, capturedAt: new Date().toISOString(), payload };
    await bindingMutation("R2", () => this.env.CONTROL_PLANE_OBJECTS.put(`${this.env.RECOVERY_OBJECT_PREFIX}/${capability}/${artifact.artifactId}.json`, JSON.stringify(artifact), { httpMetadata: { contentType: "application/json" } }));
    return artifact;
  }

  async #loadRecovery(capability: StoredRecoveryArtifact["capability"], input: JsonRecord): Promise<StoredRecoveryArtifact> {
    const artifactId = stringField(input, "artifact_id");
    const object = await this.env.CONTROL_PLANE_OBJECTS.get(`${this.env.RECOVERY_OBJECT_PREFIX}/${capability}/${artifactId}.json`);
    if (object === null) throw new OpsError("recovery_conflict", "Recovery artifact is absent");
    const raw = record(await object.json(), "recovery artifact");
    const storedCapability = stringField(raw, "capability");
    if (!isRecoveryCapability(storedCapability)) {
      throw new OpsError("recovery_conflict", "Recovery artifact capability is invalid");
    }
    const artifact: StoredRecoveryArtifact = {
      version: stringField(raw, "version") === "s26-worker-recovery.v1" ? "s26-worker-recovery.v1" : (() => { throw new OpsError("recovery_conflict", "Recovery artifact version is invalid"); })(),
      capability: storedCapability,
      artifactId: stringField(raw, "artifactId"),
      sourceResourceId: stringField(raw, "sourceResourceId"),
      ownershipMarkerDigest: stringField(raw, "ownershipMarkerDigest"),
      capturedAt: stringField(raw, "capturedAt"),
      payload: record(raw.payload, "recovery artifact payload"),
    };
    if (artifact.capability !== capability || artifact.artifactId !== artifactId || artifact.ownershipMarkerDigest !== input.ownership_marker_digest) {
      throw new OpsError("recovery_conflict", "Recovery artifact identity or ownership mismatch");
    }
    const digest = sha256Digest(canonicalJson(this.#artifactJson(artifact)));
    if (input.artifact_manifest_digest !== undefined && input.artifact_manifest_digest !== digest) {
      throw new OpsError("recovery_conflict", "Recovery artifact manifest digest mismatch");
    }
    return artifact;
  }

  async #artifactResponse(artifact: StoredRecoveryArtifact, coverage: readonly string[], providerRequestId: string, reconstructionApproved = false): Promise<unknown> {
    return { providerRequestId, artifactId: artifact.artifactId, manifestDigest: sha256Digest(canonicalJson(this.#artifactJson(artifact))), ownershipMarkerDigest: artifact.ownershipMarkerDigest, coverage, itemCount: Array.isArray(artifact.payload.objects) ? artifact.payload.objects.length : 1, capturedAt: artifact.capturedAt, reconstructionApproved };
  }

  #artifactJson(artifact: StoredRecoveryArtifact): JsonValue {
    return JSON.parse(JSON.stringify(artifact)) as JsonValue;
  }
}
