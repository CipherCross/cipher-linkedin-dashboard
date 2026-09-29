import { timingSafeEqual } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface AuthUserPrincipal {
  userId: string
  email: string | null
}

export class AuthorizationError extends Error {
  readonly status: 401 | 403 | 500

  constructor(status: 401 | 403 | 500, message: string) {
    super(message)
    this.name = 'AuthorizationError'
    this.status = status
  }
}

// The transitional Supabase bearer verifier. Its only caller is
// `identity/session.ts`'s legacy-bearer branch; both go together.
let _verifier: SupabaseClient | null = null

function verifier(): SupabaseClient {
  if (_verifier) return _verifier
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new AuthorizationError(
      500,
      'Server authentication is not configured (Supabase URL / anon key)',
    )
  }
  _verifier = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _verifier
}

function bearerToken(req: Request): string {
  const header = req.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match?.[1]) throw new AuthorizationError(401, 'Authentication required')
  return match[1]
}

/** Verify a browser JWT and return its immutable Auth subject. */
export async function requireUser(req: Request): Promise<AuthUserPrincipal> {
  const token = bearerToken(req)
  const { data, error } = await verifier().auth.getClaims(token)
  const claims = data?.claims as { sub?: unknown; email?: unknown } | undefined
  if (error || typeof claims?.sub !== 'string' || !claims.sub) {
    throw new AuthorizationError(401, 'Invalid or expired session')
  }
  return {
    userId: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null,
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
