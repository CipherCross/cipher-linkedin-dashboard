/**
 * The browser's read client, driven with an injected transport.
 *
 * ## Why this file is where the evidence is
 *
 * The default vitest run is `environment: 'node'` over `tests/**` and nothing
 * renders; `tsconfig.api.json` declares no `jsx`, so a test cannot even import a
 * `.tsx` file without failing the typecheck. Everything the switch *decides* was
 * therefore put in `src/lib/dashboardReads.ts` — which operation is called with
 * which parameters, when a walk stops, what an `unavailable` marker means, what
 * happens to a failed page — and `DataContext.tsx` and the three components hold
 * a call site each. This file is the whole of the new path's coverage; the call
 * sites are covered by `tsc -b` and by reading (see the handoff's known limits).
 *
 * ## The assertion worth reading first
 *
 * `every allowlisted read has a caller` compares this client's operation names
 * against `READ_OPERATION_NAMES` exported by the endpoint. Before this session
 * eleven of the twenty-two operations had no caller at all; that equality is
 * what makes the claim checkable rather than counted by hand, and it fails in
 * both directions — an operation added to the endpoint and never called, or a
 * caller naming something the endpoint does not allowlist.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { READ_OPERATION_NAMES } from '../api/activity-daily.js'
import {
  MAX_PAGES,
  READ_ENDPOINT,
  READ_OPS,
  READ_PATH_OPERATION,
  SYNC_RUN_LIMIT,
  fetchNeonDashboard,
  fetchNeonFollowUpHistory,
  fetchNeonLeadNotes,
  fetchNeonThread,
  fetchReadPath,
  readAll,
  readPage,
  resetReadPath,
  resolveReadPath,
} from '../src/lib/dashboardReads'
import type { ApiFetch, ReadPage } from '../src/lib/dashboardReads'

// ---------------------------------------------------------------------------
// A recording transport. Every test asserts on what was *requested*, because
// that is where this module's decisions are: a walk that stops early and a walk
// that never started both return the same rows.
// ---------------------------------------------------------------------------

interface Recorder {
  readonly fetchImpl: ApiFetch
  readonly urls: string[]
  /** Parsed query strings, in request order. */
  readonly queries: URLSearchParams[]
  /** The `op` of each request, in order. */
  ops(): string[]
  /** Every query for one operation. */
  queriesFor(operation: string): URLSearchParams[]
}

type Responder = (url: URL, index: number) => Response | Promise<Response>

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const emptyPage = <T,>(items: readonly T[] = []): ReadPage<T> => ({
  items,
  nextCursor: null,
  hasMore: false,
})

function recorder(respond: Responder = () => jsonResponse(emptyPage())): Recorder {
  const urls: string[] = []
  const queries: URLSearchParams[] = []
  const fetchImpl: ApiFetch = async (input) => {
    const raw = String(input)
    // `READ_ENDPOINT` is a site-relative path; a base is needed only to parse it.
    const url = new URL(raw, 'https://dashboard.example.invalid')
    urls.push(raw)
    queries.push(url.searchParams)
    return respond(url, urls.length - 1)
  }
  return {
    fetchImpl,
    urls,
    queries,
    ops: () => queries.map((q) => q.get('op') ?? ''),
    queriesFor: (operation) => queries.filter((q) => q.get('op') === operation),
  }
}

/** The one query for `operation`, asserting there was exactly one. */
function onlyQuery(rec: Recorder, operation: string): URLSearchParams {
  const found = rec.queriesFor(operation)
  expect(found, `expected exactly one request for ${operation}`).toHaveLength(1)
  return found[0]
}

const SINCE = '2026-05-08'
const WATERMARK = '2026-08-06T09:58:00.000Z'

