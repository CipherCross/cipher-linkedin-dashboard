/**
 * The fake identity provider, set up the way the handler suites need it.
 *
 * The identity session cookie is the only way a browser request authenticates,
 * so a suite that wants to act as a given subject presents a real fake session
 * for that subject rather than stubbing a verifier. Everything after the cookie —
 * `identity_resolve_actor`, the role, RLS — runs exactly as in production.
 */

import {
  FAKE_SESSION_COOKIE,
  FakeIdentityProvider,
} from '../../api/_lib/identity/fakeProvider.js'
import type { IdentityProvider } from '../../api/_lib/identity/provider.js'

/** `user_identities.provider` the baseline's contract fixtures are seeded under. */
export const FIXTURE_PROVIDER_NAME = 'fixture'

export class FixtureIdentity {
  readonly provider = new FakeIdentityProvider()
  private readonly seeded = new Set<string>()

  constructor(readonly providerName: string = FIXTURE_PROVIDER_NAME) {}

  /** The seam every handler and writer takes. */
  get deps(): { identity: IdentityProvider; providerName: string } {
    return { identity: this.provider, providerName: this.providerName }
  }

  /** A `Cookie` header value presenting a live session for `subject`. */
  cookie(subject: string): string {
    if (!this.seeded.has(subject)) {
      this.provider.seedAccount({
        subject,
        email: `${subject}@fixture.test`,
        password: 'unused',
      })
      this.seeded.add(subject)
    }
    return `${FAKE_SESSION_COOKIE}=${this.provider.seedSession(subject)}`
  }

  /**
   * Request headers for `subject`. `null` presents a session token the
   * provider never issued — the invalid-or-expired case, which must 401 the
   * same as no credential at all.
   */
  headers(subject: string | null, unissuedToken = 'never-issued'): Record<string, string> {
    return subject === null
      ? { cookie: `${FAKE_SESSION_COOKIE}=${unissuedToken}` }
      : { cookie: this.cookie(subject) }
  }
}
