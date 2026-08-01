import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const inventory = JSON.parse(readFileSync("docs/platform-ops/portable-identity-roles-rls-inventory-v1.json", "utf8"));
const artifact = readFileSync("postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql", "utf8");
const roleBootstrap = readFileSync("postgres/tests/portable_identity_roles_rls_role_bootstrap.sql", "utf8");
const behavior = readFileSync("postgres/tests/portable_identity_roles_rls_behavior_assertions.sql", "utf8");
const cleanroom = readFileSync("postgres/tests/portable_identity_roles_rls_cleanroom.sh", "utf8");
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compact = (value) => value.replace(/\s+/g, " ").trim();
const expectedBusinessTables = [
  "team_members",
  "annotations",
  "briefing_jobs",
  "briefings",
  "messages",
  "campaign_steps",
  "campaigns",
  "coaching_digest",
  "conversation_coaching",
  "conversation_follow_up_state",
  "events",
  "follow_up_events",
  "hypotheses",
  "hypothesis_campaigns",
  "icp_industries",
  "icp_personas",
  "icps",
  "instances",
  "lead_gender_reviews",
  "lead_notes",
  "leads",
  "pipeline_events",
  "playbook",
  "saved_searches",
  "sync_runs",
];
const expectedRlsTables = [...expectedBusinessTables.filter((name) => name !== "team_members"), "team_members", "users", "user_identities"];
const tableSql = (name) => {
  const match = artifact.match(new RegExp(`CREATE TABLE public\\.${name} \\([\\s\\S]*?\\n\\);`));
  return match?.[0] ?? "";
};

assert(inventory.format_version === 1, "inventory format_version must be 1");
assert(inventory.inventory_type === "portable-identity-roles-rls", "inventory type mismatch");
assert(inventory.artifact.sha256 === sha256(artifact), "artifact SHA-256 is stale");
assert(inventory.canonical_users.application_owned === true, "canonical users must be application-owned");
assert(inventory.canonical_users.provider_specific_columns.length === 0, "canonical users contain provider-specific columns");
assert(JSON.stringify(inventory.provider_mapping.columns) === JSON.stringify(["user_id", "provider", "provider_subject"]), "provider mapping columns mismatch");
assert(inventory.membership.canonical_user_column === "user_id", "team_members must use canonical user_id");
assert(inventory.membership.provider_specific_columns.length === 0, "membership contains provider-specific columns");
assert(inventory.business_tables.count === 25, "business table count mismatch");
assert(JSON.stringify(inventory.business_tables.names) === JSON.stringify(expectedBusinessTables), "business table inventory mismatch");
assert(inventory.rls.enabled_tables === 27, "RLS table count mismatch");
assert(JSON.stringify([...inventory.rls.identity_boundary_tables].sort()) === JSON.stringify(["team_members", "user_identities", "users"]), "identity RLS boundary inventory mismatch");
assert(inventory.actor_context.kind.includes("ActorContext.kind=user"), "S03 user ActorContext boundary is missing");
assert(inventory.actor_context.machine_system.includes("S21") && inventory.actor_context.machine_system.includes("S15"), "machine/system future owners are missing");

