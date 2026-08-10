import { describe, expect, it, vi } from "vitest";
import { env, SELF } from "cloudflare:test";

import { OpsError } from "../src/core/errors.js";
import type { S26BridgeBackend } from "../src/bridge/s26-control-plane-service.js";
import { S26WorkerBackend } from "../src/worker/backend.js";
import { handleS26WorkerRequest, s26WorkerRequestLog } from "../src/worker/index.js";

const BRIDGE_SECRET = "worker-test-bridge-secret";
const OWNERSHIP = `sha256:${"a".repeat(64)}`;
const DATA_PROJECT_NAME = "lh2-disposable-disposable-lab";

function envWith(values: Readonly<Record<string, string>>): Env {
  const derived: Env = Object.create(env);
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(derived, name, { configurable: true, enumerable: true, value });
  }
  return derived;
}

function providerResponse(status: number, body: unknown, requestId = "worker-provider-request"): Response {
  return Response.json(body, { status, headers: { "x-request-id": requestId } });
}

const environmentContext = {
  target_handle: "target-1",
  data_project_id: "project-1",
  data_project_name: DATA_PROJECT_NAME,
  ownership_marker_digest: OWNERSHIP,
  scope: "production",
} as const;

function request(
  path: string,
  body: unknown,
  options: { readonly method?: string; readonly token?: string; readonly rawBody?: string } = {},
): Request {
  return new Request(`https://lh2-s26-control-plane.example${path}`, {
    method: options.method ?? "POST",
    headers: {
      authorization: `Bearer ${options.token ?? BRIDGE_SECRET}`,
      "content-type": "application/json",
    },
    body: options.method === "GET" ? undefined : options.rawBody ?? JSON.stringify(body),
  });
}

function backendReturning(value: unknown): S26BridgeBackend {
  return { invoke: vi.fn(async () => value) };
}

async function handle(input: Request, backend: S26BridgeBackend, bearerSecret = BRIDGE_SECRET) {
  return handleS26WorkerRequest(input, {
    bearerSecret,
    backend,
    redactorSecrets: ["worker-test-provider-secret"],
  });
}

describe("S26 Worker HTTP boundary", () => {
  it("authenticates the one bearer binding before reading or invoking", async () => {
    const backend = backendReturning({ providerRequestId: "request-1" });
    const missing = request("/s26/control-plane/v1/data/smoke", {}, { token: "" });
    missing.headers.delete("authorization");
    expect((await handle(missing, backend)).status).toBe(401);
    expect((await handle(request("/s26/control-plane/v1/data/smoke", {}, { token: "wrong" }), backend)).status).toBe(401);
    expect(backend.invoke).not.toHaveBeenCalled();

    const absentBinding = await handle(
      request("/s26/control-plane/v1/data/smoke", {}),
      backend,
      "",
    );
    expect(absentBinding.status).toBe(503);
    await expect(absentBinding.json()).resolves.toEqual({ code: "secret_input_required" });
  });

  it("accepts only POST on the closed named-route vocabulary", async () => {
    const backend = backendReturning({ providerRequestId: "request-1" });
    expect((await handle(request("/s26/control-plane/v1/raw-http/get", {}), backend)).status).toBe(404);
    expect((await handle(request("/s26/control-plane/v1/data/delete", {}), backend)).status).toBe(404);
    expect((await handle(request("/s26/control-plane/v1/data/smoke", {}, { method: "GET" }), backend)).status).toBe(404);
    expect(backend.invoke).not.toHaveBeenCalled();
  });

  it("rejects bodies above the fixed 64 KiB limit", async () => {
    const backend = backendReturning({ providerRequestId: "request-1" });
    const response = await handle(
      request("/s26/control-plane/v1/data/smoke", {}, { rawBody: JSON.stringify({ value: "x".repeat(70_000) }) }),
      backend,
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ code: "body_too_large" });
    expect(backend.invoke).not.toHaveBeenCalled();
  });

  it("rejects schema additions and invokes a valid fixed route", async () => {
    const backend = backendReturning({ providerRequestId: "request-1" });
    const invalid = await handle(
      request("/s26/control-plane/v1/data/portable-schema-apply", {
        project_id: "project-1",
        baseline_version: 53,
        migration_versions: [54],
        target_schema_version: 54,
        sql: "select 1",
      }),
      backend,
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ code: "schema_validation_failed" });

    const valid = await handle(
      request("/s26/control-plane/v1/data/portable-schema-apply", {
        project_id: "project-1",
        baseline_version: 53,
        migration_versions: [54],
        target_schema_version: 54,
      }),
      backend,
    );
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toEqual({ providerRequestId: "request-1" });
    expect(backend.invoke).toHaveBeenCalledOnce();
  });

  it("rejects foreign ownership evidence", async () => {
    const backend = backendReturning({
      providerRequestId: "request-2",
      artifactId: "artifact-1",
      manifestDigest: OWNERSHIP,
      ownershipMarkerDigest: `sha256:${"b".repeat(64)}`,
      coverage: ["database_schema_data"],
      itemCount: 1,
      capturedAt: "2030-01-01T00:00:00.000Z",
      reconstructionApproved: false,
    });
    const response = await handle(
      request("/s26/control-plane/v1/data/recovery-capture", {
        source_resource_id: "source-1",
        tenant_slug: "disposable-lab",
        recovery_target_name: "recovery-1",
        ownership_marker_digest: OWNERSHIP,
      }),
      backend,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ code: "provider_error" });
  });

  it("fails closed for missing backend configuration", async () => {
    const backend: S26BridgeBackend = {
      async invoke() {
        throw new OpsError("secret_input_required", "Required Worker binding is not installed");
      },
    };
    const response = await handle(
      request("/s26/control-plane/v1/data/smoke", {
        project_id: "project-1",
        smoke_test_ids: ["schema"],
      }),
      backend,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "secret_input_required" });
  });

  it("redacts failures and preserves only an opaque ID for outcome_unknown", async () => {
    const backend: S26BridgeBackend = {
      async invoke() {
        throw new OpsError(
          "outcome_unknown",
          "provider failed with worker-test-provider-secret",
          { provider_request_id: "opaque-request-1", token: "worker-test-provider-secret" },
        );
      },
    };
    const response = await handle(
      request("/s26/control-plane/v1/data/smoke", {
        project_id: "project-1",
        smoke_test_ids: ["schema"],
      }),
      backend,
    );
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      code: "outcome_unknown",
      provider_request_id: "opaque-request-1",
    });
    expect(text).not.toContain(BRIDGE_SECRET);
    expect(text).not.toContain("worker-test-provider-secret");
  });
});

