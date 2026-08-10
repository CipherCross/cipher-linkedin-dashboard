import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  validateCatalogSchema,
  validateCatalogSnapshot,
  type CatalogSnapshot,
} from "../src/index.js";

interface DisposablePolicyArtifact {
  readonly policy_id: string;
  readonly disposition: string;
  readonly blocking_conditions: readonly string[];
  readonly catalogs: readonly CatalogSnapshot[];
}

function policy(): DisposablePolicyArtifact {
  return JSON.parse(readFileSync(new URL(
    "../../../docs/platform-ops/catalogs/s26-disposable-policy-v1.json",
    import.meta.url,
  ), "utf8")) as DisposablePolicyArtifact;
}

test("approved S26 disposable catalogs have closed schemas and canonical digests", () => {
  const artifact = policy();
  assert.equal(artifact.policy_id, "s26-disposable-policy-v1");
  assert.equal(artifact.disposition, "configuration-valid-plan-blocked");
  assert.equal(artifact.catalogs.length, 7);
  assert.equal(new Set(artifact.catalogs.map((catalog) => catalog.catalog_kind)).size, 7);
  for (const catalog of artifact.catalogs) {
    assert.equal(catalog.review_status, "approved");
    validateCatalogSchema(catalog);
    validateCatalogSnapshot(catalog);
  }
});

test("disposable policy keeps every unresolved readiness condition unavailable", () => {
  const artifact = policy();
  assert.deepEqual(artifact.blocking_conditions, [
    "vercel-commercial-entitlement-not-provider-verified",
    "vercel-fra1-not-pinned-in-approved-source-release",
    "control-plane-r2-eu-jurisdiction-not-verified",
    "signed-agent-release-manifest-not-verified",
  ]);
  const entries = artifact.catalogs.flatMap((catalog) => catalog.entries);
  for (const id of [
    "vercel-commercial-fra1",
    "cloudflare-r2-standard-eu",
    "cloudflare-r2-eu",
    "vercel-fra1",
    "s26-disposable-processors",
    "sync-agent-1.14.0",
  ]) {
    assert.equal(entries.find((entry) => entry.id === id)?.availability, "unavailable");
  }
});

test("fractional public prices use exact scaled pricing units", () => {
  const pricing = policy().catalogs.find((catalog) => catalog.catalog_kind === "pricing")!;
  const r2Storage = pricing.entries.find((entry) => entry.id === "r2-standard-storage-1000-gb-month") as {
    readonly minor_unit_price: number;
    readonly pricing_unit: string;
  };
  const neonCompute = pricing.entries.find((entry) => entry.id === "neon-launch-compute-1000-cu-hour") as {
    readonly minor_unit_price: number;
    readonly pricing_unit: string;
  };
  assert.equal(r2Storage.minor_unit_price, 1500);
  assert.equal(r2Storage.pricing_unit, "1000-gb-month");
  assert.equal(neonCompute.minor_unit_price, 10600);
  assert.equal(neonCompute.pricing_unit, "1000-cu-hour");
});
