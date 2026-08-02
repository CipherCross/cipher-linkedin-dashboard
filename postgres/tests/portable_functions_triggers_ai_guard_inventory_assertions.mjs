import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const inventory = JSON.parse(
  readFileSync("docs/platform-ops/portable-functions-triggers-ai-guard-inventory-v1.json", "utf8"),
);
const sourceInventory = JSON.parse(
  readFileSync("docs/platform-ops/tenant-schema-inventory-v053.json", "utf8"),
);
const artifact = readFileSync("postgres/tenant-baseline/v1/003_functions_triggers_ai_guard.sql", "utf8");
const roleBootstrap = readFileSync("postgres/tests/portable_functions_triggers_ai_guard_role_bootstrap.sql", "utf8");
const catalog = readFileSync("postgres/tests/portable_functions_triggers_ai_guard_catalog_assertions.sql", "utf8");
const behavior = readFileSync("postgres/tests/portable_functions_triggers_behavior_assertions.sql", "utf8");
const aiBehavior = readFileSync("postgres/tests/portable_ai_guard_behavior_assertions.sql", "utf8");
const cleanroom = readFileSync("postgres/tests/portable_functions_triggers_ai_guard_cleanroom.sh", "utf8");
const fixtures = readFileSync("postgres/tests/portable_functions_triggers_fixture_seed.sql", "utf8");

const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sorted = (values) => [...values].sort();

// --- inventory identity -----------------------------------------------------

assert(inventory.format_version === 1, "inventory format_version must be 1");
assert(inventory.inventory_type === "portable-functions-triggers-ai-guard", "inventory type mismatch");
assert(inventory.artifact.sha256 === sha256(artifact), "artifact SHA-256 is stale");
assert(
  inventory.artifact.applies_after === "postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql",
  "S07 must apply after the S06 artifact",
);
assert(inventory.artifact.apply_principal === "app_migration", "the artifact must be applied by app_migration");

// --- 1:1 parity with the S04 source inventory -------------------------------

const sourceFunctions = sorted(sourceInventory.functions.map((f) => f.signature.replace(/, /g, ",")));
const portableFunctions = sorted(inventory.functions.map((f) => f.signature));
assert(
  JSON.stringify(portableFunctions) === JSON.stringify(sourceFunctions),
  `portable function set differs from the source: ${JSON.stringify(portableFunctions)} vs ${JSON.stringify(sourceFunctions)}`,
);
assert(inventory.counts.functions === 13, "portable function count must be 13");
assert(inventory.counts.triggers === 12, "portable trigger count must be 12");
assert(
  inventory.source.source_functions === sourceInventory.functions.length &&
    inventory.source.source_triggers === sourceInventory.triggers.length,
  "recorded source counts do not match the S04 inventory",
);
assert(inventory.source.invented_business_semantics.length === 0, "S07 must not invent business semantics");

const sourceTriggers = sorted(sourceInventory.triggers.map((t) => `${t.table}.${t.name}`));
const portableTriggers = sorted(inventory.triggers.map((t) => `${t.table}.${t.name}`));
assert(
  JSON.stringify(portableTriggers) === JSON.stringify(sourceTriggers),
  "portable trigger set differs from the source",
);

// Every source trigger is created verbatim, with the same timing and event list.
for (const trigger of sourceInventory.triggers) {
  const events = trigger.events.join(" OR ");
  const expected = `CREATE TRIGGER ${trigger.name} ${trigger.timing} ${events} ON public.${trigger.table} FOR EACH ROW EXECUTE FUNCTION public.${trigger.function};`;
  assert(artifact.includes(expected), `trigger statement missing or altered: ${expected}`);
}

