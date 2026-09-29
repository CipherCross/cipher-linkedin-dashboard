/**
 * Authentication for the application data plane.
 *
 * Application APIs accept only the self-hosted identity provider's same-origin
 * HttpOnly session cookie. There is no second authenticator and no deployment
 * switch: `VITE_AUTH_PATH` is still bound by the tenant contract, but the server
 * does not read it.
 */

import type { DataStore } from '../data/contracts.js'
import type { IdentityProvider } from './provider.js'
import { getIdentityProvider } from './runtime.js'
import {
  resolveRequestActor,
  type RequestActor,
} from './session.js'

export interface ResolveApplicationActorDeps {
  readonly store: DataStore
  /** Defaults to the deployed provider; tests inject the fake. */
  readonly identity?: IdentityProvider
  /**
   * `user_identities.provider` for the session's subjects. Defaults to the
   * deployed provider's name; tests pass `fixture`, the provider the
   * baseline's contract fixtures are seeded under.
   */
  readonly providerName?: string
}

/** Resolve the caller from its identity session, or throw `AuthorizationError`. */
export function resolveApplicationActor(
  request: Request,
  deps: ResolveApplicationActorDeps,
): Promise<RequestActor> {
  return resolveRequestActor(request, {
    store: deps.store,
    identity: deps.identity ?? getIdentityProvider(),
    providerName: deps.providerName,
  })
}
