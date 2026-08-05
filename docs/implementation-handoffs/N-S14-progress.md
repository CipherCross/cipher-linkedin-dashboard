# N-S14 — progress record, session stopped mid-flight

**This is not the S14 handoff.** The session was stopped by the owner before the
deliverable was finished, to switch models. This document records exactly what is
done, what is verified, what is verified *with numbers*, and what is owed — so the
next session resumes rather than restarts.

## Identity

| | |
|---|---|
| Base SHA | `0395eb7`, which is `main` after the fast-forward this session performed |
| Branch | `codex/neon-s14-non-ai-writes`, not merged, not pushed |
| Commits | none yet — all work is in the working tree (see "State of the tree") |
| Session | S14 (non-AI writes behind the data API) |
| Predecessor | `N-S13-consolidation.md`, `N-S13-part3.md`, `N-S17.md` |
| Gate carried | none |

## Step 0 — both items done

1. **`codex/neon-s13-consolidation` was integrated with `git merge --ff-only`**
   after the owner confirmed they had reviewed it. `main` moved
   `0ad09b0 → 0395eb7` — four commits, no rebase, no squash, no cherry-pick.
   `main` is now **8 commits ahead of `origin/main`**. Nothing pushed.
2. **`006` was promoted into `PROTECTED_PATHS`** in
   `postgres/tests/portable_migration_ledger_static_assertions.mjs`, and the stale
   header comment above `IMMUTABLE_BASELINE` (which said 006 "appears only here"
   and that a later session "should promote it") was corrected in the same edit.
   **The assertion count did not change: 144 passed, 0 failed**, exactly as the
   brief predicted.

## Recorded pre-edit baselines — all six matched the brief

Measured on `0395eb7` before any edit.

| Suite | Expected | Measured | Match |
|---|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** | yes |
| `npm run build` | clean | **clean**, 5.30 s warm | yes |
| `npx vitest run` | 14 files / 280 tests | 14 files / **280 passed** | yes |
| `npm run test:neon` | 6 files / 133 tests, ~190 s | 6 files / **133 passed**, 168.04 s | yes |
| `cd ops && npm test` | 70 / 0 | **70 pass, 0 fail** | yes |
| ledger static assertions | 144 / 0 | **144 passed, 0 failed** | yes |

No preflight corrections were needed to the numbers. The brief's *framing*
needed four corrections, below.

## Four corrections to the brief, each measured rather than reasoned

These change what the session is, so they are the most important thing in this
document.

### 1. Follow-ups are already atomic, already locked, already idempotent

The brief calls follow-up atomicity "the clearest win available in this session"
and says that on Supabase the state row and the event row "are separate PostgREST
calls". **They are not.** `/api/pipeline`'s six follow-up actions all call one
RPC, `public.apply_follow_up_action`, which is a single `SECURITY DEFINER`
function in baseline step `003`
(`postgres/tenant-baseline/v1/003_functions_triggers_ai_guard.sql:97`). Read it:
it takes `pg_advisory_xact_lock` on the thread key, checks `p_expected_revision`
optimistically, replays a repeated `p_mutation_id` after comparing a
`request_fingerprint`, and writes `conversation_follow_up_state` and
`follow_up_events` in one transaction. So `mutation_id` /
`request_fingerprint` are an **idempotent-replay** mechanism (a lost response is
re-answered with `replayed: true`), and all four of the spec's stopping-condition
words are already satisfied in SQL that travels with the baseline.

The port is therefore one `execute` of the same function, and what this session
owes for follow-ups is **proof that it still holds on Neon under `app_runtime`**,
not a re-implementation.

### 2. The real atomicity wins are elsewhere, and there are three of them

Where the Supabase path genuinely does split a mutation from its audit row across
independent calls, and reports the second one failing as a field inside a **200**:

| action | the pair | how failure is reported today |
|---|---|---|
| `set_stage` | `leads.pipeline_stage` + `pipeline_events` | `event_error`, HTTP 200 |
| `assign` | `leads.assigned_to` + `pipeline_events` | `event_error`, HTTP 200 |
| `set_gender` | `leads` demographics + `lead_gender_reviews` | `review_error`, HTTP 200 |
| `conversation_import` | `messages` + `leads` milestones | `milestone_error`, HTTP 200 |

