/**
 * Delivery for password-reset links.
 *
 * `betterAuthProvider.ts` ships a sink that drops the link, and that was the
 * whole flow: an invite creates a credential nobody knows and tells the
 * recipient to reset, so with no delivery **no invited person could ever sign
 * in**. The first real tenant reached 13/13 with two accounts nobody could open.
 *
 * The sender is the platform's own verified domain, bound into the deployment
 * as `RESEND_API_KEY` and `RESEND_FROM_IDENTITY` (hosting environment contract
 * v3). A deployment without them keeps the dropping sink rather than failing to
 * boot: mail is a capability a deployment may genuinely not have, and losing
 * every other route because of it would be worse.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import type { ResetLinkSink } from './betterAuthProvider.js'
import { IDENTITY_BASE_URL_ENV } from './config.js'

/**
 * A refusal from the mail provider, carrying its status and nothing else.
 *
 * The status travels because a delivery that fails with no attribution is
 * exactly the failure this project keeps paying for: the bridge learned the
 * same lesson and forwards the upstream status for the same reason — a status
 * is a number, and carries no address, credential, URL or payload. The
 * provider's body is never kept: it quotes the recipient back.
 */
export class ResetMailDeliveryError extends Error {
  readonly name = 'ResetMailDeliveryError'

  constructor(readonly status: number) {
    super(`reset link delivery refused with status ${status}`)
  }
}

export const RESET_MAIL_API_KEY_ENV = 'RESEND_API_KEY'
export const RESET_MAIL_FROM_ENV = 'RESEND_FROM_IDENTITY'

/** The screen that accepts the token. A hash route, so the token never travels
 *  to the server as part of a page request. */
export const RESET_SCREEN_ROUTE = '/#/reset-password'

/**
 * Where the recipient is sent.
 *
 * Not the candidate's own `…/reset-password/<token>` URL. That is a server
 * route this deployment does not expose — the dispatcher forwards `?op=`
 * operations and nothing else — so the link landed on the SPA fallback and
 * showed the ordinary app with no way to set a password. The link points at the
 * screen that does the work, and the token rides in the hash.
 */
export function resetScreenLink(baseUrl: string, token: string): string {
  return `${new URL(baseUrl).origin}${RESET_SCREEN_ROUTE}?token=${encodeURIComponent(token)}`
}

const ENDPOINT = 'https://api.resend.com/emails'

export interface ResetMailConfig {
  readonly apiKey: string
  readonly from: string
  /** This deployment's own origin: the link must point at its own reset screen. */
  readonly baseUrl: string
}

/**
 * The sender for this deployment, or null when it has none.
 *
 * Refuses a `VITE_`-prefixed name for the same reason `config.ts` does: an API
 * key that reaches the browser bundle is a published key.
 */
export function readResetMailConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResetMailConfig | null {
  const apiKey = (env[RESET_MAIL_API_KEY_ENV] ?? '').trim()
  const from = (env[RESET_MAIL_FROM_ENV] ?? '').trim()
  const baseUrl = (env[IDENTITY_BASE_URL_ENV] ?? '').trim()
  if (apiKey === '' || from === '' || baseUrl === '') return null
  return { apiKey, from, baseUrl }
}

/**
 * Why the same link needs two letters.
 *
 * An invited person and a person who forgot their password receive the same
 * single-use token, and to the candidate the two are one flow — `admin.invite`
 * gets its link by driving the very same `/request-password-reset` route. But
 * the letters are not the same letter. "Reset your dashboard password" reaching
 * somebody who has never had an account, and was never told one was made for
 * them, reads as an attack on an account they do not have; the likeliest
 * outcome is that they delete it, which is how an invitation that *was*
 * delivered still fails.
 */
export type MailPurpose = 'reset' | 'invitation'

/** One send this module actually attempted, and how it went. */
export interface MailAttempt {
  readonly ok: boolean
  /** The mail provider's status, when it answered one. */
  readonly status?: number
}

interface MailScope {
  readonly purpose: MailPurpose
  readonly attempts: MailAttempt[]
}

