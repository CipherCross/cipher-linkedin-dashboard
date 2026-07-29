import * as z from "zod/v4";

const slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/);
const uuid = z.uuid();
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const dateTime = z.iso.datetime({ offset: true });
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/);
const keychainLabel = z
  .string()
  .min(1)
  .max(200)
  .regex(/^lh2-platform\/(?:platform|tenant\/[a-z][a-z0-9-]{1,30}[a-z0-9])\/[a-z0-9._-]+$/);

export const SERVER_NAME = "lh2-owner-operations" as const;
export const SERVER_VERSION = "0.3.0" as const;

export const tenantLifecycleSchema = z.enum([
  "absent",
  "planned",
  "provisioning",
  "verifying",
  "active",
  "quarantined",
  "suspended",
  "offboarding_planned",
  "retained",
]);
const workspaceClassSchema = z.enum(["internal", "disposable", "external"]);
const releaseChannelSchema = z.enum(["internal", "canary", "stable"]);
const operationStateSchema = z.enum([
  "pending",
  "running",
  "waiting_provider",
  "failed",
  "quarantined",
  "succeeded",
  "partially_succeeded",
]);
const stepStateSchema = z.enum([
  "pending",
  "running",
  "waiting_provider",
  "failed",
  "outcome_unknown",
  "succeeded",
  "not_applicable",
]);

export const toolMetaSchema = z.strictObject({
  server_name: z.literal(SERVER_NAME),
  server_version: z.literal(SERVER_VERSION),
  tool_contract_digest: sha256,
  operations_contract_version: z.literal("p2.v1"),
  registry_version: z.number().int().nonnegative(),
});

const tenantSummarySchema = z.strictObject({
  tenant_id: uuid,
  tenant_slug: slug,
  company_name: z.string().min(1).max(160),
  workspace_class: workspaceClassSchema,
  desired_lifecycle: tenantLifecycleSchema,
  observed_lifecycle: tenantLifecycleSchema,
  release_channel: releaseChannelSchema,
  region_id: id,
  supabase_tier_id: id,
  supabase_compute_id: id,
  vercel_tier_id: id,
  backup_profile_id: id,
  cron_slot: z.number().int().min(0).max(4),
  created_at: dateTime,
  updated_at: dateTime,
});

const resourceReferenceSchema = z.strictObject({
  provider_kind: z.enum([
    "supabase",
    "vercel",
    "dns",
    "smtp",
    "source_repository",
  ]),
  resource_kind: id,
  provider_owner_id: id,
  resource_id: id,
  deterministic_name: z.string().min(1).max(200),
  ownership_marker_digest: sha256,
  observed_lifecycle: id,
});

const stepSchema = z.strictObject({
  ordinal: z.number().int().min(1),
  kind: id,
  state: stepStateSchema,
  attempt: z.number().int().nonnegative(),
  provider_request_id: id.nullable(),
  redacted_error: z.string().max(1000).nullable(),
});

const operationSchema = z.strictObject({
  operation_id: id,
  operation_kind: z.enum(["tenant_onboarding", "release"]),
  scope: z.string().min(1).max(160),
  plan_id: id,
  plan_digest: sha256,
  idempotency_key: idempotencyKey,
  state: operationStateSchema,
  error_code: id.nullable(),
  redacted_error_summary: z.string().max(1000).nullable(),
  created_at: dateTime,
  updated_at: dateTime,
  completed_at: dateTime.nullable(),
});

const blockerSchema = z.strictObject({
  code: id,
  summary: z.string().min(1).max(500),
  remediation: z.string().min(1).max(1000),
});

const prerequisiteSchema = z.strictObject({
  prerequisite_id: id,
  status: z.enum(["passed", "blocker", "manual"]),
  summary: z.string().min(1).max(500),
});

const effectSchema = z.strictObject({
  ordinal: z.number().int().min(1),
  effect_kind: id,
  action: id,
  target: z.string().min(1).max(200),
});

