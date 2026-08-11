import { describe, expect, it, vi } from "vitest";
import { env, SELF } from "cloudflare:test";

import { OpsError } from "../src/core/errors.js";
import { canonicalJson, sha256Digest } from "../src/core/canonical.js";
import type { S26BridgeBackend } from "../src/bridge/s26-control-plane-service.js";
import { CANONICAL_SMOKE_TEST_IDS } from "../src/core/smoke-tests.js";
import { CANONICAL_TENANT_ENVIRONMENT } from "../src/providers/hosting-tenant.js";
import {
  CANONICAL_TENANT_SCHEDULES,
  hostingEnvironmentBindingDigest,
  scheduleManifestDigest,
} from "../src/providers/hosting.js";
import { S26WorkerBackend } from "../src/worker/backend.js";
import {
  CONTROL_PLANE_ROLES,
  bootstrapArtifactsToApply,
  readBootstrapState,
} from "../src/worker/pinned-postgres.js";
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const environmentContext = {
  target_handle: "target-1",
  data_project_id: "project-1",
  data_project_name: DATA_PROJECT_NAME,
  ownership_marker_digest: OWNERSHIP,
  scope: "production",
} as const;

function closedEnvironmentBindings() {
  return CANONICAL_TENANT_ENVIRONMENT.map((entry) => ({
    name: entry.name,
    value_class: entry.valueClass,
    source_kind: entry.source.kind,
    source: entry.source,
  }));
}

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
    const absent = await new S26WorkerBackend(envWith({ APPROVED_SOURCE_GIT_SHA: "" }), { fetch: uncalledFetch }).invoke(
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

  it("blocks application binding while the closed data-plane readiness selection is false", async () => {
    const blockedEnv = envWith({ S26_APPLICATION_DATA_PLANE_READY: "false" });
    const inspectionFetch = vi.fn<typeof fetch>(async () => providerResponse(200, { projects: [] }));
    const inspection = await new S26WorkerBackend(blockedEnv, { fetch: inspectionFetch }).invoke(
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
    const backend = new S26WorkerBackend(blockedEnv, { fetch: fetcher });
    const response = await handle(
      request("/s26/control-plane/v1/hosting/environment-bind", {
        ...environmentContext,
        bindings: closedEnvironmentBindings(),
      }),
      backend,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ code: "provider_readiness_blocked" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports the reviewed application data plane only for the closed readiness selection", async () => {
    const inspectionFetch = vi.fn<typeof fetch>(async () => providerResponse(200, { projects: [] }));
    const inspection = await new S26WorkerBackend(
      envWith({ S26_APPLICATION_DATA_PLANE_READY: "true" }),
      { fetch: inspectionFetch },
    ).invoke(
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
    expect(inspection).toMatchObject({ authConfigurationSupported: true });
    expect(inspectionFetch).toHaveBeenCalledOnce();
  });

  it("uses only the closed apply allowlist and rejects foreign ownership", async () => {
    const unknown = await handle(
      request("/s26/control-plane/v1/hosting/environment-bind", {
        ...environmentContext,
        bindings: [{
          name: "CALLER_CHOSEN_SECRET",
          value_class: "server_secret",
          source_kind: "generated_secret",
          source: { kind: "generated_secret", generatorId: "caller.chosen" },
        }],
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
        bindings: closedEnvironmentBindings(),
      }),
      new S26WorkerBackend(envWith({ S26_APPLICATION_DATA_PLANE_READY: "true" }), { fetch: fetcher }),
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
        expect(["app_runtime", "app_system", "app_machine", "identity_store"]).toContain(url.searchParams.get("role_name"));
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
    const backend = new S26WorkerBackend(envWith({ S26_APPLICATION_DATA_PLANE_READY: "true" }), {
      fetch: fetcher,
      generateSecret: () => generatedCanaries[generatedIndex++]!,
    });
    const bindings = closedEnvironmentBindings();
    const applyRequest = request("/s26/control-plane/v1/hosting/environment-bind", {
      ...environmentContext,
      bindings,
    });
    const applied = await handle(applyRequest, backend);
    expect(applied.status).toBe(200);
    const appliedText = await applied.text();
    expect(written).toHaveLength(bindings.length);
    expect(written.find((entry) => entry.key === "NEON_DATABASE_URL")?.value).toBe(databaseCanary);
    expect(written.find((entry) => entry.key === "IDENTITY_SESSION_SECRET")?.value).toBe(generatedCanaries[0]);
    expect(written.find((entry) => entry.key === "CRON_SECRET")?.value).toBe(generatedCanaries[1]);
    expect(written.find((entry) => entry.key === "NOTIFY_SECRET")?.value).toBe(generatedCanaries[2]);
    expect(written.find((entry) => entry.key === "MCP_SECRET")?.value).toBe(generatedCanaries[3]);

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
        bindings: closedEnvironmentBindings(),
      }),
      new S26WorkerBackend(envWith({ S26_APPLICATION_DATA_PLANE_READY: "true" }), { fetch: failedFetcher, generateSecret: () => generatedCanaries[0]! }),
    );
    const failedText = await failed.text();
    expect(failed.status).toBe(502);
    expect(JSON.parse(failedText)).toEqual({ code: "outcome_unknown", provider_request_id: "opaque-vercel-request" });
    expect(failedText).not.toContain(generatedCanaries[0]!);
    expect(failedText).not.toContain(databaseCanary);
  });
});

