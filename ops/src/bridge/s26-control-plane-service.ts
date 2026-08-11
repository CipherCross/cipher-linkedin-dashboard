/**
 * Local implementation of the closed S26 bridge boundary.
 *
 * This is deliberately a request handler rather than a deployed listener. A
 * separately approved host may mount it later, but this module neither reads
 * configuration nor opens a socket nor contacts a provider. Provider
 * credentials belong solely to the injected server-side backend.
 */
import * as z from "zod/v4";

import { OpsError } from "../core/errors.js";
import { Redactor } from "../core/redaction.js";
import { HOSTING_RESULT_SCHEMAS } from "../providers/adapters.js";
import { parseS26BridgePath, type S26BridgeRoute } from "../providers/s26-bridge-contract.js";

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:@/-]+$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const workspaceClass = z.enum(["internal", "disposable", "external"]);
const action = z.strictObject({ providerRequestId: identifier });
const inspection = z.strictObject({
  organizationAccessible: z.boolean(), deterministicNameAvailable: z.boolean(),
  existingResourceOwned: z.boolean(), regionAvailable: z.boolean(), tierAvailable: z.boolean(),
  computeAvailable: z.boolean(), backupCompatible: z.boolean(), authConfigurationSupported: z.boolean(), validUntil: timestamp,
});
const identityInspection = z.strictObject({ templateSetApproved: z.boolean(), productionUrlsValid: z.boolean(), inviteFlowSupported: z.boolean(), releaseCompatible: z.boolean(), validUntil: timestamp });
const smtpInspection = z.strictObject({ providerAccessible: z.boolean(), customSmtp: z.boolean(), senderIdentityVerified: z.boolean(), credentialsAvailable: z.boolean(), validUntil: timestamp });
const domainInspection = z.strictObject({ zoneOwned: z.boolean(), hostnameAvailable: z.boolean(), existingBindingOwned: z.boolean(), senderDomainVerified: z.boolean(), legalReviewApproved: z.boolean(), validUntil: timestamp });
const sourceInspection = z.strictObject({ revisionPresent: z.boolean(), releaseCompatible: z.boolean(), artifactPinned: z.boolean(), validUntil: timestamp });
const recoveryArtifact = z.strictObject({
  providerRequestId: identifier, artifactId: identifier, manifestDigest: digest, ownershipMarkerDigest: digest,
  coverage: z.array(z.enum(["database_schema_data", "auth_configuration_identities", "storage_metadata", "private_storage_objects_or_reconstruction", "deployment_configuration_metadata"])).min(1),
  itemCount: z.number().int().nonnegative(), capturedAt: timestamp, reconstructionApproved: z.boolean(),
});
const recoveryVerification = z.strictObject({
  providerRequestId: identifier,
  coverage: z.array(z.enum(["database_schema_data", "auth_configuration_identities", "storage_metadata", "private_storage_objects_or_reconstruction", "deployment_configuration_metadata"])).min(1),
  passed: z.boolean(), checkedAt: timestamp,
});
const schedule = z.strictObject({ scheduleId: identifier, method: z.literal("GET"), routePath: z.string().min(1), queryParameters: z.record(z.string(), z.string()), expression: z.string().min(1), expressionFormat: z.literal("cron5"), timezone: z.literal("UTC") });
const hostingValueSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("secret_label"), secretLabel: identifier }),
  z.strictObject({ kind: z.literal("generated_secret"), generatorId: identifier }),
  z.strictObject({ kind: z.literal("derived_from_plan"), planFieldRef: identifier }),
  z.strictObject({ kind: z.literal("derived_from_owned_resource"), resourceRef: identifier }),
]);

