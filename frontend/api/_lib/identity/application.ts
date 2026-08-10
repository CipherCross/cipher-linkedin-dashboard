/**
 * Authentication selection for the application data plane.
 *
 * The browser and the Vercel functions must move together.  When the deployed
 * frontend selects the self-hosted identity path, application APIs accept only
 * its same-origin HttpOnly session cookie; they do not fall back to the retired
 * Supabase bearer verifier.  An unset or misspelled value keeps the currently
 * deployed Supabase path, so importing this module cannot switch production.
 */

import type { DataStore } from '../data/contracts.js'
import type { IdentityProvider } from './provider.js'
import { getIdentityProvider } from './runtime.js'
import {
  resolveRequestActor,
  type RequestActor,
} from './session.js'

export const APPLICATION_AUTH_PATH_ENV = 'VITE_AUTH_PATH'

export type ApplicationAuthPath = 'supabase' | 'identity'

export function deploymentApplicationAuthPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApplicationAuthPath {
  return (env[APPLICATION_AUTH_PATH_ENV] ?? '').trim() === 'identity'
    ? 'identity'
    : 'supabase'
}

export interface ResolveApplicationActorDeps {
  readonly store: DataStore
  readonly authPath?: ApplicationAuthPath
  readonly identity?: IdentityProvider
  readonly legacyProviderName?: string
}

/** Resolve exactly the authenticator selected for this deployment. */
export function resolveApplicationActor(
  request: Request,
  deps: ResolveApplicationActorDeps,
): Promise<RequestActor> {
  const authPath = deps.authPath ?? deploymentApplicationAuthPath()
  if (authPath === 'identity') {
    return resolveRequestActor(request, {
      store: deps.store,
      identity: deps.identity ?? getIdentityProvider(),
      acceptLegacyBearer: false,
    })
  }

  return resolveRequestActor(request, {
    store: deps.store,
    acceptLegacyBearer: true,
    legacyProviderName: deps.legacyProviderName,
  })
}
