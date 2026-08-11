/**
 * The browser's client for `/api/identity` — every call `AuthContext` and the
 * Team page make when `VITE_AUTH_PATH=identity`.
 *
 * ## Why this is a plain module and not part of the React context
 *
 * The default test run is `environment: 'node'` over `tests/**\/*.test.ts`, with
 * no DOM and no `.tsx`. Nothing renders. So the whole of what this path
 * *decides* — which HTTP status means which state, what a roster row projects
 * to, which key an admin action is aimed at — lives here, where it can be
 * measured against a fake `fetch`, and `AuthContext.tsx` is left holding only
 * React state. A rule that only exists inside a component is a rule this repo
 * cannot test.
 *
 * ## What the browser holds: nothing
 *
 * The session is an `HttpOnly` cookie the SPA cannot read, write or refresh.
 * There is no token to store and none to attach — every call here is
 * `credentials: 'same-origin'` and the browser attaches the cookie itself. That
 * is also why sign-in returns 200 with a `Set-Cookie` rather than a redirect
 * (F11): the SPA does its own navigating, and nothing in this file ever sees the
 * session value.
 *
 * `Origin` is likewise never set here. It is a forbidden header — the browser
 * stamps it on every POST and refuses to let script forge it — and that is
 * exactly what makes the server's C1 origin check worth anything. A client that
 * could set it could defeat it.
 *
 * ## Three outcomes, not two
 *
 * The 401/403 split is the contract this file exists to render, and collapsing
 * it is the mistake it is written to prevent:
 *
 * - **401** — not signed in. Show sign-in.
 * - **403** — signed in, and *not an active member*. Deactivating someone leaves
 *   their session valid (F5 measured it), so this is a state a real person
 *   reaches by having their access removed while logged in. Bouncing them to
 *   sign-in would be a lie: signing in would succeed and change nothing.
 * - **200** — active, with the canonical actor.
 *
 * A fourth case is not an outcome of authentication at all: the endpoint being
 * unreachable or misconfigured (500/503, a network failure). It is kept
 * separate, because rendering a deployment fault as "you are signed out" throws
 * away a working session and teaches the person to retype their password at a
 * server that is not going to answer.
 *
 * ## Which id an admin action is aimed at
 *
 * `team_roster()` returns **two** identifiers per row and they name different
 * things: `id` is `public.team_members.id`, a bigint, and `userId` is
 * `public.users.id`, a uuid. The three admin functions all take the **uuid**
 * (`identity_admin_set_member_active(p_user_id uuid, …)`), and the Supabase path
 * this replaces keys its own updates on the bigint. Crossing them is a mistake
 * that type-checks: both are "the member's id" in English. So the admin calls
 * here take `userId` under that name and nothing in this file passes a
 * `RosterMember.id` to one.
 */

import type { TeamMember } from './types'

/** Every op this client is allowed to call, and what each is for. The server
 *  holds the authoritative allowlist; this is the browser's half of it. */
export const IDENTITY_OPS = {
  currentSession: 'session.current',
  signIn: 'session.signIn',
  signOut: 'session.signOut',
  requestReset: 'password.requestReset',
  completeReset: 'password.completeReset',
  roster: 'team.roster',
  invite: 'admin.invite',
  setActive: 'admin.setActive',
  setRole: 'admin.setRole',
} as const

export type IdentityRole = 'member' | 'admin'

/** The `session.current` payload, after validation. */
export interface IdentitySession {
  readonly subject: string
  readonly provider: string
  readonly actorId: string
  /** From `public.team_members` via the resolver — never from the cookie. This
   *  is the only thing a route gate may key on. */
  readonly role: IdentityRole
}

export type SessionOutcome =
  | { readonly kind: 'active'; readonly session: IdentitySession }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'removed'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string }

export interface RosterMember {
  /** `public.team_members.id`. Display and equality only. */
  readonly id: number
  /** `public.users.id`. The key every admin action is aimed at. */
  readonly userId: string
  readonly name: string
  readonly email: string | null
  readonly role: IdentityRole
  readonly active: boolean
  readonly createdAt: string
}

export type RosterOutcome =
  | { readonly kind: 'ok'; readonly members: readonly RosterMember[]; readonly hasMore: boolean }
  | { readonly kind: 'error'; readonly status: number; readonly message: string }

export type ActionOutcome =
  | { readonly kind: 'ok'; readonly warning: string | null }
  | {
      readonly kind: 'error'
      readonly status: number
      readonly message: string
      /** e.g. `LEDGER_STEP_PENDING` — a named precondition, not a fault. */
      readonly code: string | null
    }

/** Injectable so the whole surface is measurable without a browser. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

export function identityUrl(op: string): string {
  return `/api/identity?op=${encodeURIComponent(op)}`
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json()
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * The message to show for a refusal.
 *
 * Two shapes reach here and both are expected: the product endpoint answers
 * `{error}`, and the candidate's own routes answer `{message}`. Falling back to
 * the status is deliberate — an empty string in a toast reads as success.
 */
