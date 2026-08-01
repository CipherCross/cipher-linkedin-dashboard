import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(testDir, "../..");
const baselinePath = resolve(repoDir, "supabase/tenant-baseline/v053/053_tenant_baseline.sql");
const manifestPath = resolve(repoDir, "supabase/tenant-baseline/v053/manifest.json");
const inventoryPath = resolve(repoDir, "docs/platform-ops/tenant-schema-inventory-v053.json");
const dependenciesPath = resolve(repoDir, "docs/platform-ops/supabase-dependencies-v053.json");

const baseline = readFileSync(baselinePath, "utf8");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const dependencyInventory = JSON.parse(readFileSync(dependenciesPath, "utf8"));

const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

const sorted = (values) => [...values].sort();
const names = (values) => values.map((value) => value.name ?? value);
const matchAll = (pattern) => [...baseline.matchAll(pattern)];
const equalArrays = (actual, expected) => JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
const compact = (value) => value.replace(/\s+/g, " ").trim();

const actualBaselineSha = createHash("sha256").update(baseline).digest("hex");
const actualBaselineBytes = Buffer.byteLength(baseline);
const manifestFile = manifest.files.find((file) => file.path === "053_tenant_baseline.sql");

assert(inventory.format_version === 1, "inventory format_version must be 1");
assert(inventory.baseline.artifact_version === "v053", "inventory must describe v053");
assert(inventory.baseline.source_file === "supabase/tenant-baseline/v053/053_tenant_baseline.sql", "inventory source file mismatch");
assert(actualBaselineSha === inventory.baseline.baseline_sha256, "inventory baseline SHA-256 is stale");
assert(actualBaselineSha === manifestFile?.sha256, "manifest baseline SHA-256 is stale");
assert(actualBaselineBytes === manifestFile?.bytes, "manifest baseline byte count is stale");
assert(inventory.baseline.source_revision === manifest.source_revision, "inventory source revision mismatch");

