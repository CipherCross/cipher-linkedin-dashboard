// Member management for the Members admin page. Admin-gated in server/index.ts
// (requireRole('admin')). Uses the service-role client's GoTrue admin API to
// create/delete auth users and the profiles table for roles.
//
//   GET    -> list members (id, email, role, created_at)
//   POST   -> create a user { email, password, role } and set their role
//   PATCH  -> change a user's role { id, role }
//   DELETE -> remove a user { id } (profiles row cascades via FK)
//
// Assignable roles are limited to viewer/member/admin; `owner` is seeded only by
// the provisioner, so an admin can't self-escalate the whole org to owner here.
import { db } from './_lib/core.js'

export const maxDuration = 10

const ASSIGNABLE = new Set(['viewer', 'member', 'admin'])

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

async function list(): Promise<Response> {
  const { data, error } = await db()
    .from('profiles')
    .select('id,email,role,created_at')
    .order('created_at', { ascending: true })
  if (error) return json({ error: error.message }, 500)
  return json({ members: data ?? [] })
}

async function create(req: Request): Promise<Response> {
  let body: { email?: unknown; password?: unknown; role?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const role = typeof body.role === 'string' ? body.role : 'viewer'
  if (!email) return json({ error: 'email is required' }, 400)
  if (password.length < 8) return json({ error: 'password must be at least 8 characters' }, 400)
  if (!ASSIGNABLE.has(role)) return json({ error: 'role must be viewer, member, or admin' }, 400)

  const sb = db()
  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createErr || !created?.user) {
    return json({ error: createErr?.message ?? 'could not create user' }, 400)
  }
  // The on_auth_user_created trigger inserts a default-viewer profile; set the
  // requested role (and backfill email in case the trigger raced).
  const { error: roleErr } = await sb
    .from('profiles')
    .update({ role, email })
    .eq('id', created.user.id)
  if (roleErr) return json({ error: roleErr.message }, 500)
  return json({ ok: true, id: created.user.id, email, role })
}

async function setRole(req: Request): Promise<Response> {
  let body: { id?: unknown; role?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
  const id = typeof body.id === 'string' ? body.id : ''
  const role = typeof body.role === 'string' ? body.role : ''
  if (!id) return json({ error: 'id is required' }, 400)
  if (!ASSIGNABLE.has(role)) return json({ error: 'role must be viewer, member, or admin' }, 400)

  const { data, error } = await db()
    .from('profiles')
    .update({ role })
    .eq('id', id)
    .select('id')
  if (error) return json({ error: error.message }, 500)
  if (!data?.length) return json({ error: 'unknown user id' }, 404)
  return json({ ok: true, id, role })
}

async function remove(req: Request): Promise<Response> {
  let body: { id?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) return json({ error: 'id is required' }, 400)
  const { error } = await db().auth.admin.deleteUser(id)
  if (error) return json({ error: error.message }, 400)
  return json({ ok: true, id })
}

export const GET = () => list()
export const POST = (req: Request) => create(req)
export const PATCH = (req: Request) => setRole(req)
export const DELETE = (req: Request) => remove(req)
