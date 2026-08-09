import { describe, expect, it, vi } from "vitest";

import { OpsError } from "../src/core/errors.js";
import type { S26BridgeBackend } from "../src/bridge/s26-control-plane-service.js";
import { handleS26WorkerRequest } from "../src/worker/index.js";

const BRIDGE_SECRET = "worker-test-bridge-secret";
const OWNERSHIP = `sha256:${"a".repeat(64)}`;

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
