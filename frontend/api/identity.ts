/**
 * `/api/identity` — the whole server-side identity surface, as one function.
 *
 * **Why one function.** The Vercel budget is full at 12 (B3), which is why
 * `reclassify.ts` was folded into `classify.ts` to free the slot this occupies:
 * the deployed count is unchanged. B3 already forced the same shape on S13's
 * reads, so this is that vocabulary, not a transitional shim — the operation
 * names below are product operations and are meant to last.
 *
 * **How the operation is selected, and why it is the query string.** `?op=` and
 * never the body. The candidate's own routes need their request body delivered
 * untouched, and a dispatcher that had to parse the body to learn where to send
 * it would have to reconstruct it — which is how a credential ends up copied
 * through a place that had no reason to hold it. The op name is in the URL, the
 * body is forwarded verbatim.
 *
 * **What this endpoint exposes, and what it does not.**
 *
 * | Operation | Method | Who | What it reaches |
 * |---|---|---|---|
 * | `session.signIn` | POST | anyone | candidate's `/sign-in/email` |
 * | `session.signOut` | POST | anyone | candidate's `/sign-out` |
 * | `password.requestReset` | POST | anyone | candidate's `/forget-password` |
 * | `password.completeReset` | POST | anyone | candidate's `/reset-password` |
 * | `password.change` | POST | signed in, knows current password | candidate's `/change-password` |
 * | `session.current` | GET | any signed-in caller | the resolver, then nothing |
 * | `team.roster` | GET | any active member | `public.team_roster()` |
 * | `admin.invite` | POST | admin | `identity_admin_invite_member_atomic` |
 * | `admin.setActive` | POST | admin | `identity_admin_set_member_active` + revoke |
 * | `admin.setRole` | POST | admin | `identity_admin_set_member_role` |
 * | `maintenance.pruneSessions` | POST | admin or `CRON_SECRET` | expired rows only |
 *
 * It does **not** expose: the candidate's admin plugin routes (`admin/create-user`,
 * `admin/ban-user`, `admin/list-users`, impersonation) — the plugin is loaded
 * because step 004's DDL is its output, but no route of it is on the allowlist,
 * so the product's admin path is the three self-authorizing SQL functions and
 * nothing else. It exposes no member deletion, because disable is the sanctioned
 * end state and `public.users` rows are never removed. It exposes no way to read
 * another person's session, no provider subject other than the caller's own, and
 * no password material in any response.
 *
 * **C1, restated as code.** Every state-changing operation is POST and gets the
 * product's own origin check before anything else happens; no operation on this
 * endpoint changes state on a GET, and the two GETs are pure reads. The candidate
 * also applies its own origin check to its own routes, so the forwarded ones are
 * checked twice, by us and by it.
 */

import { authorizationResponse, requireMachineSecret } from './_lib/auth.js'
import {
  DataStoreContractError,
  type DataStore,
} from './_lib/data/contracts.js'
import {
  IDENTITY_ADMIN_COMMANDS,
  IDENTITY_OPERATIONS,
  type TeamRosterRow,
} from './_lib/data/operations/index.js'
import { getDataStore } from './_lib/data/store.js'
import {
  IDENTITY_BASE_PATH,
  IdentityConfigurationError,
  readIdentityConfig,
} from './_lib/identity/config.js'
import { checkRequestOrigin, originRefusal } from './_lib/identity/origin.js'
import type { IdentityProvider } from './_lib/identity/provider.js'
import { getIdentityProvider, pruneSessionsIfDue } from './_lib/identity/runtime.js'
import {
  requireAdminActor,
  resolveRequestActor,
  type RequestActor,
} from './_lib/identity/session.js'

export const maxDuration = 10

/**
 * Operations forwarded to the candidate, and the route each maps to.
 *
 * An allowlist rather than a prefix match: a dispatcher that forwarded any path
 * under the base path would expose every route the candidate and its plugins
 * happen to register, including ones added by a future dependency upgrade.
 */