describe('the read vocabulary', () => {
  it('every allowlisted read has a caller, and every caller is allowlisted', () => {
    const called = [...new Set(Object.values(READ_OPS))].sort()
    const allowlisted = [...READ_OPERATION_NAMES].sort()
    expect(called).toEqual(allowlisted)
  })

  it('names twenty-two reads, which is the endpoint slice S13 built', () => {
    expect(Object.values(READ_OPS)).toHaveLength(22)
    expect(new Set(Object.values(READ_OPS)).size).toBe(22)
  })

  it('does not treat the flag lookup as a read', () => {
    // It is dispatched before authentication and touches no store, so it must
    // not be walked, tolerated or counted with the reads.
    expect(Object.values(READ_OPS)).not.toContain(READ_PATH_OPERATION)
    expect(READ_OPERATION_NAMES).not.toContain(READ_PATH_OPERATION)
  })

  it('has no operation for the roster, on either side', () => {
    // `leads.assigned_to` crosses in whichever provider's id space the leads
    // came from, and the two spaces name different people. A roster served
    // beside it would mislabel every owner chip without failing anything.
    const names = [...Object.values(READ_OPS), ...READ_OPERATION_NAMES].join(' ')
    expect(names).not.toMatch(/roster|team_members|team\./)
  })
})

describe('the path flag', () => {
  beforeEach(() => {
    resetReadPath()
  })

  it('asks for exactly the flag operation, unauthenticated', async () => {
    const rec = recorder(() => jsonResponse({ readPath: 'supabase' }))
    await fetchReadPath(rec.fetchImpl)
    expect(rec.urls).toEqual([
      `${READ_ENDPOINT}?op=${encodeURIComponent(READ_PATH_OPERATION)}`,
    ])
  })

  it('moves the browser only for the exact string `neon`', async () => {
    const answers = ['neon', 'NEON', 'Neon', ' neon ', 'true', '1', 'supabase', '']
    const seen: string[] = []
    for (const readPath of answers) {
      const rec = recorder(() => jsonResponse({ readPath }))
      seen.push(await fetchReadPath(rec.fetchImpl))
    }
    expect(seen).toEqual([
      'neon',
      'supabase', 'supabase', 'supabase', 'supabase',
      'supabase', 'supabase', 'supabase',
    ])
  })

  it('resolves to supabase when the answer is missing or malformed', async () => {
    for (const body of [{}, { readPath: null }, { readPath: 7 }, null, 'neon']) {
      const rec = recorder(() => jsonResponse(body))
      expect(await fetchReadPath(rec.fetchImpl)).toBe('supabase')
    }
  })

  it('resolves to supabase on a non-200, on a body that is not JSON, and on a network failure', async () => {
    const failures: Responder[] = [
      () => jsonResponse({ error: 'boom' }, 500),
      () => jsonResponse({ error: 'nope' }, 404),
      () => new Response('<html>', { status: 200 }),
      () => {
        throw new TypeError('Failed to fetch')
      },
    ]
    for (const respond of failures) {
      const rec = recorder(respond)
      expect(await fetchReadPath(rec.fetchImpl)).toBe('supabase')
    }
  })

  it('asks once per page load and caches the answer, including a failed one', async () => {
    const rec = recorder(() => {
      throw new TypeError('Failed to fetch')
    })
    expect(await resolveReadPath(rec.fetchImpl)).toBe('supabase')
    expect(await resolveReadPath(rec.fetchImpl)).toBe('supabase')
    expect(await resolveReadPath(rec.fetchImpl)).toBe('supabase')
    // One session, one answer. Re-asking would let a five-minute refresh answer
    // from one provider while an open drawer still reads the other.
    expect(rec.urls).toHaveLength(1)
  })
})

describe('one page', () => {
  it('carries the operation and drops empty parameters', async () => {
    const rec = recorder()
    await readPage('leads.notes', { lead_id: 'abc', cursor: null, limit: 50, blank: '' }, rec.fetchImpl)
    const query = rec.queries[0]
    expect(query.get('op')).toBe('leads.notes')
    expect(query.get('lead_id')).toBe('abc')
    expect(query.get('limit')).toBe('50')
    expect(query.has('cursor')).toBe(false)
    expect(query.has('blank')).toBe(false)
  })

  it('throws on a non-200 and names the operation and the server’s reason', async () => {
    const rec = recorder(() => jsonResponse({ error: 'cursor is not for this scope' }, 400))
    await expect(readPage('leads.directory', {}, rec.fetchImpl)).rejects.toThrow(
      /leads\.directory: cursor is not for this scope/,
    )
  })

  it('throws on a non-200 with an unreadable body', async () => {
    const rec = recorder(() => new Response('gateway timeout', { status: 504 }))
    await expect(readPage('leads.directory', {}, rec.fetchImpl)).rejects.toThrow(
      /leads\.directory: request failed \(504\)/,
    )
  })
})

