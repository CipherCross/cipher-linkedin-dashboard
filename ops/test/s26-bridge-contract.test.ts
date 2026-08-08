import assert from "node:assert/strict";
import test from "node:test";

import {
  OpsError,
  S26ControlPlaneBridgeService,
  S26_BRIDGE_PROTOCOL_VERSION,
  isS26BridgeOperation,
  s26BridgePath,
} from "../src/index.js";

test("S26 bridge has a fixed versioned vocabulary and cannot form arbitrary provider routes", () => {
  assert.equal(S26_BRIDGE_PROTOCOL_VERSION, "s26-control-plane.v1");
  assert.equal(s26BridgePath("identity", "inspect"), "s26/control-plane/v1/identity/inspect");
  assert.equal(s26BridgePath("sourceRepository", "inspect"), "s26/control-plane/v1/source-repository/inspect");
  assert.equal(isS26BridgeOperation("identity", "recovery-verify"), true);
  assert.equal(isS26BridgeOperation("identity", "delete-everything"), false);
  assert.equal(isS26BridgeOperation("raw-http", "get"), false);
  assert.equal(isS26BridgeOperation("data", "portable-schema-apply"), true);
});

test("local bridge accepts only typed named routes and keeps credentials server-side", async () => {
  const secret = "bridge-local-secret";
  const calls: string[] = [];
  const bridge = new S26ControlPlaneBridgeService(
    { authorize: async (token) => token === secret },
    {
      async invoke(route, request) {
        calls.push(`${route.capability}.${route.operation}`);
        assert.equal(JSON.stringify(request).includes(secret), false);
        return { providerRequestId: "bridge-request-1" };
      },
    },
  );
  const accepted = await bridge.handle({
    method: "POST",
    path: "/s26/control-plane/v1/data/portable-schema-apply",
    authorization: `Bearer ${secret}`,
    body: { project_id: "project-1", baseline_version: 53, migration_versions: [54], target_schema_version: 54 },
  });
  assert.deepEqual(accepted, { status: 200, body: { providerRequestId: "bridge-request-1" } });
  assert.deepEqual(calls, ["data.portable-schema-apply"]);

  const rejected = await bridge.handle({
    method: "POST",
    path: "/s26/control-plane/v1/data/portable-schema-apply",
    authorization: `Bearer ${secret}`,
    body: { project_id: "project-1", baseline_version: 53, migration_versions: [54], target_schema_version: 54, sql: "select 1" },
  });
  assert.equal(rejected.status, 400);
  assert.equal(JSON.stringify(rejected).includes(secret), false);
});

test("bridge redacts provider failures, rejects foreign ownership, and preserves unknown outcomes", async () => {
  const secret = "bridge-local-secret";
  const ownership = `sha256:${"a".repeat(64)}`;
  const mismatch = new S26ControlPlaneBridgeService(
    { authorize: async () => true },
    { async invoke() { return { providerRequestId: "bridge-request-2", artifactId: "artifact-1", manifestDigest: ownership, ownershipMarkerDigest: `sha256:${"b".repeat(64)}`, coverage: ["database_schema_data"], itemCount: 1, capturedAt: "2030-01-01T00:00:00.000Z", reconstructionApproved: false }; } },
  );
  const rejected = await mismatch.handle({ method: "POST", path: "/s26/control-plane/v1/data/recovery-capture", authorization: `Bearer ${secret}`, body: { source_resource_id: "source-1", tenant_slug: "disposable-lab", recovery_target_name: "recovery-1", ownership_marker_digest: ownership } });
  assert.equal(rejected.status, 409);

  const unknown = new S26ControlPlaneBridgeService(
    { authorize: async () => true },
    { async invoke() { throw new OpsError("outcome_unknown", `provider failed with ${secret}`, { provider_request_id: "opaque-request-1", token: secret }); } },
  );
  const uncertain = await unknown.handle({ method: "POST", path: "/s26/control-plane/v1/data/smoke", authorization: `Bearer ${secret}`, body: { project_id: "project-1", smoke_test_ids: ["schema"] } });
  assert.deepEqual(uncertain, { status: 502, body: { code: "outcome_unknown", provider_request_id: "opaque-request-1" } });
  assert.equal(JSON.stringify(uncertain).includes(secret), false);
});