const CANDIDATE_ROUTES: Readonly<Record<string, string>> = {
  'session.signIn': '/sign-in/email',
  'session.signOut': '/sign-out',
  'password.requestReset': '/forget-password',
  'password.completeReset': '/reset-password',
  /**
   * Change your own password while signed in.
   *
   * Here because its absence was an omission, not a decision, and the gap was
   * sharp: `password.requestReset` needs email delivery this deployment does not
   * have, so without this there is **no** way for anyone to change their
   * password — an initial passphrase handed over out of band would have been
   * permanent.
   *
   * The candidate's own route requires the *current* password as well as the new
   * one, and requires a valid session, so this endpoint adds no authorization of
   * its own: it is POST, so it is origin-checked like every other state change,
   * and the candidate refuses a caller who cannot prove the existing password.
   * Nothing here reads or logs either value.
   */
  'password.change': '/change-password',
}

/** The only operations reachable with GET, and every one is a pure read. */
const READ_OPERATIONS: readonly string[] = ['session.current', 'team.roster']

/** Product-served operations that change state. All POST, all origin-checked. */
const WRITE_OPERATIONS: readonly string[] = [
  'admin.invite',
  'admin.setActive',
  'admin.setRole',
  'maintenance.pruneSessions',
]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

/**
 * What is safe to log. The driver wraps a failure as `${what}: ${message}`, and
 * for a connection-level failure the message embeds the database hostname, so
 * neither the error nor its message may be logged. `name` and `code` are
 * adapter-owned constants.
 */
function safeErrorLabel(error: unknown): string {
  if (error instanceof DataStoreContractError) return `${error.name}/${error.code}`
  if (error instanceof Error) return error.name
  return 'UnknownError'
}

/** SQLSTATE 42883: the step-005 function is not applied to this database yet. */
function isMissingFunction(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === '42883') return true
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause
  return cause?.code === '42883'
}

/** SQLSTATE 42501: the database itself refused a non-admin actor. */
function isInsufficientPrivilege(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === '42501') return true
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause
  return cause?.code === '42501'
}

export interface IdentityHandlerDeps {
  readonly identity: IdentityProvider
  readonly store: DataStore
  /** Transitional Supabase bearer acceptance. See `session.ts`. */
  readonly acceptLegacyBearer?: boolean
  readonly providerName?: string
  readonly legacyProviderName?: string
  readonly trustedOrigin: string
  readonly basePath?: string
}

/**
 * Build the handler. Dependency-injected so the whole surface can be exercised
 * against the fake provider and fake store in the default test run, with no
 * container and no credential.
 */
export function createIdentityHandler(
  deps: IdentityHandlerDeps,
): (request: Request) => Promise<Response> {
  const basePath = deps.basePath ?? IDENTITY_BASE_PATH

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const op = (url.searchParams.get('op') ?? '').trim()

    if (op === '') {
      return json({ error: 'op is required' }, 400)
    }

    const isCandidateRoute = Object.hasOwn(CANDIDATE_ROUTES, op)
    const isRead = READ_OPERATIONS.includes(op)
    const isWrite = WRITE_OPERATIONS.includes(op)

    if (!isCandidateRoute && !isRead && !isWrite) {
      // Names the refusal without enumerating the vocabulary.
      return json({ error: `operation is not allowlisted: ${op}` }, 400)
    }

    // Method first, so `?op=session.signIn` on a GET is a 405 rather than
    // something that reaches the origin check and looks exempt.
    const method = request.method.toUpperCase()
    if (isRead && method !== 'GET') {
      return json({ error: 'method not allowed' }, 405)
    }
    if (!isRead && method !== 'POST') {
      return json({ error: 'method not allowed' }, 405)
    }

    // C1. Every state-changing request, ours and the candidate's alike.
    if (method === 'POST') {
      const origin = checkRequestOrigin(request, deps.trustedOrigin)
      if (!origin.ok) return originRefusal(origin.reason)
    }

    if (isCandidateRoute) {
      return forwardToCandidate(request, url, basePath, CANDIDATE_ROUTES[op], deps)
    }

    // One resolution per request, passed down. G2's B5 and G3's C6.
    let resolved: RequestActor
    try {
      resolved = await resolveRequestActor(request, {
        identity: deps.identity,
        store: deps.store,
        acceptLegacyBearer: deps.acceptLegacyBearer,
        providerName: deps.providerName,
        legacyProviderName: deps.legacyProviderName,
      })
    } catch (error) {
      const denial = authorizationResponse(error)
      if (denial) return denial
      console.error('identity: actor resolution failed:', safeErrorLabel(error))
      return json({ error: 'Could not verify team access' }, 500)
    }

    switch (op) {
      case 'session.current':
        return sessionCurrent(resolved)
      case 'team.roster':
        return teamRoster(resolved, deps)
      case 'admin.invite':
        return adminInvite(request, resolved, deps)
      case 'admin.setActive':
        return adminSetActive(request, resolved, deps)
      case 'admin.setRole':
        return adminSetRole(request, resolved, deps)
      case 'maintenance.pruneSessions':
        return pruneSessions(request, resolved, deps)
      default:
        // Unreachable: the allowlist above is the same list as this switch, and
        // a test asserts they match.
        return json({ error: `operation is not allowlisted: ${op}` }, 400)
    }
  }
}

