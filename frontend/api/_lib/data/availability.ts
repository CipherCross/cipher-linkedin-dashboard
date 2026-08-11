/**
 * Answering honestly when the database could not be reached.
 *
 * Every endpoint on the Neon path resolves the caller's actor before it does
 * anything else, and every one of them shaped the same response when that
 * resolution threw: **500 `Could not verify team access`**. That sentence is a
 * claim about membership, and for the failures classified by
 * `DataStoreUnavailableError` no membership check was ever reached — the pool
 * timed out, the login was refused, or the socket died. S27 opened on exactly
 * that line reaching the owner as an alert, and the alert was wrong twice: about
 * the provider (the banner said Supabase) and about the cause (it said team
 * access).
 *
 * So this module owns the second half. `authorizationResponse` keeps answering
 * for decisions that were genuinely taken; this answers for the case where none
 * was, and it **names the code in the message**. The code is safe to publish —
 * it is one of three fixed tokens, carries no driver text, no hostname and no
 * credential — and it is the difference between an alert a person can act on and
 * one they can only screenshot.
 *
 * The status split is a claim about whether retrying can help:
 *
 * - **503** for the two transient causes, which is what they are;
 * - **500** for a rejected credential, which no retry clears and which means the
 *   deployment itself needs attention.
 */

import { DataStoreUnavailableError } from './contracts.js'
import type { DataStoreUnavailableCode } from './contracts.js'

interface Answer {
  readonly status: 500 | 503
  readonly text: string
}

const ANSWERS: Readonly<Record<DataStoreUnavailableCode, Answer>> = {
  DATASTORE_CONNECT_FAILED: {
    status: 503,
    text:
      'The dashboard database is not accepting connections right now — ' +
      'retry in a moment',
  },
  DATASTORE_CONNECTION_LOST: {
    status: 503,
    text:
      'The connection to the dashboard database dropped mid-request — ' +
      'retry in a moment',
  },
  DATASTORE_CREDENTIAL_REJECTED: {
    status: 500,
    text:
      'The dashboard database refused this deployment’s credential — ' +
      'retrying will not help, the deployment needs attention',
  },
}

/**
 * The response for a database that could not be reached, or `null` when the
 * error is something else and the caller should keep its own handling.
 *
 * Shaped like `authorizationResponse`: it returns `null` rather than throwing or
 * guessing, so a call site adds one line and loses none of its existing
 * behaviour.
 */
export function unavailableResponse(error: unknown): Response | null {
  if (!(error instanceof DataStoreUnavailableError)) return null
  const answer = ANSWERS[error.code]
  return new Response(
    JSON.stringify({ error: `${answer.text} (${error.code})` }),
    { status: answer.status, headers: { 'content-type': 'application/json' } },
  )
}
