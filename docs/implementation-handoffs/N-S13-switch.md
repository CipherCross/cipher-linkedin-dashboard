# N-S13 switch — `DataContext` and the component reads move to the application API

The gap `N-S13-consolidation.md:495` records in one line — **"`DataContext` was
not rewired to the Neon read path"** — is closed. Twenty-two operations had
eleven callers between them; they now have twenty-two, asserted rather than
counted.

**The headline is a correction to the brief, and it saved the session's largest
piece of work.** Both the brief and `N-S18.md` say the switch will need an
`?op=`-dispatched endpoint folded into an existing Vercel slot. **It already
exists.** `frontend/api/activity-daily.ts` has been exactly that since S13 part
3, with all twenty-two reads allowlisted, per-operation tolerance and a
`config.readPath` flag lookup. Nothing under `frontend/api/` changed this
session and the function count never moved off 12. See "The correction" below.

Nothing is deployed, nothing is pushed, no flag is set. `NEON_READS_DEFAULT` is
unset everywhere, so every deployment still reads Supabase and the code path
that does so is byte-for-byte the queries it was.

## Identity

| | |
|---|---|
| Base SHA | `e7741f3` (`main`, "docs: close C5, and keep the smoke that closed it") |
| Branch | `codex/neon-s13-switch`, not merged, not pushed |
| Commits | `5104d94` the client and the switch · `6909580` the two suites · this document |
| Session | S13's frontend half — `DataContext` and component-local reads, spec slice row `S13` |
| Predecessor | `N-S13-consolidation.md`, `N-S13-part3.md`, `N-S18.md` |
| Gate carried | none. G2 was decided 2026-08-03 (`approved` / `conditional-go`) |

### Changed files

```
frontend/src/lib/dashboardReads.ts               new  +510  the read client, every decision
frontend/src/lib/DataContext.tsx                 ±308  two fetchers, one commit block
frontend/src/components/ConversationDrawer.tsx    +21  messages.thread
frontend/src/components/FollowUpPanel.tsx         ±39  conversations.followUpHistory
frontend/src/components/LeadNotesPanel.tsx        +17  leads.notes
frontend/tests/dashboardReads.test.ts            new  +488  31 tests, no network
frontend/tests/dashboardReadsRest.neon.test.ts   new  +342  13 tests, real handler + live Neon
frontend/tsconfig.tsbuildinfo                     ±2   tracked build artifact
docs/implementation-handoffs/N-S13-switch.md     new  this document
```

**Nothing under `frontend/api/`, `postgres/`, `supabase/migrations/`, `ops/`,
`sync-agent/` or `spikes/s16-identity/` changed.** Ledger artifacts `000`–`008`
and the manifest are byte-identical; step `008` remains written and deliberately
unapplied. `frontend/api/` still holds exactly **12** top-level function files.

## Preflight: all six baselines matched

Measured on `e7741f3`, on a clean tree, before any edit.

| Suite | Expected | Measured | Match |
|---|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** | yes |
| `npm run build` | clean | **clean**, 2.00 s | yes |
| `npx vitest run` | 17 files / 372 | 17 / **372 passed** | yes |
| `npm run test:neon` | 11 files / 254, 0 skipped | 11 / **254 passed**, 0 skipped, 385.96 s | yes |
| `cd ops && npm test` | 70 / 0 | **70 / 0** | yes |
| ledger static assertions | 165 / 0 | **165 / 0** | yes |

## The correction: the endpoint the brief asked for was already built

The brief's first constraint reads "Бюджет функций Vercel исчерпан: 12 из 12 …
Нужен один `?op=`-диспетчер, свёрнутый в существующий слот. Образец —
`frontend/api/identity.ts`". `N-S18.md`'s closing section says the same thing in
the future tense: "it will have to be an `?op=`-dispatched endpoint like
`identity.ts`, folded into an existing slot the way `reclassify.ts` was."

Both describe work S13 part 3 finished. `frontend/api/activity-daily.ts:248`
holds `READ_OPERATIONS`, a twenty-two-name allowlist keyed by `?op=`, with
per-operation parameter parsing, per-operation missing-relation tolerance, a
single actor resolution per request, and `config.readPath` dispatched before
authentication. Its own header explains why it is one function and why the path
still says `activity-daily`.

