# N-S13 consolidation — two browser defects and the keyset's index

Three items were owed, all three are delivered, and the headline is a
**measurement that changes what you should be told**.

`conversation_reply_intent` really is read without pagination on the dashboard
running today — but the live view holds **177 rows**, not more than a thousand.
So the defect is **latent, not active**: nobody's post-P3 conversion rate is
currently wrong. It is fixed anyway, because it activates silently and the
runway is finite. The previous handoff said the truncation was happening; that
was inferred from the code and never counted. It is counted here.

`FollowUpPanel`'s `id`-only seek turns out to be latent twice over, for reasons
below. Also fixed.

Ledger step **006** is written and **not applied**. The owner runs it.

## Identity

| | |
|---|---|
| Base SHA | `0ad09b0`, which is `main` after the fast-forward this session performed |
| Branch | `codex/neon-s13-consolidation`, not merged, not pushed |
| Commits | `3e04ade` the two browser fixes · `acf506e` ledger step 006 · this document |
| Session | S13 consolidation (follow-up to `N-S13-part3.md`) |
| Predecessor | `docs/implementation-handoffs/N-S13-part3.md`, `N-S13.md`, `N-IDENTITY-LEDGER.md` |
| Gate carried | none. G2 was decided 2026-08-03 (`approved` / `conditional-go`) |

### Step 0, as required

`codex/neon-s13-part3-dashboard-reads` was reviewed and integrated with
`git merge --ff-only`. `main` moved `d22bc47 → 0ad09b0` — four commits, no
rebase, no squash, no cherry-pick. `main` is now **ahead of `origin/main`**, which
is where the previous session left it; nothing has been pushed.

### Changed files

```
frontend/src/lib/conversationPaging.ts                 new  the two extracted helpers
frontend/src/lib/DataContext.tsx                       ±29  paginated read, own promise
frontend/src/components/FollowUpPanel.tsx               ±7  lexicographic seek
frontend/tests/conversationPaging.test.ts              new  16 tests, the first src/ paging coverage
frontend/tests/dashboardSliceRest.neon.test.ts         +55  the expansion against the planted inversion
postgres/tenant-baseline/v1/006_messages_direction_seek_index.sql   new  the ledger step
postgres/tenant-baseline/v1/ledger.manifest.json       +8   step 6
postgres/tests/portable_migration_ledger_static_assertions.mjs  ±30  step 6 and the CONCURRENTLY guard
docs/implementation-handoffs/N-S13-consolidation.md    new  this document
```

Nothing under `frontend/api/`, `sync-agent/`, `supabase/migrations/`, `ops/` or
`spikes/s16-identity/` changed. Ledger artifacts `000`–`005` are byte-identical.
`frontend/api/` still holds exactly **12** top-level function files.

## Preflight corrections

**All five stated baselines matched**, measured on `0ad09b0` before any edit:

| Suite | Expected | Measured | Match |
|---|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** | yes |
| `npx vitest run` | 13 files / 264 tests | 13 files / **264 passed** | yes |
| `npm run test:neon` | 6 files / 132 tests, ~170 s | 6 files / **132 passed**, 173.66 s | yes |
| `cd ops && npm test` | 70 / 0 | **70 passed, 0 failed** | yes |
| ledger static assertions | 128 / 0 | **128 passed, 0 failed** | yes |

Three corrections to the brief's framing, none of them a wrong fact:

1. **`frontend/src/` does have test coverage.** The brief says "no test coverage
   at all". `tests/` already imports `../src/` in five files —
   `csvImport.test.ts`, `demographics.test.ts`, `leadPhotos.test.ts`,
   `replyIntent.test.ts`, `leadsRecompute.neon.test.ts` — covering
   `src/lib/leads.ts` and its neighbours. What has no coverage is
   `src/lib/DataContext.tsx` and every component, and there is a mechanical
   reason: `tsconfig.api.json`, which type-checks `tests/`, declares no `jsx`, so
   a test that imports a `.tsx` file fails the typecheck rather than the test run.
   That distinction is what shaped the approach to evidence — see below.