`assign` is roster-blocked (below), so three are available. `pipeline_events` is
not a log the dashboard displays — it is what "ever reached stage X" is
*reconstructed* from — so a missing row permanently lowers a funnel number with
nothing recording that it is missing.

### 3. `/api/review-digest` writes no database at all

The brief's endpoint table lists it as "the weekly digest write". It has **zero**
`db()`, `.from(` or `.rpc(` calls: it validates a payload and posts to Slack. It
is not in this session's scope because there is nothing to move.

### 4. `/api/import`'s Airtable actions write Airtable, not Postgres

`companyImport.ts` (555 lines) and `contactImport.ts` (611 lines) have **zero**
`db()` calls between them — they read and write the Airtable REST API. Of
`/api/import`'s ten actions only three touch the database, all in
`conversationImport.ts`.

Also worth recording: `_lib/savedSearch.ts` and `_lib/icp.ts` are **validators
only**, zero database calls. Their apparent `db()` reference is a comment.

## The scope that was chosen, and the one gating measurement behind it

`app_runtime` **does** hold `INSERT, UPDATE, DELETE` on all 24 business tables
(`002_identity_roles_actor_rls.sql:112-137`), and every one of those relations
carries a `FOR ALL TO app_runtime` policy with a `WITH CHECK` that re-derives the
actor from `app.actor_id`. `apply_follow_up_action`, `delete_manual_message`,
`set_hypothesis_campaigns` and `admin_update_team_member` all have
`GRANT EXECUTE … TO app_runtime`. **So no ledger step and no new grant is needed
for any write in this session** — checked in the artifacts, not assumed.

`team_members`, `users` and `user_identities` are deliberately *not* in that DML
grant; their writes go through S17's `SECURITY DEFINER` functions.

### Moved to Neon — implemented, wired behind the flag, live-tested

| action | endpoint | why it can move |
|---|---|---|
| `set_stage` | `/api/pipeline` | actor is a text *name*, no roster id |
| `add_note`, `delete_note` | `/api/pipeline` | same |
| `set_gender` | `/api/pipeline` | keyed on `(instance_id, profile_url)` |
| `set_instance_config` | `/api/pipeline` | no actor reference at all |
| `conversation_import` | `/api/import` | no roster id |
| `edit_message`, `delete_message` | `/api/import` | no roster id |

### Registered but deliberately not routed

`conversations.applyFollowUpAction` — all six follow-up actions. Registered in the
operation allowlist and (still owed) to be proven live; **the endpoint does not
call it.** `p_owner_id` is a `team_members.id`, and while reads stay on Supabase
the browser supplies that integer from the *Supabase* roster, where the same
value denotes a different person (N-B2). Four of the six accept one directly and
the other two inherit it from a state row those four create, so the family cannot
be split — half of it on each provider would mean a conversation whose state and
events live in different databases.

### Left on Supabase, with the reason

| action | reason |
|---|---|
| `assign` | writes `leads.assigned_to`, a source-space `team_members.id`. Roster wall. |
| `add_member`, `set_member_active`, `invite_member`, `update_member` | the roster itself; S17 already owns `invite` / `setActive` / `setRole` as identity commands on `/api/identity`. Not this session's to duplicate. |
| the 13 `/api/playbook` actions | **not blocked — deferred, and this is the one place the session fell short of "everything that is not blocked".** See "What is owed", item 1. |
| `/api/review-digest`, company/contact import | write no database (corrections 3 and 4) |

## State of the tree

Nothing is committed. `git status --porcelain`:

```
 M frontend/api/_lib/conversationImport.ts
 M frontend/api/_lib/data/operations/index.ts
 M frontend/api/import.ts
 M frontend/api/pipeline.ts
 M frontend/tests/conversationImport.test.ts
 M postgres/tests/portable_migration_ledger_static_assertions.mjs
?? frontend/api/_lib/data/operations/conversationWrites.ts
?? frontend/api/_lib/data/operations/pipelineWrites.ts
?? frontend/api/_lib/data/writePath.ts
?? frontend/api/_lib/neonWrites.ts
?? frontend/tests/support/writeSliceFixture.ts
?? frontend/tests/writeSlice.neon.test.ts
```

`frontend/api/` still holds exactly **12** top-level function files.

### What each new file is

- **`api/_lib/data/writePath.ts`** — `deploymentWritePath(env)`, fail-closed on the
  exact string `neon` in `NEON_WRITES_DEFAULT`. Mirrors `deploymentReadPath` but is
  **never served to the browser and never overridable per session**: a wrong read is
  fixed by reloading, a wrong write is a row in the wrong database.
