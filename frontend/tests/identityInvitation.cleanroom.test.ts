/**
 * The invitation link, against the **real** candidate and a real identity store.
 *
 * The offline contract suite proves the product's half: that `admin.invite`
 * asks for a letter, marks it an invitation, and reports what the sink recorded.
 * It cannot prove the half that has broken twice — that Better Auth accepts the
 * request this endpoint actually mints. `CANDIDATE_ROUTES` pointed at
 * `/forget-password` for the operation's entire life and answered 404 the whole
 * time, and nobody noticed because delivery was discarded anyway. A fake
 * provider would have agreed with the wrong route just as readily.
 *
 * So this drives `deliverInvitationLink` itself — the product's own request, not
 * a restatement of it — against a container the migration ledger built.
 *
 * Run it through the harness, which creates the database and exports the
 * credentials:
 *
 *   postgres/tests/portable_identity_invitation_link_cleanroom.sh
 *
 * Skipped, loudly, when they are absent.
 */

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { deliverInvitationLink } from '../api/identity.js'
import { FakeDataStore } from '../api/_lib/data/fake.js'
import { BetterAuthIdentityProvider } from '../api/_lib/identity/betterAuthProvider.js'
import {
  IDENTITY_STORE_DATABASE_URL_ENV,
  readIdentityConfig,
} from '../api/_lib/identity/config.js'
import {
  currentMailPurpose,
  recordMailAttempt,
  resetScreenLink,
  ResetMailDeliveryError,
} from '../api/_lib/identity/resetMail.js'

const RUNTIME_URL_ENV = 'APP_RUNTIME_DATABASE_URL'
const store = process.env[IDENTITY_STORE_DATABASE_URL_ENV]
const runtime = process.env[RUNTIME_URL_ENV]
const configured = Boolean(store?.trim()) && Boolean(runtime?.trim())

if (!configured) {
  console.warn(
    `${IDENTITY_STORE_DATABASE_URL_ENV} and ${RUNTIME_URL_ENV} are not set; the ` +
      'invitation clean room was skipped. Run it through ' +
      'postgres/tests/portable_identity_invitation_link_cleanroom.sh.',
  )
}

/** The fixture admin the baseline seeds. The invite function authorizes against it. */
const ADMIN_ACTOR = '00000000-0000-0000-0000-000000000002'

interface SentLetter {
  readonly email: string
  readonly token: string
  readonly purpose: string
}

describe.skipIf(!configured)('the invitation link, against the real candidate', () => {
  const sent: SentLetter[] = []
  /** Set by a test to make the sink refuse, the way a mail provider can. */
  let refuse: Error | null = null

  const config = readIdentityConfig()
  const provider = new BetterAuthIdentityProvider({
    config,
    // Stands exactly where the Resend sink stands. What it records is the claim
    // under test: that the candidate calls the sink at all for this request, and
    // that it does so inside the caller's own purpose scope — through the
    // `runInBackgroundOrAwait` hop, which is where an AsyncLocalStorage context
    // would be lost if it were going to be.
    sendResetLink: ({ email, token }) => {
      sent.push({ email, token, purpose: currentMailPurpose() })
      // Both calls the real sink makes, in the order it makes them: the record
      // first, so a refusal is still attributable, then the throw. Writing into
      // the caller's scope from here is itself part of the claim — this runs
      // inside the candidate, several async hops from `withMailPurpose`.
      if (refuse) {
        recordMailAttempt({ ok: false, status: 422 })
        throw refuse
      }
      recordMailAttempt({ ok: true, status: 200 })
    },
  })
  const deps = {
    identity: provider,
    store: new FakeDataStore(),
    trustedOrigin: config.baseUrl,
  }

  const pool = new Pool({ connectionString: runtime })

  /** Create a person the way production does: the step-005 SQL function. */
  let invited = 0
  const invite = async (email: string): Promise<void> => {
    invited += 1
    const prepared = await provider.prepareAccount({ password: 'a-passphrase-nobody-knows' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', ADMIN_ACTOR])
      await client.query(
        'SELECT public.identity_admin_invite_member_atomic($1, $2, $3, $4, $5, $6)',
        [
          email,
          // `team_members.name` is unique, so each person gets their own.
          `Invited Person ${invited}`,
          'member',
          'better-auth',
          prepared.subject,
          prepared.passwordHash,
        ],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  beforeAll(() => {
    sent.length = 0
  })

  afterAll(async () => {
    await provider.close()
    await pool.end()
  })

  it('reaches the candidate, which sends the invited person a usable link', async () => {
    const email = 'cleanroom-invited@example.test'
    await invite(email)

    const outcome = await deliverInvitationLink(email, deps)

    // The route exists, the minted request passed the candidate's own origin
    // check without a cookie, and a token was issued and handed to the sink.
    expect(outcome).toEqual({ delivered: true })
    expect(sent).toHaveLength(1)
    expect(sent[0].email).toBe(email)
    expect(sent[0].token).toBeTruthy()
    // The purpose survived the candidate's own async hop, so the letter that
    // goes out is the invitation and not "you asked to reset your password".
    expect(sent[0].purpose).toBe('invitation')
    // And the link the recipient follows is this deployment's reset screen,
    // carrying the token in the hash.
    expect(resetScreenLink(config.baseUrl, sent[0].token)).toContain(
      `/#/reset-password?token=${sent[0].token}`,
    )
  })

  it('does not report delivery when the mail provider refuses, though the candidate says 200', async () => {
    const email = 'cleanroom-refused@example.test'
    await invite(email)
    refuse = new ResetMailDeliveryError(422)
    try {
      const outcome = await deliverInvitationLink(email, deps)
      // The candidate awaits the sink and swallows what it throws, so its own
      // answer here is 200 and always will be. This is the assertion that the
      // endpoint is not reading delivery off that status: the sink's record is.
      expect(outcome).toMatchObject({ delivered: false, subsystem: 'reset_delivery' })
    } finally {
      refuse = null
    }
  })

  it('reports an address the store has no account for as undelivered, not as sent', async () => {
    const before = sent.length
    const outcome = await deliverInvitationLink('cleanroom-nobody@example.test', deps)
    // The candidate answers 200 for an unknown address — it refuses to be an
    // account-existence oracle — and attempts no delivery. An invite that
    // reported that as sent would leave an admin waiting for a reply that is
    // not coming.
    expect(outcome.delivered).toBe(false)
    expect(sent).toHaveLength(before)
  })
})
