# N-S13 part 3 — the rest of the `DataContext` read slice

**The scope the owner chose is complete.** S13's row was split into three parts
before any code was written; parts 1 and 2 delivered nine of `DataContext`'s
twenty reads, and this part delivers the remaining eleven plus all three
component-local reads. The allowlist goes from **nine names to twenty-two**.

Nothing is deployed, nothing is pushed, and **the browser still reads Supabase**.
S18 owns the switch.

**One finding is not about the migration and should be read first:**
`conversation_reply_intent` is silently truncated on the **dashboard running
today**. See "The live defect" below.

## Identity

| | |
|---|---|
| Base SHA (`main`) | `d22bc47` |
| Branch | `codex/neon-s13-part3-dashboard-reads`, not merged |
| Commits | `56e45da` the contract error · `c858ecd` thirteen operations and the endpoint · `75dd7dc` the guards and live coverage · this document |
| Session | S13 part 3, spec `specs/2026-07-30-neon-migration-and-multitenancy.md:414` |
| Predecessor | `docs/implementation-handoffs/N-S13.md` (parts 1 and 2), `N-B2.md`, `N-S17.md` |
| Gate carried | none. G2 was decided 2026-08-03 (`approved` / `conditional-go`) |

### Changed files

```
frontend/api/_lib/data/contracts.ts                    +37  DataStoreSchemaError
frontend/api/_lib/data/neon.ts                         +25  42P01 translation
frontend/api/_lib/data/operations/conversations.ts    +391  four conversation-keyed reads
frontend/api/_lib/data/operations/library.ts          +400  the six tolerated library reads
frontend/api/_lib/data/operations/pipeline.ts         +148  pipeline.eventLog
frontend/api/_lib/data/operations/leads.ts             +73  leads.notes
frontend/api/_lib/data/operations/messages.ts        +102  messages.thread
frontend/api/_lib/data/operations/index.ts            ±106  registrations
frontend/api/activity-daily.ts                       ±186  13 allowlist entries, tolerance, readers
frontend/tests/dashboardSlice.test.ts                ±270  the widened guards
frontend/tests/dashboardTolerance.test.ts             +221  the tolerant branch, no database
frontend/tests/dashboardSliceRest.neon.test.ts      +1,227  31 live tests
frontend/tests/support/dashboardRestFixture.ts        +724  the fixture
docs/implementation-handoffs/N-S13-part3.md            new  this document
```

13 files, **+3,878 / −32**. Nothing under `postgres/`, `supabase/migrations/`,
`ops/`, `sync-agent/` or `spikes/s16-identity/` changed. **`frontend/src/` was not
touched at all** — `DataContext.tsx` still fetches Supabase for all twenty reads,
and no page knows any of this exists. No AI handler was touched. The function
count stays at **12**.

`frontend/api/_lib/data/contracts.ts` — the S03 contract — **was** changed, for the
first time in this migration. Parts 1 and 2 both recorded needing no change to it.
Design call 1 is that decision and why it is not smuggled in as a driver detail.

## Preflight corrections

**None of the brief's stated facts turned out to be wrong.** All five recorded
baselines matched, measured before any edit:

| Suite | Expected | Measured | Match |
|---|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** | yes |
| `npx vitest run` | 12 files / 181 tests | 12 files / **181 passed** | yes |
| `npm run test:neon` | 5 files / 101 tests, ~105 s | 5 files / **101 passed**, 125 s | yes |
| `cd ops && npm test` | 70 / 0 | **70 passed, 0 failed** | yes |
| ledger static assertions | 128 / 0 | **128 passed, 0 failed** | yes |

Two working notes rather than corrections. The Neon suite took **125 s** against
the brief's "~105 s" — a remote-region timing, not a regression. And the brief's
file references `DataContext.tsx`, which lives at
`frontend/src/lib/DataContext.tsx`, not under `src/context/`.

## The live defect, stated separately from the migration

`DataContext.tsx:636` reads `conversation_reply_intent` with `select('*')` and **no
pagination at all**. PostgREST caps an unpaginated response at 1,000 rows, so on
the dashboard **running in production today** every conversation past the
thousandth is missing from that view's results.

