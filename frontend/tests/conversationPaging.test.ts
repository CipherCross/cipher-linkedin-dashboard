/**
 * The first tests for the browser's own PostgREST paging.
 *
 * `src/lib/leads.ts`, `csvImport.ts` and `demographics.ts` are covered from this
 * directory, but nothing here had ever touched `DataContext.tsx` or a component:
 * both are `.tsx`, and `tsconfig.api.json` — which type-checks `tests/` — sets no
 * `jsx`, so importing either breaks the typecheck rather than the test run. So
 * `src/lib/conversationPaging.ts` exists, and this file is the coverage that made
 * it worth extracting.
 *
 * The query builder is stubbed rather than mocked with a library. supabase-js's
 * builder is a thenable that accumulates modifiers and returns itself, so a
 * handful of chainable methods recording their arguments reproduces every part of
 * it these functions touch — and recording the arguments is the point: the bug
 * being fixed was an **absent** `.range()`, which no assertion about returned
 * rows can catch on a database small enough to fit in one page.
 */

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PAGE_SIZE,
  fetchConversationReplyIntents,
  followUpHistorySeek,
  isMissingRelation,
} from '../src/lib/conversationPaging'

interface RangeCall {
  readonly from: number
  readonly to: number
}

interface Recorded {
  readonly relation: string
  readonly selects: string[]
  readonly orders: string[]
  readonly ranges: RangeCall[]
}

type PageAnswer =
  | { readonly rows: Record<string, unknown>[] }
  | { readonly error: { code?: string; message?: string } }

/**
 * A stub whose `.range()` resolves the caller's script in order. Anything the
 * production code calls that this does not implement throws, so a read that
 * quietly stopped ordering — or started filtering — fails loudly instead of
 * passing with a plausible-looking answer.
 */
function stubClient(answers: PageAnswer[]): { client: SupabaseClient; recorded: Recorded } {
  const recorded: Recorded = { relation: '', selects: [], orders: [], ranges: [] }
  let page = 0

  const builder = {
    select(columns: string) {
      recorded.selects.push(columns)
      return this
    },
    order(column: string, opts?: { ascending?: boolean }) {
      recorded.orders.push(`${column}:${opts?.ascending === false ? 'desc' : 'asc'}`)
      return this
    },
    range(from: number, to: number) {
      recorded.ranges.push({ from, to })
      const answer = answers[page]
      page += 1
      if (!answer) throw new Error(`stub ran out of pages at request ${page}`)
      return 'error' in answer
        ? Promise.resolve({ data: null, error: answer.error })
        : Promise.resolve({ data: answer.rows, error: null })
    },
  }

  const client = {
    from(relation: string) {
      ;(recorded as { relation: string }).relation = relation
      return builder
    },
  } as unknown as SupabaseClient

  return { client, recorded }
}

const intentRow = (n: number) => ({
  instance_id: `notebook-${(n % 4) + 1}`,
  profile_url: `https://example.invalid/in/p${String(n).padStart(6, '0')}`,
  highest_intent: 'p3',
  first_p1_at: null,
  first_p2_at: null,
  first_p3_at: '2026-08-01T00:00:00.000Z',
  first_p3_campaign_id: 'notebook-1:1',
  last_out_after_p3_at: null,
  last_in_after_p3_at: null,
})

const fullPage = () => Array.from({ length: PAGE_SIZE }, (_, i) => intentRow(i))