function errorMessage(body: Record<string, unknown>, status: number): string {
  const named = typeof body.error === 'string' ? body.error : null
  const candidate = typeof body.message === 'string' ? body.message : null
  return named ?? candidate ?? `HTTP ${status}`
}

function errorCode(body: Record<string, unknown>): string | null {
  return typeof body.code === 'string' && body.code !== '' ? body.code : null
}

function readRole(value: unknown): IdentityRole | null {
  return value === 'admin' || value === 'member' ? value : null
}

/**
 * Validate `session.current` rather than cast it.
 *
 * The role decides what the UI unlocks, so a malformed payload must not become
 * `undefined` flowing into `role === 'admin'`. A body that does not carry all
 * four fields is treated as the endpoint being unavailable, not as a session.
 */
function readSession(body: Record<string, unknown>): IdentitySession | null {
  const actor = body.actor
  if (actor === null || typeof actor !== 'object' || Array.isArray(actor)) return null
  const { actorId, role } = actor as Record<string, unknown>
  const parsedRole = readRole(role)
  if (
    typeof body.subject !== 'string' ||
    body.subject === '' ||
    typeof body.provider !== 'string' ||
    typeof actorId !== 'string' ||
    actorId === '' ||
    !parsedRole
  ) {
    return null
  }
  return {
    subject: body.subject,
    provider: body.provider,
    actorId,
    role: parsedRole,
  }
}

function readRosterMember(value: unknown): RosterMember | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const role = readRole(row.role)
  if (
    typeof row.id !== 'number' ||
    typeof row.userId !== 'string' ||
    row.userId === '' ||
    typeof row.name !== 'string' ||
    !role
  ) {
    return null
  }
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    email: typeof row.email === 'string' ? row.email : null,
    role,
    active: row.active === true,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
  }
}

/**
 * A state-changing call. POST, JSON, same-origin, and nothing else — every
 * refusal this can earn (`INVALID_ORIGIN`, `MISSING_OR_NULL_ORIGIN`) comes from
 * the server seeing what the browser stamped, not from anything decided here.
 */