So the session's server-side work was **zero**, and the twelve-function budget
was never in play. `N-S18.md`'s "What the next slice is" was written against the
slice table rather than against the tree; this is the third time in this chain a
handoff's forward-looking section has not matched what was already committed
(N-S18 itself records the previous two). The rule that keeps catching it: a
handoff's "what is left" is a claim about the tree, and it is cheap to check.

One item the previous handoff *did* get right and which is now closed: ledger
step `006`'s promotion to `PROTECTED_PATHS`. `N-S13-consolidation.md` made it
"the first thing to do"; S14 did it, and S18 did the same for `007`. Both are in
`PROTECTED_PATHS` and `IMMUTABLE_BASELINE` today. Nothing was owed here.

## What moved, and what did not

`DataContext` performs **twenty** reads and the three panels perform one each.
Twenty-two of those twenty-three now have an operation and a caller.

| moved | operation |
|---|---|
| `instances`, `campaign_metrics`, `daily_activity`, `sync_runs`, `annotations`, `campaign_steps` | `instances.overview`, `campaigns.performance`, `activity.dailySeries`, `sync.recentRuns`, `annotations.timeline`, `campaigns.sequenceSteps` |
| `saved_searches`, `icps`, `icp_personas`, `icp_industries`, `hypotheses`, `hypothesis_campaigns` | `searches.saved`, `icp.profiles`, `icp.personas`, `icp.industries`, `hypotheses.list`, `hypotheses.campaigns` |
| `leads` (paged + delta) | `leads.directory` |
| `messages` inbound / outbound | `messages.inboundHistory` / `messages.outboundRecent` |
| `pipeline_events` | `pipeline.eventLog` |
| `conversation_follow_up_state`, `conversation_latest_message`, `conversation_reply_intent` | `conversations.followUpState`, `.latestMessage`, `.replyIntent` |
| `ConversationDrawer`'s thread | `messages.thread` |
| `FollowUpPanel`'s history | `conversations.followUpHistory` |
| `LeadNotesPanel`'s notes | `leads.notes` |

**One `DataContext` read did not move: `team_members`.** It has no operation and
must not get one yet — design call 4.

**Two page-local reads are outside the slice entirely and are named here because
they are a cutover blocker rather than a detail.** `Playbook.tsx:63` reads
`playbook` and `LeadsExplorer.tsx:244` reads `coaching_digest`, both straight
from Supabase. Neither is a `DataContext` read nor one of the three
component-local reads S13's scope row names, and **no operation exists for
either** — S13 parts 1–3 built twenty-two and these are not among them. They are
not touched here (widening the endpoint's vocabulary is not this session's), and
the consequence is stated in Known limit 3: with `NEON_READS_DEFAULT=neon` those
two surfaces would still read Supabase.

`AuthContext.tsx:389` also reads `team_members`, and that one is correct as it
is: it is the *Supabase authenticator's* own membership link, and the identity
path already has `session.current` instead. It is `VITE_AUTH_PATH`'s to retire,
not this session's.

## The design calls

### 1. Everything the path decides lives in a `.ts` module

`frontend/src/lib/dashboardReads.ts` holds the operation names, the flag
resolution, the page walk, the parameter construction for all twenty-two reads,
and the three component readers. `DataContext.tsx` and the three components hold
a call site each.

The reason is mechanical and it is the same one `conversationPaging.ts` records:
the default vitest run is `environment: 'node'` over `tests/**/*.test.ts`,
nothing renders, and `tsconfig.api.json` — which type-checks `tests/` — declares
no `jsx`, so a test importing a `.tsx` file fails the typecheck rather than the
test run. A rule that exists only inside a component is a rule this repo cannot
test. So the module is the surface the two new suites drive, and the call sites
are what remains uncovered (Known limit 1).

The rejected alternative was a React-rendering test setup — `jsdom`,
`@testing-library/react`, a `jsx` setting on the API tsconfig. It would change
how every API and test file is checked and add a dependency, to cover four call
sites that a switch statement's worth of logic. That is the right end state and
it is not a change to smuggle in under a migration slice.

### 2. The flag is asked for, once, and every failure means "stay put"