Why this is worse than "some data is missing":

- The view carries `highest_intent` and `first_p3_at`. **P3 is the denominator for
  post-P3 booking conversion**, so the truncation does not merely lower a count —
  it changes a *rate*, and in a direction nobody can predict, because which 1,000
  conversations survive depends on the view's own ordering rather than on anything
  meaningful.
- `DataContext` deliberately excludes this read's error from the error it reports,
  so even a genuine failure here is silent. A truncation is not an error at all.
- Every other large read on that path is paginated (`fetchAllLeads`,
  `fetchMessages`, `fetchAllPipelineEvents`, `fetchFollowUpData`). This one was
  missed.

**The new path pages it, and the live suite proves the walk is complete at 2,100
rows.** The Supabase path is untouched by this session — S18 owns
`DataContext.tsx` — so **the running dashboard still truncates**. Fixing it there
is a four-line change (the same `.range()` loop the neighbouring reads use) and it
is the owner's to schedule, independently of the Neon migration.

It was Known limit 3 of N-S13. It is repeated here because a limit in a handoff is
not the same as somebody being told a number on their screen is wrong.

## Recorded pre-edit baselines

See "Preflight corrections" — all five matched, so no regression claim below rests
on a guess.

## The design calls

### 1. Tolerating an absent relation: the adapter classifies, the caller decides

Ten of the twenty-two reads must answer an absent relation with an empty result
rather than a failure, because `DataContext` already does: it excludes those reads
from the one error it reports and takes `data ?? []`, so a database missing a
not-yet-applied table renders a blank Search Library instead of an empty
dashboard. Moving them behind an endpoint that 500s on the same input would have
been a regression against today, on relations no funnel number depends on.

**Decision: `DataStoreSchemaError` (`SCHEMA_OBJECT_MISSING`) joins the S03
contract; the Neon adapter raises it for SQLSTATE 42P01 and only for that; the
*endpoint* decides per operation whether to tolerate it, and answers with an
explicit `unavailable: true`.**

Three alternatives were rejected, and the order matters:

- **String-matching the driver's message**, which is what the Supabase path's
  `isMissingRelation` has to do. Rejected on a rule this endpoint already lives
  by: `safeErrorLabel` logs `name`/`code` and never `message`, because the
  driver composes a failure as `` `${what}: ${originalMessage}` `` and for a
  connection-level failure the original text embeds the database hostname. A
  handler that parses driver text to make a control-flow decision has re-entered
  exactly the business that rule exists to keep it out of.
- **Letting the driver return zero rows for an absent relation.** Rejected because
  it makes *every* read tolerant, including the funnel reads — where an empty
  answer is not a blank panel but a wrong number. Tolerance is a product judgement
  about one read, so it belongs where the reads are named.
- **A tolerant SQL formulation** (`to_regclass`, or a guard around the projection).
  Rejected because it is not possible: a missing relation is a *parse*-time error,
  so tolerating it inside SQL needs dynamic execution, which needs a function,
  which needs DDL, which needs a ledger step this session may not write.

**Why the marker rather than a bare `[]`.** For the six library reads the two are
interchangeable. For the follow-up pair they are not: `fetchFollowUpData` today
distinguishes a *missing* relation (`available: false`, which the UI renders as
"unavailable") from an *empty* queue, and `followUpsAvailable` is a field in
`DashboardData`. A bare `[]` would erase a distinction the browser currently makes,
which is the sort of thing that survives a migration and shows an operator an
empty task list on a pre-migration database.

**Why not 42703 as well.** A missing *column* stays an ordinary failure. Design
call 3 of N-S13 killed the column ladders on the argument that silent degradation
is worse than failure once the schema is ledger-applied; adding 42703 to the
tolerated SQLSTATE would reinstate the same degradation through the error path
instead of the query path. The constant carries a comment saying so, and mutation
M4 below is the assertion.