2. **`npm run build` is ~14 s warm, not ~5 minutes.** Part 3 measured 5 m 11 s and
   the brief carried that forward. `tsc -b` is incremental and this session had
   already run it, so the honest figure is "≈5 min cold, 14 s warm". Not a
   regression either way.
3. **The truncation is latent.** The brief was right that the previous session
   proved only the absence of pagination. See the next section.

## The measurement the brief asked for

Counted read-only through the AI SQL guard (`ai_execute_sql`, which is
`SELECT`-only and service-role-gated — reading through it for exactly this is
what it is for). Live production numbers, 2026-08-05:

| relation | rows | past the 1,000-row cap? |
|---|---|---|
| `conversation_reply_intent` | **177** | no |
| `conversation_latest_message` | 3,314 | **yes** — and it is paginated |
| `conversation_follow_up_state` | 17 | no — and it is paginated |
| `follow_up_events` | 41 | no |

Supporting figures, so "177" is not a number without a shape: `messages` carries
**497** inbound rows, **324** of them intent-labelled, across **177** distinct
conversations — which is exactly the view's row count, as it should be. Monthly
growth in newly-labelled conversations over the last six months runs 15 / 53 / 28
/ 34 / 48 / 8. At that rate the view reaches 1,000 rows in roughly **18 to 27
months**.

**What this means for the owner, stated plainly.** No displayed rate is wrong
today. The conversation universe is already 3,314, so the view lags only because
classification labels a subset; when it crosses 1,000 the read would have started
silently returning a *mixture* — the first thousand conversations answered by the
view and the rest falling back to the message cache's own derivation — with no
error, no marker and no way to notice from the screen. That is why it is fixed
now rather than scheduled.

## How items 1 and 2 were verified, given the coverage gap

This is the session's central risk and it was answered before the fix was
written, with option 1 from the brief plus a second half the brief did not
anticipate.

**A new module exists so that a test can reach the logic.** Both fixes' actual
content moved into `frontend/src/lib/conversationPaging.ts` — a plain `.ts` file,
which `tests/` can import without the `jsx` problem described above.
`isMissingRelation` moved with them, unchanged. What is left in `DataContext.tsx`
and `FollowUpPanel.tsx` is a call site each.

**`tests/conversationPaging.test.ts`, 16 tests, no database.** The supabase-js
query builder is stubbed by hand rather than with a mocking library: it is a
thenable that accumulates modifiers and returns itself, so a handful of chainable
methods recording their arguments reproduces every part of it these functions
touch — and *recording the arguments is the point*, because the defect was an
**absent** `.range()`, which no assertion about returned rows can catch on a
database that fits in one page. The stub throws on any method it does not
implement, so a read that quietly stopped ordering fails loudly.

**The PostgREST filter string was checked against real PostgREST, not assumed.**
The brief warned that a `timestamptz` carries `:` and `+`. Out of band, against
the live project with a service-role client: for one real conversation, a full
unpaginated ordered walk was taken as a baseline, then the same query was re-run
with the emitted `or(...)` filter — and it returned **precisely the tail of the
baseline**. Both the double-quoted and the bare form work; the quoted form is what
shipped, because it is PostgREST's documented escape for exactly those characters
and costs nothing. The `+` survives because supabase-js appends the filter through
`URLSearchParams`, which encodes it `%2B` rather than letting it decode to a
space — the emitted query string was inspected to confirm that, and a unit test
pins it.

**The skip is demonstrated on the fixture that already plants it.**
`tests/dashboardSliceRest.neon.test.ts` gained one live test: over `s13-rest`'s
planted `(occurred_at, id)` order inversion, the lexicographic expansion —
`occurred_at < ts OR (occurred_at = ts AND id < id)`, which is literally what the
`or(...)` filter compiles to — returns the row the `id`-only seek skips, and the
whole second page in order. The neighbouring test still shows the `id`-only
predicate skipping it. So the two halves are: *this logic does not skip* (live,
against a planted inversion) and *this filter string means that logic on real
PostgREST* (checked against live data). Neither is worth much alone, which is why
both were done — the same split part 3 used for its tolerant branch.