/**
 * Hand the request to the candidate under the route it expects.
 *
 * The body is forwarded as-is and every header is preserved, so the candidate
 * sees the real `Origin` and `Cookie` and its own middleware behaves exactly as
 * F3 measured. Only the URL path changes.
 */
async function forwardToCandidate(
  request: Request,
  url: URL,
  basePath: string,
  route: string,
  deps: IdentityHandlerDeps,
): Promise<Response> {
  const target = new URL(request.url)
  target.pathname = `${basePath}${route}`
  // `op` has been consumed by the dispatcher; the candidate never sees it.
  target.searchParams.delete('op')
  void url

  const body = await request.text()
  const forwarded = new Request(target, {
    method: request.method,
    headers: request.headers,
    body: body === '' ? undefined : body,
  })

  try {
    const response = await deps.identity.handle(forwarded)
    // Housekeeping rides along on the cheapest state-changing path there is,
    // after the response is built so it cannot alter it. See C4 in runtime.ts.
    await pruneSessionsIfDue(deps.identity)
    return response
  } catch (error) {
    console.error('identity: candidate route failed:', safeErrorLabel(error))
    return json({ error: 'Authentication is unavailable' }, 503)
  }
}

/**
 * `session.current` — the call S18's `AuthContext` makes on startup.
 *
 * Three outcomes and they are all distinct: 401 not signed in, 403 signed in but
 * not an active member, 200 with the canonical actor. `role` comes from the
 * database, and it is the only thing a route gate may key on.
 *
 * It returns the caller's own subject and nothing about anyone else — no email
 * from the store, no provider record, no session list.
 */
function sessionCurrent(resolved: RequestActor): Response {
  return json({
    subject: resolved.subject,
    provider: resolved.provider,
    actor: { actorId: resolved.actor.actorId, role: resolved.actor.role },
  })
}

async function teamRoster(
  resolved: RequestActor,
  deps: IdentityHandlerDeps,
): Promise<Response> {
  try {
    const page = await deps.store.query<TeamRosterRow>(resolved.actor, {
      operation: IDENTITY_OPERATIONS.teamRoster,
      page: { limit: 200 },
    })
    return json({ members: page.items, hasMore: page.hasMore })
  } catch (error) {
    console.error('identity: roster read failed:', safeErrorLabel(error))
    return json({ error: 'Could not load the team roster' }, 500)
  }
}

interface JsonBody {
  readonly [key: string]: unknown
}

async function readJson(request: Request): Promise<JsonBody | null> {
  try {
    const parsed = (await request.json()) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as JsonBody
  } catch {
    return null
  }
}

function readString(body: JsonBody, key: string, max: number): string | null {
  const value = body[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) return null
  return trimmed
}

function readRole(body: JsonBody): 'member' | 'admin' | null {
  return body.role === 'member' || body.role === 'admin' ? body.role : null
}

/**
 * Turn a database refusal into a response.
 *
 * 42501 is the database's own `is_app_admin()` refusing, and it is mapped to 403
 * rather than 500 deliberately: it is an authorization outcome, not a fault. It
 * should be unreachable, because `requireAdminActor` already refused a member —
 * and the fact that it is still handled here is the point. The database is the
 * gate; this is what happens when the gate, not the endpoint, is what stops
 * someone.
 */
