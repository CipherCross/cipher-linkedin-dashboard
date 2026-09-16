/**
 * The two statements the Replies fix added, executed by real PostgreSQL.
 *
 * Neither can be checked offline. `tsc` sees a template literal; the 1266-test
 * offline suite inspects that literal as *text*. A missing column, a type the
 * planner refuses, an `EXISTS` correlated to the wrong alias — every one of
 * them is a 500 on a deployed page and is invisible until a real server parses
 * the statement. This file is the parse.
 *
 * Read-only and fixture-free on purpose. It seeds nothing and asserts nothing
 * about row contents: under RLS with an actor who owns no rows both statements
 * legitimately answer empty, and an assertion on *rows* would be an assertion
 * about this database's data rather than about the SQL. What is asserted is the
 * shape the endpoint depends on — that the statement runs, returns exactly one
 * row, and that `mapRow` can read it.
 *
 * `replies.threadContext` is run for a thread that does not exist, which is the
 * case the merge had to get right: four separate reads used to answer "no row",
 * and one merged read has to answer "one row saying no".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  NeonFixtureClient,
  requireNeonTestConnection,
} from './support/neonContractHarness'
import { CONTRACT_ACTORS } from './support/dataStoreContract'
import { allReplyReviewOperations } from '../api/_lib/data/operations/replyReviews.js'
import type { NeonQueryContext, NeonStatement } from '../api/_lib/data/neon.js'
import type { DataStoreParams } from '../api/_lib/data/contracts.js'

const connection = requireNeonTestConnection()
const fixtures = new NeonFixtureClient(connection.pooled)

afterAll(async () => {
  await fixtures.end()
})

/**
 * Manual reply review arrived in baseline step `017`, and this contract
 * database predates it — which is why no `*.neon.test.ts` has ever covered the
 * Replies reads. A skip that says so is worth more than a deleted test: the
 * moment these tests run against a database that *has* the relations, they
 * check the statement, and until then the reason is written down rather than
 * inferred from an absent file.
 */
let manualReviewPresent = false

beforeAll(async () => {
  manualReviewPresent = await fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, async (client) => {
    const result = await client.query<{ present: boolean }>(
      `SELECT to_regclass('public.conversation_reply_review_state') IS NOT NULL
          AND to_regclass('public.conversation_follow_up_state') IS NOT NULL AS present`,
    )
    return result.rows[0]?.present === true
  })
  if (!manualReviewPresent) {
    console.warn('replies.threadContext not exercised: this database has no manual reply review relations (baseline step 017).')
  }
})

const ABSENT = {
  instanceId: 'notebook-absent-probe',
  profileUrl: 'https://linkedin.com/in/absent-probe',
}

const build = (
  operation: { build: (context: never) => NeonStatement },
  params: DataStoreParams,
): NeonStatement =>
  operation.build({ params } as unknown as NeonQueryContext<DataStoreParams> as never)

/** Run one operation's statement as a real actor and map the row back. */
async function run<T>(
  operation: { build: (context: never) => NeonStatement; mapRow?: (row: never) => T },
  params: DataStoreParams,
): Promise<{ rows: number; mapped: T | null }> {
  const statement = build(operation, params)
  return fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, async (client) => {
    const result = await client.query(statement.text, [...(statement.values ?? [])])
    return {
      rows: result.rows.length,
      mapped: result.rows[0] ? (operation.mapRow?.(result.rows[0] as never) ?? null) : null,
    }
  })
}

describe('replies.references — the dropdowns the capability probe used to compute', () => {
  it('runs, answers exactly one row, and maps to two reference lists', async () => {
    const { rows, mapped } = await run(allReplyReviewOperations.referencesOperation, {})
    expect(rows).toBe(1)
    expect(Array.isArray(mapped?.accounts)).toBe(true)
    expect(Array.isArray(mapped?.campaigns)).toBe(true)
    // Every campaign names the account it belongs to — the field the Replies
    // campaign filter uses to narrow itself to the selected account.
    for (const campaign of mapped?.campaigns ?? []) {
      expect(typeof campaign.id).toBe('string')
      expect(typeof campaign.instance_id).toBe('string')
    }
  })
})

describe('replies.threadContext — four reads merged into one', () => {
  it('answers one row for a thread that does not exist, rather than no row', async ({ skip }) => {
    skip(!manualReviewPresent, 'no manual reply review relations on this database')
    const { rows, mapped } = await run(allReplyReviewOperations.threadContextOperation, {
      ...ABSENT,
      messageId: null,
    })
    expect(rows).toBe(1)
    expect(mapped).toEqual({
      thread_exists: false,
      // No focus was asked for, so there is nothing to fail to find.
      focus_exists: true,
      inbound_revision: 0,
      workflow: null,
    })
  })

  it('reports a focus that belongs to no message as absent', async ({ skip }) => {
    skip(!manualReviewPresent, 'no manual reply review relations on this database')
    const { rows, mapped } = await run(allReplyReviewOperations.threadContextOperation, {
      ...ABSENT,
      messageId: 1,
    })
    expect(rows).toBe(1)
    expect(mapped?.focus_exists).toBe(false)
    expect(mapped?.thread_exists).toBe(false)
  })
})