- **`api/_lib/data/operations/pipelineWrites.ts`** — 3 queries
  (`leadPipelineFields`, `leadDemographics`, `actorDisplayName`) and 7 commands
  (`setStage`, `appendStageEvent`, `addNote`, `deleteNote`, `setGender`,
  `appendGenderReview`, `setInstanceConfig`).
- **`api/_lib/data/operations/conversationWrites.ts`** — 2 queries
  (`leadForImport`, `threadDedupKeys`) and 6 commands (`lockThread`,
  `insertImportedMessages`, `backfillMilestones`, `editManualMessage`,
  `deleteManualMessage`, `applyFollowUpAction`).
- **`api/_lib/neonWrites.ts`** — the `neon` branch of each endpoint action.
  Validation is **not** repeated here; the endpoint validates and hands over
  checked values, so there is one definition of a legal stage.
- **`tests/support/writeSliceFixture.ts`** — the `s14-writes` fixture.
- **`tests/writeSlice.neon.test.ts`** — 32 live tests.

## Design calls already taken (with the rejected alternative)

1. **A pair of writes is two operations in one transaction, not one operation.**
   Rejected: a single CTE chain doing both writes — one round trip and equally
   atomic, but it puts two operations' SQL behind one allowlist entry, which is
   the coupling the named-operation registry exists to prevent. The cost (an extra
   round trip inside the transaction) **has not been measured yet** — see owed
   item 4.
2. **Dedup stays in JavaScript.** Rejected: expressing `normalizeForDedup` as
   `lower(btrim(regexp_replace(replace(body,E'\r',''),'\s+',' ','g')))`. It would
   be a *third* definition in a *different language*, Postgres and JS disagree on
   what `\s` matches and on non-ASCII `lower()`, and the failure mode is a doubled
   thread. `normalize` is passed into `neonImportConversation` as a function.
3. **The import takes `pg_advisory_xact_lock` on the thread key, reusing
   `apply_follow_up_action`'s exact expression** —
   `hashtextextended(jsonb_build_array(instance_id, profile_url)::text, 0)`. This is
   a **genuine improvement over the Supabase path**, not a port: today two
   concurrent pastes both read the same "already there" set, and because a manual
   row's `sent_at` is the real message time while a synced row's is the LH2
   action-run time, two pastes with different parsed instants are not identical
   rows under `messages_identity_key` and both survive. Two live tests cover it.
4. **The milestone backfill is `COALESCE(column, $n)` per column**, so "fill only
   what is missing" is structural rather than a JavaScript-built patch, and it
   agrees with the `leads_keep_milestones` trigger by construction —
   `COALESCE` cannot produce NULL from a non-NULL input. **The trigger is confirmed
   present in the portable baseline** (step `003`, line 620 / trigger at 908), as
   the brief asked.
5. **The audit row's actor name is read from Neon, keyed on
   `team_members.user_id` (the canonical uuid), never on the colliding bigint.**
   Rejected: reusing the Supabase principal's name, which would source a Neon
   write's audit trail from Supabase; and carrying the name in `ActorContext`,
   which would widen the one function that runs with no actor published.
6. **`setGender`'s SQLSTATE-42703 rolling-deploy fallback is dropped**, because
   the portable baseline has all four lifecycle columns in step `001` by
   construction (checked in `public.leads`) — there is no schema version the retry
   could rescue, and a branch that can never fire is a branch nothing tests.
7. **Authorization is `resolveRequestActor({ acceptLegacyBearer: true })`**, the
   same call `activity-daily.ts` makes. The role therefore comes from **Neon's**
   `team_members`, not from a Supabase read — strictly better than today.
8. **Two new operation modules rather than appending to `pipeline.ts` /
   `conversations.ts`**, whose headers are essays about read semantics. Write
   semantics are a different subject.
9. **`NeonWriteDeps` is an injected argument, not an env var** (S17's stated
   reason). It carries `store` and `legacyProviderName`. Every endpoint call site
   omits it.

### The ownership line against S15

