import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const inventory = readJson("docs/platform-ops/portable-business-schema-inventory-v1.json");
const sourceInventory = readJson("docs/platform-ops/tenant-schema-inventory-v053.json");
const sourceDependencies = readJson("docs/platform-ops/supabase-dependencies-v053.json");
const baseline = readFileSync("postgres/tenant-baseline/v1/001_portable_business_baseline.sql", "utf8");
const source = readFileSync("supabase/tenant-baseline/v053/053_tenant_baseline.sql", "utf8");
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};
const sorted = (values) => [...values].sort();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compact = (value) => value.replace(/\s+/g, " ").trim();
const names = (values) => values.map((value) => value.name ?? value);
const tableSql = (sql) => [...sql.matchAll(/^CREATE TABLE public\.([a-z0-9_]+) \([\s\S]*?\n\);/gm)]
  .map((match) => ({ name: match[1], sql: match[0] }));
const identitySql = (sql) => [...sql.matchAll(/^ALTER TABLE public\.([a-z0-9_]+) ALTER COLUMN ([a-z0-9_]+) ADD GENERATED ALWAYS AS IDENTITY \([\s\S]*?\n\);/gm)]
  .map((match) => ({ table: match[1], column: match[2], sql: match[0] }));
const constraintSql = (sql) => [...sql.matchAll(/^ALTER TABLE ONLY public\.([a-z0-9_]+)\n    ADD CONSTRAINT ([a-z0-9_]+) ([\s\S]*?);\n/gm)]
  .map((match) => ({ table: match[1], name: match[2], definition: match[3], sql: match[0].trim() }));
const indexSql = (sql) => [...sql.matchAll(/^CREATE (UNIQUE )?INDEX ([a-z0-9_]+) ON public\.([a-z0-9_]+) USING btree \(([\s\S]*?)\);/gm)]
  .map((match) => ({ name: match[2], table: match[3], unique: Boolean(match[1]), sql: match[0] }));
const viewSql = (sql) => [...sql.matchAll(/^CREATE VIEW public\.([a-z0-9_]+)(?: WITH \([^\n]+\))? AS\n[\s\S]*?;/gm)]
  .map((match) => ({ name: match[1], sql: match[0] }));
const sourceTables = tableSql(source).map(({ name, sql }) => ({
  name,
  sql: sql.replace(/\n    auth_user_id uuid,/, ""),
}));
const portableTables = tableSql(baseline);
const sourceIdentities = identitySql(source);
const portableIdentities = identitySql(baseline);
const sourceConstraints = constraintSql(source).filter(({ sql }) => !sql.includes("auth."));
const portableConstraints = constraintSql(baseline);
const sourceIndexes = indexSql(source).filter(({ sql }) => !sql.includes("auth_user_id"));
const portableIndexes = indexSql(baseline);
const sourceViews = new Map();
for (const name of inventory.views.map((view) => view.name)) {
  if (name === "campaign_metrics") {
    const match = source.match(/CREATE OR REPLACE VIEW public\.campaign_metrics(?: WITH \([^\n]+\))? AS\n[\s\S]*?;(?=\n\n\n--\n-- Name: leads archive_follow_up_on_last_lead_delete)/);
    sourceViews.set(name, match?.[0]?.replace(/^CREATE OR REPLACE VIEW /, "CREATE VIEW "));
  } else {
    const match = source.match(new RegExp(`CREATE VIEW public\\.${name}(?: WITH \\([^\\n]+\\))? AS\\n[\\s\\S]*?;`));
    sourceViews.set(name, match?.[0]);
  }
}
const portableViews = new Map(viewSql(baseline).map((view) => [view.name, view.sql]));

assert(inventory.format_version === 1, "portable inventory format_version must be 1");
assert(inventory.inventory_type === "portable-business-schema", "portable inventory type mismatch");
assert(sha256(baseline) === inventory.baseline.sha256, "portable inventory baseline SHA-256 is stale");
assert(sha256(readFileSync("docs/platform-ops/tenant-schema-inventory-v053.json")) === inventory.source_contract.inventory_sha256, "portable source inventory SHA-256 is stale");
assert(sourceInventory.functions.find(({ signature }) => signature === "archive_follow_up_after_last_lead()")?.execute_to?.includes("service_role"), "S04 archive trigger execute ACL correction is not pinned");
assert(sourceInventory.function_acl_semantics?.meaning === "explicit_final_grant_roles_only", "S04 function ACL semantics are not pinned");
assert(sourceInventory.provider_bootstrap.absent_bucket === "agent", "S04 agent bucket negative dependency is not pinned");
assert(sourceDependencies.dependencies.some(({ id }) => id === "agent-artifact-storage"), "S04 agent-artifact Storage dependency is not pinned");
assert(portableTables.length === inventory.counts.tables, `table count mismatch: ${portableTables.length}`);
assert(sorted(portableTables.map(({ name }) => name).filter((name) => name !== "team_members")).join(",") === sorted(sourceInventory.tables.filter((name) => name !== "team_members")).join(","), "portable table names do not match S04 source contract");
assert(!baseline.includes("auth_user_id"), "provider-specific identity column leaked into portable baseline");
assert(!baseline.includes("auth."), "provider-specific identity schema reference leaked into portable baseline");
for (const sourceTable of sourceTables) {
  const portableTable = portableTables.find(({ name }) => name === sourceTable.name);
  assert(portableTable, `missing table ${sourceTable.name}`);
  if (portableTable) assert(compact(portableTable.sql) === compact(sourceTable.sql), `table definition changed: ${sourceTable.name}`);
}

