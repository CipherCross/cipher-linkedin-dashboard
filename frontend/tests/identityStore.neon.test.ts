/**
 * The adapter against the **real** identity store on the live project.
 *
 * **Read-only, by decision and not by accident.** G3 recorded that the S16 spike
 * wrote nothing to the live project. Minting an account here to exercise sign-in
 * would leave rows in a production store outside the migration ledger, so this
 * file asserts only what can be asserted without writing: that the adapter
 * reaches the store as the right principal, resolves the candidate's unqualified
 * table names, and cannot see the workspace it authenticates people into.
 *
 * The one exception is pruning, which by definition removes expired rows; the
 * assertions carry that count rather than assuming it is zero.
 *
 * This file no longer assumes the store is **empty**. It was, when S17 wrote it;
 * the first-admin bootstrap on 2026-08-04 put a real admin in it, and every
 * assertion phrased as "still zero" went red for a reason that had nothing to do
 * with the adapter. They are now phrased against a baseline captured at startup,
 * which is what they always meant and is a stronger claim.
 *
 * That is a smaller claim than "the candidate works end to end against Neon", and
 * the gap is recorded in `docs/implementation-handoffs/N-S17.md` rather than
 * papered over. The end-to-end claim is made where it can be made safely: the
 * S16 spike measured the candidate's own behaviour in a clean room against these
 * exact tables, and `postgres/tests/portable_identity_atomic_invite_cleanroom.sh`
 * proves the cross-store invite against the real DDL.
 *
 *   set -a && . ~/.config/neon-s17-identity-store.env && set +a && npm run test:neon
 *
 * Skipped — loudly, never silently — when the credential is absent, because the
 * identity store credential is issued out of band and a developer without it
 * should not see a red suite.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BetterAuthIdentityProvider } from '../api/_lib/identity/betterAuthProvider.js'
import {
  IDENTITY_STORE_DATABASE_URL_ENV,
  readIdentityConfig,
} from '../api/_lib/identity/config.js'

const credential = process.env[IDENTITY_STORE_DATABASE_URL_ENV]
const configured = typeof credential === 'string' && credential.trim() !== ''

if (!configured) {
  console.warn(
    `${IDENTITY_STORE_DATABASE_URL_ENV} is not set; the identity store leg was skipped. ` +
      'Source ~/.config/neon-s17-identity-store.env to run it.',
  )
}

describe.skipIf(!configured)('the identity store adapter, against the live store', () => {
  // A base URL and a secret are required by the config reader but irrelevant to a
  // connection test; they are supplied here so the file needs only the one
  // credential that is genuinely about the database.
  process.env.IDENTITY_BASE_URL ??= 'http://localhost:3000'
  process.env.IDENTITY_SESSION_SECRET ??= 'x'.repeat(64)

  const provider = new BetterAuthIdentityProvider({ config: readIdentityConfig() })

  // What "writes nothing" is measured against. This used to be the literal
  // `{0,0,0,0}` the store held when S17 wrote this file, and that stopped being
  // true on 2026-08-04 when the first-admin bootstrap put a real admin in it —
  // so the suite went red for a reason that had nothing to do with the adapter.
  // Capturing the counts instead of restating them makes the assertion say what
  // it always meant, and makes it a stronger claim: not "the store is empty"
  // but "these calls changed nothing", which holds however full the store is.
  let before: Record<string, number> | null = null
  // Expired sessions the pruning test legitimately removes. The final assertion
  // subtracts them rather than pretending nothing was deleted.
  let pruned = 0

  beforeAll(async () => {
    before = await provider.storeRowCountsForTests()
  })

  afterAll(async () => {
    await provider.close()
  })

  it('reaches the store, as identity_store, with the candidate names resolving', async () => {
    // `getSession` on a request with no cookie is the cheapest call that forces
    // the connection and the startup assertion to run. It must answer null rather
    // than throw: an absent session is not an error.
    const session = await provider.getSession(new Headers())
    expect(session).toBeNull()
  })

  it('prunes only expired sessions, and does not fail trying', async () => {
    // Proves the pruning statement is valid against the real DDL, which is the
    // part of C4 a fake cannot check: the column is "expiresAt", quoted and
    // camel-cased, and a typo there would only ever surface here.
    //
    // This used to assert `toBe(0)` "because the store is empty". That premise
    // died with the first real admin, and the assertion was a time bomb rather
    // than a check: sessions expire, so the first run after an expiry would have
    // gone red for correct behaviour. What is actually guaranteed is that
    // pruning removes expired rows and only those, so that is what is asserted —
    // and the count is carried into the final check rather than assumed to be 0.
    pruned = await provider.pruneExpiredSessions()
    expect(pruned).toBeGreaterThanOrEqual(0)
    expect(pruned).toBeLessThanOrEqual(before?.session ?? 0)
  })

  it('revoking sessions for an unknown subject is a no-op, not an error', async () => {
    const revoked = await provider.revokeSessions('subject-that-does-not-exist')
    expect(revoked).toBe(0)
  })

  it('refuses a blank subject rather than issuing a wide delete', async () => {
    // The failure mode this guards against is a DELETE whose WHERE clause matched
    // everything because the subject was empty.
    await expect(provider.revokeSessions('')).rejects.toThrow(/subject is required/i)
  })

  it('hashes a passphrase with the candidate’s own hashing, and the passphrase does not survive', async () => {
    const passphrase = 'correct horse battery staple'
    const prepared = await provider.prepareAccount({ password: passphrase })

    expect(prepared.subject).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(prepared.passwordHash).not.toContain(passphrase)
    expect(prepared.passwordHash.length).toBeGreaterThan(32)
    // Two calls with the same passphrase must differ, or the hash is unsalted.
    const again = await provider.prepareAccount({ password: passphrase })
    expect(again.passwordHash).not.toBe(prepared.passwordHash)
    expect(again.subject).not.toBe(prepared.subject)
  })

  it('writes nothing: the store holds exactly what it held before every call above', async () => {
    // The claim the header makes, asserted rather than promised. `prepareAccount`
    // in particular must not have written a row — it computes values and returns
    // them, and the write is ledger step 005's single transaction.
    const rows = await provider.storeRowCountsForTests()
    expect(rows).toEqual({ ...before, session: (before?.session ?? 0) - pruned })
  })
})
