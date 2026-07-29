import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import {
  CODEX_APPROVAL_POLICY,
  DESTRUCTIVE_TOOL_NAMES,
  MCP_TOOL_CONTRACT_DIGEST,
  MUTATING_TOOL_NAMES,
  OWNER_TOOL_ALLOWLIST,
  OWNER_TOOL_POLICY,
  Registry,
  RegistryOwnerOperationsAdapter,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  SERVER_VERSION,
  createOwnerMcpServer,
} from "../src/index.js";
import {
  OWNER_UUID,
  TENANT_UUID,
  TEST_NOW,
  catalogResolver,
  makeOnboardingPlan,
  observedSnapshots,
} from "./fixtures.js";

async function connectedServer(
  registry: Registry,
  adapter = new RegistryOwnerOperationsAdapter(registry),
): Promise<{
  client: Client;
  server: ReturnType<typeof createOwnerMcpServer>;
}> {
  const server = createOwnerMcpServer(
    adapter,
  );
  const client = new Client({ name: "p4-a-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function assertClosedObjects(schema: unknown, path = "$"): void {
  if (Array.isArray(schema)) {
    schema.forEach((value, index) =>
      assertClosedObjects(value, `${path}[${index}]`),
    );
    return;
  }
  if (typeof schema !== "object" || schema === null) return;
  const record = schema as Record<string, unknown>;
  if (record.type === "object" || record.properties !== undefined) {
    assert.equal(
      record.additionalProperties,
      false,
      `${path} must reject unknown properties`,
    );
  }
  for (const [name, value] of Object.entries(record)) {
    assertClosedObjects(value, `${path}.${name}`);
  }
}

function propertyNames(schema: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    schema.forEach((value) => propertyNames(value, names));
    return names;
  }
  if (typeof schema !== "object" || schema === null) return names;
  const record = schema as Record<string, unknown>;
  if (
    typeof record.properties === "object" &&
    record.properties !== null
  ) {
    for (const name of Object.keys(record.properties)) names.add(name);
  }
  Object.values(record).forEach((value) => propertyNames(value, names));
  return names;
}

test("MCP publishes only the owner allowlist with strict schemas and instructions", async () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  const { client, server } = await connectedServer(registry);
  try {
    assert.deepEqual(client.getServerVersion(), {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...OWNER_TOOL_ALLOWLIST],
    );
    for (const tool of tools) {
      const name = tool.name as keyof typeof OWNER_TOOL_POLICY;
      assert.deepEqual(tool.annotations, OWNER_TOOL_POLICY[name].annotations);
      assertClosedObjects(tool.inputSchema, `${name}.input`);
      assertClosedObjects(tool.outputSchema, `${name}.output`);
    }
  } finally {
    await client.close();
    await server.close();
    registry.close();
  }
});

test("read-only, write and reversible-destructive annotations match approval policy", () => {
  assert.deepEqual(CODEX_APPROVAL_POLICY, {
    default_tools_approval_mode: "writes",
    per_tool: {
      machine_revoke: "prompt",
      support_access_disable: "prompt",
      tenant_suspend: "prompt",
    },
  });
  const readOnlyTools = OWNER_TOOL_ALLOWLIST.filter(
    (name) => !MUTATING_TOOL_NAMES.includes(name),
  );
  assert.deepEqual(readOnlyTools, [
    "tenant_list",
    "tenant_get",
    "tenant_preflight",
    "tenant_plan_onboarding",
    "tenant_drift",
    "operation_get",
    "release_plan",
    "tenant_prepare_offboarding",
  ]);
  assert.deepEqual(DESTRUCTIVE_TOOL_NAMES, [
    "machine_revoke",
    "support_access_disable",
    "tenant_suspend",
  ]);
  for (const name of readOnlyTools) {
    assert.equal(OWNER_TOOL_POLICY[name].annotations.readOnlyHint, true);
    assert.equal(OWNER_TOOL_POLICY[name].annotations.destructiveHint, false);
  }
  for (const name of MUTATING_TOOL_NAMES) {
    assert.equal(OWNER_TOOL_POLICY[name].annotations.readOnlyHint, false);
  }
  for (const name of OWNER_TOOL_ALLOWLIST) {
    assert.equal(OWNER_TOOL_POLICY[name].annotations.idempotentHint, true);
  }
});

test("documented user-global allowlist and approval policy match code", () => {
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const setup = readFileSync(
    resolve(repositoryRoot, "docs/platform-ops/local-owner-mcp.md"),
    "utf8",
  );
  const allowlistBlock = setup.match(
    /enabled_tools = \[\n(?<tools>[\s\S]*?)\n\]/,
  );
  assert.ok(allowlistBlock?.groups?.tools);
  const documentedTools = [
    ...allowlistBlock.groups.tools.matchAll(/"([^"]+)"/g),
  ].map((match) => match[1]);
  assert.deepEqual(documentedTools, [...OWNER_TOOL_ALLOWLIST]);
  assert.match(setup, /default_tools_approval_mode = "writes"/);
  for (const name of DESTRUCTIVE_TOOL_NAMES) {
    assert.match(
      setup,
      new RegExp(
        `\\[mcp_servers\\.lh2_owner_ops\\.tools\\.${name}\\]\\napproval_mode = "prompt"`,
      ),
    );
  }
});

