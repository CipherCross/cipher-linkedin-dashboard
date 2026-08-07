import assert from "node:assert/strict";
import test from "node:test";

import {
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
});