describe('walking a relation', () => {
  it('follows the server’s cursor and concatenates in order', async () => {
    const pages: ReadPage<number>[] = [
      { items: [1, 2], nextCursor: 'c1', hasMore: true },
      { items: [3, 4], nextCursor: 'c2', hasMore: true },
      { items: [5], nextCursor: null, hasMore: false },
    ]
    const rec = recorder((_url, index) => jsonResponse(pages[index]))
    const result = await readAll<number>('leads.directory', { updated_since: null }, rec.fetchImpl)
    expect(result.items).toEqual([1, 2, 3, 4, 5])
    expect(result.unavailable).toBe(false)
    // The first request carries no cursor; each later one carries the previous
    // page's. A walk that resent the original query would loop on page one.
    expect(rec.queries.map((q) => q.get('cursor'))).toEqual([null, 'c1', 'c2'])
  })

  it('stops when the server offers no cursor, even if it claims more', async () => {
    const rec = recorder(() => jsonResponse({ items: [1], nextCursor: null, hasMore: true }))
    const result = await readAll<number>('leads.directory', {}, rec.fetchImpl)
    expect(result.items).toEqual([1])
    expect(rec.urls).toHaveLength(1)
  })

  it('short-circuits an absent relation with no rows and no second request', async () => {
    const rec = recorder(() =>
      jsonResponse({ items: [], nextCursor: null, hasMore: false, unavailable: true }),
    )
    const result = await readAll<number>('searches.saved', {}, rec.fetchImpl)
    expect(result).toEqual({ items: [], unavailable: true })
    expect(rec.urls).toHaveLength(1)
  })

  it('never answers with a prefix when a page fails mid-walk', async () => {
    const rec = recorder((_url, index) =>
      index < 2
        ? jsonResponse({ items: [index], nextCursor: `c${index}`, hasMore: true })
        : jsonResponse({ error: 'Could not load dashboard data' }, 500),
    )
    // The defect class this module exists to close: `fetchAllPipelineEvents` on
    // the Supabase path returns what it has, turning a transient failure into a
    // confidently short audit log.
    await expect(readAll('pipeline.eventLog', {}, rec.fetchImpl)).rejects.toThrow(
      /pipeline\.eventLog: Could not load dashboard data/,
    )
  })

  it('refuses to answer at all rather than return a bounded prefix of an unbounded walk', async () => {
    const rec = recorder((_url, index) =>
      jsonResponse({ items: [index], nextCursor: `c${index}`, hasMore: true }),
    )
    await expect(readAll('leads.directory', {}, rec.fetchImpl)).rejects.toThrow(
      /exceeded 1000 pages/,
    )
    expect(rec.urls).toHaveLength(MAX_PAGES)
  })
})