**Six mutations, each applied, run, and reverted** (`git diff` empty afterwards,
suite green again):

| mutation | red | reading |
|---|---|---|
| drop `.range()` — the original defect, restored | **5** | the fix's own regression test is the one that fires first |
| `break` after the first page | **4** | the walk, the boundary case and the range ledger all notice |
| return the accumulated prefix on a tolerated failure | **1** | the partial-result rule is pinned on its own |
| unquote the timestamp | **2** | including the URL round-trip assertion |
| seek on `id` alone again | **4** | the exact defect being fixed |
| drop the `ORDER BY` | **1** | an unordered `.range()` walk is not a walk |

**What is still unverified, and it is not small.** No browser was run. There is
no test that renders `DataContext` or `FollowUpPanel`, so the *call sites* — 29
changed lines in one and 7 in the other — are covered by `tsc -b` and by reading,
nothing more. `tsc -b` is a real tripwire for one specific mistake (an unused
import if a helper were dropped, since `noUnusedLocals` is on) and no tripwire at
all for a wrong argument. See Known limit 1.

## The design calls

### 1. The tolerance is **narrowed**, not preserved

The old read's error was excluded from the aggregate `error` `DataContext`
reports, and its rows were taken as `data ?? []` — so *any* failure silently
emptied the view and never failed the load. The brief asked for a deliberate
choice between preserving that exactly and narrowing it to a missing relation.

**Decision: narrow it. Only a missing relation (SQLSTATE 42P01, or PostgREST's
own `PGRST205`) yields `[]`. Everything else propagates.**

The argument that decided it is not about severity, it is about consistency
within one file. `fetchFollowUpData` already pages
`conversation_follow_up_state` and `conversation_latest_message` — the two
relations *of the same kind*, read *the same way*, ordered by *the same pair* —
and it already draws exactly this line: `isMissingRelation` yields
`available: false`, and a timeout or an RLS denial on either one already fails
the whole load. `conversation_reply_intent`'s blanket tolerance was not a policy;
it was a consequence of the read never having been written properly. Making it
behave like its two siblings removes an inconsistency rather than introducing
one.

Two things were weighed against that and lost:

- **The regression risk is real and bounded.** This is the most expensive read in
  the batch, and under the new policy a statement timeout on it fails a load that
  today would render. But a transient failure of that kind would equally hit
  `conversation_latest_message` in the same cycle, whose error *does* fail the
  load — so the exposure was already there and the asymmetry bought nothing. And
  the outer `catch` in `load()` calls `showError` and **keeps prior data**, so a
  failure on a refresh degrades to "stale numbers plus a visible banner", not a
  blank dashboard. Only a first load shows the error state.
- **An empty result here is not obviously wrong-looking.** `replyIntentMetrics`
  falls back to deriving P3 from the message cache when a row is absent, so `[]`
  produces a coherent, quieter answer rather than a zero denominator. That is
  precisely the argument for surfacing the failure: a coherent wrong number is
  the one nobody investigates.

**The bug class is closed under either branch**, which was the non-negotiable
part: a missing relation returns `[]` and discards whatever pages had arrived, and
any other error throws. A prefix is never returned. `fetchAllPipelineEvents` in the
same file still does return its accumulator on any mid-walk error — it is named in
the new module's header as the anti-pattern, and it is **not fixed here**
(Known limit 5).

### 2. The read moves out of `smallP` into its own promise

Mechanically forced — a paginating helper cannot sit in an array of query
builders — but it has a consequence worth stating: the read no longer produces a
`{data, error}` pair, so there is no longer an `error` field for someone to
forget to fold into the aggregate. The tolerance decision above is now expressed
in one place, in a function, with tests, instead of by omission from a `??`
chain.

### 3. Two helpers, one module, and why the module exists at all

`conversationPaging.ts` holds a fetch and a pure string function, which reads
like a grab-bag until you notice they are the same subject: how a
conversation-scoped PostgREST read gets past the server's 1,000-row response cap
without losing or repeating a row. One does it by counting, one by seeking.