const requestSchemas = {
  "data.inspect": z.strictObject({ organization_id: identifier, deterministic_name: z.string().min(1).max(200), region_id: identifier, tier_id: identifier, compute_id: identifier, backup_profile_id: identifier, ownership_marker_digest: digest }),
  "data.portable-schema-apply": z.strictObject({ project_id: identifier, baseline_version: z.literal(53), migration_versions: z.array(z.number().int().min(54)).min(1), target_schema_version: z.number().int().min(54) }),
  "data.smoke": z.strictObject({ project_id: identifier, smoke_test_ids: z.array(identifier).min(1) }),
  "objectStorage.smoke": z.strictObject({ project_id: identifier, smoke_test_ids: z.array(identifier).min(1), require_private_access_checks: z.literal(true) }),
  "identity.inspect": z.strictObject({ template_set_id: identifier, site_url: z.url(), redirect_urls: z.array(z.url()).min(1), release_compatibility_id: identifier }),
  "identity.configure": z.strictObject({ project_id: identifier, site_url: z.url(), redirect_urls: z.array(z.url()).min(1), template_set_id: identifier }),
  "identity.support-membership": z.strictObject({ project_id: identifier }),
  "identity.company-admin-invite": z.strictObject({ project_id: identifier, admin_email: z.email() }),
  "identity.smoke": z.strictObject({ project_id: identifier, smoke_test_ids: z.array(identifier).min(1) }),
  "smtp.inspect": z.strictObject({ smtp_profile_id: identifier, sender_domain: z.string().min(1).max(253), from_identity: z.email(), smtp_secret_labels: z.array(identifier).min(1) }),
  "smtp.configure": z.strictObject({ project_id: identifier, smtp_profile_id: identifier, sender_domain: z.string().min(1).max(253), from_identity: z.email(), smtp_secret_labels: z.array(identifier).min(1) }),
  "smtp.smoke": z.strictObject({ project_id: identifier, smoke_test_ids: z.array(identifier).min(1) }),
  "domain.inspect": z.strictObject({ hostname: z.string().min(1).max(253), sender_domain: z.string().min(1).max(253), workspace_class: workspaceClass }),
  "sourceRepository.inspect": z.strictObject({ source_git_sha: z.string().regex(/^[0-9a-f]{40}$/), compatibility_entry_id: identifier, application_version: identifier }),
  "hosting.inspect": z.strictObject({ deterministic_name: z.string().min(1).max(200), workspace_class: workspaceClass, runtime_profile_id: identifier, required_schedule_count: z.number().int().nonnegative(), required_server_value_count: z.number().int().nonnegative(), required_public_value_count: z.number().int().nonnegative(), ownership_marker_digest: digest }),
  "hosting.environment-bind": z.strictObject({
    target_handle: identifier,
    data_project_id: identifier,
    data_project_name: z.string().min(1).max(200),
    ownership_marker_digest: digest,
    scope: z.literal("production"),
    bindings: z.array(z.strictObject({
      name: z.string().min(1).max(120),
      value_class: z.enum(["server_secret", "server_public", "public_build"]),
      source_kind: z.enum(["secret_label", "generated_secret", "derived_from_plan", "derived_from_owned_resource"]),
      source: hostingValueSource,
    })).min(1),
  }),
  "hosting.build": z.strictObject({ target_handle: identifier, revision_id: z.string().regex(/^[0-9a-f]{40}$/), build_recipe_id: identifier, public_value_names: z.array(identifier), environment_binding_digest: digest, schedule_manifest_digest: digest }),
  "hosting.schedules": z.strictObject({ target_handle: identifier, release_handle: identifier, schedules: z.array(schedule), manifest_digest: digest }),
  "hosting.promote": z.strictObject({ target_handle: identifier, release_handle: identifier }),
  "hosting.rollback": z.strictObject({ target_handle: identifier, release_handle: identifier, superseded_release_handle: identifier, reason_code: identifier }),
  "hosting.verify": z.strictObject({ target_handle: identifier, expected_active_release_handle: identifier, expected_revision_id: z.string().regex(/^[0-9a-f]{40}$/), expected_hostname: z.string().min(1).max(253), expected_schedules: z.array(schedule), runtime_check_ids: z.array(identifier).min(1) }),
} as const;

const recoveryRequest = z.strictObject({ source_resource_id: identifier, tenant_slug: z.string().min(1).max(64), recovery_target_name: z.string().min(1).max(200), ownership_marker_digest: digest });
const restoreRequest = z.strictObject({ target_resource_id: identifier, tenant_slug: z.string().min(1).max(64), artifact_id: identifier, artifact_manifest_digest: digest, ownership_marker_digest: digest });
const verifyRequest = z.strictObject({ target_resource_id: identifier, tenant_slug: z.string().min(1).max(64), artifact_id: identifier, ownership_marker_digest: digest });

function schemaForRequest(route: S26BridgeRoute): z.ZodType<unknown> {
  if (route.operation === "recovery-capture") return recoveryRequest;
  if (route.operation === "recovery-restore") return restoreRequest;
  if (route.operation === "recovery-verify") return verifyRequest;
  const schema = requestSchemas[`${route.capability}.${route.operation}` as keyof typeof requestSchemas];
  if (!schema) throw new OpsError("unsupported_contract", "Bridge route has no request schema");
  return schema;
}