describe('the dashboard load', () => {
  it('requests every dataset the browser commits, once each, and nothing else', async () => {
    const rec = recorder()
    await fetchNeonDashboard({ since: SINCE, updatedSince: null, fetchImpl: rec.fetchImpl })
    const requested = rec.ops().sort()
    // Nineteen of the twenty-two; the other three are the on-demand component
    // reads and are asserted below.
    const componentReads = [READ_OPS.thread, READ_OPS.leadNotes, READ_OPS.followUpHistory]
    const expected = Object.values(READ_OPS)
      .filter((op) => !componentReads.includes(op as never))
      .sort()
    expect(requested).toEqual(expected)
    expect(requested).toHaveLength(19)
  })

  it('preserves the inbound/outbound fetch asymmetry', async () => {
    const rec = recorder()
    await fetchNeonDashboard({ since: SINCE, updatedSince: null, fetchImpl: rec.fetchImpl })

    // Inbound is all-time: sentiment, intent and durable P3 counts are rendered
    // beside all-time lead totals, so a window here silently undercounts them.
    const inbound = onlyQuery(rec, READ_OPS.inboundMessages)
    expect(inbound.has('from')).toBe(false)
    expect(inbound.has('to')).toBe(false)

    // Outbound carries the 90-day floor and no upper bound, exactly as the
    // Supabase path's `.gte('sent_at', since)` does.
    const outbound = onlyQuery(rec, READ_OPS.outboundMessages)
    expect(outbound.get('from')).toBe(SINCE)
    expect(outbound.has('to')).toBe(false)
  })

  it('bounds the daily series by the same 90-day floor and nothing else', async () => {
    const rec = recorder()
    await fetchNeonDashboard({ since: SINCE, updatedSince: null, fetchImpl: rec.fetchImpl })
    const activity = onlyQuery(rec, READ_OPS.dailySeries)
    expect(activity.get('from')).toBe(SINCE)
    expect(activity.has('to')).toBe(false)
    // The whole team's activity in one request. Filtering per notebook would pay
    // the request cost N times for a filter this caller does not want.
    expect(activity.has('instance_id')).toBe(false)
  })

  it('sends the delta watermark to exactly the four reads that can express one', async () => {
    const rec = recorder()
    await fetchNeonDashboard({ since: SINCE, updatedSince: WATERMARK, fetchImpl: rec.fetchImpl })

    for (const op of [READ_OPS.leads, READ_OPS.inboundMessages, READ_OPS.outboundMessages]) {
      expect(onlyQuery(rec, op).get('updated_since'), op).toBe(WATERMARK)
    }
    // `pipeline_events` has no `updated_at` at all — it is append-only, so its
    // insertion time is its watermark, and the parameter is named apart so the
    // two cannot be confused where they coincide.
    const events = onlyQuery(rec, READ_OPS.pipelineEvents)
    expect(events.get('occurred_since')).toBe(WATERMARK)
    expect(events.has('updated_since')).toBe(false)

    const withWatermark = rec.queries.filter(
      (q) => q.has('updated_since') || q.has('occurred_since'),
    )
    expect(withWatermark).toHaveLength(4)
  })

  it('sends no watermark at all on a full load', async () => {
    const rec = recorder()
    await fetchNeonDashboard({ since: SINCE, updatedSince: null, fetchImpl: rec.fetchImpl })
    expect(
      rec.queries.filter((q) => q.has('updated_since') || q.has('occurred_since')),
    ).toHaveLength(0)
  })

  it('takes the newest 200 sync runs as one page rather than walking the run history', async () => {
    const rec = recorder((url) =>
      url.searchParams.get('op') === READ_OPS.syncRuns
        ? jsonResponse({ items: [{ id: '1' }], nextCursor: 'more', hasMore: true })
        : jsonResponse(emptyPage()),
    )
    const result = await fetchNeonDashboard({
      since: SINCE,
      updatedSince: null,
      fetchImpl: rec.fetchImpl,
    })
    const runs = onlyQuery(rec, READ_OPS.syncRuns)
    expect(runs.get('limit')).toBe(String(SYNC_RUN_LIMIT))
    // The server said there is more and this read deliberately does not follow
    // it: the Health page renders the newest 200 runs, not every run ever.
    expect(result.syncRuns).toHaveLength(1)
  })

  it('merges the two message directions newest first', async () => {
    const rec = recorder((url) => {
      const op = url.searchParams.get('op')
      if (op === READ_OPS.inboundMessages) {
        return jsonResponse(emptyPage([{ id: 1, sent_at: '2026-08-01T00:00:00Z' }]))
      }
      if (op === READ_OPS.outboundMessages) {
        return jsonResponse(
          emptyPage([
            { id: 2, sent_at: '2026-08-03T00:00:00Z' },
            { id: 3, sent_at: '2026-07-30T00:00:00Z' },
          ]),
        )
      }
      return jsonResponse(emptyPage())
    })
    const result = await fetchNeonDashboard({
      since: SINCE,
      updatedSince: null,
      fetchImpl: rec.fetchImpl,
    })
    expect(result.messages.map((m) => m.id)).toEqual([2, 1, 3])
  })

  it('reports the follow-up feature unavailable when either of its relations is absent', async () => {
    const absent = async (missing: string) => {
      const rec = recorder((url) =>
        url.searchParams.get('op') === missing
          ? jsonResponse({ items: [], nextCursor: null, hasMore: false, unavailable: true })
          : jsonResponse(emptyPage()),
      )
      return fetchNeonDashboard({ since: SINCE, updatedSince: null, fetchImpl: rec.fetchImpl })
    }
    // The marker exists rather than a bare `[]` precisely for this: today's UI
    // renders "unavailable" and "no tasks" differently, and an array cannot tell
    // a pre-migration database from an empty queue.
    expect((await absent(READ_OPS.followUpState)).followUpsAvailable).toBe(false)
    expect((await absent(READ_OPS.latestMessage)).followUpsAvailable).toBe(false)
  })

  it('leaves the follow-up feature available when only a library relation is absent', async () => {
    const rec = recorder((url) =>
      url.searchParams.get('op') === READ_OPS.savedSearches
        ? jsonResponse({ items: [], nextCursor: null, hasMore: false, unavailable: true })
        : jsonResponse(emptyPage()),
    )
    const result = await fetchNeonDashboard({
      since: SINCE,
      updatedSince: null,
      fetchImpl: rec.fetchImpl,
    })
    expect(result.savedSearches).toEqual([])
    expect(result.followUpsAvailable).toBe(true)
  })

  it('fails the load when any read fails, with no per-read tolerance of its own', async () => {
    // The endpoint has already applied its per-operation tolerance and expressed
    // the tolerated case as a 200 with `unavailable`. A second, blanket
    // tolerance here would undo the narrowing S13 chose — and a coherent wrong
    // number is the one nobody investigates.
    for (const op of [READ_OPS.savedSearches, READ_OPS.leads, READ_OPS.pipelineEvents]) {
      const rec = recorder((url) =>
        url.searchParams.get('op') === op
          ? jsonResponse({ error: 'Could not load dashboard data' }, 500)
          : jsonResponse(emptyPage()),
      )
      await expect(
        fetchNeonDashboard({ since: SINCE, updatedSince: null, fetchImpl: rec.fetchImpl }),
      ).rejects.toThrow(new RegExp(`${op.replace('.', '\\.')}: Could not load`))
    }
  })
})

