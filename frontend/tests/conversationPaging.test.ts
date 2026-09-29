/**
 * The follow-up history seek predicate (`src/lib/conversationPaging.ts`).
 */

import { describe, expect, it } from 'vitest'
import { followUpHistorySeek } from '../src/lib/conversationPaging'

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
    // A PostgREST client appends the filter through URLSearchParams, which
    // encodes "+" as %2B. If it were interpolated into a URL by hand it would decode to a
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
