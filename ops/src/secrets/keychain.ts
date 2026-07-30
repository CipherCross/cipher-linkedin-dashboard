import { spawn } from "node:child_process";

import { OpsError } from "../core/errors.js";
import { Redactor } from "../core/redaction.js";
import type { KeychainLabels, SecretStore } from "./types.js";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface KeychainCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    stdin?: string,
  ): Promise<CommandResult>;
}

export class SpawnCommandRunner implements KeychainCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    stdin?: string,
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        env: {
          PATH: "/usr/bin:/bin",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}

export class MacOsKeychainSecretStore implements SecretStore {
  readonly #runner: KeychainCommandRunner;
  readonly #redactor: Redactor;
  readonly #executable: string;

  constructor(
    redactor: Redactor,
    runner: KeychainCommandRunner = new SpawnCommandRunner(),
    executable = "/usr/bin/security",
  ) {
    this.#redactor = redactor;
    this.#runner = runner;
    this.#executable = executable;
  }

  async set(labels: KeychainLabels, value: string): Promise<void> {
    validateLabels(labels);
    validateSecretValue(value);
    const storedValue = encodeStoredSecret(value);
    this.#redactor.registerSecret(value);
    this.#redactor.registerSecret(storedValue);
    const result = await this.#run(
      ["-q", "-i"],
      [
        "add-generic-password",
        "-U",
        "-a",
        labels.account,
        "-s",
        labels.service,
        "-w",
        storedValue,
      ].join(" ") + "\n",
    );
    if (result.exitCode !== 0) {
      throw new OpsError(
        "secret_store_error",
        this.#redactor.redactString(
          result.stderr.trim() || "macOS Keychain rejected the secret",
        ),
      );
    }
    const verified = await this.get(labels);
    if (verified !== value) {
      throw new OpsError(
        "secret_store_error",
        "macOS Keychain did not preserve the supplied secret value",
      );
    }
  }

  async get(labels: KeychainLabels): Promise<string> {
    validateLabels(labels);
    const result = await this.#run([
      "find-generic-password",
      "-a",
      labels.account,
      "-s",
      labels.service,
      "-w",
    ]);
    if (result.exitCode !== 0) {
      throw new OpsError(
        "secret_store_error",
        this.#redactor.redactString(
          result.stderr.trim() || "Secret is not available in macOS Keychain",
        ),
      );
    }
    const storedValue = result.stdout.replace(/[\r\n]+$/, "");
    const value = decodeStoredSecret(storedValue);
    validateSecretValue(value);
    this.#redactor.registerSecret(value);
    return value;
  }

  async has(labels: KeychainLabels): Promise<boolean> {
    validateLabels(labels);
    const result = await this.#run([
      "find-generic-password",
      "-a",
      labels.account,
      "-s",
      labels.service,
    ]);
    return result.exitCode === 0;
  }

  async #run(
    args: readonly string[],
    stdin?: string,
    executable = this.#executable,
  ): Promise<CommandResult> {
    try {
      return await this.#runner.run(executable, args, stdin);
    } catch (error) {
      throw this.#redactor.sanitizeError(error);
    }
  }
}

function encodeStoredSecret(value: string): string {
  return `v1_${Buffer.from(value, "utf8").toString("base64url")}`;
}

function decodeStoredSecret(value: string): string {
  if (!value.startsWith("v1_")) return value;
  if (!/^v1_[A-Za-z0-9_-]+$/.test(value)) {
    throw new OpsError("secret_invalid", "Stored secret encoding is invalid");
  }
  try {
    const decoded = Buffer.from(value.slice(3), "base64url").toString("utf8");
    if (encodeStoredSecret(decoded) !== value) {
      throw new Error("non-canonical base64url");
    }
    return decoded;
  } catch {
    throw new OpsError("secret_invalid", "Stored secret encoding is invalid");
  }
}

function validateLabels(labels: KeychainLabels): void {
  const safe = /^[a-z0-9][a-z0-9._/-]{2,160}$/;
  if (!safe.test(labels.service) || !safe.test(labels.account)) {
    throw new OpsError("secret_invalid", "Invalid Keychain service or account label");
  }
}

function validateSecretValue(value: string): void {
  if (value.length === 0) {
    throw new OpsError("secret_invalid", "Secret is empty");
  }
  if (value.includes("\0")) {
    throw new OpsError("secret_invalid", "Secret contains a NUL character");
  }
  if (/[\r\n]/.test(value)) {
    throw new OpsError(
      "secret_invalid",
      "Secret contains an embedded line break",
    );
  }
}