The rejected alternative was **exporting the helpers from `DataContext.tsx`** and
testing them there. It does not work: `tsconfig.api.json` type-checks `tests/`
with no `jsx` setting, so importing a `.tsx` file breaks
`npx tsc -p tsconfig.api.json --noEmit` even though vitest would run it happily.
Adding `"jsx"` to that config to work around it would change how every API and
test file is checked, for the benefit of one import.

The other rejected alternative was **a shared generic `pageThrough` helper** for
all five paginated reads in `DataContext`. It is the better end state and it is
the wrong change here: four of those five work today, none is covered by a test,
and their error policies differ deliberately. Refactoring them under cover of a
bug fix is how a bug fix becomes an outage.

### 4. `CREATE INDEX`, not `CREATE INDEX CONCURRENTLY` — and the runner is why

**Read the runner before choosing**, the brief said. `applyStep` in
`postgres/tools/portable_migration_ledger.mjs` emits
`BEGIN; SET ROLE app_owner; <artifact>; SET ROLE app_owner; INSERT INTO app_ledger.applied_migration …; COMMIT;`.
One step, one transaction, so the schema change and its ledger row commit
together and a half-applied step can never look applied.

**So `CONCURRENTLY` is not expressible as a ledger step**: it cannot run inside a
transaction block, and the step would fail at apply time.

**And the runner should not be special-cased for it**, which is the decision
rather than the constraint. A `CONCURRENTLY` build that fails leaves an
`INVALID` index in the catalogue. The ledger is append-only and declares no down
migrations, so it cannot express "recorded, but the object is unusable" — the one
state it exists to make impossible. Trading that guarantee for a lock is the
wrong way round.

**The trade taken, and its size.** Plain `CREATE INDEX` holds a `ShareLock` on
`public.messages` and blocks writes for the duration, and the sync agent writes
that table on a cron from four notebooks. Measured rather than asserted: the same
`CREATE INDEX` took **102 ms** over 6,343 rows and produced a **272 kB** index.
Even an order of magnitude more rows leaves this well inside one sync interval.
The recommendation to the owner is still to apply it outside a sync window if
that is free to arrange, because a blocked write is a stalled agent run and the
agent's own retry is what recovers it.

### 5. The index survey was repeated, and the note held

Part 3's transferable lesson is that its own 27× win came from
`messages_identity_key`, which already existed. So `pg_indexes` was queried live
rather than trusted. **Nine** indexes exist on `public.messages` and none serves
an unpartial `(direction, sent_at DESC, id DESC)`:

| index | why it does not serve the seek |
|---|---|
| `messages_pkey` | `(id)` |
| `messages_identity_key` | leads with `(instance_id, profile_url)` |
| `messages_thread_latest_nonempty_idx` | carries the sort columns but is partial on a non-empty body and prefixed by `(instance_id, profile_url)` |
| `messages_inbound_sentiment_idx` | partial on `direction='in' AND sentiment IS NOT NULL`, and prefixed by `(instance_id, campaign_id, profile_url)` |
| `messages_intent_backlog_idx` | partial on the intent backlog |
| `messages_unclassified_idx` | partial on unclassified inbound |
| `messages_notify_pending_idx` | partial on the notifier's queue |
| `messages_campaign_sentiment_idx` | `(campaign_id)`, partial |
| `messages_updated_at_idx` | the delta watermark alone |

### 6. The measurement, with the numbers, and one that failed

Server-side `EXPLAIN (ANALYZE)`, p50 of 7 runs, **4,243 inbound rows** (6,343
total), using the operation's **verbatim** SQL from
`api/_lib/data/operations/messages.ts` wrapped the way the driver wraps it. Taken
inside a transaction that was **rolled back**, so no DDL was applied and no
ledger row written; the index's absence afterwards was re-checked from
`pg_indexes`.

| page | without the index | with the index |
|---|---|---|
| `OFFSET 0` | 4.71 ms | **0.85 ms** |
| `OFFSET 2000` | 5.80 ms | **2.01 ms** |
| keyset seek to row 2000 | 2.98 ms | **0.73 ms** |

