import type { ToolAnnotations } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { asJsonValue } from "../core/semantic-validation.js";
import { canonicalJson, sha256Digest } from "../core/canonical.js";
import {
  ownerToolSchemas,
  type OwnerToolName,
} from "./schemas.js";

interface OwnerToolPolicy {
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
}

const readOnly = (
  title: string,
  description: string,
  openWorldHint: boolean,
): OwnerToolPolicy => ({
  title,
  description,
  annotations: {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint,
  },
});

const write = (
  title: string,
  description: string,
  destructiveHint = false,
): OwnerToolPolicy => ({
  title,
  description,
  annotations: {
    title,
    readOnlyHint: false,
    destructiveHint,
    idempotentHint: true,
    openWorldHint: true,
  },
});

export const OWNER_TOOL_POLICY = {
  tenant_list: readOnly(
    "List managed tenants",
    "Lists allowlisted tenant registry fields without secrets or provider payloads.",
    false,
  ),
  tenant_get: readOnly(
    "Get managed tenant",
    "Returns one tenant's desired and observed lifecycle plus redacted resource references.",
    false,
  ),
  tenant_preflight: readOnly(
    "Preflight tenant onboarding",
    "Checks closed onboarding inputs, credential presence, provider access, naming, capacity, domain and release prerequisites without applying effects.",
    true,
  ),
  tenant_plan_onboarding: readOnly(
    "Plan tenant onboarding",
    "Produces an immutable, expiring onboarding plan for owner review; it does not apply provider effects.",
    true,
  ),
  tenant_drift: readOnly(
    "Inspect tenant drift",
    "Compares allowlisted observed tenant versions and health with desired state without reconciling.",
    true,
  ),
  operation_get: readOnly(
    "Get operation status",
    "Returns redacted operation and step status, including the next resumable step.",
    false,
  ),
  release_plan: readOnly(
    "Plan platform release",
    "Produces an immutable canary-first release plan without migrations, builds, deployments or promotion.",
    true,
  ),
  tenant_prepare_offboarding: readOnly(
    "Prepare tenant offboarding",
    "Produces a retention and manual break-glass checklist only; it never suspends or deletes resources.",
    false,
  ),
  tenant_apply_onboarding: write(
    "Apply tenant onboarding",
    "Starts or continues exactly the approved onboarding plan digest through the operations core.",
  ),
  tenant_resume_operation: write(
    "Resume tenant operation",
    "Resumes the same failed or quarantined operation using its original approved plan and idempotency key.",
  ),
  admin_invite: write(
    "Invite company admin",
    "Sends a personal admin invitation only when the approved operation and smoke-test gates allow it.",
  ),
  machine_enrollment_create: write(
    "Create machine enrollment",
    "Creates one scoped, one-time machine enrollment through an approved operation; no credential is returned as a reusable secret.",
  ),
  machine_revoke: write(
    "Revoke machine",
    "Revokes one named machine credential without deleting tenant data or provider resources.",
    true,
  ),
  support_access_enable: write(
    "Enable support access",
    "Temporarily enables auditable platform support access with a bounded reason and expiry.",
  ),
  support_access_disable: write(
    "Disable support access",
    "Disables platform support access for one tenant without deleting resources.",
    true,
  ),
  tenant_suspend: write(
    "Suspend tenant",
    "Reversibly blocks users, machines and jobs for one tenant; it cannot delete provider resources.",
    true,
  ),
  release_apply: write(
    "Apply platform release",
    "Executes exactly an approved canary-first release plan through the operations core.",
  ),
} as const satisfies Record<OwnerToolName, OwnerToolPolicy>;

export const OWNER_TOOL_ALLOWLIST = Object.freeze(
  Object.keys(OWNER_TOOL_POLICY) as OwnerToolName[],
);

const contractShape = OWNER_TOOL_ALLOWLIST.map((name) => ({
  name,
  annotations: OWNER_TOOL_POLICY[name].annotations,
  input_schema: z.toJSONSchema(ownerToolSchemas[name].input),
  output_schema: z.toJSONSchema(ownerToolSchemas[name].output),
}));

export const MCP_TOOL_CONTRACT_DIGEST = sha256Digest(
  canonicalJson(asJsonValue(contractShape)),
);

export const DESTRUCTIVE_TOOL_NAMES = Object.freeze(
  OWNER_TOOL_ALLOWLIST.filter(
    (name) => OWNER_TOOL_POLICY[name].annotations.destructiveHint === true,
  ),
);

export const MUTATING_TOOL_NAMES = Object.freeze(
  OWNER_TOOL_ALLOWLIST.filter(
    (name) => OWNER_TOOL_POLICY[name].annotations.readOnlyHint !== true,
  ),
);

export const CODEX_APPROVAL_POLICY = Object.freeze({
  default_tools_approval_mode: "writes" as const,
  per_tool: Object.freeze({
    machine_revoke: "prompt" as const,
    support_access_disable: "prompt" as const,
    tenant_suspend: "prompt" as const,
  }),
});
