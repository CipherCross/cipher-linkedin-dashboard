import { OpsError } from "./errors.js";

const REDACTED = "[REDACTED]";
const ASSIGNMENT =
  /(\b(?:authorization|password|passphrase|secret|token|webhook_url)\b\s*[:=]\s*)([^\s,;]+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

type JsonLike =
  | null
  | boolean
  | number
  | string
  | readonly JsonLike[]
  | { readonly [key: string]: JsonLike };

export class Redactor {
  readonly #secrets = new Set<string>();

  constructor(secrets: readonly string[] = []) {
    for (const secret of secrets) this.registerSecret(secret);
  }

  registerSecret(secret: string): void {
    if (secret.length > 0) this.#secrets.add(secret);
  }

  redactString(value: string): string {
    let result = value.replace(BEARER, `Bearer ${REDACTED}`);
    result = result.replace(ASSIGNMENT, `$1${REDACTED}`);
    for (const secret of [...this.#secrets].sort((left, right) => right.length - left.length)) {
      result = result.replaceAll(secret, REDACTED);
    }
    return result;
  }

  redact<T>(value: T): T {
    return this.#redactUnknown(value, new WeakSet<object>()) as T;
  }

  containsSecret(value: unknown): boolean {
    const serialized = this.#stableSearchText(value, new WeakSet<object>());
    for (const secret of this.#secrets) {
      if (serialized.includes(secret)) return true;
    }
    return false;
  }

  assertSecretFree(value: unknown, context: string): void {
    if (this.containsSecret(value)) {
      throw new OpsError(
        "redaction_violation",
        `Sensitive value detected in ${context}`,
        { context },
      );
    }
  }

  sanitizeError(error: unknown): OpsError {
    if (error instanceof OpsError) {
      return new OpsError(
        error.code,
        this.redactString(error.message),
        this.redact(error.details),
      );
    }
    if (error instanceof Error) {
      return new OpsError("provider_error", this.redactString(error.message));
    }
    return new OpsError("provider_error", "Provider operation failed");
  }

  #redactUnknown(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.redactString(value);
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "undefined"
    ) {
      return value;
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: this.redactString(value.message),
      };
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) return REDACTED;
      seen.add(value);
      return value.map((entry) => this.#redactUnknown(entry, seen));
    }
    if (typeof value === "object") {
      if (seen.has(value)) return REDACTED;
      seen.add(value);
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          isSensitiveKey(key)
            ? REDACTED
            : this.#redactUnknown(entry, seen),
        ]),
      );
    }
    return this.redactString(String(value));
  }

  #stableSearchText(value: unknown, seen: WeakSet<object>): string {
    if (typeof value === "string") return value;
    if (
      value === null ||
      typeof value === "undefined" ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      return String(value);
    }
    if (value instanceof Error) {
      return `${value.name}:${value.message}`;
    }
    if (typeof value === "object") {
      if (seen.has(value)) return "";
      seen.add(value);
      if (Array.isArray(value)) {
        return value.map((entry) => this.#stableSearchText(entry, seen)).join("\n");
      }
      return Object.entries(value)
        .map(
          ([key, entry]) =>
            `${key}:${this.#stableSearchText(entry, seen)}`,
        )
        .join("\n");
    }
    return String(value);
  }
}

export function safeJson(value: unknown, redactor: Redactor): string {
  return JSON.stringify(redactor.redact(value), null, 2);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (
    /_(?:id|ids|label|labels|name|names|ref|refs|version)$/.test(normalized)
  ) {
    return false;
  }
  return /(?:^|_)(?:authorization|cookie|credential|credentials|password|passphrase|private_key|secret|secret_value|token|webhook|webhook_url)$/.test(
    normalized,
  );
}