describe('fetchConversationReplyIntents', () => {
  it('reads the right relation, ordered by its unique grouping key', async () => {
    const { client, recorded } = stubClient([{ rows: [intentRow(1)] }])
    await fetchConversationReplyIntents(client)
    expect(recorded.relation).toBe('conversation_reply_intent')
    expect(recorded.selects).toEqual(['*'])
    // An unordered .range() walk is not a walk: PostgreSQL may return the same
    // row on two pages. (instance_id, profile_url) is the view's grouping key
    // and therefore total.
    expect(recorded.orders).toEqual(['instance_id:asc', 'profile_url:asc'])
  })

  it('requests a bounded page instead of an unpaginated select', async () => {
    // This is the regression the whole change exists for. The old read issued no
    // .range() at all, so PostgREST answered with its first 1,000 rows and the
    // caller treated them as the relation.
    const { client, recorded } = stubClient([{ rows: [intentRow(1)] }])
    await fetchConversationReplyIntents(client)
    expect(recorded.ranges).toEqual([{ from: 0, to: PAGE_SIZE - 1 }])
  })

  it('walks past the 1,000-row cap and returns every row', async () => {
    const { client, recorded } = stubClient([
      { rows: fullPage() },
      { rows: fullPage() },
      { rows: [intentRow(1), intentRow(2)] },
    ])
    const rows = await fetchConversationReplyIntents(client)
    expect(rows).toHaveLength(PAGE_SIZE * 2 + 2)
    expect(recorded.ranges).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
      { from: 2000, to: 2999 },
    ])
  })

  it('asks one more time when the last page is exactly full', async () => {
    // A full page is not proof that the relation ends there, so the walk cannot
    // stop on it — that is the same off-by-one that would silently truncate at
    // any exact multiple of the page size.
    const { client, recorded } = stubClient([{ rows: fullPage() }, { rows: [] }])
    const rows = await fetchConversationReplyIntents(client)
    expect(rows).toHaveLength(PAGE_SIZE)
    expect(recorded.ranges).toHaveLength(2)
  })

  it('answers an absent relation with an empty result, not a failure', async () => {
    const { client } = stubClient([{ error: { code: '42P01', message: 'relation does not exist' } }])
    await expect(fetchConversationReplyIntents(client)).resolves.toEqual([])
  })

  it('answers PostgREST’s own missing-relation code the same way', async () => {
    const { client } = stubClient([
      { error: { code: 'PGRST205', message: "Could not find the table 'public.x'" } },
    ])
    await expect(fetchConversationReplyIntents(client)).resolves.toEqual([])
  })

  it('propagates every other failure rather than emptying the view', async () => {
    // Narrower than the read it replaces, on purpose: any error used to yield []
    // and was excluded from the aggregate error, so a timeout silently changed a
    // conversion rate. This is the line fetchFollowUpData already draws for the
    // two sibling conversation views.
    const { client } = stubClient([{ error: { code: '57014', message: 'statement timeout' } }])
    await expect(fetchConversationReplyIntents(client)).rejects.toMatchObject({ code: '57014' })
  })

  it('never returns the pages it already had when a later page fails', async () => {
    // The anti-pattern this closes: fetchAllPipelineEvents returns its
    // accumulator on any mid-walk error, so a transient failure becomes a
    // confidently short answer.
    const { client } = stubClient([
      { rows: fullPage() },
      { error: { code: '08006', message: 'connection failure' } },
    ])
    await expect(fetchConversationReplyIntents(client)).rejects.toMatchObject({ code: '08006' })
  })

  it('tolerates a missing relation discovered mid-walk without returning a prefix', async () => {
    const { client } = stubClient([
      { rows: fullPage() },
      { error: { code: '42P01', message: 'relation does not exist' } },
    ])
    await expect(fetchConversationReplyIntents(client)).resolves.toEqual([])
  })
})

describe('isMissingRelation', () => {
  it('accepts both codes and the message fallback', () => {
    expect(isMissingRelation({ code: '42P01' })).toBe(true)
    expect(isMissingRelation({ code: 'PGRST205' })).toBe(true)
    expect(isMissingRelation({ message: 'relation "x" does not exist' })).toBe(true)
    expect(isMissingRelation({ message: "Could not find the table 'public.x' not found" })).toBe(true)
  })

  it('rejects a missing column, a timeout and a denial', () => {
    // 42703 in particular: the Neon path refuses to tolerate a missing column
    // for the same reason — silent degradation is worse than failure once the
    // schema is ledger-applied.
    expect(isMissingRelation({ code: '42703', message: 'column "x" does not exist' })).toBe(false)
    expect(isMissingRelation({ code: '57014', message: 'canceling statement' })).toBe(false)
    expect(isMissingRelation({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(isMissingRelation(null)).toBe(false)
    expect(isMissingRelation(undefined)).toBe(false)
  })
})

describe('followUpHistorySeek', () => {
  const last = { occurred_at: '2026-08-05T06:29:31.802048+00:00', id: 39 }

  it('expands the ROW comparison PostgREST cannot express', () => {
    expect(followUpHistorySeek(last)).toBe(
      'occurred_at.lt."2026-08-05T06:29:31.802048+00:00",'
      + 'and(occurred_at.eq."2026-08-05T06:29:31.802048+00:00",id.lt.39)',
    )
  })

  it('seeks on the whole sort key, not on id alone', () => {
    // The defect: `.lt('id', lastId)` under an (occurred_at DESC, id DESC) order
    // skips a row whenever the two orders are inverted at a page boundary.
    const seek = followUpHistorySeek(last)
    expect(seek).toContain('occurred_at.lt.')
    expect(seek).toContain('occurred_at.eq.')
    expect(seek).toContain('id.lt.39')
  })

  it('quotes the timestamp, whose “:” and “.” are meaningful to PostgREST', () => {
    const seek = followUpHistorySeek(last)
    expect(seek).toContain('"2026-08-05T06:29:31.802048+00:00"')
    // Both occurrences quoted, not just the first.
    expect(seek.match(/"/g)).toHaveLength(4)
  })

  it('survives URLSearchParams encoding with its “+” intact', () => {
    // supabase-js appends the filter through URLSearchParams, which encodes "+"
    // as %2B. If it were interpolated into a URL by hand it would decode to a
    // space and the seek would compare against a different instant.
    const url = new URL('https://example.invalid/rest/v1/follow_up_events')
    url.searchParams.append('or', `(${followUpHistorySeek(last)})`)
    expect(url.search).toContain('%2B00%3A00')
    expect(new URLSearchParams(url.search).get('or')).toBe(`(${followUpHistorySeek(last)})`)
  })

  it('descends, matching the order it pages', () => {
    // A seek pointing the wrong way returns the same page forever. The static
    // guard on the Neon read slice asserts the same property for the same
    // reason.
    expect(followUpHistorySeek(last)).not.toContain('.gt.')
  })
})
