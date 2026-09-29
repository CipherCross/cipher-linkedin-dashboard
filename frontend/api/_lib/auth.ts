import { timingSafeEqual } from 'node:crypto'

export class AuthorizationError extends Error {
  readonly status: 401 | 403 | 500

  constructor(status: 401 | 403 | 500, message: string) {
    super(message)
    this.name = 'AuthorizationError'
    this.status = status
  }
}

export function authorizationResponse(error: unknown): Response | null {
  if (!(error instanceof AuthorizationError)) return null
  return new Response(JSON.stringify({ error: error.message }), {
    status: error.status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}

export async function guardMachine(
  req: Request,
  envName: 'CRON_SECRET' | 'NOTIFY_SECRET' | 'MCP_SECRET',
): Promise<Response | null> {
  try {
    requireMachineSecret(req, envName)
    return null
  } catch (error) {
    const response = authorizationResponse(error)
    if (response) return response
    throw error
  }
}

/**
 * Fail-closed bearer comparison for cron/agent/MCP machine callers.
 *
 * Constant-time over equal-length inputs: `timingSafeEqual` refuses buffers of
 * different lengths, and a length mismatch is already a refusal, so it answers
 * 401 without comparing. What that reveals is the secret's length, which a
 * fixed-format secret does not keep private anyway.
 */
export function requireMachineSecret(
  req: Request,
  envName: 'CRON_SECRET' | 'NOTIFY_SECRET' | 'MCP_SECRET',
): void {
  const expected = process.env[envName]
  if (!expected) {
    throw new AuthorizationError(500, `${envName} is not configured`)
  }
  const received = Buffer.from(req.headers.get('authorization') ?? '', 'utf8')
  const wanted = Buffer.from(`Bearer ${expected}`, 'utf8')
  if (received.length !== wanted.length || !timingSafeEqual(received, wanted)) {
    throw new AuthorizationError(401, 'Unauthorized')
  }
}