**The benefit is demonstrable at this scale, and the plans are the finding.**
Every plan changes from `Seq Scan → Sort` (a top-N heapsort) to `Index Scan using
messages_direction_seek_idx`, and in the keyset case the ROW comparison becomes
an `Index Cond`:

```
Index Cond: ((direction = 'in'::text)
             AND (ROW(sent_at, id) < ROW('2025-11-20 09:00:00+00'::timestamptz, '1856'::bigint)))
```

where without the index it was a `Filter`. That is exactly the qualitative change
part 2 predicted and could not show.

**And the ratio is the claim, not the milliseconds.** Without the index, keyset
(2.98 ms) and the deep offset page (5.80 ms) are the same shape and the
difference is only that the ROW compare drops rows before the sort. With it, the
seek is **2.8× faster than the deep offset page** (0.73 against 2.01) — and the
offset's cost grows with the offset while the seek's does not, so that widens as
the relation does.

**A hypothesis that had to be tested and turned out to be wrong.** The operation
guards every predicate as `$n IS NULL OR …`, and a disjunction with a
non-indexable branch is a normal way to lose an index. It does not happen here:
the driver sends parameter values, PostgreSQL plans with them as constants and
simplifies the disjunction, so the `Index Cond` above is what the real query
gets. A control run with the guards written out by hand reached an `Index Only
Scan` at 0.27 ms — faster, but only because that control projects two columns
instead of seventeen, so it is not the operation's shape and is recorded as a
control rather than as a result.

**One measurement could not be taken, and it matters.** The plans are all from
`app_owner`, which is not subject to the `messages` RLS policy. `app_owner` is
deliberately **not** a member of `app_runtime` — `SET ROLE app_runtime` fails with
`permission denied` — so the credential that can create an index cannot assume the
role that reads under RLS, and the two cannot be combined in one transaction. The
policy references no column of `public.messages` (it gates on `app.actor_id` plus
two `EXISTS` probes against `users` and `team_members`), so it cannot constrain an
index scan on this key — but that is an argument from the policy text, not a
measurement. Known limit 3.

### 7. The step was dry-run, including both failure paths

Applied exactly as the runner would — `BEGIN; SET ROLE app_owner; <artifact>` —
with `COMMIT` replaced by `ROLLBACK`. The index was created, `indisvalid` and
`indisready` both true, the `COMMENT` present, and after the rollback
`pg_indexes` shows nothing. So the step is known to apply rather than believed to.

Its two prerequisite guards were driven to fire, because a guard that has never
raised is a comment:

| probe | result |
|---|---|
| artifact pointed at a relation that does not exist | raises `42P01`, naming step 001 |
| artifact pointed at a real relation lacking the three columns | raises `42703` |
| same, at a relation carrying all three | passes, no raise |

## Coverage and checks, with real numbers

| Check | Baseline | After |
|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** |
| `npx tsc -b` / `npm run build` | clean | **clean** (14 s warm; the pre-existing >500 kB chunk warning is unchanged) |
| `npx vitest run` | 13 files / 264 passed | 14 files / **280 passed** (+16) |
| `npm run test:neon` | 6 files / 132 passed, 173.66 s | 6 files / **133 passed** (+1), 188.99 s |
| `cd ops && npm test` | 70 / 0 | **70 passed, 0 failed** — unchanged |
| ledger static assertions | 128 / 0 | **144 passed, 0 failed** (+16) |

**The ledger assertion count grew, and here is exactly what added the 16**, as
the brief required:

| added | count |
|---|---|
| `pinned digest matches 006_messages_direction_seek_index.sql` | 1 |
| `006…sql is unchanged since its own session` + `…is pinned in the ledger at its published digest` | 2 |
| provider-marker, secret and resource-ID sweep of `006…sql` | 3 |
| the same three for this handoff document | 3 |
| `step 006 declares no role-bootstrap prerequisite, because an index needs none` | 1 |
| `step N contains no CONCURRENTLY…`, over all six steps | 6 |

