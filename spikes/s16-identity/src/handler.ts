/**
 * The spike's request surface, shaped exactly like a Vercel function:
 * `(request: Request) => Promise<Response>`, Web Fetch types only, no
 * framework, no Node `http` types, no filesystem, no module-scope credential.
 *
 * That shape is the point of the "does it work in the serverless runtime"
 * question. Everything the candidate needs at request time is the incoming
 * `Request` and a database connection; nothing it needs is a long-lived
 * server object, an in-process session table or a sticky instance.
 *
 * **This is not mounted anywhere.** It is not in `frontend/api/`, it is not in
 * `vercel.json`, and the product's serverless-function count is unchanged at
 * 12. `tests/serverlessShape.test.ts` asserts both of those.
 */

import { AUTH_BASE_PATH } from './spikeAuth.js'
import { ActorResolutionError, type ActorResolver, type CanonicalActor } from './canonicalActor.js'

/** The application route: "who am I, canonically?" */
export const WHOAMI_PATH = '/api/s16-whoami'

/**
 * The only surface of the candidate the spike depends on.
 *
 * Deliberately structural and tiny: two members. If replacing the candidate
 * ever becomes the answer, this interface is the whole porting surface, and
 * that is a fact about the decision G3 is making.
 */
export interface CandidateAuth {
  handler(request: Request): Promise<Response>
  api: {
    getSession(input: { headers: Headers }): Promise<{
      user: { id: string; email: string; canonicalUserId?: string | null }
    } | null>
  }
}

export interface SpikeHandlerDeps {
  readonly auth: CandidateAuth
  readonly resolveActor: ActorResolver
  /** `user_identities.provider` the mapping matches on. */
  readonly provider: string
}

export interface WhoAmIBody {
  readonly subject: string
  readonly actor: CanonicalActor
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Build the handler.
 *
 * Failure logging: nothing here logs an error's `message`. S12 measured that a
 * `DataStoreContractError`'s message can embed the database hostname, and this
 * session's invariants forbid a provider hostname in any log line. The handler
 * returns a fixed string per outcome and logs nothing at all, which is the
 * strongest version of that rule.
 */
export function createSpikeHandler(
  deps: SpikeHandlerDeps,
): (request: Request) => Promise<Response> {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === WHOAMI_PATH) {
      let session: Awaited<ReturnType<CandidateAuth['api']['getSession']>>
      try {
        session = await deps.auth.api.getSession({ headers: request.headers })
      } catch {
        return json(401, { error: 'Authentication required' })
      }
      if (!session) return json(401, { error: 'Authentication required' })

      try {
        const actor = await deps.resolveActor({
          provider: deps.provider,
          subject: session.user.id,
          proposedActorId: session.user.canonicalUserId ?? null,
        })
        return json(200, { subject: session.user.id, actor } satisfies WhoAmIBody)
      } catch (error) {
        if (error instanceof ActorResolutionError) {
          return json(403, { error: 'Your account is not an active team member' })
        }
        return json(500, { error: 'Identity resolution failed' })
      }
    }

    if (url.pathname === AUTH_BASE_PATH || url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
      return deps.auth.handler(request)
    }

    return json(404, { error: 'Not found' })
  }
}