function adminFailure(error: unknown, what: string): Response {
  if (isMissingFunction(error)) {
    return json(
      {
        error:
          'Inviting a member needs migration ledger step 005, which is not ' +
          'applied to this database yet.',
        code: 'LEDGER_STEP_PENDING',
      },
      503,
    )
  }
  if (isInsufficientPrivilege(error)) {
    return json({ error: 'Admin access required' }, 403)
  }
  console.error(`identity: ${what} failed:`, safeErrorLabel(error))
  return json({ error: `Could not ${what}` }, 500)
}

async function adminInvite(
  request: Request,
  resolved: RequestActor,
  deps: IdentityHandlerDeps,
): Promise<Response> {
  try {
    requireAdminActor(resolved)
  } catch (error) {
    return authorizationResponse(error) ?? json({ error: 'Forbidden' }, 403)
  }

  const body = await readJson(request)
  if (!body) return json({ error: 'invalid JSON body' }, 400)

  const email = readString(body, 'email', 320)
  const name = readString(body, 'name', 100)
  const role = readRole(body)
  if (!email || !email.includes('@')) {
    return json({ error: 'email must be a valid address' }, 400)
  }
  if (!name) return json({ error: 'name is required' }, 400)
  if (!role) return json({ error: 'role must be member or admin' }, 400)

  // A random initial passphrase that is never returned and never logged. The
  // invited person reaches their account through the reset flow, so nobody —
  // including whoever ran the invite — ever knows this value. It exists only so
  // the account has a credential row at all.
  const initial = crypto.randomUUID() + crypto.randomUUID()

  try {
    const prepared = await deps.identity.prepareAccount({ password: initial })
    const result = await deps.store.transaction(resolved.actor, (transaction) =>
      transaction.execute({
        operation: IDENTITY_ADMIN_COMMANDS.invite,
        params: {
          email,
          name,
          role,
          provider: deps.identity.name,
          providerSubject: prepared.subject,
          passwordHash: prepared.passwordHash,
        },
      }),
    )
    // The subject is deliberately not echoed: it is the store's internal id and
    // the caller has no use for it.
    return json({ ok: true, member: result })
  } catch (error) {
    return adminFailure(error, 'invite the member')
  }
}

async function adminSetActive(
  request: Request,
  resolved: RequestActor,
  deps: IdentityHandlerDeps,
): Promise<Response> {
  try {
    requireAdminActor(resolved)
  } catch (error) {
    return authorizationResponse(error) ?? json({ error: 'Forbidden' }, 403)
  }

  const body = await readJson(request)
  if (!body) return json({ error: 'invalid JSON body' }, 400)
  const userId = readString(body, 'userId', 64)
  if (!userId) return json({ error: 'userId is required' }, 400)
  if (typeof body.active !== 'boolean') {
    return json({ error: 'active must be a boolean' }, 400)
  }
  const active = body.active

  let result: unknown
  try {
    result = await deps.store.transaction(resolved.actor, (transaction) =>
      transaction.execute({
        operation: IDENTITY_ADMIN_COMMANDS.setActive,
        params: { userId, active },
      }),
    )
  } catch (error) {
    return adminFailure(error, 'change member activation')
  }

  // **C2's second half.** The SQL function moves `users.active` and
  // `team_members.active` together, which stops the member's next request at
  // 403 — but it does not touch session state, because the store is not its to
  // write. Disabling someone and ending their live session are two things, and
  // this is the second. Without it the member stays authenticated: F5 measured
  // that their cookie remains valid and they can still sign in.
  let sessionsRevoked: number | null = null
  if (!active) {
    const subject = readOptionalSubject(result)
    if (subject) {
      try {
        sessionsRevoked = await deps.identity.revokeSessions(subject)
      } catch (error) {
        // The canonical disable already committed and is the control that
        // matters. Report the shortfall rather than pretending it succeeded, so
        // an operator knows a live session may survive until it expires.
        console.error(
          'identity: session revocation after disable failed:',
          safeErrorLabel(error),
        )
        return json(
          {
            ok: true,
            member: result,
            sessionsRevoked: null,
            warning:
              'The member is disabled and their next request is refused, but ' +
              'their existing session could not be revoked.',
          },
          200,
        )
      }
    }
  }

  return json({ ok: true, member: result, sessionsRevoked })
}