const mutationAuthorizationSchema = z.strictObject({
  server_version: z.literal(SERVER_VERSION),
  tool_contract_digest: sha256,
  plan_id: id,
  plan_digest: sha256,
  expected_registry_version: z.number().int().nonnegative(),
  idempotency_key: idempotencyKey,
});

export const onboardingBusinessInputsSchema = z.strictObject({
  company_name: z.string().trim().min(1).max(160),
  tenant_slug: slug,
  workspace_class: workspaceClassSchema,
  admin_email: z.email().max(320),
  expected_instances: z.number().int().min(1).max(100),
  release_channel: releaseChannelSchema,
  residency_policy_id: id,
  supabase_region_id: id,
  supabase_tier_id: id,
  supabase_compute_id: id,
  vercel_tier_id: id,
  backup_profile_id: id,
  pricing_catalog_id: id,
  retention_policy_id: id,
  subprocessor_profile_id: id,
  smtp_profile_id: id,
  smtp_secret_labels: z.array(keychainLabel).max(8),
  integration_secret_labels: z.array(keychainLabel).max(32),
  support_access_policy: z.strictObject({
    initial_state: z.literal("disabled"),
    maximum_duration_hours: z.number().int().min(1).max(168),
  }),
});
export type OnboardingBusinessInputs = z.infer<
  typeof onboardingBusinessInputsSchema
>;

const releaseBusinessInputsSchema = z.strictObject({
  release_id: id,
  compatibility_id: id,
  source_git_sha: gitSha,
  application_version: id,
  release_channel: releaseChannelSchema,
  target_tenant_slugs: z.array(slug).min(1).max(100),
});

const planSummarySchema = z.strictObject({
  plan_id: id,
  plan_digest: sha256,
  generated_at: dateTime,
  expires_at: dateTime,
  expected_registry_version: z.number().int().nonnegative(),
  state: z.enum(["valid", "blocked"]),
  effects: z.array(effectSchema).max(64),
  prerequisites: z.array(prerequisiteSchema).max(64),
  blockers: z.array(blockerSchema).max(64),
});

const mutationResultSchema = z.strictObject({
  meta: toolMetaSchema,
  operation_id: id,
  state: operationStateSchema,
  resumed: z.boolean(),
  next_action: z.enum(["operation_get", "tenant_get", "await_provider", "none"]),
});