**A deliberate narrowing, recorded because it is not "equivalent".**
`fetchAllPipelineEvents` returns `all` — the rows accumulated so far — on **any**
error from **any** page, mid-walk. So a transient failure on page three currently
yields a silently truncated audit log and a confidently short funnel.
`pipeline.eventLog` tolerates a missing relation and nothing else. That is narrower
than today on purpose: a blank panel is recoverable, a plausible wrong number is
not. It is the one place this session's behaviour differs from the Supabase path's
rather than reproducing it.

### 2. Keyset on the conversation views — and here the benefit is real, with numbers

Part 2 measured keyset against offset on `messages` and found **no difference**
(6.93 ms against 7.57 ms), because the sort key had no index and both plans came
out as a sequential scan feeding a top-N heapsort. It said so plainly, and left the
index as a ledger step somebody else owns.

**The claim for the conversation views is different, so it needed its own
evidence.** The seek predicate is on the views' *grouping* columns, so PostgreSQL
can push it down into the aggregate's input; an `OFFSET` applied outside can only
be evaluated after the whole aggregate has been computed. Server-side
`EXPLAIN ANALYZE`, p50 of 7 runs, over `conversation_reply_intent`'s 2,100 fixture
rows:

| page | execution |
|---|---|
| `OFFSET 0` | 24.43 ms |
| `OFFSET 2000` | 44.80 ms |
| keyset seek to row 2000 | **1.62 ms** |

**About 27× faster at the deep page, and the plans say why.** The offset
formulation scans the base relation whole:

```
Seq Scan on messages (actual time=0.063..11.146 rows=3360)
  Rows Removed by Filter: 2983
Execution Time: 45.300 ms
```

The keyset formulation turns the ROW comparison into an **index condition**, on an
index that already exists:

```
Index Scan using messages_identity_key on messages (actual time=0.070..1.904 rows=99)
  Index Cond: ((ROW(instance_id, profile_url) > ROW('s13-rest', 's13-rest/lead/002000'))
               AND (direction = 'in'))
Execution Time: 3.347 ms
```

`messages_identity_key` is `(instance_id, profile_url, direction, sent_at,
content_hash)` — a unique index whose *leading* columns are exactly the views'
grouping key. So unlike part 2's `messages` reads, **this win needs no new index
and no ledger step**; it was available and unused.

Two honest qualifications. The absolute numbers are small at 2,100 rows and the
ratio is what matters, since offset's cost grows with the offset and the seek's does
not. And whether the planner chooses that index is the planner's decision, not this
session's — so the live test *prints* the plan rather than asserting it, and its
only assertion is that nothing is pathological. A threshold there would encode
today's data volume as a contract.

### 3. Which reads seek and which count — the line, drawn once

Eight reads keyset and fourteen offset, and the rule is "does the row count grow
with the team's work":

| keyset | why |
|---|---|
| `leads.directory`, `messages.inboundHistory`, `messages.outboundRecent` | part 2's |
| `pipeline.eventLog` | append-only, one row per manual action, forever |
| `conversations.followUpState` / `.latestMessage` / `.replyIntent` | one row per conversation the team has ever held |
| `conversations.followUpHistory` | append-only per conversation, and it has an exactly-matching index |

| offset | why |
|---|---|
| the five S12/S13 aggregate slices | small and view-backed; S12 measured 522 ms against 525 ms |
| `messages.thread` | bounded by one human conversation |
| `leads.notes` | bounded per lead — **and it may not seek at all**, see below |
| the six library reads | bounded by how much a human types |

**`leads.notes` is the one where offset is a correctness requirement rather than a
preference.** `lead_notes.created_at` is `timestamptz DEFAULT now()` **with no NOT
NULL**, so a note can have none. A keyset seek over a nullable leading column needs
explicit NULL ordering on both the `ORDER BY` and the comparison, and
`ROW(a, b) < ROW(c, d)` involving NULL evaluates to **NULL rather than false** — so
the rows would be dropped silently rather than raising. On a relation of a handful
of rows per lead, offset costs nothing and avoids the trap outright. The fixture
seeds a note with a NULL `created_at` so this is exercised rather than argued.

The whole split is asserted as a *set* in the guard suite, so moving a read across
the line has to edit that line.

### 4. `owner_id` is `assigned_to` under another name, and the guard narrows the same way

