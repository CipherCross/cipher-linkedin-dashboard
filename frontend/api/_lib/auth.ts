// Request authentication + RBAC for the /api endpoints. Until now these ran the
// service-role key behind no auth; now every call must carry a Supabase user JWT
// and meet a minimum role. The role comes from the `user_role` claim stamped by
// the Custom Access Token hook (see migrations/014_auth_rbac.sql); if the hook
// isn't enabled yet we fall back to reading public.profiles with the service-role
// client, so rollout is safe either way.
import { jwtVerify } from 'jose'
import { db } from './core.js'

export type AppRole = 'owner' | 'admin' | 'member' | 'viewer'

// Higher number = more privilege. `meetsRole(role, min)` is the gate.
export const RANK: Record<AppRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
}

const ROLES = new Set<string>(Object.keys(RANK))

export interface AuthContext {
  userId: string
  email?: string
  role: AppRole
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

let _secret: Uint8Array | null = null
function jwtSecret(): Uint8Array {
  if (_secret) return _secret
  const s = process.env.SUPABASE_JWT_SECRET
  if (!s) throw new Error('Missing SUPABASE_JWT_SECRET (project Settings → API → JWT secret)')
  return (_secret = new TextEncoder().encode(s))
}

function bearer(req: Request): string {
  const header = req.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) {
    throw new AuthError(401, 'missing bearer token')
  }
  return header.slice(7).trim()
}

async function roleFromDb(userId: string): Promise<AppRole> {
  const { data } = await db().from('profiles').select('role').eq('id', userId).single()
  const r = data?.role
  return r && ROLES.has(r) ? (r as AppRole) : 'viewer'
}

/** Verify the Supabase JWT and resolve the caller's role. Throws AuthError on
 *  a missing/invalid/expired token. */
export async function authenticate(req: Request): Promise<AuthContext> {
  const token = bearer(req)
  let payload: Record<string, unknown>
  try {
    ;({ payload } = await jwtVerify(token, jwtSecret()))
  } catch {
    throw new AuthError(401, 'invalid or expired token')
  }
  const userId = typeof payload.sub === 'string' ? payload.sub : ''
  if (!userId) throw new AuthError(401, 'invalid token (no subject)')

  const claim = payload.user_role
  let role: AppRole
  if (typeof claim === 'string' && ROLES.has(claim)) {
    role = claim as AppRole
  } else {
    role = await roleFromDb(userId)
  }
  const email = typeof payload.email === 'string' ? payload.email : undefined
  return { userId, email, role }
}

export function meetsRole(role: AppRole, min: AppRole): boolean {
  return RANK[role] >= RANK[min]
}

/** Authenticate and enforce a minimum role; throws AuthError (401/403). */
export async function requireRole(req: Request, min: AppRole): Promise<AuthContext> {
  const ctx = await authenticate(req)
  if (!meetsRole(ctx.role, min)) throw new AuthError(403, 'forbidden: requires ' + min)
  return ctx
}