describe("S26 Worker lifecycle configuration", () => {
  it("starts and serves identity preflight without any apply-time tenant secret", async () => {
    const response = await SELF.fetch("https://lh2-s26-control-plane.example/s26/control-plane/v1/identity/inspect", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.BRIDGE_BEARER_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        template_set_id: "worker-test-only",
        site_url: "https://disposable.example.test",
        redirect_urls: ["https://disposable.example.test/auth/callback"],
        release_compatibility_id: "worker-test-only",
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      templateSetApproved: true,
      productionUrlsValid: true,
      inviteFlowSupported: true,
      releaseCompatible: true,
    });
  });

  it("blocks an absent owner-approved SHA and a missing remote SHA", async () => {
    const uncalledFetch = vi.fn<typeof fetch>();
    const absent = await new S26WorkerBackend(env, { fetch: uncalledFetch }).invoke(
      { capability: "sourceRepository", operation: "inspect" },
      { source_git_sha: "c".repeat(40), compatibility_entry_id: "worker-test-only", application_version: "worker-test-only" },
    );
    expect(absent).toMatchObject({ revisionPresent: false, releaseCompatible: false, artifactPinned: false });
    expect(uncalledFetch).not.toHaveBeenCalled();

    const sha = "c".repeat(40);
    const missingFetch = vi.fn<typeof fetch>(async () => providerResponse(404, { message: "not found" }));
    const missing = await new S26WorkerBackend(envWith({ APPROVED_SOURCE_GIT_SHA: sha }), { fetch: missingFetch }).invoke(
      { capability: "sourceRepository", operation: "inspect" },
      { source_git_sha: sha, compatibility_entry_id: "worker-test-only", application_version: "worker-test-only" },
    );
    expect(missing).toMatchObject({ revisionPresent: false, releaseCompatible: false, artifactPinned: false });
    expect(missingFetch).toHaveBeenCalledOnce();
  });

  it("blocks unavailable official data API credentials without fabricating a value", async () => {
    const inspectionFetch = vi.fn<typeof fetch>(async () => providerResponse(200, { projects: [] }));
    const inspection = await new S26WorkerBackend(env, { fetch: inspectionFetch }).invoke(
      { capability: "data", operation: "inspect" },
      {
        organization_id: env.NEON_ORGANIZATION_ID,
        deterministic_name: DATA_PROJECT_NAME,
        region_id: "worker-test-only",
        tier_id: "worker-test-only",
        compute_id: "worker-test-only",
        backup_profile_id: "worker-test-only",
        ownership_marker_digest: OWNERSHIP,
      },
    );
    expect(inspection).toMatchObject({ authConfigurationSupported: false });

    const fetcher = vi.fn<typeof fetch>();
    const backend = new S26WorkerBackend(env, { fetch: fetcher });
    const response = await handle(
      request("/s26/control-plane/v1/hosting/environment-bind", {
        ...environmentContext,
        bindings: [{ name: "PUBLIC_DATA_API_KEY", value_class: "public_build", source_kind: "secret_label" }],
      }),
      backend,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ code: "provider_readiness_blocked" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses only the closed apply allowlist and rejects foreign ownership", async () => {
    const unknown = await handle(
      request("/s26/control-plane/v1/hosting/environment-bind", {
        ...environmentContext,
        bindings: [{ name: "CALLER_CHOSEN_SECRET", value_class: "server_secret", source_kind: "generated_secret" }],
      }),
      new S26WorkerBackend(env, { fetch: vi.fn<typeof fetch>() }),
    );
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toEqual({ code: "unsupported_contract" });

    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname === "console.neon.tech" && url.pathname.endsWith("/projects/project-1")) {
        return providerResponse(200, { project: { id: "project-1", name: DATA_PROJECT_NAME, org_id: "foreign-org" } });
      }
      return providerResponse(500, {});
    });
    const foreign = await handle(
      request("/s26/control-plane/v1/hosting/environment-bind", {
        ...environmentContext,
        bindings: [{ name: "APP_BASE_URL", value_class: "server_public", source_kind: "derived_from_plan" }],
      }),
      new S26WorkerBackend(env, { fetch: fetcher }),
    );
    expect(foreign.status).toBe(409);
    await expect(foreign.json()).resolves.toEqual({ code: "provider_error" });
  });

  it("keeps generated and derived values out of output, errors, logs, recovery, and audit-shaped results", async () => {
    const databaseCanary = "postgresql://app_runtime:db-canary@ep.example.invalid/neondb";
    const generatedCanaries = [
      "generated-auth-canary",
      "generated-schedule-canary",
      "generated-ingest-canary",
      "generated-tool-canary",
    ];
    let generatedIndex = 0;
    const written: Array<Record<string, unknown>> = [];
    const environmentEntries: Array<Record<string, unknown>> = [
      { id: "ownership", key: "LH2_OWNERSHIP_MARKER_DIGEST", value: OWNERSHIP, type: "plain", target: ["production"] },
    ];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const method = init?.method ?? "GET";
      if (url.hostname === "console.neon.tech" && url.pathname.endsWith("/projects/project-1")) {
        return providerResponse(200, { project: { id: "project-1", name: DATA_PROJECT_NAME, org_id: env.NEON_ORGANIZATION_ID } });
      }
      if (url.hostname === "console.neon.tech" && url.pathname.endsWith("/projects/project-1/connection_uri")) {
        expect(url.searchParams.get("role_name")).toBe("app_runtime");
        return providerResponse(200, { uri: databaseCanary });
      }
      if (url.hostname === "api.vercel.com" && url.pathname.endsWith("/projects/target-1") && method === "GET") {
        return providerResponse(200, { id: "target-1", latestDeploymentId: "deployment-1" });
      }
      if (url.hostname === "api.vercel.com" && url.pathname.endsWith("/projects/target-1/env") && method === "GET") {
        return providerResponse(200, { envs: environmentEntries });
      }
      if (url.hostname === "api.vercel.com" && url.pathname.endsWith("/projects/target-1/env") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        written.push(body);
        environmentEntries.push({ id: `env-${written.length}`, ...body });
        return providerResponse(200, { id: `env-${written.length}` }, `vercel-write-${written.length}`);
      }
      return providerResponse(500, {}, "unexpected-route");
    });
    const backend = new S26WorkerBackend(env, {
      fetch: fetcher,
      generateSecret: () => generatedCanaries[generatedIndex++]!,
    });
    const bindings = [
      { name: "DATABASE_URL", value_class: "server_secret", source_kind: "derived_from_owned_resource" },
      { name: "AUTH_SESSION_SECRET", value_class: "server_secret", source_kind: "generated_secret" },
      { name: "SCHEDULE_INVOKE_SECRET", value_class: "server_secret", source_kind: "generated_secret" },
      { name: "CRON_SECRET", value_class: "server_secret", source_kind: "generated_secret" },
      { name: "INGEST_INVOKE_SECRET", value_class: "server_secret", source_kind: "generated_secret" },
      { name: "NOTIFY_SECRET", value_class: "server_secret", source_kind: "generated_secret" },
      { name: "TOOL_BRIDGE_SECRET", value_class: "server_secret", source_kind: "generated_secret" },
      { name: "MCP_SECRET", value_class: "server_secret", source_kind: "generated_secret" },
      { name: "APP_BASE_URL", value_class: "server_public", source_kind: "derived_from_plan" },
    ];
    const applyRequest = request("/s26/control-plane/v1/hosting/environment-bind", {
      ...environmentContext,
      bindings,
    });
    const applied = await handle(applyRequest, backend);
    expect(applied.status).toBe(200);
    const appliedText = await applied.text();
    expect(written).toHaveLength(bindings.length);
    expect(written.find((entry) => entry.key === "DATABASE_URL")?.value).toBe(databaseCanary);
    expect(written.find((entry) => entry.key === "AUTH_SESSION_SECRET")?.value).toBe(generatedCanaries[0]);
    expect(written.find((entry) => entry.key === "SCHEDULE_INVOKE_SECRET")?.value).toBe(written.find((entry) => entry.key === "CRON_SECRET")?.value);
    expect(written.find((entry) => entry.key === "INGEST_INVOKE_SECRET")?.value).toBe(written.find((entry) => entry.key === "NOTIFY_SECRET")?.value);
    expect(written.find((entry) => entry.key === "TOOL_BRIDGE_SECRET")?.value).toBe(written.find((entry) => entry.key === "MCP_SECRET")?.value);

    const logText = JSON.stringify(s26WorkerRequestLog(applyRequest, applied));
    const recovery = await backend.invoke(
      { capability: "hosting", operation: "recovery-capture" },
      { source_resource_id: "target-1", tenant_slug: "disposable-lab", recovery_target_name: "recovery-1", ownership_marker_digest: OWNERSHIP },
    );
    const recoveryJson = JSON.parse(JSON.stringify(recovery)) as { artifactId: string };
    const stored = await env.CONTROL_PLANE_OBJECTS.get(`s26-control-plane/recovery/v1/hosting/${recoveryJson.artifactId}.json`);
    expect(stored).not.toBeNull();
    const storedText = await stored!.text();
    for (const canary of [databaseCanary, ...generatedCanaries]) {
      expect(appliedText).not.toContain(canary);
      expect(logText).not.toContain(canary);
      expect(JSON.stringify(recovery)).not.toContain(canary);
      expect(storedText).not.toContain(canary);
    }
    expect(storedText).not.toContain("\"value\"");

    const failedFetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const method = init?.method ?? "GET";
      if (url.hostname === "console.neon.tech" && url.pathname.endsWith("/projects/project-1")) {
        return providerResponse(200, { project: { id: "project-1", name: DATA_PROJECT_NAME, org_id: env.NEON_ORGANIZATION_ID } });
      }
      if (url.hostname === "console.neon.tech" && url.pathname.endsWith("/projects/project-1/connection_uri")) {
        return providerResponse(200, { uri: databaseCanary });
      }
      if (url.hostname === "api.vercel.com" && url.pathname.endsWith("/projects/target-1") && method === "GET") {
        return providerResponse(200, { id: "target-1" });
      }
      if (url.hostname === "api.vercel.com" && url.pathname.endsWith("/projects/target-1/env") && method === "GET") {
        return providerResponse(200, { envs: [{ id: "ownership", key: "LH2_OWNERSHIP_MARKER_DIGEST", value: OWNERSHIP }] });
      }
      return providerResponse(503, {}, "opaque-vercel-request");
    });
    const failed = await handle(
      request("/s26/control-plane/v1/hosting/environment-bind", {
        ...environmentContext,
        bindings: [{ name: "AUTH_SESSION_SECRET", value_class: "server_secret", source_kind: "generated_secret" }],
      }),
      new S26WorkerBackend(env, { fetch: failedFetcher, generateSecret: () => generatedCanaries[0]! }),
    );
    const failedText = await failed.text();
    expect(failed.status).toBe(502);
    expect(JSON.parse(failedText)).toEqual({ code: "outcome_unknown", provider_request_id: "opaque-vercel-request" });
    expect(failedText).not.toContain(generatedCanaries[0]!);
    expect(failedText).not.toContain(databaseCanary);
  });
});