async function postOp(
  op: string,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<Response> {
  return fetchImpl(identityUrl(op), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function actionOutcome(response: Response): Promise<ActionOutcome> {
  const body = await readBody(response)
  if (!response.ok) {
    return {
      kind: 'error',
      status: response.status,
      message: errorMessage(body, response.status),
      code: errorCode(body),
    }
  }
  // `admin.setActive` answers 200 with a `warning` when the member was disabled
  // but their live session could not be revoked. That is a partial success and
  // must not be silently rendered as a clean one.
  return {
    kind: 'ok',
    warning: typeof body.warning === 'string' ? body.warning : null,
  }
}

/**
 * Who the caller is, as the server sees them right now.
 *
 * This is the one call the SPA makes on startup and on every revalidation, and
 * it is a GET: no origin check, no state change, no body.
 */
export async function currentSession(
  fetchImpl: FetchLike = defaultFetch,
): Promise<SessionOutcome> {
  let response: Response
  try {
    response = await fetchImpl(identityUrl(IDENTITY_OPS.currentSession), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    // A network failure is not a sign-out. Losing the distinction would drop a
    // working session every time the laptop's wifi blinked.
    return {
      kind: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    }
  }

  if (response.status === 401) return { kind: 'anonymous' }

  const body = await readBody(response)
  if (response.status === 403) {
    return { kind: 'removed', message: errorMessage(body, 403) }
  }
  if (!response.ok) {
    return { kind: 'unavailable', message: errorMessage(body, response.status) }
  }

  const session = readSession(body)
  if (!session) {
    return { kind: 'unavailable', message: 'The identity service returned an unreadable session.' }
  }
  return { kind: 'active', session }
}

export type SignInOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'refused'; readonly message: string }

/**
 * Sign in. No `callbackURL` is sent: the candidate answers 200 with the cookie
 * and the SPA navigates itself, and an absent callback is one fewer thing that
 * can be aimed off-origin.
 */
export async function signIn(
  email: string,
  password: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<SignInOutcome> {
  const response = await postOp(
    IDENTITY_OPS.signIn,
    { email: email.trim(), password },
    fetchImpl,
  )
  if (response.ok) return { kind: 'ok' }
  const body = await readBody(response)
  // Deliberately the server's own wording. Inventing "wrong password" here
  // would tell a caller which half of the pair was wrong.
  return { kind: 'refused', message: errorMessage(body, response.status) }
}

/**
 * Sign out. Best-effort by construction: the local state is cleared by the
 * caller regardless, because a failure here must never leave someone stuck
 * looking at a dashboard they have asked to leave.
 */
export async function signOut(fetchImpl: FetchLike = defaultFetch): Promise<void> {
  try {
    await postOp(IDENTITY_OPS.signOut, {}, fetchImpl)
  } catch {
    // See above.
  }
}

/**
 * Ask for a recovery link.
 *
 * **This deployment has no email delivery** — SMTP is the external gate the
 * spec names for S18 — so the request is accepted and no message is sent. The
 * call is wired anyway rather than disabled, because the endpoint is the
 * finished half and hiding it would make the gap invisible; the caller's copy
 * is what stays honest about it.
 *
 * `redirectTo` is same-origin. An off-origin one is refused 403
 * `INVALID_REDIRECT_URL`, which F14 measured, so it is built from the caller's
 * own origin and never from anything a form supplied.
 */
/**
 * Set a new password from a recovery link.
 *
 * The token is the whole credential: it arrives in the link, is used once, and
 * is never stored. Failures are returned rather than thrown so the screen can
 * say whether the link expired or the password was refused.
 */
export async function completePasswordReset(
  token: string,
  newPassword: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<SignInOutcome> {
  let response: Response
  try {
    response = await postOp(IDENTITY_OPS.completeReset, { token, newPassword }, fetchImpl)
  } catch {
    return { kind: 'refused', message: 'The service is unreachable. Try again in a moment.' }
  }
  if (response.ok) return { kind: 'ok' }
  const body = await readBody(response)
  return { kind: 'refused', message: errorMessage(body, response.status) }
}

export async function requestPasswordReset(
  email: string,
  origin: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<SignInOutcome> {
  const response = await postOp(
    IDENTITY_OPS.requestReset,
    { email: email.trim(), redirectTo: `${origin}/` },
    fetchImpl,
  )
  if (response.ok) return { kind: 'ok' }
  const body = await readBody(response)
  return { kind: 'refused', message: errorMessage(body, response.status) }
}

/**
 * The roster. Gated on membership rather than admin — an ordinary member needs
 * it to see who owns a conversation — so it is also how a signed-in person's own
 * display name is found.
 */
export async function teamRoster(
  fetchImpl: FetchLike = defaultFetch,
): Promise<RosterOutcome> {
  let response: Response
  try {
    response = await fetchImpl(identityUrl(IDENTITY_OPS.roster), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    return {
      kind: 'error',
      status: 0,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const body = await readBody(response)
  if (!response.ok) {
    return {
      kind: 'error',
      status: response.status,
      message: errorMessage(body, response.status),
    }
  }
  const raw = Array.isArray(body.members) ? body.members : []
  // A row that does not parse is dropped rather than faked. Half a roster is a
  // visible gap; a row with an invented uuid is an admin action aimed at nobody.
  const members = raw
    .map(readRosterMember)
    .filter((member): member is RosterMember => member !== null)
  return { kind: 'ok', members, hasMore: body.hasMore === true }
}

export interface InviteInput {
  readonly email: string
  readonly name: string
  readonly role: IdentityRole
}

export async function inviteMember(
  input: InviteInput,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ActionOutcome> {
  return actionOutcome(
    await postOp(
      IDENTITY_OPS.invite,
      {
        email: input.email.trim(),
        name: input.name.trim(),
        role: input.role,
      },
      fetchImpl,
    ),
  )
}

/**
 * Enable or disable a member.
 *
 * Keyed on the canonical uuid, which is also what makes the revocation right:
 * the server reads the provider subject back out of the SQL function's own
 * result and revokes that, so a caller cannot aim a revocation at someone else.
 */
export async function setMemberActive(
  userId: string,
  active: boolean,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ActionOutcome> {
  return actionOutcome(
    await postOp(IDENTITY_OPS.setActive, { userId, active }, fetchImpl),
  )
}

export async function setMemberRole(
  userId: string,
  role: IdentityRole,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ActionOutcome> {
  return actionOutcome(
    await postOp(IDENTITY_OPS.setRole, { userId, role }, fetchImpl),
  )
}

/**
 * Project a roster row onto the shape the rest of the SPA already consumes, so
 * `Layout`, `usePipelineActions` and the Team page compile against one type on
 * both paths.
 *
 * `auth_user_id` is **null**, and that is a statement rather than a placeholder:
 * on this path there is no Supabase Auth user, and the field means precisely
 * that. Filling it with the canonical uuid would make an id from one space
 * answer a question about another — the same conflation the admin keys above
 * exist to avoid — and the Supabase path reads that field to mean "login
 * enabled", which would then be wrong in both directions.
 */
export function toTeamMember(row: RosterMember): TeamMember {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    created_at: row.createdAt,
    auth_user_id: null,
    email: row.email,
    role: row.role,
  }
}

/** The signed-in person's own roster row, found by canonical id. */
export function findSelf(
  members: readonly RosterMember[],
  actorId: string,
): RosterMember | null {
  return members.find((member) => member.userId === actorId) ?? null
}