export const ownerToolSchemas = {
  tenant_list: {
    input: z.strictObject({
      lifecycle: tenantLifecycleSchema.optional(),
      workspace_class: workspaceClassSchema.optional(),
    }),
    output: z.strictObject({
      meta: toolMetaSchema,
      tenants: z.array(tenantSummarySchema).max(1000),
    }),
  },
  tenant_get: {
    input: z.strictObject({ tenant_slug: slug }),
    output: z.strictObject({
      meta: toolMetaSchema,
      tenant: tenantSummarySchema,
      resources: z.array(resourceReferenceSchema).max(100),
    }),
  },
  tenant_preflight: {
    input: onboardingBusinessInputsSchema,
    output: z.strictObject({
      meta: toolMetaSchema,
      status: z.enum(["passed", "blocked"]),
      provider_snapshot_valid_until: dateTime.nullable(),
      prerequisites: z.array(prerequisiteSchema).max(64),
      blockers: z.array(blockerSchema).max(64),
    }),
  },
  tenant_plan_onboarding: {
    input: onboardingBusinessInputsSchema,
    output: z.strictObject({
      meta: toolMetaSchema,
      plan: planSummarySchema.extend({
        tenant_slug: slug,
        production_hostname: z.string().min(1).max(253),
        supabase_project_name: z.string().min(1).max(120),
        vercel_project_name: z.string().min(1).max(120),
        source_git_sha: gitSha,
        baseline_version: z.literal(53),
        migration_versions: z.array(z.number().int().min(54)).max(100),
        recurring_cost_low_minor: z.number().int().nonnegative(),
        recurring_cost_high_minor: z.number().int().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      }),
    }),
  },
  tenant_drift: {
    input: z.strictObject({ tenant_slug: slug }),
    output: z.strictObject({
      meta: toolMetaSchema,
      tenant_slug: slug,
      status: z.enum(["in_sync", "drifted", "unknown"]),
      critical: z.boolean(),
      observed_schema_version: z.number().int().nonnegative().nullable(),
      observed_application_version: id.nullable(),
      observed_agent_versions: z.array(id).max(100),
      health: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
      findings: z.array(
        z.strictObject({
          code: id,
          severity: z.enum(["info", "warning", "critical"]),
          summary: z.string().min(1).max(500),
        }),
      ).max(100),
    }),
  },
  operation_get: {
    input: z.strictObject({ operation_id: id }),
    output: z.strictObject({
      meta: toolMetaSchema,
      operation: operationSchema,
      steps: z.array(stepSchema).max(256),
      next_step: stepSchema.nullable(),
    }),
  },
  release_plan: {
    input: releaseBusinessInputsSchema,
    output: z.strictObject({
      meta: toolMetaSchema,
      plan: planSummarySchema.extend({
        release_id: id,
        source_git_sha: gitSha,
        release_channel: releaseChannelSchema,
        target_tenant_slugs: z.array(slug).max(100),
        rollout_order: z.array(z.enum([
          "expand_migrations",
          "internal",
          "canary",
          "canary_verification",
          "tenant_migrations",
          "tenant_deployments",
          "stable_agent",
        ])).length(7),
      }),
    }),
  },
  tenant_prepare_offboarding: {
    input: z.strictObject({
      tenant_slug: slug,
      retention_policy_id: id,
      reason: z.string().trim().min(1).max(500),
    }),
    output: z.strictObject({
      meta: toolMetaSchema,
      tenant_slug: slug,
      state: z.literal("offboarding_planned"),
      effects_applied: z.literal(false),
      checklist: z.array(
        z.strictObject({
          checklist_id: id,
          summary: z.string().min(1).max(500),
          manual_break_glass: z.boolean(),
        }),
      ).min(1).max(64),
      blockers: z.array(blockerSchema).max(64),
    }),
  },
  tenant_apply_onboarding: {
    input: z.strictObject({
      authorization: mutationAuthorizationSchema,
    }),
    output: mutationResultSchema,
  },
  tenant_resume_operation: {
    input: z.strictObject({
      authorization: mutationAuthorizationSchema,
      operation_id: id,
    }),
    output: mutationResultSchema,
  },
  admin_invite: {
    input: z.strictObject({
      authorization: mutationAuthorizationSchema,
      tenant_slug: slug,
      admin_email: z.email().max(320),
    }),
    output: mutationResultSchema,
  },
  machine_enrollment_create: {
    input: z.strictObject({
      authorization: mutationAuthorizationSchema,
      tenant_slug: slug,
      instance_id: id,
      platform: z.enum(["windows", "macos"]),
    }),
    output: mutationResultSchema,
  },
  machine_revoke: {
    input: z.strictObject({
      authorization: mutationAuthorizationSchema,
      tenant_slug: slug,
      machine_id: id,
      reason: z.string().trim().min(1).max(500),
    }),
    output: mutationResultSchema,
  },
  support_access_enable: {
    input: z.strictObject({
      authorization: mutationAuthorizationSchema,
      tenant_slug: slug,
      reason: z.string().trim().min(1).max(500),
      duration_hours: z.number().int().min(1).max(168),
    }),
    output: mutationResultSchema,
  },
  support_access_disable: {
    input: z.strictObject({
      authorization: mutationAuthorizationSchema,
      tenant_slug: slug,
      reason: z.string().trim().min(1).max(500),
    }),
    output: mutationResultSchema,
  },
  tenant_suspend: {
    input: z.strictObject({
      authorization: mutationAuthorizationSchema,
      tenant_slug: slug,
      reason: z.string().trim().min(1).max(500),
    }),
    output: mutationResultSchema,
  },
  release_apply: {
    input: z.strictObject({
      authorization: mutationAuthorizationSchema,
    }),
    output: mutationResultSchema,
  },
} as const;

export type OwnerToolName = keyof typeof ownerToolSchemas;