One existing assertion was **edited, not added**: `manifest declares five steps`
became `manifest declares six steps in order 1 -> 2 -> 3 -> 4 -> 5 -> 6`. Net
`128 → 144`.

The `CONCURRENTLY` guard is asserted over **every** step rather than only 006, so
the next person who reaches for it has to change that line and read the reason
first. It is the cheapest available expression of design call 4.

## Invariants confirmed

- **`DataContext` was not rewired to the Neon read path.** Both fixes are in the
  Supabase path, in place. `config.readPath` still defaults to `supabase`;
  `NEON_READS_DEFAULT` is set nowhere. Nothing under `frontend/api/` changed.
- **No roster join anywhere.** Nothing in this session reads `team_members`,
  `team_roster`, `leads.assigned_to`, `conversation_follow_up_state.owner_id`, or
  `follow_up_events.previous_owner_id` / `new_owner_id`. The new module touches
  one view and one predicate; `FollowUpPanel`'s existing `owner_id` usage is
  untouched and stays in the source id space.
- **`frontend/api/` holds exactly 12 top-level function files**, verified by
  listing. No 13th, no subdirectory trick.
- **`ai_execute_sql` was not touched** and gained no write path. It was *used*, for
  the item-1 count, which is a `SELECT` through the guard as designed.
- **No `supabase db push`, no `sync-agent/deploy.sh`, no Vercel deploy, no
  `git push`.** `NEON_DATABASE_URL` is still set in no Vercel environment.
- **Ledger step 006 was not applied.** No `app_ledger` row was written. Every
  probe ran inside a transaction that ended in `ROLLBACK`, and the absence of the
  index was re-checked from `pg_indexes` afterwards each time.
- **Ledger artifacts `000`–`005` and the manifest's existing entries are
  unmodified.** Nothing under `spikes/s16-identity/` changed. The immutability
  assertion is green.
- **No provider resource was created** — no project, branch, role, bucket or
  deployment. The one temporary object was an in-transaction index and two
  `TEMP` tables, all rolled back.
- **No `set_config(..., false)` was executed anywhere**, in product code or in any
  probe. The one `set_config` in a probe passed `true` and was on a connection
  that never reached `SET ROLE app_runtime` anyway. N-S13's pooled-session
  incident did not recur: `tests/dataStore.neon.test.ts` is green in the final
  full run.
- **No credential, connection string or provider resource identifier** entered the
  repository, a test, a fixture, a log line or this document. All four throwaway
  probes were written under `frontend/` and deleted; the credential sweep over
  the ledger artifacts and this file is green.
- **The Supabase project was read and never written.** Two read paths were used:
  `ai_execute_sql` (`SELECT`-only by construction) and a service-role client
  issuing `select` only, for the PostgREST filter round trip.

## Known limits

1. **The two browser fixes have no browser evidence.** `tests/conversationPaging.test.ts`
   covers the extracted logic and the Neon suite covers the seek's semantics, but
   nothing renders `DataContext.tsx` or `FollowUpPanel.tsx`. Their call sites are
   covered by `tsc -b` and by reading. `vercel dev` was not run and no page was
   loaded. This is the weakest evidence in the session and it is stated here
   rather than implied by omission.
2. **The `or(...)` round trip was checked on data with no inversion and no second
   page.** Live `follow_up_events` holds 41 events across 17 conversations, the
   largest with 5 — so today the `append` branch is never reached at all, and a
   census found **0** `(occurred_at, id)` order inversions. The filter string is
   proved to parse and filter correctly on real PostgREST; the skip it prevents is
   proved on the Neon fixture. No single environment shows both.
3. **The index's benefit is measured without RLS.** See design call 6: the
   credential that can create an index cannot assume the role that reads under
   RLS. The policy cannot constrain the scan by inspection, but that is not a
   measurement. If the owner wants it closed, the way is to measure after the
   apply, from the runtime credential.
4. **`fetchAllPipelineEvents` still returns its accumulator on a mid-walk error.**
   The anti-pattern the new module is written against is still live, two functions
   above it, and a transient failure on page three still yields a silently short
   audit log and a confidently short funnel. Out of scope here; it is the same
   defect class as item 1 and deserves the same treatment.
