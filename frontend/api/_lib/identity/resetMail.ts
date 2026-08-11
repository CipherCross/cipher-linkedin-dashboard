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

import type { ResetLinkSink } from './betterAuthProvider.js'

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

const ENDPOINT = 'https://api.resend.com/emails'

export interface ResetMailConfig {
  readonly apiKey: string
  readonly from: string
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
  if (apiKey === '' || from === '') return null
  return { apiKey, from }
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
  return async ({ email, url }) => {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: [email],
        subject: 'Reset your dashboard password',
        text:
          `Open this link to choose a new password:\n\n${url}\n\n` +
          'It can be used once. If you did not ask for it, ignore this message.',
      }),
    })
    if (!response.ok) throw new ResetMailDeliveryError(response.status)
  }
}
