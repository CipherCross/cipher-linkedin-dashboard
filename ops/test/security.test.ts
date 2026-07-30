import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FakeAuthProvider,
  FakeDomainProvider,
  FakeSmtpProvider,
  FakeSourceRepositoryProvider,
  FakeSupabaseProvider,
  FakeVercelProvider,
  MacOsKeychainSecretStore,
  OnboardingExecutor,
  OpsError,
  Redactor,
  Registry,
  runCli,
  type CommandResult,
  type KeychainCommandRunner,
  type ProviderResource,
  type SupabaseProjectRequest,
} from "../src/index.js";
import {
  OWNER_UUID,
  TEST_NOW,
  catalogResolver,
  executionContext,
  makeApplyRequest,
  makeOnboardingPlan,
  observedSnapshots,
} from "./fixtures.js";

const CANARY = "p3b-canary-secret-7f9d2d7d";

class RecordingRunner implements KeychainCommandRunner {
  readonly calls: {
    executable: string;
    args: readonly string[];
    stdin?: string | undefined;
  }[] = [];
  result: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

  async run(
    executable: string,
    args: readonly string[],
    stdin?: string,
  ): Promise<CommandResult> {
    this.calls.push({ executable, args, stdin });
    return this.result;
  }
}

class LeakyErrorSupabase extends FakeSupabaseProvider {
  override async createOrAdoptProject(
    _request: SupabaseProjectRequest,
  ): Promise<ProviderResource> {
    throw new OpsError("provider_error", `provider returned token=${CANARY}`, {
      raw_provider_response: {
        authorization: `Bearer ${CANARY}`,
        payload: CANARY,
      },
    });
  }
}

class LeakySuccessSupabase extends FakeSupabaseProvider {
  override async createOrAdoptProject(
    request: SupabaseProjectRequest,
  ): Promise<ProviderResource> {
    const safe = await super.createOrAdoptProject(request);
    return { ...safe, resourceId: `sb_${CANARY}` };
  }
}

test("macOS Keychain adapter never places secret values in process arguments", async () => {
  const redactor = new Redactor();
  const runner = new RecordingRunner();
  const store = new MacOsKeychainSecretStore(redactor, runner);
  const storedCanary = `v1_${Buffer.from(CANARY, "utf8").toString("base64url")}`;
  const labels = {
    service: "lh2-platform" as const,
    account: "platform/supabase.management_token",
  };

  runner.result = { exitCode: 0, stdout: `${storedCanary}\n`, stderr: "" };
  await store.set(labels, CANARY);
  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[0]!.executable, "/usr/bin/security");
  assert.deepEqual(runner.calls[0]!.args, ["-q", "-i"]);
  assert.equal(runner.calls[0]!.args.join(" ").includes(CANARY), false);
  assert.equal(runner.calls[0]!.args.join(" ").includes(storedCanary), false);
  assert.equal(runner.calls[0]!.stdin!.includes(CANARY), false);
  assert.equal(runner.calls[0]!.stdin!.includes(storedCanary), true);
  assert.equal(runner.calls[1]!.args.join(" ").includes(CANARY), false);
  assert.equal(runner.calls[1]!.args.join(" ").includes(storedCanary), false);

  assert.equal(await store.get(labels), CANARY);
  assert.equal(runner.calls[2]!.args.join(" ").includes(CANARY), false);
  assert.equal(runner.calls[2]!.args.join(" ").includes(storedCanary), false);
});

test("canary values are removed from provider error and success paths", async () => {
  for (const supabase of [new LeakyErrorSupabase(), new LeakySuccessSupabase()]) {
    const redactor = new Redactor([CANARY]);
    const registry = new Registry(":memory:", OWNER_UUID, redactor);
    try {
      const plan = makeOnboardingPlan();
      registry.savePlan(plan, { catalogs: catalogResolver(), now: TEST_NOW });
      const started = registry.startOrResumeOperation(
        makeApplyRequest(plan),
        "owner",
        observedSnapshots(),
        TEST_NOW,
      );
      const executor = new OnboardingExecutor(
        registry,
        {
          supabase,
          vercel: new FakeVercelProvider(),
          auth: new FakeAuthProvider(),
          smtp: new FakeSmtpProvider(),
          domain: new FakeDomainProvider(),
          sourceRepository: new FakeSourceRepositoryProvider(),
        },
        redactor,
      );
      const context = executionContext(
        plan,
        started.operationId,
        started.fencingToken,
      );
      await executor.executeNext(context);
      await assert.rejects(
        executor.executeNext(context),
        (error: unknown) => {
          assert.ok(error instanceof OpsError);
          assert.equal(JSON.stringify(error).includes(CANARY), false);
          assert.equal(error.message.includes(CANARY), false);
          return true;
        },
      );
      const database = registry.unsafeDatabaseForTests();
      const persisted = JSON.stringify({
        operations: database.prepare("SELECT * FROM operations").all(),
        steps: database.prepare("SELECT * FROM operation_steps").all(),
        refs: database.prepare("SELECT * FROM resource_refs").all(),
        audit: database.prepare("SELECT * FROM audit_entries").all(),
      });
      assert.equal(persisted.includes(CANARY), false);
      registry.verifyAuditChain();
    } finally {
      registry.close();
    }
  }
});

test("CLI accepts secrets only through the injected no-echo reader and emits metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lh2-ops-cli-security-"));
  const registryPath = join(directory, "registry.sqlite");
  const output: string[] = [];
  const errors: string[] = [];
  const memory = new Map<string, string>();
  try {
    const init = await runCli(
      [
        "registry",
        "init",
        "--registry",
        registryPath,
        "--owner-id",
        OWNER_UUID,
      ],
      {
        stdout: (value) => output.push(value),
        stderr: (value) => errors.push(value),
      },
    );
    assert.equal(init, 0);

    const setResult = await runCli(
      [
        "secrets",
        "set",
        "--registry",
        registryPath,
        "--scope",
        "platform",
        "--name",
        "supabase.management_token",
      ],
      {
        stdout: (value) => output.push(value),
        stderr: (value) => errors.push(value),
        readSecret: async () => CANARY,
        makeSecretStore: () => ({
          async set(labels, value) {
            memory.set(`${labels.service}/${labels.account}`, value);
          },
          async get(labels) {
            return memory.get(`${labels.service}/${labels.account}`)!;
          },
          async has(labels) {
            return memory.has(`${labels.service}/${labels.account}`);
          },
        }),
      },
    );
    assert.equal(setResult, 0);
    assert.equal(memory.get("lh2-platform/platform/supabase.management_token"), CANARY);
    assert.equal(output.join("\n").includes(CANARY), false);
    assert.equal(errors.join("\n").includes(CANARY), false);
    assert.equal(readFileSync(registryPath).includes(Buffer.from(CANARY)), false);

    const rejected = await runCli(
      [
        "secrets",
        "set",
        "--registry",
        registryPath,
        "--scope",
        "platform",
        "--name",
        "vercel.team_token",
        "--value",
        CANARY,
      ],
      {
        stdout: (value) => output.push(value),
        stderr: (value) => errors.push(value),
        readSecret: async () => {
          throw new Error("must not prompt");
        },
      },
    );
    assert.equal(rejected, 2);
    assert.equal(errors.join("\n").includes(CANARY), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