assert(portableIdentities.length === inventory.counts.identity_columns, `identity count mismatch: ${portableIdentities.length}`);
assert(JSON.stringify(portableIdentities.map(({ table, column, sql }) => ({ table, column, sql: compact(sql) }))) === JSON.stringify(sourceIdentities.map(({ table, column, sql }) => ({ table, column, sql: compact(sql) }))), "identity definitions changed");
assert(portableConstraints.length === inventory.counts.constraints - inventory.counts.check_constraints, `explicit constraint count mismatch: ${portableConstraints.length}`);
assert(sorted(portableConstraints.map(({ name }) => name)).join(",") === sorted([
  ...names(inventory.constraints.primary_keys),
  ...names(inventory.constraints.unique),
  ...names(inventory.constraints.foreign_keys),
]).join(","), "portable explicit constraint names do not match inventory");
assert(JSON.stringify(portableConstraints.map(({ name, sql }) => [name, compact(sql)]).sort()) === JSON.stringify(sourceConstraints.map(({ name, sql }) => [name, compact(sql)]).sort()), "portable constraint definitions changed");

assert(portableIndexes.length === inventory.counts.explicit_indexes, `explicit index count mismatch: ${portableIndexes.length}`);
assert(JSON.stringify(sorted(portableIndexes.map(({ name }) => name))) === JSON.stringify(sorted(inventory.indexes.map(({ name }) => name))), "portable index names do not match inventory");
assert(JSON.stringify(portableIndexes.map(({ name, sql }) => [name, compact(sql)]).sort()) === JSON.stringify(sourceIndexes.map(({ name, sql }) => [name, compact(sql)]).sort()), "portable index definitions changed");

assert(portableViews.size === inventory.counts.views, `view count mismatch: ${portableViews.size}`);
assert(!baseline.includes("CREATE OR REPLACE VIEW"), "portable baseline must declare each final view once");
assert(sorted([...portableViews.keys()]).join(",") === sorted(inventory.views.map(({ name }) => name)).join(","), "portable view names do not match inventory");
for (const view of inventory.views) {
  const actual = portableViews.get(view.name);
  assert(actual, `missing view ${view.name}`);
  assert(view.security_invoker === true && actual.includes("security_invoker='true'"), `view ${view.name} must preserve security_invoker metadata`);
  assert(sha256(actual) === view.definition_sha256, `view ${view.name} definition hash is stale`);
  assert(compact(actual) === compact(sourceViews.get(view.name) ?? ""), `view output definition changed: ${view.name}`);
}

const forbiddenPatterns = [
  /auth\./i,
  /storage\./i,
  /supabase_migrations/i,
  /postgrest/i,
  /\b(anon|authenticated|service_role|ai_sql_runner)\b/i,
  /\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER|POLICY)\b/i,
  /\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i,
  /\b(GRANT|REVOKE)\b/i,
  /\bOWNER\s+TO\b/i,
  /\bINSERT\s+INTO\b/i,
  /\b(SK-|Bearer\s|SUPABASE_|NEON_PROJECT|VERCEL_|R2_)/i,
];
for (const pattern of forbiddenPatterns) assert(!pattern.test(baseline), `forbidden provider/runtime marker in baseline: ${pattern}`);
assert((baseline.match(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;$/gim) ?? []).length === 1, "portable baseline must require only pgcrypto");
assert(inventory.portability_assertions.no_provider_subject_or_provider_resource_ids === true, "provider ID portability assertion missing");
assert(inventory.portability_assertions.server_owned_api_required === true, "server-owned API intent missing");
assert(inventory.portability_assertions.runtime_must_be_non_owner_and_non_bypassrls === true, "runtime role intent missing");

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Portable business schema inventory assertions passed");
  console.log(`tables=${inventory.counts.tables} views=${inventory.counts.views} identities=${inventory.counts.identity_columns}`);
  console.log(`indexes=${inventory.counts.indexes} constraints=${inventory.counts.constraints} fks=${inventory.counts.foreign_key_constraints}`);
}