`tools.ts`, `anomalies.ts` and `core.ts` were **not touched** — they are the AI
layer and S15's. `auth.ts` was **not modified**; it is only imported
(`authorizationResponse`, `AuthorizationError`). `db()` still lives in `core.ts`
and every existing Supabase call site is intact. The line drawn: S14 adds new
modules and branches inside two handlers; it does not restructure any shared
module the AI layer also uses.

## Verified, with real numbers

| Check | Baseline | Now |
|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** |
| `npx vitest run` | 14 files / 280 passed | **14 files / 280 passed** |
| ledger static assertions | 144 / 0 | **144 passed, 0 failed** |
| `tests/writeSlice.neon.test.ts` | — | **32 passed / 32**, run in isolation |

The 32 live tests cover: the flag's fail-closed parsing; unauthenticated (401),
inactive-member (403) and member-permitted writes; `set_stage`'s pair, its no-op
short-circuit, `pipeline_stage_changed_at` holding still for a substatus-only edit
and clearing on pipeline exit, and its 404; notes insert/404/delete/re-delete-404;
`set_gender` updating both rows of one person, snapshotting the prediction,
recording a **null** prediction when it overrode a human, and clearing; instance
config; import dedup by normalized body where the unique key cannot help,
milestone backfill, idempotent re-paste, `force`, instance mismatch; **two
concurrent-import lock tests**; and manual edit/delete including a synced row
being refused and left byte-identical.

**Three of them are the injected mid-transaction failure**, and they are the
strongest evidence in the session. Each swaps exactly one command in the *real*
`buildApplicationRegistry()` for one that issues
`DO $$ BEGIN RAISE EXCEPTION … END $$`, then asserts a **500** (not a 200 with an
error field) and reads the paired row back to show it absent:

