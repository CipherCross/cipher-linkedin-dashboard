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
  readonly owner_waivers: readonly string[];
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
  assert.equal(artifact.disposition, "configuration-valid-plan-eligible");
  assert.equal(artifact.catalogs.length, 7);
  assert.equal(new Set(artifact.catalogs.map((catalog) => catalog.catalog_kind)).size, 7);
  for (const catalog of artifact.catalogs) {
    assert.equal(catalog.review_status, "approved");
    validateCatalogSchema(catalog);
    validateCatalogSnapshot(catalog);
  }
});

test("re-scoped disposable policy is plan-eligible and records its waivers", () => {
  const artifact = policy();
  assert.deepEqual(artifact.blocking_conditions, []);
  assert.deepEqual(artifact.owner_waivers, [
    "vercel-hobby-non-commercial-self-use-declared-by-owner",
    "vercel-function-region-not-pinned",
    "control-plane-r2-jurisdiction-not-constrained",
    "signed-agent-release-manifest-not-required-for-drill",
  ]);

  const entries = artifact.catalogs.flatMap((catalog) => catalog.entries);
  // The dropped requirements leave no selectable entry behind, so a later plan
  // cannot quietly pick an EU-pinned or commercial entitlement again.
  for (const id of [
    "vercel-commercial-fra1",
    "vercel-commercial-entitlement-pending",
    "cloudflare-r2-standard-eu",
    "cloudflare-r2-eu",
    "vercel-fra1",
  ]) {
    assert.equal(entries.find((entry) => entry.id === id), undefined);
  }
  for (const id of ["s26-disposable-processors", "sync-agent-1.14.0"]) {
    assert.equal(entries.find((entry) => entry.id === id)?.availability, "available");
  }
});

test("the drill's every selected catalog entry is available", () => {
  const artifact = policy();
  const selected = [
    "eu-disposable-policy",
    "aws-eu-central-1",
    "neon-free",
    "autoscale-0.25-2cu",
    "vercel-hobby",
    "s26-disposable-daily",
    "retention-30d",
    "s26-disposable-processors",
    "s26-neon-hosting-v1",
    "sync-agent-1.14.0",
    "agent-ingest.v1",
    "resend-eu-west-1",
    "s26-self-hosted-better-auth-v1",
  ];
  const entries = artifact.catalogs.flatMap((catalog) => catalog.entries);
  for (const id of selected) {
    const entry = entries.find((candidate) => candidate.id === id);
    assert.equal(entry?.availability, "available", `${id} must be available`);
    assert.equal(entry?.approved, true, `${id} must be approved`);
  }
});

test("hosting runs on a non-billable entitlement so the drill buys nothing", () => {
  const tiers = policy().catalogs.find((catalog) => catalog.catalog_kind === "provider_tiers")!;
  const hosting = tiers.entries.find((entry) => entry.id === "vercel-hobby") as {
    readonly billable: boolean;
    readonly pricing_sku_id?: string;
  };
  assert.equal(hosting.billable, false);
  assert.equal(hosting.pricing_sku_id, undefined);
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