function schemaForResponse(route: S26BridgeRoute): z.ZodType<unknown> {
  if (route.operation === "recovery-capture") return recoveryArtifact;
  if (route.operation === "recovery-verify") return recoveryVerification;
  if (route.operation === "recovery-restore") return action;
  if (route.capability === "data" && route.operation === "inspect") return inspection;
  if (route.capability === "identity" && route.operation === "inspect") return identityInspection;
  if (route.capability === "smtp" && route.operation === "inspect") return smtpInspection;
  if (route.capability === "domain") return domainInspection;
  if (route.capability === "sourceRepository") return sourceInspection;
  if (route.capability === "hosting") {
    const method = {
      inspect: "inspect",
      "environment-bind": "bindEnvironment",
      build: "buildRelease",
      schedules: "registerSchedules",
      promote: "promoteRelease",
      rollback: "rollbackRelease",
      verify: "verifyDeployment",
    }[route.operation] as keyof typeof HOSTING_RESULT_SCHEMAS | undefined;
    if (!method) throw new OpsError("unsupported_contract", "Bridge route has no response schema");
    return HOSTING_RESULT_SCHEMAS[method];
  }
  return action;
}

export interface S26BridgeAuthorizer {
  /** Token comparison and bridge credential storage are server-side only. */
  authorize(bearerToken: string): Promise<boolean>;
}

export interface S26BridgeBackend {
  /** Named server-side operation; it never receives credentials, URLs, or raw HTTP. */
  invoke(route: S26BridgeRoute, request: unknown): Promise<unknown>;
}

export interface S26BridgeRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly body: unknown;
}

export interface S26BridgeResponse { readonly status: 200 | 400 | 401 | 404 | 409 | 502 | 503; readonly body: unknown; }

export class S26ControlPlaneBridgeService {
  constructor(
    private readonly authorizer: S26BridgeAuthorizer,
    private readonly backend: S26BridgeBackend,
    private readonly redactor = new Redactor(),
  ) {}

  async handle(request: S26BridgeRequest): Promise<S26BridgeResponse> {
    try {
      if (request.method !== "POST") return { status: 404, body: { code: "unsupported_route" } };
      const route = parseS26BridgePath(request.path);
      if (!route) return { status: 404, body: { code: "unsupported_route" } };
      const token = /^Bearer (.+)$/.exec(request.authorization ?? "")?.[1];
      if (!token || !(await this.authorizer.authorize(token))) return { status: 401, body: { code: "unauthorized" } };
      this.redactor.registerSecret(token);
      const input = schemaForRequest(route).parse(request.body);
      this.redactor.assertSecretFree(input, "bridge request");
      const output = schemaForResponse(route).parse(await this.backend.invoke(route, input));
      this.redactor.assertSecretFree(output, "bridge response");
      this.#verifyOwnership(input, output);
      return { status: 200, body: output };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { status: 400, body: { code: "schema_validation_failed" } };
      }
      const safe = this.redactor.sanitizeError(error);
      const status = safe.code === "outcome_unknown"
        ? 502
        : safe.code === "secret_input_required" || safe.code === "secret_store_error"
          ? 503
          : safe.code === "provider_error" || safe.code === "provider_readiness_blocked"
            ? 409
            : 400;
      // The upstream provider's numeric status travels with the code. Three
      // separate S26 failures cost a session each because a deterministic
      // refusal reached the operator as a bare bridge status with no way to tell
      // which provider had said what. A status is a number: it carries no scope,
      // credential, URL or payload, which is the same reasoning the client-side
      // transport already uses for its own `provider_status`.
      return {
        status,
        body: {
          code: safe.code,
          provider_request_id: typeof safe.details.provider_request_id === "string" ? safe.details.provider_request_id : undefined,
          ...(typeof safe.details.status === "number" ? { provider_status: safe.details.status } : {}),
        },
      };
    }
  }

  #verifyOwnership(input: unknown, output: unknown): void {
    if (typeof input !== "object" || input === null || typeof output !== "object" || output === null) return;
    const expected = (input as Record<string, unknown>).ownership_marker_digest;
    const observed = (output as Record<string, unknown>).ownershipMarkerDigest;
    if (typeof expected === "string" && typeof observed === "string" && expected !== observed) {
      throw new OpsError("provider_error", "Bridge ownership marker mismatch");
    }
  }
}