| injected failure | asserted afterwards |
|---|---|
| `pipeline.appendStageEvent` | `pipeline_stage` still `first_contact`, `pipeline_stage_changed_at` still NULL, 0 `pipeline_events` |
| `pipeline.appendGenderReview` | `gender` still `male`, `demo_model` still `name-v1`, 0 `lead_gender_reviews` |
| `conversations.backfillMilestones` | 1 message (the fixture's), all three milestones still NULL |

### Two real defects the tests found in my own code

Both were in the fixture, both fixed: `leads` is unique on
`(campaign_id, profile_url)` so the two rows of one human need two campaigns; and
an `unnest` arity was one short of its column list.

## What is owed — the resume list, in order

1. **The `/api/playbook` slice: 13 actions, not blocked, not done.** This is the
   session's shortfall against "deliver everything that is not blocked". The work
   is real but mechanical, with one genuine design problem: `playbook.ts`'s
   `saveEntity(supa, table, bodyKey, …)` / `deleteEntity(supa, table, …)` are
   **generic over a table-name string** with a dynamic column set, which a
   named-operation allowlist cannot express as one entry. It needs one operation
   per (entity, verb) — roughly `save`/`delete` × `icp`, `icp_persona`,
   `icp_industry`, `hypothesis`, `saved_search`, plus `setHypothesisCampaigns`
   (an existing RPC), `assignSearch`, `saveCampaignContext` and the legacy
   playbook save. Decide and record how a partial-column UPDATE is expressed
   without a dynamic column list (a `COALESCE`-per-column statement is the
   obvious answer and matches design call 4).
2. **Contract tests against the fake store.** `tests/data/fake.ts` supports
   commands (`registerCommand` / `runCommand`); `tests/identity.test.ts` is the
   worked precedent. None written yet. The live suite is stronger evidence but
   slower and needs a credential, and the brief asked for both.
3. **The mutation pass.** Not started. Every earlier session in this migration ran
   one and reported a table of "mutation → tests red". The obvious candidates:
   drop the advisory lock; move the audit `execute` outside the transaction; swap
   `COALESCE(replied_at, $2)` for `$2`; dedup on the raw body instead of the
   normalized one; remove `AND source = 'manual'`; drop the no-op short-circuit.
4. **The round-trip cost of design call 1 is asserted, not measured.** The handoff
   must not claim a latency figure until it is measured. `EXPLAIN`-style timing of
   one paired write versus a CTE equivalent, p50 of several runs.
5. **`conversations.applyFollowUpAction` has no live test.** It is registered and
   unrouted. It needs the same treatment the read slice's unwired operations got:
   at minimum an apply, a replay of the same `mutation_id` returning
   `replayed: true`, and a stale `expected_revision` raising `40001` —
   all on the `s14-writes` fixture, where the roster ids are the fixture's own.
6. **Re-run the full set and record the deltas.** Only the three cheap checks and
   the new file in isolation have been run since the edits:
   `npm run build`, the whole `npm run test:neon` (was 6 files / 133; expect
   7 files / 165 with the new file), and `cd ops && npm test` (expect 70 / 0,
   untouched).
7. **`docs/implementation-handoffs/N-S14.md` itself**, in the structure the brief
   specifies, and it owes three things by name: which write actions moved and
   which stayed with the reason for each (drafted above); the atomicity evidence
   including the injected failure (done above, needs the measured latency);
   and where the `_lib` ownership line was drawn against S15 (drafted above).
   Then **delete this progress file** — it exists only because the session
   stopped early.
8. **Consider `SELECT … FOR UPDATE`** in `pipeline.leadPipelineFields`. The
   operation's own header states the remaining exposure: two concurrent stage
   moves can both read the same previous stage, and although the `UPDATE`'s row
   lock makes the second one block, its audit row is written from a value it could
   no longer have read. It is a one-word change and it wants its own concurrency
   test, which is why it was not taken blind.

## Invariants confirmed

- **`frontend/api/` holds exactly 12 top-level function files**, verified by
  listing. No 13th, no subdirectory trick.
- **`config.readPath` / `NEON_READS_DEFAULT` were not flipped** and `DataContext`
  was not rewired. Nothing under `frontend/src/` was touched at all.
- **`ai_execute_sql` was not touched** and gained no write path.
- **`app_runtime` gained no right it lacked.** No `GRANT` was issued, no ledger
  step written. The rights used were verified to exist in `002` and `003`.
- **The Supabase write path is intact.** Every existing call site still compiles
  and runs; `deploymentWritePath()` returns `supabase` for an unset environment,
  so the default behaviour of every action is byte-identical. `npx vitest run` is
  green at 280, which includes the pre-existing Supabase-path import tests.
- **Ledger artifacts `000`–`006` are byte-identical**, the manifest is unmodified,
  and nothing under `spikes/s16-identity/` changed. The only ledger-adjacent edit
  is `PROTECTED_PATHS` plus its comment, in the *test* file.
- **No `set_config(..., false)` anywhere.** The one advisory lock is
  `pg_advisory_xact_lock`, transaction-scoped, released by the server at
  COMMIT/ROLLBACK — chosen over the session variant precisely because the pooled
  endpoint reuses backends across clients.
- **No `supabase db push`, no `sync-agent/deploy.sh`, no Vercel deploy, no
  `git push`.** `NEON_DATABASE_URL` is set in no Vercel environment.
- **No provider resource was created** — no project, branch, role, bucket or
  deployment.
- **No credential, connection string or provider resource identifier** entered the
  repository, a test, a fixture, a log line or this document.

## Known limits so far

1. **The `s14-writes` fixture is left on the shared Neon project between runs
   only if a run crashes.** `afterAll` drops it and `beforeEach` resets it, but
   this is the first suite that commits, so a hard kill can leave rows. They are
   all scoped by `instance_id = 's14-writes'` and the five lead uuids are
   deterministic, so `dropWriteFixture` cleans them on the next run.
2. **No browser was run and no page was loaded.** The endpoint branches are
   covered by `tsc` and by the live suite calling the same functions the endpoint
   calls — not by the endpoint itself. A test that drives `POST /api/pipeline`
   end to end with the flag on does not exist.
3. **`safeErrorLabel` now has a third copy** (`api/activity-daily.ts`,
   `api/identity.ts`, `api/_lib/neonWrites.ts`). Consolidating it means touching
   files this session does not own; recorded rather than resolved.
4. **Carried forward untouched:** N-S13-consolidation's Known limit 3 (the RLS
   plan leaves ~2.6× on the table), `fetchAllPipelineEvents` still returning its
   accumulator on a mid-walk error, the `rangedCampaigns` /`campaign_metrics`
   `last_activity_at` disagreement, `public.team_roster()` having no
   `auth_user_id`, C5 and the three Vercel identity env vars from S17, and the
   eleven read operations with no caller.

## The next session must not edit

Ledger artifacts `000`–`006`, the manifest's existing entries, or any file under
`spikes/s16-identity/`. `006` is applied to the live project and is now pinned in
both `IMMUTABLE_BASELINE` and `PROTECTED_PATHS`.