`config.readPath` is the server's own operation and the browser calls it like
any other read — except that it is unauthenticated by design, so it goes through
plain `fetch` rather than `authFetch`. Routing it through the authenticator
would make a dashboard on the *Supabase* path depend on reaching Neon
successfully just to be told to keep using Supabase.

**Every failure resolves to `supabase`**: a non-200, a body that is not the
expected enum, a network error, an endpoint that does not exist. Only the exact
string `neon` moves the browser — the same direction `deploymentReadPath()` and
`deploymentAuthPath()` take, and for the same reason: a build or a deployment
that fumbles the flag must keep the path that works.

Two consequences worth stating rather than discovering:

- **`npm run dev` is unaffected.** Vite does not serve `api/`, so the lookup
  404s and the SPA stays on Supabase. The dev loop needs no flag and no `vercel
  dev`.
- **It costs one round trip before the first load**, because the answer decides
  which fetcher runs and there is nothing useful to do concurrently. Memoized
  for the page's lifetime, so it is one request per session, not per load and
  not per component. Caching a *failed* lookup as `supabase` is deliberate:
  re-asking would let one session flap between providers — a five-minute refresh
  answering from Neon while an open drawer still reads Supabase — which is
  strictly worse than being consistently on the path that works.

### 3. One commit block, two fetchers

`load()` now resolves the flag, calls one of two fetchers, and commits. Both
fetchers return the same `Fetched` shape — plain arrays in the browser's own
types plus one nullable `error` string — so the delta merge, the pending-patch
replay, the follow-up patch replay and the reference-stability pass are written
once and cannot fork.

The Supabase fetcher is the old inline code **moved verbatim**: the same
thirteen queries in the same order, the same two column ladders, the same seven
reads whose errors are excluded from the aggregate, the same delta watermark.
The only edits are `supabase` → `supabase!` (it is no longer inside the
narrowing guard) and returning `data ?? []` instead of the `{data, error}` pair.
That is the part of this session that could break a dashboard in daily use, and
it is the part with the least new code in it on purpose.

### 4. The roster does not cross, so on the Neon path there is no roster

`fetchNeonDashboardData` sets `teamMembers: []`.

The hazard is N-B2's and it does not throw: `leads.assigned_to`,
`conversation_follow_up_state.owner_id` and `follow_up_events`'
`previous_owner_id` / `new_owner_id` are `team_members.id` values in whichever
provider's id space the rows came from, and the two spaces name different people
— source id 1 is the real admin, target id 1 is the immutable S06 fixture
"Active One". Reading leads from Neon while serving the roster from Supabase
would put a confidently wrong name on every owner chip, every follow-up task and
every CSV `assigned_to` column, and fail nothing.

**Decision: empty.** A missing name is a visible gap; a wrong one is not. The
alternative — carrying the Supabase roster across — is the one thing on this
path that would look like it worked. This is also, concretely, why the flag
cannot be flipped: it is not a defect to fix later, it is the roster session's
scope, and `leads` and `team_members` still move together or not at all.

### 5. The server's tolerance is the whole tolerance

The Supabase path excludes seven reads from the aggregate `error` and takes
`data ?? []`, so *any* failure on `team_members`, the six library relations or
the pipeline log silently empties them. `fetchAllPipelineEvents` goes further and
returns the pages it managed to collect when a page fails mid-walk.

**On the Neon path the client adds no tolerance of its own.** Ten operations
answer an absent relation with HTTP 200 and `unavailable: true`, which the client
turns into `[]` — and `followUpsAvailable: false` for the two follow-up
relations, which is the distinction that marker exists to preserve. Everything
else is an error: a walk that hits a failed page throws and **discards its
accumulator**, and a walk that will not terminate throws rather than answering
with what it collected.

This is narrower than today and the argument is the one design call 1 of
`N-S13-part3.md` made: a blank panel is recoverable, a plausible wrong number is
not. Its cost is bounded — `load()`'s outer `catch` calls `showError` and keeps
prior data, so a failure on a refresh degrades to "stale numbers plus a visible
banner". Only a first load shows the error state.

**The behaviour difference is real and is recorded rather than smoothed over**
(Known limit 8): with the flag on, a statement timeout on `searches.saved` fails
a load that today would render a blank Search Library.

