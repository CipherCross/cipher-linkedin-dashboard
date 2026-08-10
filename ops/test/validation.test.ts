import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryCatalogResolver,
  OpsError,
  Registry,
  catalogDigest,
  validateCatalogSchema,
  validateCatalogSnapshot,
  validatePlanSchema,
  validatePlanSemantics,
} from "../src/index.js";
import {
  OWNER_UUID,
  TEST_NOW,
  catalogResolver,
  makeCatalogs,
  makeOnboardingPlan,
} from "./fixtures.js";

function expectCode(code: OpsError["code"], work: () => unknown): void {
  assert.throws(work, (error: unknown) => error instanceof OpsError && error.code === code);
}

test("valid onboarding plan passes strict schema, digest, catalogs and semantic rules", () => {
  const plan = makeOnboardingPlan();
  validatePlanSchema("tenant_onboarding", plan);
  validatePlanSemantics(plan, {
    catalogs: catalogResolver(),
    now: TEST_NOW,
    registryOwnerId: OWNER_UUID,
  });
});

test("closed JSON schema rejects unknown nested fields", () => {
  const plan = makeOnboardingPlan({
    mutateSpec(spec) {
      const inputs = spec.inputs as Record<string, unknown>;
      inputs.provider_payload = { arbitrary: true };
    },
  });
  expectCode("schema_validation_failed", () =>
    validatePlanSchema("tenant_onboarding", plan),
  );
});

test("semantic validation rejects cost ordering, migration gaps and reserved slugs", () => {
  const invalidCost = makeOnboardingPlan({
    mutateSpec(spec) {
      const cost = spec.cost as Record<string, unknown>;
      cost.recurring_low_minor = 7000;
      cost.recurring_high_minor = 6000;
    },
  });
  validatePlanSchema("tenant_onboarding", invalidCost);
  expectCode("invalid_plan", () =>
    validatePlanSemantics(invalidCost, {
      catalogs: catalogResolver(),
      now: TEST_NOW,
      registryOwnerId: OWNER_UUID,
    }),
  );

  const migrationGap = makeOnboardingPlan({
    mutateSpec(spec) {
      const versions = spec.versions as Record<string, unknown>;
      versions.migration_versions = [54, 56];
      versions.target_schema_version = 56;
    },
  });
  validatePlanSchema("tenant_onboarding", migrationGap);
  expectCode("invalid_plan", () =>
    validatePlanSemantics(migrationGap, {
      catalogs: catalogResolver(),
      now: TEST_NOW,
      registryOwnerId: OWNER_UUID,
    }),
  );

  const reservedSlug = makeOnboardingPlan({ slug: "admin" });
  validatePlanSchema("tenant_onboarding", reservedSlug);
  expectCode("invalid_plan", () =>
    validatePlanSemantics(reservedSlug, {
      catalogs: catalogResolver(),
      now: TEST_NOW,
      registryOwnerId: OWNER_UUID,
    }),
  );
});

test("unknown, expired and unapproved catalogs block a plan", () => {
  const plan = makeOnboardingPlan();
  const unknownEntry = makeOnboardingPlan({
    mutateSpec(spec) {
      const inputs = spec.inputs as Record<string, unknown>;
      inputs.data_tier_id = "data-unknown";
    },
  });
  validatePlanSchema("tenant_onboarding", unknownEntry);
  expectCode("catalog_invalid", () =>
    validatePlanSemantics(unknownEntry, {
      catalogs: catalogResolver(),
      now: TEST_NOW,
      registryOwnerId: OWNER_UUID,
    }),
  );

  const missingCatalogs = makeCatalogs().filter(
    (catalog) => catalog.catalog_kind !== "pricing",
  );
  expectCode("catalog_invalid", () =>
    validatePlanSemantics(plan, {
      catalogs: new InMemoryCatalogResolver(missingCatalogs),
      now: TEST_NOW,
      registryOwnerId: OWNER_UUID,
    }),
  );

  const expiredCatalogs = makeCatalogs().map((catalog) =>
    catalog.catalog_kind === "pricing"
      ? { ...catalog, valid_until: "2029-12-31T00:00:00.000Z" }
      : catalog,
  );
  expectCode("catalog_invalid", () =>
    validatePlanSemantics(plan, {
      catalogs: new InMemoryCatalogResolver(expiredCatalogs),
      now: TEST_NOW,
      registryOwnerId: OWNER_UUID,
    }),
  );
});

test("catalog snapshots are closed records and unknown fields fail before planning", () => {
  const changed = { ...makeCatalogs()[0]!, entries: [{ id: "eu-west", availability: "available" as const, approved: true }] };
  const catalog = { ...changed, digest: catalogDigest(changed) };
  validateCatalogSchema(catalog);
  validateCatalogSnapshot(catalog);
  const withUnknown = {
    ...catalog,
    entries: [{ ...catalog.entries[0], provider_response_fragment: "forbidden" }],
  };
  expectCode("catalog_invalid", () => validateCatalogSnapshot(withUnknown));
  expectCode("schema_validation_failed", () => validateCatalogSchema(withUnknown));
});

test("catalog digest excludes only itself and covers scaled exact pricing", () => {
  const changed = {
    ...makeCatalogs().find((catalog) => catalog.catalog_kind === "pricing")!,
    entries: [
      {
        id: "r2-storage-1000-gb-month",
        availability: "available" as const,
        approved: true,
        provider: "cloudflare-r2",
        currency: "USD",
        minor_unit_price: 1500,
        pricing_unit: "1000-gb-month",
        tax_treatment: "excluded" as const,
        effective_at: "2029-12-01T00:00:00.000Z",
        source_reference: "https://developers.cloudflare.com/r2/pricing/",
      },
    ],
  };
  const catalog = { ...changed, digest: catalogDigest(changed) };
  validateCatalogSchema(catalog);
  validateCatalogSnapshot(catalog);

  expectCode("catalog_invalid", () => validateCatalogSnapshot({
    ...catalog,
    entries: [{ ...catalog.entries[0]!, minor_unit_price: 1501 }],
  }));
});

test("plan persistence rejects a stale expected registry version", () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  try {
    const stale = makeOnboardingPlan({ expectedRegistryVersion: 0 });
    expectCode("registry_version_conflict", () =>
      registry.savePlan(stale, { catalogs: catalogResolver(), now: TEST_NOW }),
    );
    assert.equal(registry.registryVersion, 0);
  } finally {
    registry.close();
  }
});