const tableMatches = matchAll(/^CREATE TABLE public\.([a-z0-9_]+) \(/gm).map((match) => match[1]);
assert(tableMatches.length === inventory.counts.tables, `table statement count mismatch: ${tableMatches.length}`);
assert(equalArrays(tableMatches, inventory.tables), "table names do not match the baseline");

const viewMatches = matchAll(/^CREATE( OR REPLACE)? VIEW public\.([a-z0-9_]+)/gm).map((match) => ({
  name: match[2],
  operation: match[1] ? "CREATE OR REPLACE VIEW" : "CREATE VIEW",
}));
assert(viewMatches.length === inventory.counts.views, `view declaration count mismatch: ${viewMatches.length}`);
assert(JSON.stringify(viewMatches) === JSON.stringify(inventory.view_declarations), "view declarations do not match the baseline");
const finalViewNames = [...new Set(viewMatches.map((view) => view.name))];
assert(finalViewNames.length === inventory.counts.final_view_objects, `final view object count mismatch: ${finalViewNames.length}`);
assert(equalArrays(finalViewNames, names(inventory.views)), "final view names do not match the baseline");
for (const view of inventory.views) {
  const securityInvoker = new RegExp(`(?:CREATE|CREATE OR REPLACE) VIEW public\\.${view.name} WITH \\(security_invoker='true'\\)`);
  assert(securityInvoker.test(baseline), `view ${view.name} is not marked security_invoker in the final definition`);
}

const functionMatches = matchAll(/^CREATE FUNCTION public\.([a-z0-9_]+)\(/gm).map((match) => match[1]);
assert(functionMatches.length === inventory.counts.functions, `function count mismatch: ${functionMatches.length}`);
assert(equalArrays(functionMatches, inventory.functions.map((entry) => entry.signature.split("(")[0])), "function names do not match the baseline");
for (const functionEntry of inventory.functions) {
  const name = functionEntry.signature.split("(")[0];
  const start = baseline.indexOf(`CREATE FUNCTION public.${name}(`);
  const end = baseline.indexOf(`\nALTER FUNCTION public.${name}(`, start);
  const definition = start >= 0 && end > start ? baseline.slice(start, end) : "";
  assert(start >= 0, `function ${functionEntry.signature} is absent from the baseline`);
  assert(definition.includes(`LANGUAGE ${functionEntry.language}`), `function ${functionEntry.signature} language mismatch`);
  assert(definition.includes("SECURITY DEFINER") === functionEntry.security_definer, `function ${functionEntry.signature} security-definer semantics mismatch`);
  if (functionEntry.search_path === null) {
    assert(!definition.includes("SET search_path"), `function ${functionEntry.signature} unexpectedly sets search_path`);
  } else {
    assert(definition.includes(`SET search_path TO '${functionEntry.search_path}'`), `function ${functionEntry.signature} search_path mismatch`);
  }
  assert(new RegExp(`\\nALTER FUNCTION public\\.${name}\\([^\\n]*\\) OWNER TO ${functionEntry.owner};`).test(baseline), `function ${functionEntry.signature} owner mismatch`);
  const grantedTo = [...baseline.matchAll(new RegExp(`(?:GRANT (?:ALL|EXECUTE) ON FUNCTION public\\.${name}\\([^;]*?\\)\\s+TO\\s+([^;]+);)`, "gi"))]
    .flatMap((match) => match[1].split(","))
    .map((role) => role.trim().toLowerCase())
    .filter((role) => /^[a-z_]+$/.test(role));
  assert(equalArrays([...new Set(grantedTo)], functionEntry.execute_to.map((role) => role.toLowerCase())), `function ${functionEntry.signature} execute ACL mismatch`);
}

const triggerMatches = matchAll(/^CREATE TRIGGER ([a-z0-9_]+) (BEFORE|AFTER) (.*?) ON public\.([a-z0-9_]+).*?EXECUTE FUNCTION public\.([a-z0-9_]+)\(/gm).map((match) => ({
  name: match[1],
  timing: match[2],
  events: match[3],
  table: match[4],
  function: `${match[5]}()`,
}));
assert(triggerMatches.length === inventory.counts.triggers, `trigger count mismatch: ${triggerMatches.length}`);
assert(equalArrays(triggerMatches.map((trigger) => trigger.name), names(inventory.triggers)), "trigger names do not match the baseline");
for (const trigger of inventory.triggers) {
  const actual = triggerMatches.find((candidate) => candidate.name === trigger.name);
  assert(actual?.table === trigger.table, `trigger ${trigger.name} table mismatch`);
  assert(actual?.timing === trigger.timing, `trigger ${trigger.name} timing mismatch`);
  for (const event of trigger.events) assert(compact(actual?.events ?? "").includes(compact(event)), `trigger ${trigger.name} event mismatch: ${event}`);
  assert(actual?.function === trigger.function, `trigger ${trigger.name} function mismatch`);
}

const indexMatches = matchAll(/^CREATE (UNIQUE )?INDEX ([a-z0-9_]+) ON public\.([a-z0-9_]+) USING btree \(([^\n]+)$/gm).map((match) => ({
  name: match[2],
  table: match[3],
  unique: Boolean(match[1]),
  definition: match[0],
}));
assert(indexMatches.length === inventory.counts.explicit_indexes, `explicit index count mismatch: ${indexMatches.length}`);
assert(equalArrays(indexMatches.map((index) => index.name), names(inventory.indexes)), "explicit index names do not match the baseline");
for (const index of inventory.indexes) {
  const actual = indexMatches.find((candidate) => candidate.name === index.name);
  assert(actual?.table === index.table, `index ${index.name} table mismatch`);
  assert(actual?.unique === index.unique, `index ${index.name} uniqueness mismatch`);
  const definition = compact(actual?.definition ?? "").replace(/::text/g, "");
  assert(definition.includes(compact(index.expression)), `index ${index.name} expression mismatch`);
  if (index.predicate) {
    for (const term of index.predicate.split(" AND ")) assert(definition.includes(compact(term)), `index ${index.name} predicate mismatch: ${term}`);
  }
}

const inlineChecks = matchAll(/^\s+CONSTRAINT ([a-z0-9_]+) CHECK/gm).map((match) => match[1]);
const primaryKeys = matchAll(/ADD CONSTRAINT ([a-z0-9_]+) PRIMARY KEY/gm).map((match) => match[1]);
const uniqueConstraints = matchAll(/ADD CONSTRAINT ([a-z0-9_]+) UNIQUE/gm).map((match) => match[1]);
const foreignKeys = matchAll(/ADD CONSTRAINT ([a-z0-9_]+) FOREIGN KEY/gm).map((match) => match[1]);
assert(inlineChecks.length === inventory.counts.check_constraints, `check constraint count mismatch: ${inlineChecks.length}`);
assert(equalArrays(inlineChecks, inventory.constraints.check), "check constraint names do not match the baseline");
assert(primaryKeys.length === inventory.counts.primary_key_constraints, `primary-key constraint count mismatch: ${primaryKeys.length}`);
assert(equalArrays(primaryKeys, names(inventory.constraints.primary_keys)), "primary-key names do not match the baseline");
assert(uniqueConstraints.length === inventory.counts.unique_constraints, `unique constraint count mismatch: ${uniqueConstraints.length}`);
assert(equalArrays(uniqueConstraints, names(inventory.constraints.unique)), "unique constraint names do not match the baseline");
assert(foreignKeys.length === inventory.counts.foreign_key_constraints, `foreign-key constraint count mismatch: ${foreignKeys.length}`);
assert(equalArrays(foreignKeys, names(inventory.constraints.foreign_keys)), "foreign-key names do not match the baseline");
assert(inlineChecks.length + primaryKeys.length + uniqueConstraints.length + foreignKeys.length === inventory.counts.constraints, "total constraint count mismatch");
assert(primaryKeys.length + uniqueConstraints.length === inventory.counts.constraint_backed_indexes, "constraint-backed index count mismatch");
assert(indexMatches.length + primaryKeys.length + uniqueConstraints.length === inventory.counts.indexes, "total index count mismatch");

const policyMatches = matchAll(/^CREATE POLICY "([^"]+)" ON public\.([a-z0-9_]+) FOR SELECT TO ([a-z0-9_]+)/gm).map((match) => ({
  name: match[1],
  table: match[2],
  role: match[3],
}));
assert(policyMatches.length === inventory.counts.policies, `policy count mismatch: ${policyMatches.length}`);
assert(inventory.rls.policy_count_per_table === 2, "RLS inventory must require two policies per table");
assert(equalArrays([...new Set(policyMatches.map((policy) => policy.table))], inventory.rls.enabled_tables), "RLS table names do not match policy tables");
for (const table of inventory.rls.enabled_tables) {
  assert(policyMatches.filter((policy) => policy.table === table).length === 2, `RLS policy count mismatch for ${table}`);
  assert(policyMatches.some((policy) => policy.table === table && policy.role === "authenticated" && policy.name === `active members can read ${table}`), `member policy missing for ${table}`);
  assert(policyMatches.some((policy) => policy.table === table && policy.role === "ai_sql_runner" && policy.name === "ai sql runner can read"), `AI policy missing for ${table}`);
}