### 6. What each read sends, and the three that are not obvious

- **The fetch asymmetry is enforced on both sides.** `messages.inboundHistory`
  is requested with no `from`/`to` at all, and the endpoint does not declare it
  `ranged`, so a window sent by mistake would be ignored rather than silently
  undercounting the all-time sentiment and P3 figures rendered beside all-time
  lead totals. `messages.outboundRecent` carries the 90-day floor and no upper
  bound, exactly as `.gte('sent_at', since)` does.
- **The delta watermark goes to exactly four reads.** `leads.directory` and the
  two message reads take `updated_since`; `pipeline.eventLog` takes
  **`occurred_since`**, because that relation has no `updated_at` at all — it is
  append-only, so its insertion time is its watermark, and the names are kept
  apart precisely where the two coincide. A unit test pins the set at four and a
  live test proves the endpoint binds it.
- **`sync.recentRuns` is one page of 200, not a walk.** The Supabase path spells
  the cap `.limit(200)`; here it is the page size and the first page is the
  answer. Following the cursor would fetch the entire run history to render the
  Health page's newest two hundred. A test asserts the walk does not happen even
  when the server reports `hasMore`.

### 7. The two column ladders die on the new path, and the drawer's is the worse one

Neither `LEAD_COLUMN_LADDER` nor `ConversationDrawer`'s three-rung retry is
reproduced. The argument belongs to the operations
(`api/_lib/data/operations/leads.ts`, `messages.ts`) and is not re-litigated
here, but the consequence is worth restating at the call site, which is where a
reader meets it: the drawer's middle rung silently drops `intent_level` and
`intent_reason` from every message in a thread, so an SDR triaging a
conversation would see no buying intent *because the query asked for none*. That
was a defensible trade while migration 047 was in flight; against a
ledger-applied baseline that already carries every column, it hides a broken
deployment from the person least able to detect it.

The Supabase branches keep their ladders untouched.

### 8. `FollowUpPanel` pages on the server's cursor and keeps its client seek

The Neon branch passes the endpoint's opaque cursor, which compiles to a ROW
comparison over the whole `(occurred_at, id)` sort key — so the seek and the
order cannot disagree, and the client holds no seek logic at all. The Supabase
branch still calls `followUpHistorySeek` from `conversationPaging.ts`, the
lexicographic expansion commit `3e04ade` added; it is untouched, and its 16 unit
tests still pass. The page size, previously the literal `50` in two places, is
now one `HISTORY_PAGE` constant both branches use, so the panel behaves
identically whichever answers.

## Coverage and checks, with real numbers

| Check | Baseline (`e7741f3`) | After |
|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** |
| `npm run build` | clean, 2.00 s | **clean**, 2.04 s (the pre-existing >500 kB chunk warning is unchanged) |
| `npx vitest run` | 17 files / 372 passed | 18 files / **403 passed** (+31) |
| `npm run test:neon` | 11 files / 254 passed, 0 skipped, 385.96 s | 12 files / **267 passed** (+13), 0 skipped, 372.06 s |
| `cd ops && npm test` | 70 / 0 | **70 / 0** — unchanged |
| ledger static assertions | 165 / 0 | **165 / 0** — unchanged, nothing under `postgres/` touched |

### `tests/dashboardReads.test.ts` — 31 tests, no network

The transport is injected and records every URL, because that is where this
module's decisions are: a walk that stopped early and a walk that never started
return the same rows. What it pins:

| assertion | why it earns its place |
|---|---|
| the client's operation set **equals** the endpoint's `READ_OPERATION_NAMES` | this is what closes "eleven of twenty-two reads have no caller", and it fails in both directions |
| no name anywhere matches `roster` / `team_members` / `team.` | design call 4, asserted rather than commented |
| the flag moves only for exact `neon`; malformed, non-200, non-JSON and network failure all resolve `supabase` | eight inputs, one direction |
| the flag is asked once per page load, including after a failure | the flap this prevents is invisible when it happens |
| a walk chains the server's cursor, and a later page carries the previous cursor | a walk resending its first query loops on page one |
| a failed page **throws**; `MAX_PAGES` **throws** | the prefix defect, both shapes |
| `unavailable` short-circuits with `[]` and no second request | |
| the nineteen dashboard operations are requested once each, and nothing else | |
| inbound carries no window, outbound carries `from` | the asymmetry, as a request |
| the watermark reaches exactly four reads, and the log's is `occurred_since` | |
| `sync.recentRuns` carries `limit=200` and is **not** walked even when told there is more | |
| `followUpsAvailable` is false if **either** follow-up relation is absent | |
| a 500 on any read — tolerated or not — fails the whole load | design call 5 |

