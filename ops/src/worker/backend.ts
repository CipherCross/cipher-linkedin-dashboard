import { hashPassword } from "better-auth/crypto";
import { Pool, type PoolClient, type QueryResult } from "@neondatabase/serverless";

import { OpsError } from "../core/errors.js";
import { canonicalJson, sha256Digest, type JsonValue } from "../core/canonical.js";
import {
  CANONICAL_TENANT_ENVIRONMENT,
} from "../providers/hosting-tenant.js";
import { hostingEnvironmentBindingDigest } from "../providers/hosting.js";
import { neonOwnershipRoleName } from "../providers/neon-ownership.js";
import type { S26BridgeBackend } from "../bridge/s26-control-plane-service.js";
import type { S26BridgeRoute } from "../providers/s26-bridge-contract.js";
import { applyPinnedPortablePostgres, runPinnedPortableSmoke, runPinnedRestoreVerification } from "./pinned-postgres.js";

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

function observedCrons(value: JsonRecord): readonly { readonly path: string; readonly schedule: string }[] {
  if (!Array.isArray(value.crons)) return [];
  return value.crons.map((entry) => {
    const cron = record(entry, "Vercel cron");
    return { path: stringField(cron, "path"), schedule: stringField(cron, "schedule") };
  });
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

async function providerJson(input: {
  readonly provider: string;
  readonly url: string;
  readonly token: string;
  readonly method?: "GET" | "POST" | "PATCH";
  readonly body?: JsonRecord;
  readonly fetcher?: typeof fetch;
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
    const allowed = new Set(["schema", "auth", "rls", "storage", "api", "cron", "preview-isolation", "smtp"]);
    if (stringArray(input, "smoke_test_ids").some((id) => !allowed.has(id))) {
      throw new OpsError("unsupported_contract", "Unknown smoke test ID");
    }
    await runPinnedPortableSmoke(await this.#ownerConnectionUri(stringField(input, "project_id")));
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
      "SELECT to_regclass('identity.\"user\"') IS NOT NULL AS configured",
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
    await databaseMutation(
      await this.#ownerConnectionUri(stringField(input, "project_id")),
      statement,
    );
    // The generated bootstrap password is deliberately discarded. The approved
    // application-hosted Better Auth reset flow is the only way to set one.
    await this.#sendResend(
      email,
      "Your CipherCross dashboard invitation",
      `Open ${this.env.BETTER_AUTH_BASE_URL}/#/reset-password and request a password-reset link for this address.`,
    );
    return { providerRequestId: crypto.randomUUID() };
  }

  async #identitySmoke(input: JsonRecord): Promise<unknown> {
    const result = await databaseQuery(
      await this.#ownerConnectionUri(stringField(input, "project_id")),
      "SELECT to_regclass('identity.\"user\"') IS NOT NULL AS identity_store, to_regprocedure('public.identity_admin_invite_member_atomic(text,text,text,text,text,text)') IS NOT NULL AS invite_path",
    );
    const rows = result.rows;
    if (rows[0]?.identity_store !== true || rows[0]?.invite_path !== true) {
      throw new OpsError("provider_error", "Better Auth database surface is incomplete");
    }
    return { providerRequestId: crypto.randomUUID() };
  }

  async #objectSmoke(input: JsonRecord): Promise<unknown> {
    if (input.require_private_access_checks !== true) throw new OpsError("unsupported_contract", "Private object checks are required");
    const key = `${this.env.RECOVERY_OBJECT_PREFIX}/smoke/${stringField(input, "project_id")}/${crypto.randomUUID()}`;
    await bindingMutation("R2", () => this.env.CONTROL_PLANE_OBJECTS.put(key, new Uint8Array([0x53, 0x32, 0x36])));
    const observed = await this.env.CONTROL_PLANE_OBJECTS.get(key);
    await bindingMutation("R2", () => this.env.CONTROL_PLANE_OBJECTS.delete(key));
    if (observed === null) throw new OpsError("provider_error", "R2 binding smoke check failed");
    return { providerRequestId: crypto.randomUUID() };
  }

  async #objectRecoveryCapture(input: JsonRecord): Promise<unknown> {
    const source = stringField(input, "source_resource_id");
    const listed = await this.env.CONTROL_PLANE_OBJECTS.list({ prefix: `tenant/${source}/`, limit: 1000 });
    if (listed.truncated) throw new OpsError("provider_error", "R2 recovery inventory exceeded the fixed object limit");
    const totalBytes = listed.objects.reduce((sum, object) => sum + object.size, 0);
    if (totalBytes > 100 * 1024 * 1024) {
      throw new OpsError("provider_error", "R2 recovery inventory exceeded the fixed byte limit");
    }
    const artifactId = crypto.randomUUID();
    const objects: Array<Record<string, unknown>> = [];
    for (const [index, listedObject] of listed.objects.entries()) {
      const sourceObject = await this.env.CONTROL_PLANE_OBJECTS.get(listedObject.key);
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
      await bindingMutation("R2", () => this.env.CONTROL_PLANE_OBJECTS.put(`tenant/${target}/${suffix}`, source.body, options));
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
      const restored = await this.env.CONTROL_PLANE_OBJECTS.head(`tenant/${target}/${sourceKey.slice(sourcePrefix.length)}`);
      if (restored === null || restored.size !== numberField(object, "size")) {
        passed = false;
        break;
      }
    }
    const listed = await this.env.CONTROL_PLANE_OBJECTS.list({ prefix: `tenant/${target}/`, limit: 1000 });
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
    const existingByName = new Map(
      existingValues.map((entry) => {
        const current = record(entry, "Vercel environment entry");
        return [stringField(current, "key"), current] as const;
      }),
    );
    let lastRequestId = existingResponse.id;
    const resultBindings: Array<{ name: string; valueClass: string; sourceKind: string }> = [];
    for (const descriptor of descriptors) {
      const name = stringField(descriptor, "name");
      const valueClass = stringField(descriptor, "value_class");
      const sourceKind = stringField(descriptor, "source_kind");
      const approved = this.#hostingValue(name, applicationConnectionUris, generatedValue);
      const current = existingByName.get(name);
      const body = {
        key: name,
        value: approved.value,
        type: valueClass === "server_secret" ? "sensitive" : "encrypted",
        target: ["production"],
      };
      const response = current === undefined
        ? await this.#vercel(`/v10/projects/${encodeURIComponent(target)}/env`, "POST", body)
        : await this.#vercel(`/v9/projects/${encodeURIComponent(target)}/env/${encodeURIComponent(stringField(current, "id"))}`, "PATCH", body);
      lastRequestId = response.id;
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
    if (scheduleDigest !== requireConfigured(this.env.APPROVED_SCHEDULE_MANIFEST_DIGEST, "APPROVED_SCHEDULE_MANIFEST_DIGEST")) {
      throw new OpsError("provider_snapshot_drift", "Vercel schedule manifest digest is not approved");
    }
    const response = await this.#vercel("/v13/deployments", "POST", {
      name: stringField(input, "target_handle"),
      project: stringField(input, "target_handle"),
      gitSource: { type: "github", repo: `${this.env.SOURCE_REPOSITORY_OWNER}/${this.env.SOURCE_REPOSITORY_NAME}`, ref: revision },
    });
    const release = stringField(response.value, "id");
    const deployment = await this.#waitForDeployment(release, response.id);
    const gitSource = record(deployment.value.gitSource, "Vercel deployment git source");
    const observedRevision = gitSource.sha ?? gitSource.ref;
    if (observedRevision !== revision) {
      throw new OpsError("provider_snapshot_drift", "Vercel built a revision other than the approved pinned SHA");
    }
    return { hostingRequestId: deployment.id, releaseHandle: release, targetHandle: stringField(input, "target_handle"), revisionId: revision, revisionPinned: true, buildRecipeId: buildRecipe, publicValueNames: publicNames, environmentBindingDigest, scheduleManifestDigest: scheduleDigest, artifactDigest: sha256Digest(canonicalJson({ release, revision, environment_binding_digest: environmentBindingDigest })), status: "verified" };
  }

  async #hostingSchedules(input: JsonRecord): Promise<unknown> {
    const release = stringField(input, "release_handle");
    const deployment = await this.#vercel(`/v13/deployments/${encodeURIComponent(release)}`);
    const expected = expectedCrons(input);
    const manifestDigest = stringField(input, "manifest_digest");
    if (
      scheduleManifestDigestOf(expected) !== manifestDigest
      || manifestDigest !== requireConfigured(this.env.APPROVED_SCHEDULE_MANIFEST_DIGEST, "APPROVED_SCHEDULE_MANIFEST_DIGEST")
    ) {
      throw new OpsError("provider_snapshot_drift", "Vercel schedule manifest digest is not the fixed approved set");
    }
    if (!cronsMatch(expected, observedCrons(deployment.value))) {
      throw new OpsError("provider_error", "Vercel deployment cron manifest does not match the fixed schedule set");
    }
    return { hostingRequestId: deployment.id, targetHandle: stringField(input, "target_handle"), releaseHandle: release, registered: input.schedules, manifestDigest };
  }

  async #waitForDeployment(release: string, createRequestId: string): Promise<{ readonly id: string; readonly value: JsonRecord }> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const deployment = await this.#vercel(`/v13/deployments/${encodeURIComponent(release)}`);
      if (deployment.value.readyState === "READY") return deployment;
      if (deployment.value.readyState === "ERROR" || deployment.value.readyState === "CANCELED") {
        throw new OpsError("provider_error", "Vercel deployment did not reach READY", {
          provider_request_id: deployment.id,
        });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    throw new OpsError("outcome_unknown", "Vercel deployment readiness outcome is unknown", {
      provider_request_id: createRequestId,
    });
  }

  async #hostingRollout(input: JsonRecord, kind: "promote" | "rollback"): Promise<unknown> {
    const target = stringField(input, "target_handle");
    const active = stringField(input, "release_handle");
    const project = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}`);
    const previous = kind === "promote"
      ? this.#latestDeploymentId(project.value)
      : stringField(input, "superseded_release_handle");
    const response = await this.#vercel(`/v13/deployments/${encodeURIComponent(active)}/promote`, "POST", { projectId: target });
    return { hostingRequestId: response.id, targetHandle: target, rolloutHandle: response.id, rolloutKind: kind, activeReleaseHandle: active, previousReleaseHandle: previous, rolloutSequence: Date.now(), reasonCode: kind === "rollback" ? stringField(input, "reason_code") : null };
  }

  #latestDeploymentId(project: JsonRecord): string | null {
    if (typeof project.latestDeploymentId === "string") return project.latestDeploymentId;
    if (!Array.isArray(project.latestDeployments) || project.latestDeployments.length === 0) return null;
    const latest = record(project.latestDeployments[0], "Vercel latest deployment");
    return typeof latest.id === "string" ? latest.id : null;
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

  async #hostingVerify(input: JsonRecord): Promise<unknown> {
    const target = stringField(input, "target_handle");
    const expected = stringField(input, "expected_active_release_handle");
    const response = await this.#vercel(`/v13/deployments/${encodeURIComponent(expected)}`);
    const project = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}`);
    const environment = await this.#vercel(`/v9/projects/${encodeURIComponent(target)}/env`);
    const ready = response.value.readyState === "READY";
    const expectedScheduleSet = expectedCrons(input);
    const providerCrons = observedCrons(response.value);
    const schedulesMatch = cronsMatch(expectedScheduleSet, providerCrons);
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
    const aliases = Array.isArray(response.value.alias)
      ? response.value.alias.filter((entry): entry is string => typeof entry === "string")
      : [];
    const domainMatches = aliases.includes(expectedHostname);
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
        assigned: domainMatches,
        certificateReady: domainMatches && ready,
        matchesExpected: domainMatches,
        servesActiveRelease: domainMatches && activeMatches,
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

  async #resend(path: string, method: "GET" | "POST" = "GET", body?: JsonRecord) {
    return providerJson({ provider: "resend", url: `${this.env.RESEND_API_BASE_URL}${path}`, token: requireBinding(this.env.RESEND_API_KEY, "RESEND_API_KEY"), method, fetcher: this.#fetch, ...(body === undefined ? {} : { body }) });
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

  async #sendResend(to: string, subject: string, text: string): Promise<string> {
    const response = await this.#resend("/emails", "POST", { from: this.env.RESEND_FROM_IDENTITY, to: [to], subject, text });
    return response.id;
  }

  async #smtpSmoke(input: JsonRecord): Promise<unknown> {
    const id = await this.#sendResend(requireBinding(this.env.RESEND_SMOKE_RECIPIENT, "RESEND_SMOKE_RECIPIENT"), "S26 SMTP smoke", `S26 fixed smoke checks: ${stringArray(input, "smoke_test_ids").join(", ")}`);
    return { providerRequestId: id };
  }

  async #domainInspect(input: JsonRecord): Promise<unknown> {
    const hostname = stringField(input, "hostname");
    const senderDomain = stringField(input, "sender_domain");
    if (senderDomain !== this.env.RESEND_SENDER_DOMAIN) {
      throw new OpsError("unsupported_contract", "Domain inspection sender is outside the fixed Resend profile");
    }
    // A hostname that no project has claimed yet has no domain config at all,
    // and Vercel answers 404. That is the expected pre-provisioning state for a
    // new tenant, not a provider failure: the name is simply still available.
    let config: JsonRecord | null = null;
    try { config = (await this.#vercel(`/v6/domains/${encodeURIComponent(hostname)}/config`)).value; } catch (error) {
      if (!(error instanceof OpsError) || error.code !== "provider_error" || error.details.status !== 404) throw error;
    }
    const response = { value: config ?? { misconfigured: false, configuredBy: null } };
    const resend = await this.#resend("/domains");
    const domains = Array.isArray(resend.value.data) ? resend.value.data : [];
    const sender = domains
      .map((entry) => record(entry, "Resend domain"))
      .find((entry) => entry.name === senderDomain);
    return { zoneOwned: response.value.misconfigured !== true, hostnameAvailable: response.value.configuredBy === null || response.value.configuredBy === undefined, existingBindingOwned: config !== null && response.value.configuredBy === this.env.VERCEL_TEAM_ID, senderDomainVerified: sender?.status === "verified", legalReviewApproved: input.workspace_class === "disposable", validUntil: validUntil() };
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
