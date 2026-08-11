/**
 * The closed smoke-suite vocabulary.
 *
 * These IDs are the onboarding contract's, not a free selection: the plan
 * carries them, the executor routes each group to the port that owns it, and
 * the bridge backend accepts nothing outside the union. Keeping the vocabulary
 * in one module is what stops the executor's routing and the server side's
 * allowlist from drifting into two different spellings of the same suite.
 */
export const CANONICAL_SMOKE_TEST_IDS = {
  data: ["schema_ledger", "rls_role_boundaries"],
  objectStorage: ["private_storage_delivery"],
  identity: ["auth_anonymous_denied", "auth_inactive_denied", "auth_member_allowed"],
  email: ["smtp_delivery"],
  /** The runtime checks the hosting control plane owns inside the suite. */
  hosting: ["api_health", "cron_configuration", "preview_isolation", "runtime_project_ref"],
} as const;

/** Every ID the closed suite may contain, in no particular order. */
export const CANONICAL_SMOKE_TEST_ID_SET: readonly string[] = [
  ...CANONICAL_SMOKE_TEST_IDS.data,
  ...CANONICAL_SMOKE_TEST_IDS.objectStorage,
  ...CANONICAL_SMOKE_TEST_IDS.identity,
  ...CANONICAL_SMOKE_TEST_IDS.email,
  ...CANONICAL_SMOKE_TEST_IDS.hosting,
];
