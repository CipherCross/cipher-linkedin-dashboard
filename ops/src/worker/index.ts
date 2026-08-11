import { Redactor } from "../core/redaction.js";
import {
  S26ControlPlaneBridgeService,
  type S26BridgeBackend,
} from "../bridge/s26-control-plane-service.js";
import { parseS26BridgePath } from "../providers/s26-bridge-contract.js";
import { S26WorkerBackend } from "./backend.js";

const MAX_REQUEST_BYTES = 64 * 1024;

interface WorkerHandlerOptions {
  readonly bearerSecret: string;
  readonly backend: S26BridgeBackend;
  readonly redactorSecrets?: readonly string[];
}

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

async function timingSafeTokenEqual(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [candidateDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(left: ArrayBuffer, right: ArrayBuffer): boolean;
  };
  return subtle.timingSafeEqual(candidateDigest, expectedDigest);
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("unsupported_content_type");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) throw new Error("invalid_content_length");
    if (parsedLength > MAX_REQUEST_BYTES) throw new Error("body_too_large");
  }

  if (request.body === null) throw new Error("invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid_json");
  }
}

/**
 * HTTP boundary used by both the deployed Worker and workerd request tests.
 * The injected backend remains the only component permitted to hold provider
 * behavior; callers can select only a fixed S26 route and validated body.
 */
export async function handleS26WorkerRequest(
  request: Request,
  options: WorkerHandlerOptions,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" || parseS26BridgePath(path) === null) {
    return jsonResponse(404, { code: "unsupported_route" });
  }
  if (options.bearerSecret.length === 0) {
    return jsonResponse(503, { code: "secret_input_required" });
  }
  const presented = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (presented === undefined || !(await timingSafeTokenEqual(presented, options.bearerSecret))) {
    return jsonResponse(401, { code: "unauthorized" });
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_json";
    return jsonResponse(code === "body_too_large" ? 413 : 400, { code });
  }

  const redactor = new Redactor([
    options.bearerSecret,
    ...(options.redactorSecrets ?? []),
  ]);
  const service = new S26ControlPlaneBridgeService(
    {
      authorize: (candidate) => timingSafeTokenEqual(candidate, options.bearerSecret),
    },
    options.backend,
    redactor,
  );
  const authorization = request.headers.get("authorization");
  const result = await service.handle({
    method: request.method,
    path,
    ...(authorization === null ? {} : { authorization }),
    body,
  });
  return jsonResponse(result.status, result.body);
}

/** The sanitized code/status a failed bridge response already carries. */
export function s26BridgeFailureFields(body: unknown): Readonly<{ code?: unknown; provider_status?: unknown; provider_error_code?: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  return { code: record.code, provider_status: record.provider_status, provider_error_code: record.provider_error_code };
}

function requiredSecret(value: string | undefined): string {
  return typeof value === "string" ? value : "";
}

export function s26WorkerRequestLog(
  request: Request,
  response: Response,
  failure?: Readonly<{ code?: unknown; provider_status?: unknown; provider_error_code?: unknown }>,
): Readonly<Record<string, unknown>> {
  return {
    event: "s26_bridge_request",
    method: request.method,
    path: new URL(request.url).pathname,
    status: response.status,
    // The already-sanitized code and the upstream provider's numeric status.
    // Without these the server-side log said only "some route returned 409",
    // which is how three separate deterministic refusals each cost a session to
    // attribute. Both values have already passed redaction; neither is a URL,
    // credential, scope or payload.
    ...(typeof failure?.code === "string" ? { code: failure.code } : {}),
    ...(typeof failure?.provider_status === "number" ? { provider_status: failure.provider_status } : {}),
    ...(typeof failure?.provider_error_code === "string" ? { provider_error_code: failure.provider_error_code } : {}),
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const response = await handleS26WorkerRequest(request, {
      bearerSecret: requiredSecret(env.BRIDGE_BEARER_SECRET),
      backend: new S26WorkerBackend(env),
      redactorSecrets: [
        requiredSecret(env.NEON_API_TOKEN),
        requiredSecret(env.VERCEL_API_TOKEN),
        requiredSecret(env.RESEND_API_KEY),
        requiredSecret(env.SOURCE_REPOSITORY_TOKEN),
      ],
    });
    // The body is read back from a clone so logging cannot consume the stream
    // the caller still needs.
    let failure: Readonly<{ code?: unknown; provider_status?: unknown; provider_error_code?: unknown }> = {};
    if (!response.ok) {
      try { failure = s26BridgeFailureFields(await response.clone().json()); } catch { failure = {}; }
    }
    console.log(JSON.stringify(s26WorkerRequestLog(request, response, failure)));
    return response;
  },
} satisfies ExportedHandler<Env>;