describe("S26 apply steps are re-runnable against their own effect", () => {
  const REVISION = "b".repeat(40);

  function vercelFetcher(
    routes: (url: URL, method: string, init: RequestInit | undefined) => Response | undefined,
  ) {
    return vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const method = init?.method ?? "GET";
      return routes(url, method, init as RequestInit | undefined)
        ?? providerResponse(500, {}, "unexpected-route");
    });
  }

  it("skips a role bootstrap whose own effect is already present", async () => {
    const asked: unknown[][] = [];
    const client = {
      query: async (_text: string, values?: readonly unknown[]) => {
        asked.push([...(values ?? [])]);
        return {
          rows: [{
            control_plane: true,
            identity_store: true,
            ai_execution: false,
            machine_ingest: false,
          }],
        };
      },
    };
    await expect(readBootstrapState(client)).resolves.toEqual({
      controlPlane: true,
      identityStore: true,
      aiExecution: false,
      machineIngest: false,
    });
    // The probe asks about the exact seven-role contract, so a cluster missing
    // one of them is never mistaken for a prepared one.
    expect(asked[0]?.[0]).toEqual([...CONTROL_PLANE_ROLES]);
    expect(asked[0]?.[1]).toBe(7);
  });

  it("reads a fresh database as no bootstrap applied", async () => {
    const client = { query: async () => ({ rows: [] as Record<string, unknown>[] }) };
    await expect(readBootstrapState(client)).resolves.toEqual({
      controlPlane: false,
      identityStore: false,
      aiExecution: false,
      machineIngest: false,
    });
  });

  it("runs only bootstrap artifacts whose postcondition is missing", () => {
    expect(bootstrapArtifactsToApply({
      controlPlane: true,
      identityStore: true,
      aiExecution: false,
      machineIngest: true,
    })).toEqual(["aiExecution"]);
    expect(bootstrapArtifactsToApply({
      controlPlane: true,
      identityStore: true,
      aiExecution: true,
      machineIngest: true,
    })).toEqual([]);
  });

  it("adopts production values the target already carries instead of rotating them", async () => {
    const environmentEntries = [
      { id: "ownership", key: "LH2_OWNERSHIP_MARKER_DIGEST", value: OWNERSHIP, type: "plain", target: ["production"] },
      ...CANONICAL_TENANT_ENVIRONMENT.map((entry, index) => ({
        id: `env-${index}`,
        key: entry.name,
        type: entry.valueClass === "server_secret" ? "sensitive" : "encrypted",
        target: ["production"],
      })),
    ];
    const writes: string[] = [];
    const fetcher = vercelFetcher((url, method) => {
      if (url.hostname === "console.neon.tech" && url.pathname.endsWith("/projects/project-1")) {
        return providerResponse(200, { project: { id: "project-1", name: DATA_PROJECT_NAME, org_id: env.NEON_ORGANIZATION_ID } });
      }
      if (url.hostname === "console.neon.tech" && url.pathname.endsWith("/connection_uri")) {
        return providerResponse(200, { uri: "postgresql://app_runtime:pw@ep.example.invalid/neondb" });
      }
      if (url.hostname === "api.vercel.com" && url.pathname.endsWith("/projects/target-1") && method === "GET") {
        return providerResponse(200, { id: "target-1" });
      }
      if (url.hostname === "api.vercel.com" && url.pathname.endsWith("/projects/target-1/env")) {
        if (method === "GET") return providerResponse(200, { envs: environmentEntries });
        writes.push(`${method} ${url.pathname}`);
        return providerResponse(200, { id: "unexpected" });
      }
      return undefined;
    });
    const rotated: string[] = [];
    const response = await handle(
      request("/s26/control-plane/v1/hosting/environment-bind", {
        ...environmentContext,
        bindings: closedEnvironmentBindings(),
      }),
      new S26WorkerBackend(envWith({ S26_APPLICATION_DATA_PLANE_READY: "true" }), {
        fetch: fetcher,
        generateSecret: () => { rotated.push("generated"); return "rotated-canary"; },
      }),
    );
    expect(response.status).toBe(200);
    // Nothing was written, and above all no generated secret was minted: a
    // retry that rotated them would break the release already promoted with
    // the previous ones.
    expect(writes).toEqual([]);
    expect(rotated).toEqual([]);
    const body = await response.json() as { bindings: readonly { name: string }[] };
    expect(body.bindings.map((binding) => binding.name).sort())
      .toEqual(CANONICAL_TENANT_ENVIRONMENT.map((entry) => entry.name).sort());
  });

  it("writes only the production values a partially bound target is missing", async () => {
    const bound = CANONICAL_TENANT_ENVIRONMENT.slice(0, 3);
    const written: string[] = [];
    const fetcher = vercelFetcher((url, method, init) => {
      if (url.hostname === "console.neon.tech" && url.pathname.endsWith("/projects/project-1")) {
        return providerResponse(200, { project: { id: "project-1", name: DATA_PROJECT_NAME, org_id: env.NEON_ORGANIZATION_ID } });
      }
      if (url.hostname === "console.neon.tech" && url.pathname.endsWith("/connection_uri")) {
        return providerResponse(200, { uri: "postgresql://app_runtime:pw@ep.example.invalid/neondb" });
      }
      if (url.hostname === "api.vercel.com" && url.pathname.endsWith("/projects/target-1") && method === "GET") {
        return providerResponse(200, { id: "target-1" });
      }
      if (url.hostname === "api.vercel.com" && url.pathname.endsWith("/projects/target-1/env")) {
        if (method === "GET") {
          return providerResponse(200, {
            envs: [
              { id: "ownership", key: "LH2_OWNERSHIP_MARKER_DIGEST", value: OWNERSHIP, type: "plain", target: ["production"] },
              // A preview-scoped value of the same name is a different binding
              // and must not be mistaken for the production one.
              { id: "preview", key: CANONICAL_TENANT_ENVIRONMENT[3]!.name, type: "encrypted", target: ["preview"] },
              ...bound.map((entry, index) => ({
                id: `env-${index}`,
                key: entry.name,
                type: entry.valueClass === "server_secret" ? "sensitive" : "encrypted",
                target: ["production"],
              })),
            ],
          });
        }
        written.push(String((JSON.parse(String(init?.body)) as { key: string }).key));
        return providerResponse(200, { id: `written-${written.length}` });
      }
      return undefined;
    });
    const response = await handle(
      request("/s26/control-plane/v1/hosting/environment-bind", {
        ...environmentContext,
        bindings: closedEnvironmentBindings(),
      }),
      new S26WorkerBackend(envWith({ S26_APPLICATION_DATA_PLANE_READY: "true" }), { fetch: fetcher }),
    );
    expect(response.status).toBe(200);
    expect(written.sort()).toEqual(
      CANONICAL_TENANT_ENVIRONMENT.map((entry) => entry.name)
        .filter((name) => !bound.some((entry) => entry.name === name))
        .sort(),
    );
  });

  it("adopts a verified build of the approved revision instead of deploying again", async () => {
    const approvedScheduleDigest = scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES);
    const environmentBindingDigest = hostingEnvironmentBindingDigest(
      CANONICAL_TENANT_ENVIRONMENT.map((entry) => ({ name: entry.name, valueClass: entry.valueClass, source: entry.source })),
    );
    const buildIdentityDigest = sha256Digest(canonicalJson({
      target_handle: "target-1",
      revision_id: REVISION,
      build_recipe_id: env.VERCEL_BUILD_RECIPE_ID,
      environment_binding_digest: environmentBindingDigest,
      schedule_manifest_digest: approvedScheduleDigest,
    }));
    const crons = CANONICAL_TENANT_SCHEDULES.map((entry) => ({
      path: Object.keys(entry.queryParameters).length === 0
        ? entry.routePath
        : `${entry.routePath}?${new URLSearchParams(Object.entries(entry.queryParameters)).toString()}`,
      schedule: entry.expression,
    }));
    const created: string[] = [];
    const fetcher = vercelFetcher((url, method) => {
      if (url.pathname === "/v7/deployments" && method === "GET") {
        return providerResponse(200, {
          deployments: [
            { uid: "older", meta: { lh2S26BuildDigest: `sha256:${"c".repeat(64)}` } },
            { uid: "already-built", meta: { lh2S26BuildDigest: buildIdentityDigest } },
          ],
        });
      }
      if (url.pathname === "/v13/deployments" && method === "POST") {
        created.push("deployment");
        return providerResponse(200, { id: "fresh" });
      }
      if (url.pathname === "/v13/deployments/already-built" && method === "GET") {
        return providerResponse(200, {
          id: "already-built",
          readyState: "READY",
          target: "production",
          gitSource: { sha: REVISION },
          meta: { lh2S26BuildDigest: buildIdentityDigest },
          crons,
        });
      }
      if (url.pathname === "/v9/projects/target-1" && method === "GET") {
        return providerResponse(200, {
          id: "target-1",
          crons: { deploymentId: "already-built", definitions: crons },
        });
      }
      return undefined;
    });
    const buildInput = {
        target_handle: "target-1",
        revision_id: REVISION,
        build_recipe_id: env.VERCEL_BUILD_RECIPE_ID,
        public_value_names: CANONICAL_TENANT_ENVIRONMENT
          .filter((entry) => entry.valueClass === "public_build")
          .map((entry) => entry.name)
          .sort(),
        environment_binding_digest: environmentBindingDigest,
        schedule_manifest_digest: approvedScheduleDigest,
    };
    const backend = new S26WorkerBackend(envWith({
      APPROVED_SOURCE_GIT_SHA: REVISION,
      APPROVED_SCHEDULE_MANIFEST_DIGEST: approvedScheduleDigest,
    }), { fetch: fetcher });
    await expect(backend.invoke(
      { capability: "hosting", operation: "build" },
      buildInput,
    )).resolves.toMatchObject({ releaseHandle: "already-built", status: "verified" });
    const response = await handle(
      request("/s26/control-plane/v1/hosting/build", buildInput),
      backend,
    );
    expect(response.status, `${await response.clone().text()} created=${JSON.stringify(created)}`).toBe(200);
    expect(created).toEqual([]);
    await expect(response.json()).resolves.toMatchObject({ releaseHandle: "already-built", status: "verified" });
  });

  it("marks a fresh preview build with its complete retry identity", async () => {
    const approvedScheduleDigest = scheduleManifestDigest(CANONICAL_TENANT_SCHEDULES);
    const environmentBindingDigest = hostingEnvironmentBindingDigest(
      CANONICAL_TENANT_ENVIRONMENT.map((entry) => ({ name: entry.name, valueClass: entry.valueClass, source: entry.source })),
    );
    const buildIdentityDigest = sha256Digest(canonicalJson({
      target_handle: "target-1",
      revision_id: REVISION,
      build_recipe_id: env.VERCEL_BUILD_RECIPE_ID,
      environment_binding_digest: environmentBindingDigest,
      schedule_manifest_digest: approvedScheduleDigest,
    }));
    const crons = CANONICAL_TENANT_SCHEDULES.map((entry) => ({
      path: Object.keys(entry.queryParameters).length === 0
        ? entry.routePath
        : `${entry.routePath}?${new URLSearchParams(Object.entries(entry.queryParameters)).toString()}`,
      schedule: entry.expression,
    }));
    let createBody: Record<string, unknown> | undefined;
    const fetcher = vercelFetcher((url, method, init) => {
      if (url.pathname === "/v7/deployments" && method === "GET") {
        return providerResponse(200, { deployments: [] });
      }
      if (url.pathname === "/v9/projects/target-1" && method === "GET") {
        return providerResponse(200, {
          id: "target-1",
          name: "lh2-disposable-disposable-lab",
          ...(createBody === undefined
            ? {}
            : { crons: { deploymentId: "fresh-release", definitions: crons } }),
        });
      }
      if (url.pathname === "/v13/deployments" && method === "POST") {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return providerResponse(200, { id: "fresh-release" }, "create-request");
      }
      if (url.pathname === "/v13/deployments/fresh-release" && method === "GET") {
        return providerResponse(200, {
          id: "fresh-release",
          readyState: "READY",
          target: "production",
          gitSource: { sha: REVISION },
          meta: { lh2S26BuildDigest: buildIdentityDigest },
          crons,
        });
      }
      return undefined;
    });
    const backend = new S26WorkerBackend(envWith({
      APPROVED_SOURCE_GIT_SHA: REVISION,
      APPROVED_SCHEDULE_MANIFEST_DIGEST: approvedScheduleDigest,
    }), { fetch: fetcher });
    await expect(backend.invoke(
      { capability: "hosting", operation: "build" },
      {
        target_handle: "target-1",
        revision_id: REVISION,
        build_recipe_id: env.VERCEL_BUILD_RECIPE_ID,
        public_value_names: CANONICAL_TENANT_ENVIRONMENT
          .filter((entry) => entry.valueClass === "public_build")
          .map((entry) => entry.name)
          .sort(),
        environment_binding_digest: environmentBindingDigest,
        schedule_manifest_digest: approvedScheduleDigest,
      },
    )).resolves.toMatchObject({ releaseHandle: "fresh-release", status: "verified" });
    expect(createBody).toEqual({
      name: "lh2-disposable-disposable-lab",
      project: "target-1",
      target: "production",
      gitSource: {
        type: "github",
        org: env.SOURCE_REPOSITORY_OWNER,
        repo: env.SOURCE_REPOSITORY_NAME,
        ref: REVISION,
        sha: REVISION,
      },
      meta: { lh2S26BuildDigest: buildIdentityDigest },
    });
  });

  it("does not promote a release the target already serves", async () => {
    const promotions: string[] = [];
    let current = "release-1";
    const fetcher = vercelFetcher((url, method) => {
      if (url.pathname === "/v9/projects/target-1" && method === "GET") {
        return providerResponse(200, {
          id: "target-1",
          targets: { production: { id: current, readySubstate: "PROMOTED" } },
        });
      }
      if (url.pathname.includes("/promote/") && method === "POST") {
        promotions.push(url.pathname);
        current = url.pathname.split("/").at(-1)!;
        return providerResponse(200, {});
      }
      return undefined;
    });
    const backend = new S26WorkerBackend(env, { fetch: fetcher });
    const adopted = await handle(
      request("/s26/control-plane/v1/hosting/promote", { target_handle: "target-1", release_handle: "release-1" }),
      backend,
    );
    expect(adopted.status).toBe(200);
    expect(promotions).toEqual([]);
    await expect(adopted.json()).resolves.toMatchObject({ activeReleaseHandle: "release-1", rolloutKind: "promote" });

    const promoted = await handle(
      request("/s26/control-plane/v1/hosting/promote", { target_handle: "target-1", release_handle: "release-2" }),
      backend,
    );
    expect(promoted.status).toBe(200);
    expect(promotions).toEqual(["/v10/projects/target-1/promote/release-2"]);
  });

  it("does not mistake an unaliased staged production build for current traffic", async () => {
    let promoted = false;
    const promotions: string[] = [];
    const fetcher = vercelFetcher((url, method) => {
      if (url.pathname === "/v9/projects/target-1" && method === "GET") {
        return providerResponse(200, {
          id: "target-1",
          targets: {
            production: {
              id: "release-staged",
              readySubstate: promoted ? "PROMOTED" : "STAGED",
            },
          },
        });
      }
      if (url.pathname === "/v10/projects/target-1/promote/release-staged" && method === "POST") {
        promotions.push(url.pathname);
        promoted = true;
        return providerResponse(200, {});
      }
      return undefined;
    });
    const response = await handle(
      request("/s26/control-plane/v1/hosting/promote", {
        target_handle: "target-1",
        release_handle: "release-staged",
      }),
      new S26WorkerBackend(env, { fetch: fetcher }),
    );
    expect(response.status).toBe(200);
    expect(promotions).toEqual(["/v10/projects/target-1/promote/release-staged"]);
  });

  it("accepts the closed smoke vocabulary the executor actually sends", async () => {
    const fetcher = vercelFetcher((url) => {
      if (url.hostname === "console.neon.tech" && url.pathname.endsWith("/connection_uri")) {
        return providerResponse(503, {}, "opaque-neon-request");
      }
      return undefined;
    });
    const backend = new S26WorkerBackend(env, { fetch: fetcher });
    const unknown = await handle(
      request("/s26/control-plane/v1/data/smoke", { project_id: "project-1", smoke_test_ids: ["preview-isolation"] }),
      backend,
    );
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toEqual({ code: "unsupported_contract" });

    // The contract's own IDs pass the allowlist and reach the provider, which
    // is the only difference the boundary can show without a live database.
    const accepted = await handle(
      request("/s26/control-plane/v1/data/smoke", {
        project_id: "project-1",
        smoke_test_ids: [...CANONICAL_SMOKE_TEST_IDS.data],
      }),
      backend,
    );
    expect(accepted.status).toBe(502);
    await expect(accepted.json()).resolves.toEqual({ code: "outcome_unknown", provider_request_id: "opaque-neon-request" });
  });

  it("reuses and removes the same R2 canary on a smoke retry", async () => {
    const projectId = "project-r2-smoke-retry";
    const backend = new S26WorkerBackend(env, { fetch: vi.fn<typeof fetch>() });
    const body = {
      project_id: projectId,
      smoke_test_ids: [...CANONICAL_SMOKE_TEST_IDS.objectStorage],
      require_private_access_checks: true,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await handle(
        request("/s26/control-plane/v1/object-storage/smoke", body),
        backend,
      );
      expect(response.status).toBe(200);
    }
    const remaining = await env.TENANT_LEAD_PHOTOS.list({
      prefix: `${env.RECOVERY_OBJECT_PREFIX}/smoke/${projectId}/`,
    });
    expect(remaining.objects).toEqual([]);
  });

  it("adopts a delivered SMTP smoke marker instead of sending twice", async () => {
    const projectId = "project-smtp-smoke-retry";
    const idempotencyKeys: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      expect(url.hostname).toBe("api.resend.com");
      expect(url.pathname).toBe("/emails");
      idempotencyKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      return providerResponse(200, { id: "email-provider-id" }, "resend-request-1");
    });
    const backend = new S26WorkerBackend(env, { fetch: fetcher });
    const body = {
      project_id: projectId,
      smoke_test_ids: [...CANONICAL_SMOKE_TEST_IDS.email],
    };
    const first = await handle(request("/s26/control-plane/v1/smtp/smoke", body), backend);
    const repeated = await handle(request("/s26/control-plane/v1/smtp/smoke", body), backend);
    expect(first.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(idempotencyKeys).toHaveLength(1);
    expect(idempotencyKeys[0]).toMatch(/^s26\/[0-9a-f]{64}$/);
    await expect(first.json()).resolves.toEqual({ providerRequestId: "resend-request-1" });
    await expect(repeated.json()).resolves.toEqual({ providerRequestId: "resend-request-1" });
  });

  it("quarantines an email still ambiguous beyond the provider idempotency window", async () => {
    const projectId = "project-smtp-stale-pending";
    const recipient = env.RESEND_SMOKE_RECIPIENT;
    const markerDigest = await sha256Hex(`${recipient}\n${CANONICAL_SMOKE_TEST_IDS.email.join("\n")}`);
    const markerKey = `${env.RECOVERY_OBJECT_PREFIX}/smtp-smoke/${projectId}/${markerDigest}.json`;
    await env.CONTROL_PLANE_OBJECTS.put(markerKey, JSON.stringify({
      version: "s26-email-delivery.v1",
      state: "pending",
      idempotencyKey: `s26/${await sha256Hex(markerKey)}`,
      correlationId: "ambiguous-email-request",
      createdAt: "2000-01-01T00:00:00.000Z",
    }));
    const fetcher = vi.fn<typeof fetch>();
    const response = await handle(
      request("/s26/control-plane/v1/smtp/smoke", {
        project_id: projectId,
        smoke_test_ids: [...CANONICAL_SMOKE_TEST_IDS.email],
      }),
      new S26WorkerBackend(env, { fetch: fetcher }),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      code: "outcome_unknown",
      provider_request_id: "ambiguous-email-request",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