describe('the three component reads', () => {
  it('scopes the thread by instance as well as profile', async () => {
    const rec = recorder()
    // The same person can be reached from two LinkedIn accounts, so a
    // profile-only read merges two people's threads into one panel.
    await fetchNeonThread('notebook-1', 'https://www.linkedin.com/in/x', rec.fetchImpl)
    const query = onlyQuery(rec, READ_OPS.thread)
    expect(query.get('instance_id')).toBe('notebook-1')
    expect(query.get('profile_url')).toBe('https://www.linkedin.com/in/x')
  })

  it('walks the whole thread rather than showing its first page', async () => {
    const rec = recorder((_url, index) =>
      index === 0
        ? jsonResponse({ items: [{ id: 1 }], nextCursor: 'c1', hasMore: true })
        : jsonResponse(emptyPage([{ id: 2 }])),
    )
    const rows = await fetchNeonThread('notebook-1', '/in/x', rec.fetchImpl)
    expect(rows.map((r) => r.id)).toEqual([1, 2])
  })

  it('asks for one lead’s notes by uuid', async () => {
    const rec = recorder()
    await fetchNeonLeadNotes('11111111-2222-3333-4444-555555555555', rec.fetchImpl)
    expect(onlyQuery(rec, READ_OPS.leadNotes).get('lead_id')).toBe(
      '11111111-2222-3333-4444-555555555555',
    )
  })

  it('pages the follow-up history on the server’s cursor, not on a client seek', async () => {
    const rec = recorder(() =>
      jsonResponse({ items: [{ id: 9 }], nextCursor: 'next', hasMore: true }),
    )
    const first = await fetchNeonFollowUpHistory('notebook-1', '/in/x', 50, null, rec.fetchImpl)
    expect(first.nextCursor).toBe('next')
    expect(first.hasMore).toBe(true)
    expect(rec.queries[0].get('limit')).toBe('50')
    expect(rec.queries[0].has('cursor')).toBe(false)

    await fetchNeonFollowUpHistory('notebook-1', '/in/x', 50, 'next', rec.fetchImpl)
    expect(rec.queries[1].get('cursor')).toBe('next')
    // One page per call. This is the one component read whose paging is a user
    // action ("load more") rather than a completeness requirement.
    expect(rec.urls).toHaveLength(2)
  })
})