// Security-definer and search_path properties are declared per function and are
// consistent with what the artifact actually creates.
for (const fn of inventory.functions) {
  const name = fn.signature.slice(0, fn.signature.indexOf("("));
  assert(
    new RegExp(`CREATE FUNCTION public\\.${name}\\(`).test(artifact),
    `artifact does not create ${fn.signature}`,
  );
  assert(typeof fn.search_path === "string", `${fn.signature} must declare a fixed search_path`);
  assert(
    fn.owner === "app_owner" || (fn.owner === "app_ai_runner" && name === "ai_execute_sql"),
    `${fn.signature} has an unexpected owner ${fn.owner}`,
  );
  assert(!fn.execute_to.includes("PUBLIC"), `${fn.signature} must not grant EXECUTE to PUBLIC`);
  assert(
    !fn.execute_to.some((role) => ["anon", "authenticated", "service_role", "ai_sql_runner"].includes(role)),
    `${fn.signature} grants EXECUTE to a provider role`,
  );
  for (const role of fn.execute_to) {
    const pattern = new RegExp(
      `GRANT EXECUTE ON FUNCTION public\\.${name}\\([^;]*\\) TO [^;]*\\b${role}\\b`,
    );
    assert(pattern.test(artifact), `artifact is missing the EXECUTE grant of ${fn.signature} to ${role}`);
  }
  if (fn.execute_to.length === 0) {
    assert(
      !new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(`).test(artifact),
      `${fn.signature} should have no EXECUTE grant`,
    );
  }
}
assert(
  inventory.functions.filter((f) => f.security_definer).length === inventory.counts.security_definer_functions,
  "security definer count does not match the function list",
);
assert(
  (artifact.match(/^CREATE FUNCTION public\./gm) ?? []).length === 13,
  "the artifact must create exactly 13 functions",
);
assert(
  (artifact.match(/^CREATE TRIGGER /gm) ?? []).length === 12,
  "the artifact must create exactly 12 triggers",
);
assert(
  (artifact.match(/^REVOKE ALL ON FUNCTION public\./gm) ?? []).length === 13,
  "every function must have an explicit REVOKE from PUBLIC",
);

// --- milestone contract -----------------------------------------------------

const milestone = inventory.milestone_contract;
assert(milestone.trigger === "leads_keep_milestones", "the milestone trigger name changed");
assert(
  JSON.stringify(milestone.columns) ===
    JSON.stringify(["invited_at", "connected_at", "first_message_at", "replied_at", "added_at"]),
  "milestone column set changed",
);
assert(/allowed/i.test(milestone.null_to_non_null), "NULL to non-NULL must remain allowed");
assert(/preserved/i.test(milestone.non_null_to_null), "non-NULL to NULL must remain preserved");
assert(/idempotent/i.test(milestone.repeated_sync_upsert), "repeated sync upserts must remain idempotent");
assert(
  milestone.sanctioned_regress.only_writer === "delete_manual_message(bigint)" &&
    milestone.sanctioned_regress.scope === "transaction_local",
  "the sanctioned milestone regress path changed owner or scope",
);
for (const column of milestone.columns) {
  assert(
    new RegExp(`new\\.${column}\\s+:= coalesce\\(new\\.${column},\\s+old\\.${column}\\)`).test(artifact),
    `leads_keep_milestones no longer preserves ${column}`,
  );
}
assert(
  artifact.includes("current_setting('app.allow_milestone_regress', true)") &&
    artifact.includes("set_config('app.allow_milestone_regress', 'on', true)"),
  "the sanctioned, transaction-local milestone regress flag is missing",
);
for (const assertionName of [
  "milestone_null_to_non_null_allowed",
  "milestone_non_null_to_null_blocked",
  "milestone_partial_update_preserved",
  "repeated_upsert_idempotent",
  "regress_still_blocked_after_recompute",
]) {
  assert(behavior.includes(assertionName), `behavior assertions lack ${assertionName}`);
}
for (const actorCase of ["missing", "malformed", "empty", "unknown", "inactive"]) {
  assert(behavior.includes(`${actorCase}_actor_denied`), `behavior assertions lack the ${actorCase} actor case`);
}
assert(behavior.includes("valid_actor_is_active_member"), "behavior assertions lack the valid actor case");

// --- AI SQL guard -----------------------------------------------------------

const guard = inventory.ai_sql_guard;
assert(guard.sandbox_role.name === "app_ai_runner", "the AI sandbox role name changed");
assert(guard.sandbox_role.replaces_provider_role === "ai_sql_runner", "the replaced provider role is not recorded");
assert(
  guard.sandbox_role.login === false &&
    guard.sandbox_role.superuser === false &&
    guard.sandbox_role.bypass_rls === false &&
    guard.sandbox_role.object_owner === false &&
    guard.sandbox_role.credentials_in_sql === false,
  "the AI sandbox role contract weakened",
);
assert(guard.execution_principal.name === "app_system", "the AI execution principal changed");
assert(
  guard.execution_principal.table_privileges.length === 0 &&
    guard.execution_principal.other_function_privileges.length === 0,
  "the AI execution principal gained privileges beyond the guard",
);
for (const denied of ["app_runtime", "app_readonly", "PUBLIC", "anonymous"]) {
  assert(guard.denied_direct_execution.includes(denied), `${denied} must be denied direct guard execution`);
}
assert(guard.result_shape.empty_result === "[]" && guard.result_shape.never_null === true, "result shape weakened");
assert(guard.result_shape.row_cap === 1000, "the 1000 row cap changed");
assert(guard.statement_timeout.declared === "10s", "the 10 second limit changed");
assert(
  typeof guard.statement_timeout.boundary === "string" && guard.statement_timeout.boundary.length > 0,
  "the statement timeout boundary must stay documented",
);

const guardBody = artifact.slice(artifact.indexOf("CREATE FUNCTION public.ai_execute_sql"));
assert(
  guardBody.includes("only a single statement is allowed"),
  "the guard lost its explicit multi-statement rejection",
);
assert(guardBody.includes("only SELECT / WITH queries are allowed"), "the guard lost its SELECT/WITH check");
assert(guardBody.includes("unterminated literal or comment"), "the guard lost its malformed-input check");
assert(guardBody.includes("AI SQL guard: empty statement"), "the guard lost its empty-input check");
assert(
  guardBody.includes("mutation, DDL and session statements are not allowed"),
  "the guard lost its mutation rejection",
);
assert(
  guardBody.includes("set_config('statement_timeout', '10000', true)"),
  "the guard lost the source's transaction-local statement timeout",
);
assert(
  guardBody.includes("select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) sub limit 1000) t"),
  "the guard lost the source jsonb_agg result shape or the 1000 row cap",
);
assert(
  /ALTER FUNCTION public\.ai_execute_sql\(query text\) OWNER TO app_ai_runner;/.test(artifact),
  "the guard is not owned by the AI sandbox role",
);
assert(
  /GRANT EXECUTE ON FUNCTION public\.ai_execute_sql\(query text\) TO app_system;/.test(artifact),
  "the guard is not granted to the AI execution principal",
);
assert(
  !/GRANT EXECUTE ON FUNCTION public\.ai_execute_sql\([^;]*\) TO [^;]*\b(app_runtime|app_readonly|app_machine|PUBLIC)\b/.test(artifact),
  "the guard was granted to a principal that must not reach it",
);
assert(
  /REVOKE CREATE ON SCHEMA public FROM app_ai_runner;/.test(artifact),
  "the AI sandbox keeps CREATE on schema public",
);
assert(
  artifact.indexOf("GRANT USAGE, CREATE ON SCHEMA public TO app_ai_runner;") <
    artifact.indexOf("REVOKE CREATE ON SCHEMA public FROM app_ai_runner;"),
  "the temporary CREATE grant is not revoked after the ownership transfer",
);

// The AI sandbox never receives a write privilege or a business function.
assert(
  !/GRANT[^;]*\b(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b[^;]*TO[^;]*app_ai_runner/.test(artifact),
  "the AI sandbox role was granted a write privilege",
);
assert(
  !/GRANT[^;]*ON ALL SEQUENCES[^;]*app_ai_runner/.test(artifact),
  "the AI sandbox role was granted sequence privileges",
);
assert(
  !new RegExp("GRANT SELECT[^;]*\\bpublic\\.(users|user_identities)\\b[^;]*TO[^;]*app_ai_runner").test(artifact),
  "the AI sandbox role can read canonical identity tables",
);
assert(
  (artifact.match(/_ai_read ON public\./g) ?? []).length === 25,
  "the AI read policy count must be 25",
);
assert(
  !/CREATE POLICY (users|user_identities)_ai_read/.test(artifact),
  "an identity table received an AI read policy",
);

// Column-scoped grants keep operator secrets and membership metadata away.
assert(
  /GRANT SELECT\(id, name, active, created_at\) ON TABLE public\.team_members TO app_ai_runner;/.test(artifact),
  "team_members AI column grants changed",
);
assert(
  /GRANT SELECT\(id, label, last_sync_at, agent_version, created_at, account_name, account_url, account_avatar, config_updated_at\)/.test(
    artifact,
  ),
  "instances AI column grants changed",
);
assert(guard.data_boundary.withheld.instances.includes("config"), "instances.config must stay withheld");
for (const column of ["email", "role", "user_id"]) {
  assert(guard.data_boundary.withheld.team_members.includes(column), `team_members.${column} must stay withheld`);
}
for (const assertionName of [
  "plain_select_allowed",
  "with_statement_allowed",
  "empty_result_is_json_array",
  "row_cap_enforced",
  "timeout_enforced",
  "timeout_boundary_pinned",
  "literals_and_comments_are_not_statements",
]) {
  assert(aiBehavior.includes(assertionName), `AI guard assertions lack ${assertionName}`);
}
for (const rejected of [
  "insert into leads",
  "update leads set",
  "delete from leads",
  "merge into leads",
  "create table ai_probe",
  "drop table leads",
  "select 1; select 2",
  "select * from leads for update",
]) {
  assert(aiBehavior.includes(rejected), `AI guard assertions lack the rejected case: ${rejected}`);
}

// --- role bootstrap ---------------------------------------------------------

for (const role of ["app_ai_runner", "app_ai_client"]) {
  const roleBlock = roleBootstrap.match(new RegExp(`CREATE ROLE ${role}[\\s\\S]*?;`))?.[0] ?? "";
  assert(roleBlock.includes("NOSUPERUSER"), `${role} must be NOSUPERUSER`);
  assert(roleBlock.includes("NOBYPASSRLS"), `${role} must be NOBYPASSRLS`);
  assert(roleBlock.includes("NOINHERIT"), `${role} must be NOINHERIT`);
}
assert(
  /CREATE ROLE app_ai_runner[\s\S]*?NOLOGIN[\s\S]*?;/.test(roleBootstrap),
  "app_ai_runner must have no LOGIN",
);
assert(!/CREATE ROLE/i.test(artifact), "the S07 artifact must not bootstrap roles");
assert(!/PASSWORD/i.test(roleBootstrap) && !/PASSWORD/i.test(artifact), "no role password may appear in SQL");
assert(
  JSON.stringify(inventory.clean_room_tests.test_only_roles) === JSON.stringify(["app_ai_client"]),
  "test-only role inventory mismatch",
);

// --- clean-room harness applies all three artifacts in order ----------------

const applyOrder = inventory.clean_room_tests.apply_order;
assert(
  JSON.stringify(applyOrder) ===
    JSON.stringify([
      "postgres/tenant-baseline/v1/001_portable_business_baseline.sql",
      "postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql",
      "postgres/tenant-baseline/v1/003_functions_triggers_ai_guard.sql",
    ]),
  "clean-room apply order mismatch",
);
for (const file of applyOrder) {
  assert(cleanroom.includes(file), `clean-room harness does not apply ${file}`);
}
assert(
  cleanroom.includes("portable_identity_roles_rls_catalog_assertions.sql"),
  "the clean-room does not replay the S06 catalog assertions",
);
assert(
  cleanroom.includes("run_as app_migration") &&
    cleanroom.includes("run_as app_runtime") &&
    cleanroom.includes("run_as app_ai_client"),
  "the clean-room does not use separate migration, runtime and AI principals",
);
assert(
  cleanroom.includes("Runtime principal unexpectedly executed the AI SQL guard"),
  "the clean-room does not prove the runtime principal cannot reach the guard",
);

// --- static portability and scope checks ------------------------------------

const portableFiles = {
  "003_functions_triggers_ai_guard.sql": artifact,
  "role bootstrap": roleBootstrap,
  "catalog assertions": catalog,
  "behavior assertions": behavior,
  "AI guard assertions": aiBehavior,
  "fixture seed": fixtures,
  "clean-room harness": cleanroom,
};
const providerPatterns = [
  /\bauth\.(uid|jwt|role)\b/i,
  /\bstorage\.(objects|buckets)\b/i,
  /supabase_migrations/i,
  /postgrest/i,
  /\bsupabase\b/i,
  /\bservice_role\b/i,
  /\bai_sql_runner\b/i,
  /\bsb-[a-z0-9]{8,}\b/i,
];
for (const [label, contents] of Object.entries(portableFiles)) {
  for (const pattern of providerPatterns) {
    // The catalog assertions and the inventory deliberately name the provider
    // roles they must prove absent; the artifact itself never may.
    if (label !== "003_functions_triggers_ai_guard.sql" && label !== "fixture seed") continue;
    assert(!pattern.test(contents), `forbidden provider marker ${pattern} in ${label}`);
  }
}
const secretPatterns = [/\bPASSWORD\b/i, /\bSECRET\b/i, /\bAPI[_ -]?KEY\b/i, /\bBEARER\b/i, /\bTOKEN\b/i];
for (const [label, contents] of Object.entries(portableFiles)) {
  for (const pattern of secretPatterns) {
    assert(!pattern.test(contents), `possible credential marker ${pattern} in ${label}`);
  }
}
assert(!/anon\b|authenticated\b/.test(artifact), "a provider browser role leaked into the artifact");

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Portable functions, triggers and AI SQL guard inventory assertions passed");
  console.log(
    `functions=${inventory.counts.functions} triggers=${inventory.counts.triggers} ` +
      `security_definer=${inventory.counts.security_definer_functions} ` +
      `ai_policies=${inventory.counts.ai_read_policies} policies_total=${inventory.counts.policies_total_after_s07}`,
  );
  console.log(`artifact_sha256=${sha256(artifact)}`);
}
