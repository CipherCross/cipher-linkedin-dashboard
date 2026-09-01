/**
 * The browser's read client, driven with an injected transport.
 *
 * ## Why this file is where the evidence is
 *
 * Everything the switch *decides* lives in `src/lib/dashboardReads.ts` — which
 * operation is called with which parameters, when a walk stops, what an
 * `unavailable` marker means, what happens to a failed page — and `DataContext.tsx`
 * and the five components hold a call site each. This file proves the decisions.
 *
 * It was written when it was also the *only* coverage the new path had, because
 * the default vitest run is `environment: 'node'` and `tsconfig.api.json` declared
 * no `jsx`, so a test could not import a `.tsx` file at all. Both of those changed
 * with the rendering suites (`*.test.tsx`, jsdom per file), so the call sites are
 * covered too — but by different files, deliberately. This one stays `node` and
 * stays fast.
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
  fetchNeonBootstrap,
  fetchNeonDashboard,
  fetchNeonLeadsSearchPage,
  fetchNeonOverviewSummary,
  fetchNeonSequenceHub,
  fetchNeonRouteSnapshot,
  fetchNeonFollowUpHistory,
  fetchNeonCoachingDigests,
  fetchNeonLeadNotes,
  fetchNeonPlaybook,
  fetchNeonThread,
  fetchDeploymentPaths,
  fetchReadPath,
  readAll,
  readPage,
  resetReadPath,
  resolvePhotoPath,
  resolveReadPath,
  routeSnapshotRequest,
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

  it('names thirty reads including route-owned performance contracts', () => {
    expect(Object.values(READ_OPS)).toHaveLength(30)
    expect(new Set(Object.values(READ_OPS)).size).toBe(30)
  })

  it('does not treat the flag lookup as a read', () => {
    // It is dispatched before authentication and touches no store, so it must
    // not be walked, tolerated or counted with the reads.
    expect(Object.values(READ_OPS)).not.toContain(READ_PATH_OPERATION)
    expect(READ_OPERATION_NAMES).not.toContain(READ_PATH_OPERATION)
  })

  it('reads the roster under one name, and no other identity name at all', () => {
    // **Narrowed, not dropped.** This assertion used to read "no name anywhere
    // matches `roster|team_members|team.`", written when the roster could not
    // cross because `leads` came from the other provider. It does now — both
    // ends of every member-id join arrive from one database — so what the
    // invariant protects is no longer "no roster" but "exactly one, and nothing
    // else identity-shaped". A second roster read, a `team_members` table read
    // or an admin operation appearing in this client still fails here.
    const names = [...Object.values(READ_OPS), ...READ_OPERATION_NAMES]
    const rosterNames = names.filter((name) =>
      /roster|team_members|team\.|identity/i.test(name),
    )
    expect([...new Set(rosterNames)]).toEqual(['identity.teamRoster'])
    expect(READ_OPS.teamRoster).toBe('identity.teamRoster')
    // The table, under either spelling, is never asked for directly: the
    // function is the only thing that returns more than the caller's own row.
    expect(names.join(' ')).not.toMatch(/team_members/)
  })
})

describe('the path flag', () => {
  /**
   * The two build shapes the fallback distinguishes, passed explicitly rather
   * than left to `import.meta.env` — a developer's own `.env` holds Supabase
   * variables, so an ambient default would make these tests pass or fail
   * depending on whose machine ran them.
   */
  const TENANT_BUILD = {}
  const LEGACY_BUILD = {
    VITE_SUPABASE_URL: 'https://project.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'anon-key',
  }

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

  it('believes only the two exact strings the server can answer', async () => {
    const answers = ['neon', 'supabase', ' neon ', 'NEON', 'Neon', 'true', '1', '']
    const seen: string[] = []
    for (const readPath of answers) {
      const rec = recorder(() => jsonResponse({ readPath }))
      seen.push(await fetchReadPath(rec.fetchImpl, TENANT_BUILD))
    }
    // The two answers are taken as given, whitespace and all. Everything after
    // them is unreadable, which since S27 means the fallback rather than
    // `supabase` — see the failure test below for why that direction turned round.
    expect(seen).toEqual([
      'neon', 'supabase', 'neon',
      'neon', 'neon', 'neon', 'neon', 'neon',
    ])
  })

  it('falls back when the answer is missing or malformed', async () => {
    for (const body of [{}, { readPath: null }, { readPath: 7 }, null, 'neon']) {
      const rec = recorder(() => jsonResponse(body))
      expect(await fetchDeploymentPaths(rec.fetchImpl, TENANT_BUILD)).toEqual({
        readPath: 'neon',
        photoPath: 'disabled',
      })
    }
  })

  /**
   * **S27 turned this direction round, and it is the point of the change.**
   *
   * `supabase` was the safe fallback while Supabase was the thing that worked.
   * On a tenant it is a `null` client, so one transient blip used to become
   * *"Supabase is not configured — set VITE_SUPABASE_URL…"*, a sentence about a
   * provider the deployment does not have, for the rest of the tab's life.
   *
   * A failed lookup means the same-origin API is unreachable, so every read is
   * about to fail anyway; what matters is that it fails visibly and retryably.
   */
  it('falls back to neon on a non-200, on a body that is not JSON, and on a network failure', async () => {
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
      expect(await fetchReadPath(rec.fetchImpl, TENANT_BUILD)).toBe('neon')
    }
  })

  /**
   * The other half of the same rule, and the reason the fallback is derived
   * rather than simply flipped to `neon`.
   *
   * A build that *does* hold a Supabase client reads straight from PostgREST and
   * does not depend on this same-origin lookup at all. Falling back to `neon`
   * there would be a new way to break a working dashboard: a blip in a lookup
   * that its reads never needed would move it onto a path the deployment may have
   * no credential for.
   */
  it('falls back to supabase on a build that holds a Supabase client', async () => {
    const failures: Responder[] = [
      () => jsonResponse({ error: 'boom' }, 500),
      () => {
        throw new TypeError('Failed to fetch')
      },
    ]
    for (const respond of failures) {
      const rec = recorder(respond)
      expect(await fetchDeploymentPaths(rec.fetchImpl, LEGACY_BUILD)).toEqual({
        readPath: 'supabase',
        photoPath: 'supabase',
      })
    }
  })

  it('reads a half-configured Supabase build as holding no client', async () => {
    // `src/lib/supabase.ts` needs both variables to construct a client and
    // exports `null` otherwise, so one alone is not a client to fall back to.
    const rec = recorder(() => {
      throw new TypeError('Failed to fetch')
    })
    for (const env of [
      { VITE_SUPABASE_URL: 'https://project.supabase.co' },
      { VITE_SUPABASE_ANON_KEY: 'anon-key' },
      { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: 'anon-key' },
    ]) {
      expect(await fetchReadPath(rec.fetchImpl, env)).toBe('neon')
    }
  })

  /**
   * The photo flag, and the rule that is enforced on both sides of the wire.
   *
   * The browser asks for photos by `lead.id`, and the two providers' lead ids name
   * different rows (`N-B2.md`). So a deployment answering `photoPath: 'neon'` while
   * its read path is Supabase would have the dashboard render one person's face
   * against another's name — and it would look like a caching bug. The server
   * refuses to *report* that combination and this refuses to *believe* it; a
   * mutation removing either was silent until this test existed.
   */
  it('never takes the photo path without the read path', async () => {
    const rec = recorder(() =>
      jsonResponse({ readPath: 'supabase', photoPath: 'neon' }),
    )
    expect(await fetchDeploymentPaths(rec.fetchImpl)).toEqual({
      readPath: 'supabase',
      photoPath: 'supabase',
    })
  })

  it('takes the photo path when both are neon', async () => {
    const rec = recorder(() => jsonResponse({ readPath: 'neon', photoPath: 'neon' }))
    expect(await fetchDeploymentPaths(rec.fetchImpl)).toEqual({
      readPath: 'neon',
      photoPath: 'neon',
    })
  })

  it('preserves the explicit initials-only photo posture', async () => {
    const rec = recorder(() =>
      jsonResponse({ readPath: 'neon', photoPath: 'disabled' }),
    )
    expect(await fetchDeploymentPaths(rec.fetchImpl)).toEqual({
      readPath: 'neon',
      photoPath: 'disabled',
    })
  })

  it.each([
    ['absent', { readPath: 'neon' }],
    ['null', { readPath: 'neon', photoPath: null }],
    ['a near miss', { readPath: 'neon', photoPath: 'Neon' }],
    ['true', { readPath: 'neon', photoPath: true }],
  ])('leaves the photo path on supabase when it is %s', async (_label, body) => {
    const rec = recorder(() => jsonResponse(body))
    expect((await fetchDeploymentPaths(rec.fetchImpl)).photoPath).toBe('supabase')
  })

  it('takes neither provider for photos when the lookup fails', async () => {
    const failures: Responder[] = [
      () => jsonResponse({ readPath: 'neon', photoPath: 'neon' }, 500),
      () => new Response('<html>', { status: 200 }),
      () => {
        throw new TypeError('Failed to fetch')
      },
    ]
    for (const respond of failures) {
      const rec = recorder(respond)
      // The photo half is the one that needed thinking about. `supabase` would
      // ask a client that may not exist for objects named by the other provider's
      // rows, and `neon` would fire one 503 per avatar at a deployment that may
      // not serve them. Initials are the honest answer to "we do not know yet".
      expect(await fetchDeploymentPaths(rec.fetchImpl, TENANT_BUILD)).toEqual({
        readPath: 'neon',
        photoPath: 'disabled',
      })
    }
  })

  it('reads a photo field it cannot parse as an answer, not a failure', async () => {
    // A server built before S20 sends no `photoPath` at all, and `supabase`
    // photos were right for it. Only an unreadable *read* path means the lookup
    // itself failed.
    const rec = recorder(() => jsonResponse({ readPath: 'supabase' }))
    expect(await fetchDeploymentPaths(rec.fetchImpl)).toEqual({
      readPath: 'supabase',
      photoPath: 'supabase',
    })
  })

  it('answers both flags from one request', async () => {
    const rec = recorder(() => jsonResponse({ readPath: 'neon', photoPath: 'neon' }))
    expect(await resolveReadPath(rec.fetchImpl)).toBe('neon')
    expect(await resolvePhotoPath(rec.fetchImpl)).toBe('neon')
    // One lookup for both, so the two can never disagree about one deployment.
    expect(rec.urls).toHaveLength(1)
  })

  it('asks once per page load and caches an answer', async () => {
    const rec = recorder(() => jsonResponse({ readPath: 'supabase' }))
    expect(await resolveReadPath(rec.fetchImpl)).toBe('supabase')
    expect(await resolveReadPath(rec.fetchImpl)).toBe('supabase')
    expect(await resolveReadPath(rec.fetchImpl)).toBe('supabase')
    // One session, one answer. Re-asking would let a five-minute refresh answer
    // from one provider while an open drawer still reads the other.
    expect(rec.urls).toHaveLength(1)
  })

  /**
   * **A failure is not an answer, and S27 stopped caching it.**
   *
   * Caching one pinned the page to a fallback until the tab was reloaded — the
   * Retry button could not help, because nothing re-asked. This does not reopen
   * the flapping the memo exists to prevent: that needs two *successful* answers
   * that disagree, and a deployment's answer does not change under a running tab.
   */
  it('re-asks after a failure, and heals when the lookup comes back', async () => {
    let attempt = 0
    const rec = recorder(() => {
      attempt += 1
      if (attempt < 3) throw new TypeError('Failed to fetch')
      return jsonResponse({ readPath: 'neon', photoPath: 'neon' })
    })
    expect(await resolveReadPath(rec.fetchImpl, TENANT_BUILD)).toBe('neon')
    expect(await resolvePhotoPath(rec.fetchImpl, TENANT_BUILD)).toBe('disabled')
    // The third call is the one that succeeds, and it is the one remembered.
    expect(await resolvePhotoPath(rec.fetchImpl, TENANT_BUILD)).toBe('neon')
    expect(await resolvePhotoPath(rec.fetchImpl, TENANT_BUILD)).toBe('neon')
    expect(rec.urls).toHaveLength(3)
  })

  it('shares one in-flight failing lookup rather than one request per caller', async () => {
    // Only the *settled* fallback is dropped. Callers that arrive together still
    // pay for one request, so a startup with three readers does not triple it.
    const rec = recorder(() => {
      throw new TypeError('Failed to fetch')
    })
    const [a, b, c] = await Promise.all([
      resolveReadPath(rec.fetchImpl, TENANT_BUILD),
      resolveReadPath(rec.fetchImpl, TENANT_BUILD),
      resolveReadPath(rec.fetchImpl, TENANT_BUILD),
    ])
    expect([a, b, c]).toEqual(['neon', 'neon', 'neon'])
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
    // Twenty of the twenty-five; the other five are the page-local reads and are
    // asserted below. The coaching pair belongs with them rather than with the
    // load: the playbook is one page's whole content, and the digest panel is
    // collapsed by default on another, so folding either into the first load
    // would pay for a request nobody is looking at on every dashboard open.
    const pageLocalReads = [
      READ_OPS.bootstrap,
      READ_OPS.overviewSummary,
      READ_OPS.routeSnapshot,
      READ_OPS.sequenceHub,
      READ_OPS.leadsSearchPage,
      READ_OPS.thread,
      READ_OPS.leadNotes,
      READ_OPS.followUpHistory,
      READ_OPS.playbook,
      READ_OPS.coachingDigests,
    ]
    const expected = Object.values(READ_OPS)
      .filter((op) => !pageLocalReads.includes(op as never))
      .sort()
    expect(requested).toEqual(expected)
    expect(requested).toHaveLength(20)
    // The twentieth is the roster, and it is part of the *load* rather than an
    // on-demand read: `memberName(lead.assigned_to)` runs on the first render of
    // the Pipeline board, so a roster fetched later would render a page of
    // nameless owners first.
    expect(requested).toContain(READ_OPS.teamRoster)
  })

  it('loads the shell through one bootstrap request', async () => {
    const rec = recorder((url) => {
      expect(url.searchParams.get('op')).toBe(READ_OPS.bootstrap)
      return jsonResponse(emptyPage([{
        instances: [{ id: 'n1' }],
        campaigns: [{ campaign_id: 'n1:1' }],
        teamMembers: [{ id: 7, name: 'A' }],
      }]))
    })
    const result = await fetchNeonBootstrap(rec.fetchImpl)
    expect(rec.urls).toHaveLength(1)
    expect(result.rosterPath).toBe('neon')
    expect(result.instances).toHaveLength(1)
    expect(result.teamMembers[0]?.id).toBe(7)
  })

  it('maps every non-local page to a deterministic route snapshot key', () => {
    expect(routeSnapshotRequest('#/account/notebook-1?range=all')).toEqual({
      route: 'account', routeId: 'notebook-1', key: 'account:notebook-1',
    })
    expect(routeSnapshotRequest('#/campaign/notebook-1%3A42')).toEqual({
      route: 'campaign', routeId: 'notebook-1:42', key: 'campaign:notebook-1:42:compare:',
    })
    expect(routeSnapshotRequest('#/campaign/notebook-1%3A42?cmp=notebook-2%3A7,notebook-3%3A8')).toEqual({
      route: 'campaign',
      routeId: 'notebook-1:42',
      compareIds: 'notebook-2:7,notebook-3:8',
      key: 'campaign:notebook-1:42:compare:notebook-2:7,notebook-3:8',
    })
    for (const route of ['pipeline', 'follow-ups', 'review', 'health', 'searches', 'icp', 'hypotheses']) {
      expect(routeSnapshotRequest(`#/${route}?q=ignored`)).toEqual({ route, key: route })
    }
    for (const local of ['#/', '#/leads', '#/team', '#/playbook', '#/chat', '#/csv-import', '#/neon-activity']) {
      expect(routeSnapshotRequest(local)).toBeNull()
    }
  })

  it('loads one route snapshot row with validated route parameters', async () => {
    const payload = { leads: [{ id: 'l1' }], followUpsAvailable: true }
    const rec = recorder(() => jsonResponse(emptyPage([payload])))
    await expect(fetchNeonRouteSnapshot({
      route: 'account', routeId: 'notebook-1', key: 'account:notebook-1',
    }, rec.fetchImpl)).resolves.toEqual(payload)
    const query = onlyQuery(rec, READ_OPS.routeSnapshot)
    expect(query.get('route')).toBe('account')
    expect(query.get('route_id')).toBe('notebook-1')
    expect(query.has('compare_ids')).toBe(false)
    expect(query.get('limit')).toBe('1')
  })

  it('requests one exact Overview summary for the inclusive UTC range', async () => {
    const payload = {
      totals: { leads: 10 }, accounts: [], campaigns: [], activity: [], velocity: [],
      velocityUndated: 0, funnel: { leads: 10 },
    }
    const rec = recorder(() => jsonResponse(emptyPage([payload])))
    const result = await fetchNeonOverviewSummary(
      { from: '2026-05-01', to: '2026-05-31' },
      rec.fetchImpl,
    )
    const query = onlyQuery(rec, READ_OPS.overviewSummary)
    expect(query.get('from')).toBe('2026-05-01')
    expect(query.get('to')).toBe('2026-05-31')
    expect(query.get('limit')).toBe('1')
    expect(result.totals.leads).toBe(10)
  })

  it('requests one bounded Sequence Hub snapshot', async () => {
    const payload = { items: [], newestReplies: [] }
    const rec = recorder(() => jsonResponse(emptyPage([payload])))
    await expect(fetchNeonSequenceHub(rec.fetchImpl)).resolves.toEqual(payload)
    const query = onlyQuery(rec, READ_OPS.sequenceHub)
    expect(query.get('limit')).toBe('1')
  })

  it('requests one server-filtered Leads page instead of walking the directory', async () => {
    const payload = { items: [], total: 42, allTotal: 10_250, replyCounts: { total: 5, c: {} } }
    const rec = recorder(() => jsonResponse(emptyPage([payload])))
    const result = await fetchNeonLeadsSearchPage({
      inst: 'uitop', camp: 'all', stage: 'replied', risk: 'all', pipe: 'all',
      who: 'all', gender: 'all', agebucket: 'all', follow: 'all',
      repliedSince: '2026-08-01T00:00:00.000Z', sentiment: 'positive', intent: 'p3',
      q: 'founder', sort: 'replied_at', dir: 'desc', today: '2026-08-12',
      page: 2, pageSize: 50,
    }, rec.fetchImpl)
    const query = onlyQuery(rec, READ_OPS.leadsSearchPage)
    expect(query.get('instance_id')).toBe('uitop')
    expect(query.get('page')).toBe('2')
    expect(query.get('page_size')).toBe('50')
    expect(query.get('sentiment')).toBe('positive')
    expect(query.get('limit')).toBe('1')
    expect(result.allTotal).toBe(10_250)
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

  it('projects roster rows onto the shape the SPA already renders', async () => {
    // Every field crossed, because the two identifiers on a roster row name
    // different things — `id` is `team_members.id` (bigint), `userId` is
    // `users.id` (uuid) — and crossing them type-checks and is silent.
    const rec = recorder((url) =>
      url.searchParams.get('op') === READ_OPS.teamRoster
        ? jsonResponse(
            emptyPage([
              {
                id: 7,
                userId: '00000000-0000-0000-0000-0000000000aa',
                name: 'Active One',
                email: 'active-one@example.test',
                role: 'admin',
                active: true,
                createdAt: '2026-02-03T04:05:06.000Z',
              },
            ]),
          )
        : jsonResponse(emptyPage()),
    )
    const result = await fetchNeonDashboard({
      since: SINCE,
      updatedSince: null,
      fetchImpl: rec.fetchImpl,
    })

    expect(result.teamMembers).toEqual([
      {
        id: 7,
        name: 'Active One',
        active: true,
        created_at: '2026-02-03T04:05:06.000Z',
        // Null, and deliberately so: there is no Supabase Auth user behind a
        // `team_roster()` row. Filling it with the canonical uuid would make an
        // id from one space answer a question about another — and the Team page
        // reads this field to mean "has a Supabase login", which would then be
        // wrong in both directions. `Team.tsx` gets "is a login" from the
        // baseline's `user_id NOT NULL` instead, keyed on `rosterPath`.
        auth_user_id: null,
        email: 'active-one@example.test',
        role: 'admin',
      },
    ])
    // The bigint reached `id`, and the uuid reached nothing.
    expect(JSON.stringify(result.teamMembers)).not.toContain(
      '00000000-0000-0000-0000-0000000000aa',
    )
  })

  it('labels the roster it returns with the provider it came from', async () => {
    // The marker every write surface consults. It lives on this result rather
    // than being written by `DataContext.tsx` because a literal in a `.tsx` file
    // is one no test here can reach — a mutation setting it to `'supabase'` in
    // that file reddened nothing, which is how it ended up here.
    const rec = recorder()
    const result = await fetchNeonDashboard({
      since: SINCE,
      updatedSince: null,
      fetchImpl: rec.fetchImpl,
    })
    expect(result.rosterPath).toBe('neon')
  })

  it('walks the roster rather than taking its first page', async () => {
    // `/api/identity?op=team.roster` caps at one page of 200 and reports
    // `hasMore` (N-S18's stated limit). Here the whole roster is the answer:
    // `memberName` resolves *any* `assigned_to`, so a truncated roster would
    // leave the owners past the cap nameless — which is the failure this slice
    // exists to end, one page further down.
    // Counted per operation, not per request: the recorder's index is the global
    // request number and the roster's second page arrives after nineteen others.
    let rosterPage = 0
    const rec = recorder((url) => {
      if (url.searchParams.get('op') !== READ_OPS.teamRoster) {
        return jsonResponse(emptyPage())
      }
      const page = rosterPage++
      return jsonResponse({
        items: [
          {
            id: page + 1,
            userId: `0000000${page}-0000-0000-0000-00000000000${page}`,
            name: `Member ${page}`,
            email: null,
            role: 'member',
            active: true,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: page === 0 ? 'page-2' : null,
        hasMore: page === 0,
      })
    })
    const result = await fetchNeonDashboard({
      since: SINCE,
      updatedSince: null,
      fetchImpl: rec.fetchImpl,
    })
    expect(result.teamMembers.map((m) => m.id)).toEqual([1, 2])
    const rosterQueries = rec.queriesFor(READ_OPS.teamRoster)
    expect(rosterQueries).toHaveLength(2)
    // The second page carries the server's cursor; a walk that resent its first
    // query would loop on page one and return the same member twice.
    expect(rosterQueries[0].has('cursor')).toBe(false)
    expect(rosterQueries[1].get('cursor')).toBe('page-2')
  })

  it('fails the load when the roster read fails, rather than emptying the team', async () => {
    // The roster is not tolerated on the endpoint and is not tolerated here.
    // `team_members` is in the baseline's first artifact, so an absent relation
    // is a broken deployment — and answering it with `[]` is exactly the
    // "0 Active teammates" this slice removed.
    const rec = recorder((url) =>
      url.searchParams.get('op') === READ_OPS.teamRoster
        ? jsonResponse({ error: 'Could not load dashboard data' }, 500)
        : jsonResponse(emptyPage()),
    )
    await expect(
      fetchNeonDashboard({ since: SINCE, updatedSince: null, fetchImpl: rec.fetchImpl }),
    ).rejects.toThrow(/identity\.teamRoster/)
  })

  it('asks the roster for nothing: no window, no watermark, no scope', async () => {
    const rec = recorder()
    await fetchNeonDashboard({ since: SINCE, updatedSince: WATERMARK, fetchImpl: rec.fetchImpl })
    const roster = onlyQuery(rec, READ_OPS.teamRoster)
    expect([...roster.keys()]).toEqual(['op'])
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

describe('the coaching pair', () => {
  it('returns the playbook row when there is one', async () => {
    const rec = recorder(() =>
      jsonResponse(emptyPage([{ content: '# Playbook', updated_at: '2026-08-06T10:00:00Z' }])),
    )
    const doc = await fetchNeonPlaybook(rec.fetchImpl)
    expect(doc).toEqual({ content: '# Playbook', updated_at: '2026-08-06T10:00:00Z' })
    // No parameters at all: it is a singleton, and there is nothing to scope.
    expect([...onlyQuery(rec, READ_OPS.playbook).keys()]).toEqual(['op'])
  })

  it('answers null — not an empty document — when the singleton is unwritten', async () => {
    // The page renders `null` as an empty editor on its placeholder, which is
    // what `maybeSingle()` produces on the other path. It may only do that
    // because the *failure* case cannot reach here: it throws.
    const rec = recorder(() => jsonResponse(emptyPage([])))
    expect(await fetchNeonPlaybook(rec.fetchImpl)).toBeNull()
  })

  it('throws on a failed playbook read rather than answering with a blank one', async () => {
    // The assertion this pair exists for. `loadError` locks the editor, and it
    // is only set because this rejects — an empty string here would unlock a
    // blank box that an admin can Save over the real playbook.
    const rec = recorder(() => jsonResponse({ error: 'Could not load dashboard data' }, 500))
    await expect(fetchNeonPlaybook(rec.fetchImpl)).rejects.toThrow(
      /coach\.playbook: Could not load dashboard data/,
    )
  })

  it('walks every account’s digest rather than taking the first page', async () => {
    const rec = recorder((_url, index) =>
      index === 0
        ? jsonResponse({
            items: [{ instance_id: 'notebook-1' }],
            nextCursor: 'c1',
            hasMore: true,
          })
        : jsonResponse(emptyPage([{ instance_id: 'notebook-2' }])),
    )
    const rows = await fetchNeonCoachingDigests(rec.fetchImpl)
    // A truncated read would leave the accounts past the cap indistinguishable
    // from ones whose digest has never been computed.
    expect(rows.map((r) => r.instance_id)).toEqual(['notebook-1', 'notebook-2'])
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
