/**
 * PostgREST paging for the conversation-scoped relations, extracted so it can be
 * tested.
 *
 * ## Why this file exists at all
 *
 * Everything it holds used to live inside `DataContext.tsx` and
 * `components/FollowUpPanel.tsx`. Both are `.tsx`, and `tsconfig.api.json` —
 * which is what type-checks `tests/` — declares no `jsx`, so a test importing
 * either of them fails to compile. `src/lib/*.ts` is already covered from
 * `tests/` (`leads.ts`, `csvImport.ts`, `demographics.ts`), so moving the two
 * pieces that carry real logic into a plain module puts them inside the coverage
 * that already exists rather than inventing a second test setup.
 *
 * The two pieces are here together because they are one subject: how a
 * conversation-scoped PostgREST read walks past the server's 1,000-row response
 * cap without losing or repeating a row. One does it by counting, the other by
 * seeking.
 *
 * ## The rule both of them exist to enforce
 *
 * **A partial result must never be returned as if it were complete.** That is
 * the defect class this module was written to close, and it has two shapes:
 *
 * - asking for a relation with no `.range()` loop at all, so the server silently
 *   answers with its first 1,000 rows and the caller treats them as the whole
 *   relation (`conversation_reply_intent`, fixed below);
 * - accumulating pages and returning what has arrived so far when a page fails
 *   mid-walk, which turns a transient error into a confidently short answer.
 *   `fetchAllPipelineEvents` in `DataContext.tsx` still does this; it is not
 *   this module's to change, and it is the anti-pattern these functions are
 *   written against.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConversationReplyIntent } from './types'

/**
 * PostgREST's response cap. Requesting a page of exactly this size and stopping
 * on the first short page is the idiom every paginated read in `DataContext`
 * uses; a full page is not proof there are more rows, but one more request that
 * comes back empty is cheap and it is the only way to know.
 */
export const PAGE_SIZE = 1000

/**
 * True for PostgREST's "relation does not exist" — SQLSTATE 42P01 from
 * PostgreSQL, or `PGRST205` when PostgREST's own schema cache has never seen the
 * relation. supabase-js error shapes vary by version and transport, so a message
 * naming a missing relation is accepted as a fallback.
 *
 * Moved here from `DataContext.tsx` unchanged. It is a string match on driver
 * text, which the Neon read path deliberately refuses to do — there the adapter
 * classifies SQLSTATE 42P01 into `DataStoreSchemaError` and the handler decides.
 * PostgREST gives this path no structural signal to use instead, which is one of
 * the reasons that contract was widened.
 */
export function isMissingRelation(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null
  if (err?.code === '42P01' || err?.code === 'PGRST205') return true
  return !!err?.message && /(relation|table|view).*(does not exist|not found)/i.test(err.message)
}

/**
 * Every row of `conversation_reply_intent`, paginated.
 *
 * ## What was wrong before
 *
 * This read was `supabase.from('conversation_reply_intent').select('*')` with no
 * `.range()` loop, sitting in `DataContext`'s `smallP` batch — so past the
 * thousandth conversation the view's rows were simply absent, with no error and
 * no marker. Every other unbounded read on that path pages; this one was missed.
 *
 * The consequence is worse than a missing count. The view carries
 * `highest_intent` and `first_p3_at`, and `replyIntentMetrics` in `leads.ts`
 * treats a row as **authoritative** over the message cache's own derivation —
 * so a truncated result does not zero the P3 cohort, it produces a *mixture*:
 * the surviving conversations get the view's answer and the rest fall back to
 * whatever the message cache can see. P3 is the denominator for post-P3 booking
 * conversion, so that mixture moves a rate, in a direction that depends on the
 * view's own row order rather than on anything meaningful.
 *
 * ## The ordering is part of the fix, not decoration
 *
 * `(instance_id, profile_url)` is the view's grouping key and therefore unique
 * across it, so it is a total order and page boundaries cannot drop or repeat a
 * row. An unordered `.range()` walk is not a walk at all — PostgreSQL is free to
 * return the same row on two pages. `fetchFollowUpData` orders its two sibling
 * views by the same pair for the same reason.
 *
 * ## Its error policy is narrower than what it replaces, deliberately
 *
 * The old read's error was excluded from the aggregate `error` `DataContext`
 * reports, and its rows were taken as `data ?? []`, so **any** failure here
 * silently emptied the view. This function keeps that tolerance for exactly one
 * failure — a relation the database does not have, which is a pre-migration
 * database and a real deployment state — and lets everything else propagate.
 *
 * That is the same line `fetchFollowUpData` already draws for
 * `conversation_follow_up_state` and `conversation_latest_message`: the two
 * relations of the same kind, read the same way, in the same file. A timeout or
 * an RLS denial on one of those already fails the load; making this view behave
 * like its siblings removes an inconsistency rather than adding one. And the
 * failure it now surfaces is precisely the one worth surfacing: an empty result
 * from this view is not a blank panel, it is a silently different conversion
 * rate.
 *
 * Both branches return a complete answer or none: `[]` when the relation is
 * absent, a throw otherwise. Accumulated pages are never returned.
 */
export async function fetchConversationReplyIntents(
  client: SupabaseClient,
): Promise<ConversationReplyIntent[]> {
  const all: ConversationReplyIntent[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from('conversation_reply_intent')
      .select('*')
      .order('instance_id')
      .order('profile_url')
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      // Discards `all` on purpose. A missing relation can only really appear on
      // the first page, but a tolerated failure must not be able to answer with
      // a prefix of the relation either.
      if (isMissingRelation(error)) return []
      throw error
    }
    all.push(...((data ?? []) as unknown as ConversationReplyIntent[]))
    if (!data || data.length < PAGE_SIZE) break
  }
  return all
}

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
 * those characters. (`+` survives regardless: supabase-js appends the filter
 * through `URLSearchParams`, which percent-encodes it as `%2B` rather than
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