### `tests/dashboardReadsRest.neon.test.ts` — 13 tests, real handler, live Neon

The injected transport **is the handler**: `createActivityDailyHandler` → the
real operation registry → the real driver → the real baseline RLS policies, over
the `s13-rest` fixture, with only the identity provider's JWT verification
stubbed as the sibling live suites stub it.

It exists because the unit suite cannot prove what it most needs to: a client
sending `updatedSince` instead of `updated_since` passes every recorded-query
assertion and then refetches the entire relation on every five-minute tick,
silently. Only a real endpoint can refuse it.

| assertion | result |
|---|---|
| the flag lookup answers **with no credential** | 200, `supabase` |
| `leads.directory` walked past the page cap | 2,140 rows, all distinct |
| both message directions walked and merged | 2,140 in + 700 out, non-increasing `sent_at` |
| the two conversation views keep their differing counts | 2,100 vs 2,140 — a client reading the wrong view could not pass both |
| `conversations.followUpState`, `pipeline.eventLog` | 2,100 and 2,100 |
| the six library relations | 3 / 1 / 2 / 3 / 2 / 2; `text[]` an array, `jsonb` an object |
| the outbound window binds, the inbound history does not | fewer than 700 outbound, exactly 2,140 inbound |
| the delta watermark **through `fetchNeonDashboard`** | 0 leads, 0 messages, 0 events; the unwatermarked relations still whole |
| `messages.thread` | both directions, oldest first, intent columns populated |
| the same profile on the wrong notebook | `[]` |
| `leads.notes` | 26 rows, the NULL-`created_at` note first, the rest strictly descending |
| `conversations.followUpHistory` paged on the cursor | `[50, 50, 20]` = 120, no duplicates, strictly descending across the fixture's planted `(occurred_at, id)` inversion |

### The mutation pass — including the two that measured nothing

Each mutation applied alone, the suite run, the file restored, `git diff` empty
afterwards and both suites green again.

**Unit suite (31 tests):**

| mutation | red | reading |
|---|---|---|
| the flag accepts any non-empty string | **2** | |
| a network failure resolves `neon` | **2** | the fail-safe direction is pinned on its own |
| the flag is re-asked instead of memoized | **1** | |
| a failed page returns the prefix collected | **2** | the defect class |
| the walk stops after the first page | **4** | |
| the walk resends its original query | **1** | the cursor-chain assertion is the tripwire |
| the watermark spelled `updatedSince` | **1** | |
| the inbound history windowed like the outbound | **1** | the asymmetry |
| the log sent `updated_since` | **1** | |
| `sync.recentRuns` walked | **1** | |
| `followUpsAvailable` keys on one relation | **1** | |
| one operation dropped from the vocabulary | **3** | the coverage guard fires first |
| a non-200 answered with an empty page | **4** | |

**Live suite (13 tests):**

| mutation | red | reading |
|---|---|---|
| the follow-up pager forgets the cursor | **1** | |
| the watermark spelled `updatedSince` — *the same mutation as above* | **1** | this is the pair that matters: both halves see one defect |
| the thread's two scope arguments transposed | **1** | |

**Two mutations were attempted first and measured nothing, which is recorded
because a mutation that proves nothing is worse than none.**

1. **The watermark mutation did not redden the live suite as first written.**
   The live test passed `updated_since` by hand to `readAll`, so it proved the
   *endpoint parses* the parameter while leaving the client free to send
   anything. The test was rewritten to drive `fetchNeonDashboard` — the actual
   caller — and the mutation then fired. That gap is exactly the one this suite
   exists to close, and it was open in the suite written to close it.
2. **The thread-scoping mutation added an unused parameter** instead of removing
   the scoping, so `instance_id` was still sent and nothing changed. Redone as
   an argument transposition (`instance_id: profileUrl`), which is the realistic
   defect, and it fired.