const rlsMatches = matchAll(/^ALTER TABLE public\.([a-z0-9_]+) ENABLE ROW LEVEL SECURITY;/gm).map((match) => match[1]);
assert(rlsMatches.length === inventory.counts.rls_enabled_tables, `RLS-enabled table count mismatch: ${rlsMatches.length}`);
assert(equalArrays(rlsMatches, inventory.rls.enabled_tables), "RLS-enabled tables do not match the baseline");

const identityMatches = matchAll(/SEQUENCE NAME public\.([a-z0-9_]+)/g).map((match) => match[1]);
assert(identityMatches.length === inventory.counts.identity_columns, `identity sequence count mismatch: ${identityMatches.length}`);
assert(equalArrays(identityMatches, inventory.sequences), "identity sequence names do not match the baseline");

const extensionMatches = matchAll(/^create extension if not exists ([a-z0-9_]+);/gim).map((match) => match[1]);
assert(extensionMatches.length === inventory.counts.extensions, `extension count mismatch: ${extensionMatches.length}`);
assert(equalArrays(extensionMatches, inventory.extensions.map((extension) => extension.name)), "extension names do not match the baseline");
assert(inventory.source_extension_inventory.length === inventory.counts.source_observed_extensions, "source extension inventory count mismatch");
assert(inventory.source_extension_inventory.some((extension) => extension.name === "supabase_vault" && extension.declared_in_baseline === false), "source-only supabase_vault absence is not recorded");