/**
 * The provider subject to revoke, as the SQL function reports it.
 *
 * Read from the function's return value rather than from the request, because
 * the request carries a canonical `userId` and the store is keyed by subject —
 * and because trusting the caller for the thing being revoked would let an admin
 * aim a revocation at a subject unrelated to the member they disabled.
 */
function readOptionalSubject(result: unknown): string | null {
  const subject = (result as { provider_subject?: unknown } | null)?.provider_subject
  return typeof subject === 'string' && subject.trim() !== '' ? subject.trim() : null
}

async function adminSetRole(
  request: Request,
  resolved: RequestActor,
  deps: IdentityHandlerDeps,
): Promise<Response> {
  try {
    requireAdminActor(resolved)
  } catch (error) {
    return authorizationResponse(error) ?? json({ error: 'Forbidden' }, 403)
  }

  const body = await readJson(request)
  if (!body) return json({ error: 'invalid JSON body' }, 400)
  const userId = readString(body, 'userId', 64)
  const role = readRole(body)
  if (!userId) return json({ error: 'userId is required' }, 400)
  if (!role) return json({ error: 'role must be member or admin' }, 400)

  try {
    const result = await deps.store.transaction(resolved.actor, (transaction) =>
      transaction.execute({
        operation: IDENTITY_ADMIN_COMMANDS.setRole,
        params: { userId, role },
      }),
    )
    return json({ ok: true, member: result })
  } catch (error) {
    return adminFailure(error, 'change the member role')
  }
}

/**
 * The explicit pruning trigger (C4).
 *
 * Reachable two ways, and both are deliberate: an admin actor, or a machine
 * caller holding `CRON_SECRET`. It is a POST, so it is origin-checked like every
 * other state change and Vercel's GET-only cron scheduler cannot drive it — the
 * in-request schedule in `runtime.ts` is the default mechanism and this is the
 * deliberate one.
 */
async function pruneSessions(
  request: Request,
  resolved: RequestActor,
  deps: IdentityHandlerDeps,
): Promise<Response> {
  const isAdmin = resolved.actor.role === 'admin'
  if (!isAdmin) {
    try {
      requireMachineSecret(request, 'CRON_SECRET')
    } catch {
      return json({ error: 'Admin access required' }, 403)
    }
  }

  try {
    const pruned = await deps.identity.pruneExpiredSessions()
    return json({ ok: true, pruned })
  } catch (error) {
    console.error('identity: pruning failed:', safeErrorLabel(error))
    return json({ error: 'Could not prune sessions' }, 500)
  }
}

/**
 * The deployed handler. Constructed lazily on first request so importing this
 * module needs no credential — a type-check and the contract suite both import
 * it without touching a database.
 */
let deployed: ((request: Request) => Promise<Response>) | null = null

function deployedHandler(): (request: Request) => Promise<Response> {
  if (!deployed) {
    const config = readIdentityConfig()
    deployed = createIdentityHandler({
      identity: getIdentityProvider(),
      store: getDataStore(),
      trustedOrigin: config.baseUrl,
      // Transitional, and the reason is in session.ts: the running dashboard
      // still signs in through Supabase Auth and S18 is what rewires it.
      acceptLegacyBearer: true,
    })
  }
  return deployed
}

async function entry(request: Request): Promise<Response> {
  try {
    return await deployedHandler()(request)
  } catch (error) {
    // A configuration failure must not look like an authentication failure, and
    // the *response* stays deliberately vague: this endpoint is unauthenticated,
    // and which variables a deployment is missing is not something to publish.
    //
    // The server log is the opposite case, and the distinction is the point.
    // Everywhere else here logs only `name/code`, because a driver-level failure
    // embeds the database hostname in its message. An IdentityConfigurationError
    // names an environment *variable* and never a value, so logging its message
    // leaks nothing and is the only thing that makes a misconfigured deployment
    // diagnosable at all. Learned the hard way: the first production deploy
    // returned this 500 and the logs could not say which variable was at fault.
    if (error instanceof IdentityConfigurationError) {
      console.error('identity: not configured:', error.message)
    } else {
      console.error('identity: handler unavailable:', safeErrorLabel(error))
    }
    return json({ error: 'Identity is not configured' }, 500)
  }
}

export const GET = (request: Request) => entry(request)
export const POST = (request: Request) => entry(request)