A third measurement is worth stating as a *negative* result: sending `from`/`to`
on `messages.inboundHistory` reddens the **unit** suite only. The endpoint does
not declare that read `ranged`, so it ignores the parameters rather than
refusing them — the asymmetry is safe by construction on the server and is
observable only in the request the client builds.

## Invariants confirmed

- **The Supabase path is unchanged in behaviour.** Its thirteen queries, two
  column ladders, five paginated walks, tolerated-error set and delta watermark
  are the same code, moved into a function. `NEON_READS_DEFAULT` is set in no
  environment, so `resolveReadPath()` answers `supabase` everywhere and no
  deployment executes a line of the new fetcher.
- **Nothing under `frontend/api/` changed**, and the function count is **12**,
  verified by listing. No new endpoint, no rewrite, no subdirectory.
- **No flag was set or flipped**: `NEON_READS_DEFAULT`, `NEON_WRITES_DEFAULT`,
  `NEON_AI_PATH_DEFAULT` and `VITE_AUTH_PATH` are all where S18 left them.
- **`acceptLegacyBearer` is untouched.** It is how the browser authenticates to
  this endpoint today, on either read path, and removing it is a cutover action.
- **No roster join anywhere.** Nothing in the new client reads `team_members` or
  `team_roster`, and the Neon path serves an empty roster rather than a
  cross-provider one. Asserted, not commented.
- **No DDL, no migration, no ledger step.** Artifacts `000`–`008`, the manifest
  and everything under `spikes/s16-identity/` are unmodified; `008` remains
  unapplied. The ledger static assertions are unchanged at 165 / 0.
- **`ai_execute_sql` was not touched** and was not used.
- **No `supabase db push`, no `sync-agent/deploy.sh`, no Vercel deploy, no
  `git push`.** `main` is unchanged at `e7741f3` and equal to `origin/main`.
- **No `set_config(..., false)`** anywhere, in product code or in a probe. The
  live suite uses `NeonFixtureClient`, which publishes the actor
  transaction-locally; `tests/dataStore.neon.test.ts` is green in the final run.
- **No credential, connection string or provider resource identifier** entered
  the repository, a test, a fixture, a log line or this document. The one
  URL-shaped literal in the new tests is `dashboard.example.invalid`.
- **The Supabase project was neither read nor written** by anything in this
  session.

## Known limits

1. **No browser was run, and the four call sites are the uncovered half.**
   Everything the path decides is in `dashboardReads.ts` and is measured; the
   branches inside `DataContext.tsx`, `ConversationDrawer.tsx`,
   `FollowUpPanel.tsx` and `LeadNotesPanel.tsx` are covered by `tsc -b` and by
   reading, nothing more. This repo cannot render a component in its test run
   (design call 1). This is the weakest evidence in the session.
2. **The Neon path shows no teammate names.** `teamMembers: []` — design call 4.
   Owner chips, assignee filters and the Supabase Team page lose their labels
   until the roster session migrates `team_members` with `leads` and applies
   N-B2's id map to the four columns that carry a member id.
3. **`playbook` and `coaching_digest` have no operation and are not switched.**
   `Playbook.tsx:63` and `LeadsExplorer.tsx:244` read Supabase unconditionally,
   on both paths. They are outside S13's scope row and outside the endpoint's
   twenty-two-name vocabulary; a cutover needs two more operations, two
   allowlist entries and their own tolerance decisions.
4. **`AuthContext.tsx:389` still reads `team_members` from Supabase.** Correct
   as it stands — it is the Supabase authenticator's membership link and the
   identity path already has `session.current` — but it means
   `VITE_AUTH_PATH=identity` and `NEON_READS_DEFAULT=neon` remain independently
   gated, and the combination has never been exercised anywhere.
5. **The flag costs one round trip before the first load.** Unavoidable while the
   flag is server-side by design: the answer decides which fetcher runs. One
   request per session, memoized, and it 404s harmlessly under `npm run dev`.
6. **Parity is against synthetic fixtures, not tenant data.** B2's copy was
   deleted the day it landed, so the live suite proves these reads agree with
   the fixture — not that any dashboard figure matches what the team sees today.
   Re-copying is a fresh owner decision.
