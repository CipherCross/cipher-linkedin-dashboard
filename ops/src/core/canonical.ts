import { createHash } from "node:crypto";

import { OpsError } from "./errors.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function serialize(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OpsError("invalid_plan", "Canonical JSON cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }

  const objectValue = value as { readonly [key: string]: JsonValue };
  const entries = Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(objectValue[key]!)}`);
  return `{${entries.join(",")}}`;
}

/** RFC 8785/JCS serialization for JSON-compatible values. */
export function canonicalJson(value: JsonValue): string {
  return serialize(value);
}

export function sha256Digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function planDigest(spec: JsonValue): string {
  return sha256Digest(canonicalJson(spec));
}