`conversation_follow_up_state.owner_id` and `follow_up_events.previous_owner_id` /
`new_owner_id` are `team_members.id` values in the **source** id space. N-B2's
collision applies unchanged: the same integers on Neon denote different people, and
a roster join here mislabels the owner of a follow-up task while **failing
nothing**.

Part 1 asserted that no operation's SQL contains the string `owner_id` at all,
which held only because nothing read the follow-up relations yet. **That assertion
is now narrowed to three named per-operation permissions** — `leads.directory`,
`conversations.followUpState`, `conversations.followUpHistory` — each asserted to
select its member id and to be structurally incapable of resolving it: exactly one
`FROM`, no `JOIN` of any kind, no subquery that could reach a roster. Every other
read still may not mention a member id in any spelling, and `owner_id` as a
substring catches `previous_owner_id` and `new_owner_id` too.

The columns cannot be dropped: the follow-up queue's owner filter *is* that value,
and dropping it would be data loss dressed as caution — the same argument part 2
made for `assigned_to`.

**One relation is the exception, and it is worth knowing about.**
`pipeline_events.from_assignee` / `to_assignee` and
`follow_up_events.previous_owner_name` / `new_owner_name` are member **names**,
snapshotted as text when the event was written. They need no roster to read and
they stay correct after a member is removed — so the audit trails are legible
across the provider boundary while the *state* tables are not. That asymmetry is
the shape a roster migration should aim for.

### 5. `messages.thread` — the second column ladder dies, and it is the worse one

`ConversationDrawer.tsx:180` walks a three-rung ladder of its own: the intent
columns, then `source`, then neither, dropping a rung on SQLSTATE 42703.

**Decision: one fixed projection, on N-S13 design call 3's reasoning — and the
argument lands harder here than on `leads`.** The drawer's *purpose* is triage, and
its middle rung silently removes `intent_level` and `intent_reason` from every
message in the thread. An SDR would be reading a conversation that shows no buying
intent **because the query asked for none** — a confident wrong answer in the one
place a human makes a decision from what is on screen. That was defensible while
migration 047 was in flight against a schema applied out of band. On a
ledger-applied schema that already contains every column, it hides a broken
deployment from the person least able to detect it.

It is a distinct operation rather than a mode of `inboundHistory`: both directions
rather than one, ascending rather than descending, one conversation rather than the
team, and a narrower projection (no `instance_id`, `campaign_id` or `profile_url`,
because the caller already holds the lead).

### 6. `occurredSince`, not `updatedSince` — and still not `range`

`pipeline_events` has **no `updated_at` column at all**. Being append-only, its
insertion time is its watermark, so the delta filters `occurred_at` — which is also
the row's own event time. That is the one case where a watermark and a window
coincide, which is precisely why they are named apart.

**Decision: an explicit `occurredSince` parameter (`?occurred_since=`), and the
operation ignores `range` entirely.** Reusing `updatedSince` would have named a
column that does not exist. Using `range` would have been worse: a caller that
passed the dashboard's 90-day display window — the obvious thing to pass, since
`range` means that everywhere else — would silently drop every older stage move and
shrink "ever reached stage X" for the whole team, with no error. The live suite
asserts that supplying `from`/`to` does not change the rows.

### 7. `follow_up_events`: the client's seek does not match its own order

Not a decision so much as a defect found while matching the existing read.

`FollowUpPanel.tsx:112` orders by `(occurred_at DESC, id DESC)` and then pages with
`.lt('id', lastId)` — **a predicate on `id` alone**. The two agree only while `id`
order and `occurred_at` order agree, and that is not guaranteed: `occurred_at`
defaults to `now()`, which is *transaction-start* time, while `id` comes from a
sequence at *insert* time. Two overlapping transactions can therefore commit with
the orders inverted — T1 begins first (earlier `now()`) but T2 inserts first
(smaller `id`). When that inversion lands on a page boundary, "load more" **skips a
row**.

The new operation uses a ROW comparison, which has no such gap. The fixture plants
an inversion positioned at the first page boundary and the live suite shows both
halves: the client's predicate is executed out of band and demonstrated to skip the
next row, and the operation's walk is shown to return all 120 events in order.

