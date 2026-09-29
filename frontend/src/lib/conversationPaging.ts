/**
 * The PostgREST seek predicate for one conversation's follow-up history,
 * extracted so it can be tested without mounting a component.
 *
 * The browser now pages that history on the application API's own cursor
 * (`fetchNeonFollowUpHistory` in `dashboardReads.ts`), so nothing in `src`
 * calls this any more; it is kept, with its test, as the documented
 * lexicographic expansion of the `(occurred_at, id)` seek.
 */

/**
 * The "load more" predicate for one conversation's follow-up history, which is
 * ordered `(occurred_at DESC, id DESC)`.
 *
 * ## Why a predicate on `id` alone was wrong
 *
 * `FollowUpPanel` paged with `.lt('id', lastId)` while ordering on
 * `(occurred_at DESC, id DESC)`. Those two agree only while `id` order and
 * `occurred_at` order agree, and nothing guarantees that: `occurred_at` defaults
 * to `now()`, which is **transaction-start** time, while `id` comes from a
 * sequence at **insert** time. Two overlapping transactions can therefore commit
 * inverted — T1 starts first and so carries the earlier `occurred_at`, T2
 * inserts first and so carries the smaller `id`. When such a pair straddles a
 * page boundary, the `id`-only seek skips the row the order says comes next.
 *
 * ## The expansion, and why it is spelled out by hand
 *
 * PostgREST cannot express `(occurred_at, id) < (ts, id)` as a ROW comparison,
 * so the lexicographic form is written out:
 *
 * ```
 * occurred_at.lt.<ts>,and(occurred_at.eq.<ts>,id.lt.<id>)
 * ```
 *
 * inside an `or`. That is exactly
 * `occurred_at < ts OR (occurred_at = ts AND id < id)`, which is the ROW
 * comparison the Neon operation uses, and it has no gap.
 *
 * ## The quoting
 *
 * A `timestamptz` rendered by PostgREST looks like
 * `2026-08-05T06:29:31.802048+00:00` — it carries `.`, `:` and `+`, and `.` and
 * `:` are both meaningful inside a PostgREST filter string. The value is
 * therefore double-quoted, which is PostgREST's documented escape for exactly
 * those characters. (`+` survives regardless: a PostgREST client appends the
 * filter through `URLSearchParams`, which percent-encodes it as `%2B` rather than
 * letting it decode to a space.) Verified against live PostgREST rather than
 * assumed — the quoted form returns precisely the tail of an unpaginated walk of
 * the same conversation.
 *
 * A timestamp cannot contain a `"`, so no inner escaping is needed and none is
 * invented; anything that is not a timestamp has no business being passed here.
 */
export function followUpHistorySeek(last: { occurred_at: string; id: number }): string {
  const ts = `"${last.occurred_at}"`
  return `occurred_at.lt.${ts},and(occurred_at.eq.${ts},id.lt.${last.id})`
}