5. **`conversation_reply_intent`'s truncation was latent, so nothing is being
   corrected.** No historical number needs restating and no backfill is implied.
   If the owner wants a tripwire rather than a fix that quietly holds, the count
   is 177 today and the threshold is 1,000.
6. **Step 006 is unapplied**, so nothing running benefits from it and no `pg_index`
   row exists. Until the owner applies it, part 2's keyset remains the shape
   without the payoff, exactly as before this session.
7. **006 is not in `PROTECTED_PATHS`**, on purpose and per the list's own comment:
   that check runs against the diff since the merge base, so a session's own new
   file would flag itself. It is pinned in `IMMUTABLE_BASELINE` at its published
   digest, which is the stronger of the two checks. Whichever session follows
   should promote it — **after** the owner has applied it, not before, because an
   unapplied step may still need a correction.
8. **`rangedCampaigns` and `campaign_metrics` still disagree on
   `last_activity_at`** — pre-existing on both providers, asserted as a divergence
   rather than fixed. Untouched.
9. **The tolerant branch on the Neon read path has still never seen a genuinely
   absent relation** (N-S13-part3 Known limit 4). Untouched.
10. **`public.team_roster()` still returns no `auth_user_id`**, so
    `Team.tsx:236-239`'s "Login enabled" / "Assignment only" label still has no
    Neon source. The roster session's.
11. **C5 and the three Vercel identity env vars remain open from S17.** Untouched.
12. **Eleven of the twenty-two read operations still have no caller.** By design
    until the switch session.

## Commits

| SHA | Subject |
|---|---|
| `3e04ade` | `fix(dashboard): paginate the reply-intent view and seek the whole sort key` |
| `acf506e` | `feat(neon): add ledger step 006, the message keyset's index` |
| *(this commit)* | `docs(neon): record the S13 consolidation` — a commit cannot carry its own hash; `git log --oneline origin/main..HEAD` resolves it |

**Not pushed.** `main` is at `0ad09b0` — four commits ahead of `origin/main` from
the fast-forward — and this branch is three further commits on top. Nothing is
deployed.

## Exact starting point for the next session

1. **Ask the owner to apply ledger step 006.** It is written, dry-run, and
   unapplied. The command is
   `node postgres/tools/portable_migration_ledger.mjs apply` with
   `NEON_MIGRATION_URL` (`~/.config/neon-identity-ledger.env`) in the
   environment — the `app_migration` principal, which is what the manifest
   requires. Expect `applied step 6` then `ledger consistent: 6/6`. Prefer a
   moment outside a sync window: it takes a `ShareLock` on `messages` for
   ~100 ms at today's size.
2. **Then promote `006` into `PROTECTED_PATHS`**, in the session *after* the
   apply, exactly as `004` and `005` were promoted. Not before — see Known
   limit 7.
3. **Then close Known limit 3** if it is worth closing: re-run the A/B from the
   runtime credential under RLS, with the index in place, and record whether the
   `Index Cond` survives the policy.
4. **`fetchAllPipelineEvents` is the remaining instance of the same defect
   class** (Known limit 4). It is a smaller change than item 1 was, and
   `src/lib/conversationPaging.ts` is now the place to put it and the test to
   copy.
5. **S18 is still the switch session** and its own starting point is unchanged —
   see `N-S13-part3.md` §"Exact starting point for S18", items 1 to 4. Both
   defects it listed as item 5 are now closed; item 6, the index, is written and
   waiting on the apply above.
6. **`leads` and `team_members` are still one unit.** Four columns carry
   source-space `team_members.id`; N-B2 has the id map. `config.readPath` cannot
   be flipped for `leads` until the roster moves.
7. **Seed your own fixtures.** `s13-rest` and `s13-dashboard` are on the shared
   Neon project (now 6,343 `messages` rows in total); that is a mutation of a
   shared database, not a contract.

**The next session must not edit** ledger artifacts `000`–`006`, the manifest's
existing entries, or any file under `spikes/s16-identity/`.