const requiredDependencyIds = [
  "managed-schemas",
  "auth-users-foreign-key",
  "auth-uid",
  "supabase-roles",
  "storage-buckets",
  "storage-objects-and-policies",
  "agent-artifact-storage",
  "supabase-migration-ledger",
  "postgrest",
  "supabase-auth-runtime",
  "supabase-storage-runtime",
  "service-role-transport",
  "pgcrypto",
  "supabase-vault-negative-check",
];
const dependenciesById = new Map(dependencyInventory.dependencies.map((dependency) => [dependency.id, dependency]));
for (const id of requiredDependencyIds) assert(dependenciesById.has(id), `required dependency is missing: ${id}`);
const agentArtifactDependency = dependenciesById.get("agent-artifact-storage");
assert(agentArtifactDependency?.provider === "Supabase Storage", "agent-artifact dependency provider mismatch");
assert(agentArtifactDependency?.object.includes("agent") && agentArtifactDependency?.object.includes("agent.py"), "agent-artifact dependency object semantics are weak");
assert(agentArtifactDependency?.file.includes("sync-agent/config.example.yaml") && agentArtifactDependency?.file.includes("sync-agent/deploy.sh"), "agent-artifact dependency lacks config and release evidence");
assert(agentArtifactDependency?.replacement_owner.includes("S23"), "agent-artifact dependency owner is not pinned to S23");
for (const dependency of dependencyInventory.dependencies) {
  assert(typeof dependency.file === "string" && dependency.file.length > 0, `dependency ${dependency.id} lacks file evidence`);
  assert(typeof dependency.object === "string" && dependency.object.length > 0, `dependency ${dependency.id} lacks object evidence`);
  assert(typeof dependency.purpose === "string" && dependency.purpose.length > 0, `dependency ${dependency.id} lacks purpose`);
  assert(typeof dependency.migration_risk === "string" && dependency.migration_risk.length > 0, `dependency ${dependency.id} lacks migration risk`);
}

const serializedArtifacts = JSON.stringify({ inventory, dependencyInventory });
assert(!/sk-[A-Za-z0-9]{20,}/.test(serializedArtifacts), "inventory contains a possible API key");
assert(!/Bearer [A-Za-z0-9._-]{20,}/.test(serializedArtifacts), "inventory contains a possible bearer token");

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Tenant v053 machine-readable inventory assertions passed");
  console.log(`tables=${inventory.counts.tables} views=${inventory.counts.views} final_view_objects=${inventory.counts.final_view_objects} functions=${inventory.counts.functions} triggers=${inventory.counts.triggers}`);
  console.log(`indexes=${inventory.counts.indexes} constraints=${inventory.counts.constraints} rls_tables=${inventory.counts.rls_enabled_tables} policies=${inventory.counts.policies} dependencies=${dependencyInventory.dependencies.length}`);
}