Severity is low — it needs concurrent follow-up mutations on one conversation and
it loses a history row, not state — and the browser is not this session's to
change. **Reported, not fixed.** It belongs with S18 or with whoever next touches
that panel.

### 8. Twenty-two names, and the guard suite widened on purpose

The allowlist assertion spells all twenty-two names literally, as part 1's spelled
nine, and its test name carries the count — the cheapest available tripwire on the
surface area of the read path. Two assertions were edited and one was added:

- **`allowlists twenty-two reads and no more`** — was nine. Edited.
- **`covers every allowlisted name with an inspected definition`** — unchanged in
  substance, but it is what stops a twenty-third read from dodging every assertion
  in the file by not appearing in `READ_SLICE`.
- **`tolerates a missing relation on exactly the ten reads that may`** — new, and
  it asserts the *set*, plus explicitly that each funnel read and each on-demand
  component read is absent from it. Marking a funnel read tolerant is one word.

Two further new guards earn their place: `seeks in the direction each keyset read
actually orders` (a seek pointing the wrong way returns the same page forever — a
non-terminating walk rather than a skipped row, and the driver deliberately
generates neither half), and `scopes every conversation-scoped read by instance as
well as profile` (`CLAUDE.md`'s rule: the same person can be reached from two
accounts, so a profile-only filter merges two people's threads).

## Coverage and checks, with real numbers

| Check | Baseline | After |
|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** |
| `npm run build` | clean | **clean** (5 m 11 s; the pre-existing chunk-size warning is unchanged) |
| `npx vitest run` | 12 files / 181 passed | 13 files / **264 passed** (+83) |
| `npm run test:neon` | 5 files / 101 passed, 125 s | 6 files / **132 passed** (+31), 168 s and 174 s over two full runs |
| `cd ops && npm test` | 70 / 0 | **70 passed, 0 failed** — unchanged |
| ledger static assertions | 128 / 0 | **128 passed, 0 failed** — unchanged, nothing under `postgres/` touched |

### What the live suite proves

`tests/dashboardSliceRest.neon.test.ts`, 31 tests, real handler → real registry →
real driver → real RLS, against the live project.

| assertion | result |
|---|---|
| `pipeline.eventLog` full walk | 2,100 rows, ≥3 pages, cursor chained twice, strictly ascending pairwise |
| duplicate-`occurred_at` groups | all 300 groups exactly 7 rows; a page boundary **confirmed** to fall inside a group |
| `occurred_since` delta | exactly 1,050 rows, all at or after the watermark |
| `from`/`to` on the event log | supplying a window returns **identical** rows |
| `conversations.replyIntent` full walk | **2,100 rows — past the 1,000 cap the Supabase path stops at**; ≥3 pages, chained twice |
| key uniqueness across the walk | 2,100 distinct `(instance_id, profile_url)`, strictly ascending |
| page-size invariance | `limit=150` returns rows **identical** to `limit=1000`, in more pages |
| intent milestones | 700 / 700 / 700 across p1/p2/p3; every p3 row has `first_p3_at` and a **non-null `last_out_after_p3_at`** later than it |
| unlabelled conversations | present in `latestMessage` (2,140), absent from `replyIntent` (2,100) |
| `latestMessage` direction | outbound for exactly the 700 p3 conversations — the view's `DISTINCT ON` ordering, not a re-derivation |
| `followUpState` | 2,100 rows; 210 owned, `owner_id` a **number** and one of the two fixture ids; 300 archived; `next_follow_up_date` matches `YYYY-MM-DD` |
| `followUpHistory` walk | 120 events as `[50, 50, 20]`, strictly descending pairwise, no duplicates |
| the planted order inversion | the client's `id`-only seek **demonstrated to skip** the next row; the ROW comparison returns the full sequence |
| instance scoping | same profile, wrong notebook → `[]`, and **no** `unavailable` marker |
| `messages.thread` | both directions, oldest first, exact 11-column projection, intent columns populated |
| `leads.notes` | 26 rows; the NULL-`created_at` note **first**; the rest strictly descending |
| library shapes | `text[]` arrive as arrays, `jsonb` as an object with booleans intact, `'{}'`/`{}` defaults preserved as themselves |
| library ordering | `(platform, name, id)` and `(icp_id, sort, id)` verified against the emitted rows |
| adapter classification | 42P01 → `DataStoreSchemaError`/`SCHEMA_OBJECT_MISSING`, message carries no driver text; **42703 → not** that class |
| present-but-empty | a tolerated read returns `[]` with **no** marker |
| deny matrix | 401 / 401 / 403 / 403 / 403 / 200, on **five** operations each, tolerated reads included |
| auth precedes validation | a parameterless request to a parameterized read, unauthenticated, is **401** not 400 |
| every new operation readable | all **13**, by an active member and an active admin |
| malformed input | operation names, watermarks, cross-scope cursors, cursor arity, uuid form, and the thread-key length cap — all 400 before the database |

**The fixture's most important properties**, and why they are shaped that way:
`PIPELINE_GROUP = 7` is coprime with 1,000, so a group sharing one instant *must*
straddle a page boundary — the case that fails when `id` leaves the sort key, and
the suite asserts the boundary really falls mid-group so the test cannot pass
vacuously. And `replyIntent` (2,100) and `latestMessage` (2,140) have deliberately
**different** counts, so a test that read the wrong view cannot pass both.

### `tests/dashboardTolerance.test.ts` — the branch the live path cannot reach

Every tolerated relation exists in the Neon baseline, so on a correct deployment
the tolerant branch is dead code — and dropping a relation to reach it would need
DDL outside the ledger. So the behaviour is split and both halves are executed:
the adapter's classification live (above), and the handler's decision here, with no
database, driven by a store that raises what the adapter raises.

10 tolerated reads × 200 + `unavailable: true` + exactly one `console.warn` whose
payload is `DataStoreSchemaError/SCHEMA_OBJECT_MISSING` and never a driver message.
Three intolerable failures (authorization denial, statement timeout, connection
failure) still 500 **on a tolerated read**. Six non-tolerant reads 500 on an absent
relation. And malformed input never reaches the store at all.

### Mutation checks — what makes "264 / 132" mean something

Each mutation was applied, the relevant suite re-run, and the file restored with
`git checkout --`. The tree was verified byte-identical to `HEAD` afterwards
(`git diff HEAD` empty) and both suites re-run green.

| mutation | red | reading |
|---|---|---|
| `pipeline.eventLog` seek drops the `id` tiebreaker | **5 live** — the walk, the group-integrity test, the projection, the delta, and the allow-all | the coprime group straddling a boundary is what bites; the walk re-emits rows rather than skipping |
| conversation seek `>` becomes `<` | **1 static + 5 live** | the static guard catches a reversed seek with **no database** — the signature worth having, since the live failure mode is a non-terminating walk |
| `searches.saved` loses `tolerateMissingRelation` | **1 static** | and the tolerance suite silently shrank from 264 to 263 tests, because it is an `it.each` over the set — which is exactly why the *set* is asserted and not only the mechanism |
| driver translates 42703 instead of 42P01 | **1 live** — the isolated classification probe | the narrow SQLSTATE is asserted on its own, not as a side effect |
| `leads.notes` orders `created_at DESC NULLS LAST` | **1 live** — the test named for it | the nullable sort column is pinned directly |
| `followUpHistory` stops scoping by instance (SQL still valid) | **1 static + 1 live**, both named for it | scoping is asserted, not commented |

The last mutation was **done twice**: the first attempt left the SQL syntactically
broken, so its four live failures proved only that the tests notice a broken query.
Recorded because a mutation that breaks the code some other way measures nothing,
and the redone version — a tautology that keeps the parameter and drops only the
scope — is the one whose two failures mean something.

## Invariants confirmed

- **The browser is untouched.** `frontend/src/` has no diff. `DataContext.tsx`
  still fetches Supabase for all twenty reads, and the three component-local reads
  still use their own Supabase queries. S18 owns the switch.
- **`config.readPath` still defaults to `supabase`.** `NEON_READS_DEFAULT` was not
  set anywhere and the default was not flipped — an owner call, and one that cannot
  be taken for `leads` at all until the roster moves.
- **`leads` and `team_members` are still one unit, and the roster is still off this
  path.** No operation reads `team_members` or `team_roster`; asserted over all
  twenty-two. `public.team_roster()` still returns no `auth_user_id`, so
  `Team.tsx:236-239`'s "Login enabled" label still has no Neon source — unchanged,
  and still the roster session's.
- **Read-only end to end.** All thirteen additions are registered *queries*; the
  store runs them in `BEGIN READ ONLY`. `registerCommand` gained nothing, and the
  three identity commands remain the only writes and remain unreachable from this
  endpoint — asserted by name.
- **The function count is 12**, verified by listing `frontend/api/*.ts`. No 13th
  file, and no subdirectory trick — S17 recorded that trap and both S13 parts
  refused it.
- **The actor is resolved once per request** (B5) and passed down. Unchanged.
- **No SQL crosses the contract boundary.** Every new parameter is a value —
  an instant, a thread key, a uuid. No parameter names a column; the two column
  ladders were dropped rather than parameterized.
- **`ai_execute_sql` was not touched** and gained no write path.
- **No DDL, no migration, no ledger step.** Ledger artifacts `000`–`005`, the
  manifest and everything under `spikes/s16-identity/` are unmodified; the ledger
  static assertions are unchanged at 128 / 0.
- **No credential, connection string or provider resource identifier** entered the
  repository, a test, a fixture, a log line or this document. All 13 changed files
  were swept for connection-string, endpoint-id and JWT shapes: **0 hits**. The
  expired-token literal is assembled from fragments at runtime, following S11's
  precedent, and the one URL-shaped string in a test uses `example.invalid`.
- **No provider resource was created.** No project, branch, role, bucket or
  deployment. No `supabase db push`, no `sync-agent/deploy.sh`, no Vercel deploy,
  no `git push`.
- **The Supabase project was not read or written** by anything in this session.
- **No `set_config(..., false)` was executed anywhere**, in product code or in a
  probe. The throwaway plan probe used `NeonFixtureClient`, which publishes the
  actor transaction-locally, and it was deleted before the final runs. N-S13's
  pooled-session incident did not recur: `tests/dataStore.neon.test.ts` is green at
  33/33 in the final full run.

## Known limits

1. **`conversation_reply_intent` still truncates on the Supabase path**, which is
   the dashboard people are looking at. This session paginates the *new* path and
   reports the defect; it does not touch `DataContext.tsx`. See "The live defect".
2. **The `follow_up_events` `id`-only seek is still in the browser**
   (`FollowUpPanel.tsx:112`). Reported, demonstrated in a live test, not fixed —
   `frontend/src/` is out of scope for this part.
3. **The `messages` keyset index still does not exist**, carried unchanged from
   N-S13 Known limit 1. `messages (direction, sent_at DESC, id DESC)` would make
   part 2's keyset a real win as `messages_identity_key` already does for the
   conversation views. It needs a ledger step and an owner apply. Note the
   contrast: part 3's benefit needed no index because a suitable one already
   existed, which is a reason to check for one before writing a ledger step.
4. **The tolerant branch is untested against a *genuinely* absent relation.** It is
   driven directly with a raising store, and the adapter's classification is proved
   live — but no test has ever seen the endpoint answer a real missing table,
   because reaching that state needs DDL outside the ledger. This is the weakest
   evidence in the session and it is bounded: both halves are executed, just never
   in the same process.
5. **`rangedCampaigns` and `campaign_metrics` still disagree on
   `last_activity_at`** — pre-existing, on both providers, asserted as a divergence
   in part 2 rather than fixed. Untouched.
6. **The fixture is permanent.** 2,140 leads, 2,840 messages, 2,100 follow-up
   states, 120 follow-up events, 2,100 pipeline events, 26 notes and 13 library rows
   under `s13-rest` now live on the shared Neon project, joining S11's, S12's and
   part 2's. All synthetic, no tenant data, idempotent under re-run. Consequences
   for the next session: `pipeline_events`, `lead_notes`, `icps`, `hypotheses`,
   `saved_searches`, `icp_personas` and `icp_industries` are **no longer empty**,
   and several of them have no `instance_id` to scope by — filter the library
   relations by the `S13R` name prefix and `pipeline_events` by `actor`.
7. **The Neon suite mutates the shared project**, unchanged from S11: two
   concurrent runs would interfere, and `fileParallelism: false` protects a single
   runner rather than two developers. The suite is now ~168 s.
8. **No browser evidence.** Nothing in `frontend/src/` changed, so there was
   nothing to render. The first browser evidence for any of these reads belongs to
   S18.
9. **Parity is against seeded fixtures, not tenant data.** B2's copy is deleted and
   re-copying is a fresh owner decision. What is proven is that these operations
   agree with SQL over a controlled dataset — not that live dashboard figures match.
10. **The keyset measurement is one view at one scale.** 2,100 rows, one region,
    one afternoon. The ratio is the claim, not the milliseconds, and the plan is
    printed rather than asserted because the index choice is the planner's.
11. **`icp_personas` and `icp_industries` are proved by parent id, not by name.**
    They have no `name` this fixture controls (`icp_personas` has a `kind`), so
    those two assertions filter on `icp_id`. Narrower than the other four, and it
    was a real test bug caught by the first live run rather than by reading.
12. **C5 and the three Vercel identity env vars remain open from S17.** Untouched.

## Commits

| SHA | Subject |
|---|---|
| `56e45da` | `feat(neon): classify an absent relation as a contract error` |
| `c858ecd` | `feat(neon): serve the rest of the dashboard read slice` |
| `75dd7dc` | `test(neon): guard and cover the rest of the read slice` |
| *(this commit)* | `docs(neon): record S13 part 3` — this file. A commit cannot carry its own hash; `git log --oneline main..HEAD` resolves it. |

**Not pushed and not merged.** The branch sits at `d22bc47` + 4 commits; `main` is
unchanged and equal to `origin/main`. The owner was not asked to apply anything,
because this session wrote no migration. Nothing is deployed:
`NEON_DATABASE_URL` is still set in no Vercel environment, so nothing running reads
any of this.

## Exact starting point for S18

Review this branch and integrate it with `git merge --ff-only`. S13's scope row —
`DataContext` **and** component-local reads — is then complete: twenty-two
operations, one dispatching endpoint, and live coverage of all of them.

1. **Rewire `frontend/src/`.** `DataContext.tsx` and the three components
   (`ConversationDrawer.tsx`, `FollowUpPanel.tsx`, `LeadNotesPanel.tsx`) still read
   Supabase directly. The API side is done and the operation names are the
   vocabulary to call: `frontend/src/lib/neonActivity.ts` is the existing client
   fetch + cursor-walk helper to generalize.
2. **`unavailable: true` maps to `followUpsAvailable: false`.** That is why the
   marker exists rather than a bare `[]`; the library reads can ignore it.
3. **The roster moves with `leads`, or neither moves.** `team_members` must migrate
   first, with the source→target id map applied to `leads.assigned_to`,
   `conversation_follow_up_state.owner_id` and `follow_up_events.previous_owner_id`
   / `new_owner_id` — four columns now, not one. N-B2 has the map. A verbatim copy
   commits, misattributes, and warns about nothing. `public.team_roster()` also
   needs a login-presence column before `Team.tsx` can read it from Neon.
4. **Flipping `config.readPath` is an owner decision**, and it cannot be taken for
   `leads` until item 3 lands.
5. **Two browser defects are reported and unfixed**, both cheap and both
   independent of the migration: `conversation_reply_intent`'s missing pagination
   (`DataContext.tsx:636` — affects numbers on screen today) and
   `FollowUpPanel.tsx:112`'s `id`-only seek.
6. **The `messages` keyset index** (Known limit 3) needs a ledger step and an owner
   apply. Check for an existing index first — part 3's win came from one that was
   already there.
7. **Seed your own fixtures.** `s13-rest` and `s13-dashboard` are on the project
   today; that is a mutation of a shared database, not a contract. And the library
   relations are no longer empty — see Known limit 6.

`S18` must not edit ledger artifacts `000`–`005`, the manifest's existing entries,
or any file in `spikes/s16-identity/`.