test("allowlist has no raw, secret-read, provider-delete or migration bypass tool", () => {
  const forbiddenNames = new Set([
    "shell",
    "sql",
    "http",
    "dns",
    "env_get",
    "env_set",
    "secret_get",
    "secret_read",
    "provider_delete",
    "migration_down",
    "migration_repair",
  ]);
  for (const name of OWNER_TOOL_ALLOWLIST) {
    assert.equal(forbiddenNames.has(name), false);
    assert.doesNotMatch(name, /(?:raw|delete|down_migration|secret_read)/);
  }
});

test("tool inputs expose no arbitrary command, query, URL, payload or secret value", async () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  const { client, server } = await connectedServer(registry);
  try {
    const forbiddenFields = new Set([
      "command",
      "shell",
      "sql",
      "query",
      "http",
      "url",
      "env",
      "environment",
      "dns",
      "payload",
      "provider_payload",
      "secret",
      "secret_value",
      "token",
      "password",
      "delete",
      "down_migration",
      "migration_repair",
    ]);
    for (const tool of (await client.listTools()).tools) {
      for (const name of propertyNames(tool.inputSchema)) {
        assert.equal(
          forbiddenFields.has(name),
          false,
          `${tool.name} must not accept ${name}`,
        );
      }
    }
  } finally {
    await client.close();
    await server.close();
    registry.close();
  }
});

test("packaged entrypoint serves the same allowlist over local STDIO", async () => {
  const temporaryDirectory = mkdtempSync(
    resolve(tmpdir(), "lh2-owner-mcp-"),
  );
  const registryPath = resolve(temporaryDirectory, "registry.sqlite");
  const registry = new Registry(registryPath, OWNER_UUID);
  registry.close();
  const mainPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../src/mcp/main.js",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mainPath, "--registry", registryPath],
    stderr: "pipe",
  });
  const client = new Client({ name: "p4-a-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      [...OWNER_TOOL_ALLOWLIST],
    );
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
  } finally {
    await client.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("MCP rejects unknown input fields before dispatch", async () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  const { client, server } = await connectedServer(registry);
  try {
    const result = await client.callTool({
      name: "tenant_list",
      arguments: { command: "whoami" },
    });
    assert.equal(result.isError, true);
    assert.equal(registry.registryVersion, 0);
  } finally {
    await client.close();
    await server.close();
    registry.close();
  }
});

test("MCP apply delegates to the registry core and preserves idempotency", async () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  const plan = makeOnboardingPlan({ expectedRegistryVersion: 1 });
  registry.savePlan(plan, { catalogs: catalogResolver(), now: TEST_NOW });
  const { client, server } = await connectedServer(
    registry,
    new RegistryOwnerOperationsAdapter(registry, observedSnapshots),
  );
  const authorization = {
    server_version: SERVER_VERSION,
    tool_contract_digest: MCP_TOOL_CONTRACT_DIGEST,
    plan_id: plan.plan_id,
    plan_digest: plan.plan_digest,
    expected_registry_version: 1,
    idempotency_key: "p4a-stable-key-0001",
  };
  try {
    const first = await client.callTool({
      name: "tenant_apply_onboarding",
      arguments: { authorization },
    });
    assert.equal(first.isError, undefined);
    const firstOutput = first.structuredContent as {
      operation_id: string;
      resumed: boolean;
    };
    assert.equal(firstOutput.resumed, false);

    const second = await client.callTool({
      name: "tenant_apply_onboarding",
      arguments: { authorization },
    });
    assert.equal(second.isError, undefined);
    const secondOutput = second.structuredContent as {
      operation_id: string;
      resumed: boolean;
    };
    assert.equal(secondOutput.operation_id, firstOutput.operation_id);
    assert.equal(secondOutput.resumed, true);
    assert.equal(registry.listTenants().length, 1);
    assert.equal(registry.countResourceReferences(TENANT_UUID), 0);
  } finally {
    await client.close();
    await server.close();
    registry.close();
  }
});

test("write calls fail closed on a mismatched server tool contract digest", async () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  const { client, server } = await connectedServer(registry);
  try {
    const result = await client.callTool({
      name: "tenant_apply_onboarding",
      arguments: {
        authorization: {
          server_version: SERVER_VERSION,
          tool_contract_digest: `sha256:${"0".repeat(64)}`,
          plan_id: "plan-1",
          plan_digest: `sha256:${"1".repeat(64)}`,
          expected_registry_version: 0,
          idempotency_key: "p4a-stable-key-0002",
        },
      },
    });
    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result.content),
      /tool contract digest does not match/,
    );
    assert.equal(registry.registryVersion, 0);
  } finally {
    await client.close();
    await server.close();
    registry.close();
  }
});

test("P4-B capabilities fail closed without invoking live providers", async () => {
  const registry = new Registry(":memory:", OWNER_UUID);
  const { client, server } = await connectedServer(registry);
  try {
    const result = await client.callTool({
      name: "tenant_drift",
      arguments: { tenant_slug: "acme-team" },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /unavailable in P4-A/);
    assert.equal(registry.registryVersion, 0);
  } finally {
    await client.close();
    await server.close();
    registry.close();
  }
});
