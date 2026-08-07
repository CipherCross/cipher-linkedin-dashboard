import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryCatalogResolver,
  OpsError,
  Registry,
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
  const catalog = { ...makeCatalogs()[0]!, entries: [{ id: "eu-west", availability: "available", approved: true }] };
  validateCatalogSchema(catalog);
  validateCatalogSnapshot(catalog);
  const withUnknown = {
    ...catalog,
    entries: [{ ...catalog.entries[0], provider_response_fragment: "forbidden" }],
  };
  expectCode("catalog_invalid", () => validateCatalogSnapshot(withUnknown));
  expectCode("schema_validation_failed", () => validateCatalogSchema(withUnknown));
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
