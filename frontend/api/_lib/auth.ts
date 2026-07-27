import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { db } from './core.js'

export type AppRole = 'member' | 'admin'

export interface AuthUserPrincipal {
  userId: string
  email: string | null
}

export interface AppPrincipal extends AuthUserPrincipal {
  member: {
    id: number
    name: string
    email: string | null
    role: AppRole
    active: true
    auth_user_id: string
  }
}

export class AuthorizationError extends Error {
  readonly status: 401 | 403 | 500

  constructor(status: 401 | 403 | 500, message: string) {
    super(message)
    this.name = 'AuthorizationError'
    this.status = status
  }
}

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

/** Verify the JWT and require a live, active team_members link. */
export async function requireMember(req: Request): Promise<AppPrincipal> {
  const user = await requireUser(req)
  const { data, error } = await db()
    .from('team_members')
    .select('id,name,email,role,active,auth_user_id')
    .eq('auth_user_id', user.userId)
    .maybeSingle()

  if (error) {
    console.error('Auth membership lookup failed:', error.message)
    throw new AuthorizationError(500, 'Could not verify team access')
  }
  if (
    !data ||
    data.active !== true ||
    data.auth_user_id !== user.userId ||
    (data.role !== 'member' && data.role !== 'admin')
  ) {
    throw new AuthorizationError(403, 'Your account is not an active team member')
  }

  return {
    ...user,
    member: {
      id: Number(data.id),
      name: String(data.name),
      email: typeof data.email === 'string' ? data.email : null,
      role: data.role,
      active: true,
      auth_user_id: data.auth_user_id,
    },
  }
}

/** Require a live team membership with the server-controlled admin role. */
export async function requireAdmin(req: Request): Promise<AppPrincipal> {
  const principal = await requireMember(req)
  if (principal.member.role !== 'admin') {
    throw new AuthorizationError(403, 'Admin access required')
  }
  return principal
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

export type AuthorizationResult<T> =
  | { principal: T; response?: never }
  | { principal?: never; response: Response }

async function guarded<T>(load: () => Promise<T>): Promise<AuthorizationResult<T>> {
  try {
    return { principal: await load() }
  } catch (error) {
    const response = authorizationResponse(error)
    if (response) return { response }
    throw error
  }
}

export const guardMember = (req: Request) => guarded(() => requireMember(req))
export const guardAdmin = (req: Request) => guarded(() => requireAdmin(req))

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

/** Fail-closed bearer comparison for cron/agent/MCP machine callers. */
export function requireMachineSecret(
  req: Request,
  envName: 'CRON_SECRET' | 'NOTIFY_SECRET' | 'MCP_SECRET',
): void {
  const expected = process.env[envName]
  if (!expected) {
    throw new AuthorizationError(500, `${envName} is not configured`)
  }
  const received = req.headers.get('authorization')
  if (received !== `Bearer ${expected}`) {
    throw new AuthorizationError(401, 'Unauthorized')
  }
}