for (const table of expectedRlsTables) {
  assert(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`).test(artifact), `RLS not enabled for ${table}`);
}
for (const table of expectedBusinessTables.filter((name) => name !== "team_members")) {
  assert(new RegExp(`CREATE POLICY ${table}_active_member ON public\\.${table}`).test(artifact), `shared policy missing for ${table}`);
}
for (const table of ["users", "user_identities", "team_members"]) {
  assert(new RegExp(`CREATE POLICY ${table}_active_actor_select ON public\\.${table}`).test(artifact), `identity policy missing for ${table}`);
}

assert(tableSql("users").includes("id uuid"), "canonical user id must be UUID");
assert(!/(provider|provider_subject)/i.test(tableSql("users")), "provider fields leaked into canonical users");
assert(tableSql("user_identities").includes("user_id uuid"), "mapping user_id must be UUID");
assert(tableSql("user_identities").includes("provider_subject text"), "mapping provider_subject is missing");
assert(/ALTER TABLE public\.team_members\s+ADD COLUMN user_id uuid NOT NULL;/.test(artifact), "team_members canonical user_id is not required");
assert(!/auth_user_id/i.test(artifact), "provider-specific team_members identity column leaked");

for (const role of ["app_owner", "app_migration", "app_runtime", "app_readonly", "app_machine", "app_system"]) {
  const roleBlock = roleBootstrap.match(new RegExp(`CREATE ROLE ${role}[\\s\\S]*?;`))?.[0] ?? "";
  assert(roleBlock.includes("NOSUPERUSER"), `${role} must be NOSUPERUSER`);
  assert(roleBlock.includes("NOBYPASSRLS"), `${role} must be NOBYPASSRLS`);
  assert(roleBlock.includes("NOINHERIT"), `${role} must be NOINHERIT`);
}
assert(inventory.roles.owner.object_owner === true && inventory.roles.owner.login === false, "owner role contract mismatch");
assert(inventory.roles.migration.login === true && inventory.roles.migration.superuser === false, "migration role must be a non-superuser login");
assert(JSON.stringify(inventory.roles.migration.can_set_role) === JSON.stringify(["app_owner"]), "migration SET ROLE boundary mismatch");
assert(inventory.roles.runtime.login === true && inventory.roles.runtime.object_owner === false, "runtime principal contract mismatch");
assert(JSON.stringify(inventory.roles.runtime.can_set_role) === JSON.stringify([]), "runtime must not have SET ROLE targets");
assert(inventory.roles.machine.fail_closed === true && inventory.roles.system.fail_closed === true, "machine/system roles must fail closed");
assert(artifact.includes("SET ROLE app_owner;"), "artifact must enter the dedicated owner role through the migration principal");
assert(!/CREATE ROLE/i.test(artifact), "S06 artifact must not bootstrap roles as postgres");
assert(/ALTER TABLE public\.users OWNER TO app_owner;/.test(artifact), "app_owner must own canonical users");
assert(!/OWNER TO app_runtime/.test(artifact), "runtime role must not own objects");
assert(!artifact.includes("user_identities_user_id_idx") && !artifact.includes("team_members_user_id_idx"), "duplicate identity indexes remain in the artifact");
assert(JSON.stringify(inventory.duplicate_indexes_removed) === JSON.stringify(["user_identities_user_id_idx", "team_members_user_id_idx"]), "duplicate index removal inventory mismatch");
assert(/GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_runtime, app_readonly;/.test(artifact), "runtime read grant missing");
assert(/GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;/.test(artifact), "runtime sequence grant missing");
assert(/REVOKE ALL ON SCHEMA public FROM PUBLIC;/.test(artifact), "anonymous schema access was not revoked");
assert(/REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;/.test(artifact), "anonymous table access was not revoked");
assert((artifact.match(/FOR ALL TO app_runtime, app_readonly/g) ?? []).length === 24, "shared RLS policy count mismatch");
assert((artifact.match(/FOR SELECT TO app_runtime, app_readonly/g) ?? []).length === 3, "identity RLS policy count mismatch");
assert((artifact.match(/current_setting\('app\.actor_id', true\)/g) ?? []).length > 60, "actor context is not used by policies");
assert(artifact.includes("SET LOCAL app.actor_id"), "transaction-local actor contract is missing");
assert(inventory.clean_room_tests.artifact_apply_principal === "app_migration", "clean-room artifact principal is not app_migration");
assert(inventory.clean_room_tests.runtime_principal === "app_runtime", "clean-room runtime principal is not app_runtime");
for (const actorCase of ["active", "missing", "malformed", "unknown", "inactive", "cross-user"]) {
  assert(behavior.includes(actorCase), `behavior assertions lack ${actorCase} actor case`);
}
assert(/INSERT INTO public\.annotations/.test(behavior) && /UPDATE public\.annotations/.test(behavior) && /DELETE FROM public\.annotations/.test(behavior), "positive business DML assertions are incomplete");
assert(cleanroom.includes("--username app_migration") && cleanroom.includes("--username app_runtime"), "clean-room does not use separate migration/runtime principals");

const forbiddenPatterns = [
  /auth\./i,
  /storage\./i,
  /supabase_migrations/i,
  /postgrest/i,
  /\b(anon|authenticated|service_role|ai_sql_runner)\b/i,
  /\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER)\b/i,
  /\bAI[_ -]?EXECUTE[_ -]?SQL\b/i,
  /\b(PASSWORD|CREDENTIALS?|SECRETS?|TOKENS?|API[_ -]?KEYS?)\b/i,
];
for (const pattern of forbiddenPatterns) assert(!pattern.test(artifact), `forbidden portable artifact marker: ${pattern}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Portable identity, roles and RLS inventory assertions passed");
  console.log(`business_tables=${inventory.business_tables.count} rls_tables=${inventory.rls.enabled_tables} policies=27`);
  console.log(`artifact_sha256=${sha256(artifact)}`);
}