7. **The first load issues nineteen concurrent walks.** Proven correct against
   the fixture's ~10k rows; never measured against live volume, where `leads`
   alone is tens of thousands of rows across four notebooks. The Supabase path
   fans out comparably, but not through a serverless function with a 10 s
   `maxDuration` per request.
8. **The Neon path's error policy differs from the Supabase path's** — design
   call 5. A failure on a library relation or the pipeline log now fails the
   load instead of silently emptying that panel. Deliberate, and a real
   behaviour change the moment the flag is flipped.
9. **`fetchAllPipelineEvents` still returns its accumulator mid-walk** on the
   Supabase path (`N-S13-consolidation.md` Known limit 4). Untouched. The new
   module is written against that anti-pattern and names it; fixing it there is
   still a four-line change nobody has made.
10. **`rangedCampaigns` and `campaign_metrics` still disagree on
    `last_activity_at`** — pre-existing on both providers. Untouched.
11. **The Neon suite mutates the shared project**, unchanged from S11: two
    concurrent runs interfere, and the new file re-seeds `s13-rest` through its
    own idempotent seeder rather than assuming another file ran first.
12. **The tolerant branch has still never seen a genuinely absent relation** on
    either side (N-S13-part3 Known limit 4). The client's half is driven with a
    fabricated `unavailable` response; reaching the real state needs DDL outside
    the ledger.

## Exact starting point for the next session

1. **Review this branch and integrate it with `git merge --ff-only`.** S13's
   scope row is then complete on both sides: twenty-two operations, one
   dispatching endpoint, twenty-two callers, and a flag that is off.
2. **The roster is the next blocking slice, and it is now the *only* thing
   between here and a flippable read flag apart from item 3.** `team_members`
   must migrate with `leads`, with N-B2's source→target map applied to
   `leads.assigned_to`, `conversation_follow_up_state.owner_id` and
   `follow_up_events.previous_owner_id` / `new_owner_id` — four columns.
   `public.team_roster()` also still returns no `auth_user_id`, so
   `Team.tsx:236-239`'s "Login enabled" / "Assignment only" label has no Neon
   source. Until then `teamMembers` is `[]` on the Neon path by design.
3. **`playbook` and `coaching_digest` need two operations** (Known limit 3)
   before `NEON_READS_DEFAULT=neon` means what it says. Both are small,
   single-relation reads; the shape to copy is `LIBRARY_OPERATIONS`.
4. **Flipping `NEON_READS_DEFAULT` is an owner decision and is not takeable
   yet** — not because of a defect here, but because the Neon project holds only
   synthetic fixtures. B2's tenant copy was deleted the day it landed.
5. **The first browser evidence for any of this is still owed** (Known limit 1).
   The cheapest useful version is `vercel dev` with `NEON_READS_DEFAULT=neon`
   against the fixture project: it would exercise the four call sites, the
   nineteen-way fan-out and the empty-roster rendering in one pass.
6. **Ledger step `008` remains written and unapplied**, declined by the owner on
   2026-08-06. When applied: through the ledger runner as `app_migration`, then
   promoted to `PROTECTED_PATHS` **and** `IMMUTABLE_BASELINE` in the same edit,
   with the step-count assertion bumped to eight.
7. **Seed your own fixtures.** `s13-rest`, `s13-dashboard`, `s11-contract` and
   `s12-activity` are on the shared Neon project. That is a mutation of a shared
   database, not a contract.

**The next session must not edit** ledger artifacts `000`–`008`, the manifest's
existing entries, `PROTECTED_PATHS`, `IMMUTABLE_BASELINE`, or any file under
`spikes/s16-identity/`.

## Commits

| SHA | Subject |
|---|---|
| `5104d94` | `frontend: read the dashboard through the application API, behind the flag` |
| `6909580` | `test: cover the read client, offline and against live Neon` |
| *(this commit)* | `docs(neon): record the S13 switch` — a commit cannot carry its own hash; `git log --oneline main..HEAD` resolves it |

**Not pushed and not merged.** `main` is at `e7741f3` and equal to
`origin/main`; this branch is three commits on top. Nothing is deployed, and
`NEON_READS_DEFAULT` is set in no Vercel environment, so nothing running reads
any of this.