/**
 * The send in progress: what it is for, and what became of it.
 *
 * `AsyncLocalStorage` and deliberately **not** a module-level variable. The
 * sink is process-wide and a warm function instance serves overlapping
 * requests, so a flag set by an invite would still be set when an unrelated
 * reset requested a second later reached the sink — and that person would get
 * an email telling them an account had just been created for them. The context
 * follows the call chain instead, so two concurrent sends cannot read or
 * overwrite each other's.
 */
const mailScope = new AsyncLocalStorage<MailScope>()

/**
 * Run `fn` with `purpose` in scope, and report every send it caused.
 *
 * **Why the caller cannot just read the response.** The candidate hands
 * `sendResetPassword` to `runInBackgroundOrAwait`, which awaits it and then
 * **swallows whatever it throws** (`catch (e) { logger.error(…) }`, better-auth
 * 1.6.25). So a mail provider refusing outright still produces `200 {status:
 * true}` from the route. A caller that believed that status would report mail
 * it never sent — the exact failure this module's own delivery error was added
 * to prevent, reintroduced one layer up. The attempts below come from the sink
 * itself, which is the only thing that knows.
 *
 * An empty list is meaningful and is not an error: the candidate does not
 * attempt delivery for an address it has no user for, and a deployment with no
 * sender keeps a sink that never calls out. Both are "nothing was sent", which
 * is what the caller needs to know.
 */
export async function withMailPurpose<T>(
  purpose: MailPurpose,
  fn: () => Promise<T>,
): Promise<{ readonly result: T; readonly attempts: readonly MailAttempt[] }> {
  const scope: MailScope = { purpose, attempts: [] }
  const result = await mailScope.run(scope, fn)
  return { result, attempts: scope.attempts }
}

/**
 * The purpose in scope, defaulting to `reset`.
 *
 * The default is the unmarked case on purpose: a send that arrives here with no
 * context is the ordinary "I forgot my password" flow, which is the one a
 * caller reaches without going through this module at all.
 */
export function currentMailPurpose(): MailPurpose {
  return mailScope.getStore()?.purpose ?? 'reset'
}

/**
 * Record what a send did. Called by the sink, and by the fake provider standing
 * in for one. Outside a `withMailPurpose` scope it does nothing, so delivery
 * never depends on somebody having opened one.
 */
export function recordMailAttempt(attempt: MailAttempt): void {
  mailScope.getStore()?.attempts.push(attempt)
}

interface Letter {
  readonly subject: string
  readonly body: (link: string) => string
}

const LETTERS: Readonly<Record<MailPurpose, Letter>> = {
  reset: {
    subject: 'Reset your dashboard password',
    body: (link) =>
      `Open this link to choose a new password:\n\n${link}\n\n` +
      'It can be used once. If you did not ask for it, ignore this message.',
  },
  invitation: {
    subject: 'Your dashboard account is ready',
    body: (link) =>
      'An administrator created a dashboard account for you.\n\n' +
      `Open this link to choose your password and sign in:\n\n${link}\n\n` +
      'It can be used once. If you were not expecting this, ignore this message.',
  },
}

/**
 * Builds the sink.
 *
 * The link is passed through exactly as the identity provider built it — this
 * function never parses, rewrites or logs it, and never logs the address. A
 * delivery failure throws, so the caller sees a failed reset request instead of
 * a success for mail that was never sent.
 */
export function createResetLinkSink(config: ResetMailConfig): ResetLinkSink {
  return async ({ email, token }) => {
    const link = resetScreenLink(config.baseUrl, token)
    const letter = LETTERS[currentMailPurpose()]
    let response: Response
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: config.from,
          to: [email],
          subject: letter.subject,
          text: letter.body(link),
        }),
      })
    } catch (error) {
      // The provider was not reached at all. Recorded before rethrowing, or an
      // unreachable provider would read as "nothing was attempted", which is
      // the one thing it is not.
      recordMailAttempt({ ok: false })
      throw error
    }
    recordMailAttempt({ ok: response.ok, status: response.status })
    if (!response.ok) throw new ResetMailDeliveryError(response.status)
  }
}
