# N-B2 — the bounded tenant-data copy, the parity comparison, and its deletion

| | |
|---|---|
| Base SHA | `bcf3a4a` (`main`, "fix(neon): include the IdentityProviderError code in the safe log label") |
| Branch | `codex/neon-b2-tenant-slice` (see "Commits") |
| Phase | N4, between S17 and S13 |
| Mandate | `G2` owner decision (2026-08-03), `owner_decision.items[1]` — blocker `B2` |
| Applied to a live provider project | **yes** — 8,039 rows copied on 2026-08-05 under an approved written scope, and **deleted the same day** |

## What this session was for

`G2` rejected S12's cheapest option — ship S13 behind a flag and check parity at
cutover — on one argument: "deferring parity to cutover means the first
comparison of real numbers happens at the moment of highest cost to be wrong."
So B2 exists to make that comparison early, on a bounded slice, and then remove
the slice.

It is **data, not schema**. No ledger step was written, none was applied, and the
live project is still at `5/5`.

## Preflight: the brief's premises, corrected

Three of the brief's statements about the starting state were wrong. Two changed
the work.

1. **`origin/main` was already at `bcf3a4a`.** The brief said one commit was
   unpushed. It was not; nothing had to be carried.
2. **The ledger verifies at `5/5` with no `--allow-partial`** — confirmed, as
   the brief expected: `ledger consistent: 5/5 steps, order 1 -> 2 -> 3 -> 4 -> 5`.
3. **The live project did *not* hold "no business rows at all".** It held
   **7,911**: `events` 7,904, `leads` 3, `messages` 3, `campaigns` 1,
   `instances` 3. Every one is a synthetic fixture, under instances
   `notebook-test`, `s11-contract` (S11's contract set, 2,504 events) and
   `s12-activity` (S12's benchmark set, 5,400 events). No real data — but the
   copy was landing *beside* existing rows, not into an empty schema, and that
   turned out to matter twice: once for identity-column collisions, once for
   every count this session reports.

A fourth correction, to the brief's own framing: it says the copy must not
"create a second row" for the real admin's address in `team_members`. It cannot,
because **`team_members` is not in the approved scope and was never copied.** The
hazard that *did* materialise from that table was the opposite one, and worse —
see "The collision that would have worked and lied".

There is no `psql` on this machine. Every live read and write went through a
throwaway Docker `psql` wrapper built in the session scratchpad, which decomposes
a URL from `~/.config` into `PG*` variables. Nothing was written to the
repository and no connection string was printed. The wrapper's first form passed
the URL positionally and was silently overridden by the ledger runner's own
`--dbname`; that is why it exports `PG*` instead.

## The four things `G2` required in writing, and the owner's answers

`G2`: B2 "requires before it runs: an explicit written scope, approved by the
owner: which tables, which instance, how many rows, and how the copy is deleted
afterwards." All four were settled before a single row moved.

### 1. Scope — approved as `G2` proposed

| | |
|---|---|
| instance | `notebook-1` |
| excluded | `notebook-1:4`, the retired test campaign |
| tables | `instances`, `campaigns`, `campaign_steps`, `leads`, `messages`, `events` |
| row ceiling | **8,039** |

The exclusion is **satisfied by construction**: migration 038 already removed
`notebook-1:4` from the source, and it was measured absent from all five child
tables before the copy. It is still applied in code, because a scope that only
holds while a separate migration holds is not a scope.

### 2. Pseudonymisation — the owner chose **copy verbatim**

`G2` raised this and deliberately did not decide it. It was put to the owner as a
trade rather than a recommendation-in-disguise: the parity claim is about counts,
rates and day buckets, which depend on milestone timestamps, ids, stage columns
and the derived sentiment/intent columns — not on `messages.body`,
`leads.full_name` or `leads.headline`. Deterministic surrogates would have
yielded identical evidence with far less personal data on a new provider.

**The owner declined surrogates and chose to copy verbatim.** That decision is
the owner's, was taken against this session's stated recommendation, and is
recorded as such. Its cost is bounded by the deletion decision below: real
bodies and real names were on the new provider for roughly one hour.

### 3. Deletion — **before the end of this session**

Not "at S13 sign-off" and not open-ended. Written before the copy, performed
after the parity comparison, and proved rather than asserted — see "Deletion,
proved twice".

### 4. How the source read was authorised

`SUPABASE_SERVICE_ROLE_KEY` was not on this machine. The owner chose to have the
already-authenticated CLI issue it rather than mint a new secret. It was written
to `~/.config/neon-b2-supabase.env` at mode 600, outside the repository, and used
only for reads. **The source was never written to.**

## The collision that would have worked and lied

This is the session's most important finding, and it is not about B2.

`leads.assigned_to` is a `bigint` foreign key to `team_members(id)`. Those ids
denote **different people** on the two sides:

| id | source | target |
|---|---|---|
| 1 | the real admin | S06 fixture "Active One" (`member`, immutable) |
| 2 | a real member | S06 fixture "Active Two" (`admin`, immutable) |
| 3 | a real member | S06 fixture "Inactive Three" (`member`, inactive, immutable) |
| 4 | a real member | *(free)* |
| 5 | a real member | the real admin, from S17's bootstrap |

Copying `leads` unchanged would have **succeeded**. Every foreign key is
satisfied, every type matches, no constraint fires. And 113 real leads would have
been attributed to a fixture that the live contract suites assert is an ordinary
member. That is the dangerous failure mode: not the copy that breaks, but the
copy that commits and misreports.

**Owner decision, 2026-08-05:** remap `1 -> 5` — the same real person on both
sides, 113 leads — and, for the one assignee with no counterpart on the target,
null the attribution rather than widen the scope by a seventh table. That
affected **8** leads of 1,713. The remaining 1,592 were already unassigned.

The tool refuses any assignee outside its written map rather than guessing;
that refusal is what surfaced the second assignee, after the first load attempt
had already been authorised. Extending the map is a scope decision, not a code
change.

**The full attribution, recorded here so it survives the copy's deletion:**

| source assignee | leads | disposition in the copy |
|---|---|---|
| 1 | 113 | remapped to target id 5, the same real person |
| 3 | 8 | nulled — no counterpart on the target |
| (none) | 1,592 | already unassigned on the source |

The source retains the real attribution; it was never written to. Nothing was
lost anywhere except in a copy that no longer exists.

### What this means for the actual cutover — read this before S13 or any migration session

The collision is **not specific to B2**. Any future migration of `leads` carries
it, and so does every other reference to `team_members`. Three requirements
follow, none of which are in B2's scope and none of which are yet met:

1. `team_members` must migrate **before** `leads`, with an explicit
   source-id → target-id map applied to every referencing column.
2. The three S06 fixtures occupy ids 1–3 and **cannot be deleted** — the live
   contract suites assert them by id and role
   (`portable_identity_atomic_invite_assertions.sql` asserts fixture 1 is *not*
   an admin). So the real roster cannot simply take its source ids.
3. A cutover that copies `assigned_to` verbatim will silently misattribute work.
   It will not fail. It will not warn. This is the single most likely way for the
   migration to lose information while every check stays green.

## What was copied, and how much

| table | rows | ids preserved |
|---|---|---|
| `instances` | 1 | yes |
| `campaigns` | 4 | yes |
| `campaign_steps` | 66 | yes (composite key) |
| `leads` | 1,713 | yes (uuid) |
| `messages` | 3,702 | **yes** — measured free |
| `events` | 2,553 | **no** — re-keyed, see below |
| **total** | **8,039** | at the approved ceiling exactly |

`messages.id` and `events.id` are `GENERATED ALWAYS` identity columns. Their real
values were preserved wherever the target's own pre-existing fixture rows left
them free, and re-issued where they did not — decided inside the load transaction
from the rows actually present, and announced either way:

```
b2: messages kept its source id values
b2: events re-keyed; 419 source id values were already taken by pre-existing rows
```

`events` collided because the S11/S12 fixtures occupy ids 1–25,432 while 1,922 of
the copied events sit below 10,000. Nothing has a foreign key to either column,
so a re-keyed event is the same row for every purpose this copy serves — and the
`daily_activity` parity below is computed **over `events`**, so a re-key that had
disturbed anything a metric reads would have shown up there.

The whole load is one transaction. Rows arrive through `ON COMMIT DROP` temp
staging tables rather than straight into the target, because the assignee remap
has to happen *before* the row exists: an `UPDATE` afterwards would fire
`touch_leads_updated_at` and rewrite a copied value.

## The parity comparison — the point of the session

Computed from the **two sides' own aggregate views**, not from the extract.
Comparing the extract to the load would only prove the copier is self-consistent;
this compares the number the dashboard would actually show.

**`campaign_metrics`, 4 campaigns, every cell agreeing:**

| campaign | leads | invites | accepted | replies | acceptance | reply rate |
|---|---|---|---|---|---|---|
| `notebook-1:1` | 230 | 223 | 61 | 19 | 26.9 | 31.1 |
| `notebook-1:2` | 1,066 | 995 | 369 | 137 | 35.2 | 37.1 |
| `notebook-1:3` | 393 | 384 | 72 | 17 | 18.5 | 22.2 |
| `notebook-1:5` | 24 | 22 | 7 | 1 | 31.8 | 14.3 |

**`daily_activity`, 409 day/event-type buckets, every cell agreeing.**

```
Parity: 10 passed, 0 failed
```

Values are compared as strings after normalising the only two shapes a JSON
reader and a SQL reader legitimately disagree about — numeric type and timestamp
precision. A real difference in a count or a rate survives both normalisations.

**There is no difference to explain.** Every row count, every metric cell and
every day bucket matched on the first comparison and again on the second.

## Deletion, proved twice — and reproducibility with it

The owner authorised a full cycle rather than a single delete, so that
reversibility and reproducibility are demonstrated rather than claimed:

| step | result |
|---|---|
| 1. delete | all 8,039 removed; every table back to 0 inside the scope |
| 2. verify the target | fixtures intact: `s11-contract` 2,504, `s12-activity` 5,400, `messages` 3, `leads` 3, `team_members` 4 |
| 3. re-load from the same extract | 8,039 again, **the same 419 id collisions** |
| 4. verify parity again | **10 passed, 0 failed** — identical |
| 5. final delete | all 8,039 removed |

**The end state, measured on the live project after step 5:**

```
instances 3 | campaigns 1 | campaign_steps 0 | leads 3 | messages 3
events 7904 | team_members 4
sequences: events=25432  messages=3
```

That is exactly the state measured before the session began, sequences included.
Reversibility extends to the generators the load moved forward: `delete` winds
each one back to the rows that remain, so a deleted copy leaves no trace in the
sequence either.

The deletion is scoped identically to the load — same predicate, same exclusions
— so it cannot reach a row outside the approved instance, and the fixtures are
untouched by construction rather than by care.

## What already existed and was used rather than rebuilt

The ledger runner and the five applied baseline steps were used unchanged and not
extended. No step `006` was written. `frontend/api/_lib/data/` was not touched —
B2 does not read through the application API, deliberately: the parity claim is
about the *database*, and routing it through S13's unfinished read path would
have made a failure ambiguous between the two.

## The tool

`postgres/tools/b2_tenant_slice.mjs` — `extract`, `load`, `verify`, `delete`,
`counts`. The approved scope is a **constant in the file**, not a flag, so the
scope and the code that copies it cannot drift apart and `delete` removes exactly
what `load` wrote.

It is deliberately **not** added to `S08_ARTIFACTS` in the static assertions.
That list is swept for `PROVIDER_MARKERS`, and this tool would fail that sweep by
doing its job — it bridges two providers by definition. Adding it would have
meant either weakening the sweep or lying about what the file is. It is still
swept for credentials and resource identifiers, by hand and with a canary, and
contains neither: every endpoint, key and connection string arrives from the
environment.

Two defects the tool's own guards caught, both recorded in the file rather than
quietly fixed:

1. **The extract truncated every table over 1,000 rows to its first page.**
   Without `Prefer: count=exact` the source reports its total as `*`, so the
   pager could not tell a full page from the last one. Wall-clock success hid it
   completely — three of six tables were silently short. It is now caught twice:
   the header is sent, and the extract counts its own CSV data rows (honouring
   quoting, because message bodies contain newlines) and refuses to write a file
   whose row count disagrees with the source's exact count.
2. **The assignee guard fired on a second, unmapped assignee** after the first
   had been approved, which is how the 8 leads were found at all rather than
   after the fact.

## Invariants confirmed

- **The running dashboard still works.** No file under `frontend/src` or
  `frontend/api` changed. `DataContext` is untouched and remains S13's. S14's
  writes and S15's AI handlers are untouched. The source project was read from
  and never written to.
- **The immutable baseline is intact.** `001`–`005` byte-identical at their
  published digests. **`005` was added to `PROTECTED_PATHS`** this session, as
  S17 asked and could not do itself. `supabase/migrations/` untouched.
- **No ledger step was written or applied.** The live project is at `5/5`,
  verified before and after, with no `--allow-partial`.
- **The AI SQL guard is not loosened and gains no write path.** Its file, owner,
  grant and statement filter are unchanged, and nothing in this session touched
  `ai_execute_sql` or any role granted to it.
- **The three S06 identity fixtures are unedited and undeleted.** `team_members`
  still holds 4 rows; fixture `…0001` is still a `member`.
- **`spikes/s16-identity/**` unchanged.** Suites still 8 files / 62 tests and
  1 file / 6 tests.
- **`ops/` and `sync-agent/` untouched.** `ops` still 70/0.
- **No credential, connection string or provider resource identifier entered the
  repository.** Canary-verified: a fake connection string and a fake JWT were
  planted in a changed file, the sweep caught both, and they were removed.
- **No deployment of any kind.** No `supabase db push`, no `sync-agent/deploy.sh`,
  no Vercel deploy.

## Checks

| Check | Baseline | Now |
|---|---|---|
| `frontend && npm test` | 11 files / 128 tests | **11 / 128**, 0 failed |
| `frontend && npm run test:neon` | 3 files / 61 tests | **3 / 61**, 0 failed — *after* the fix below; it was 60/61 on arrival |
| `frontend && npm run typecheck:api` | clean | **clean** |
| `frontend && npm run build` | clean | **clean** |
| `ops && npm test` | 70 / 0 | **70 / 0** |
| `portable_migration_ledger_static_assertions.mjs` | 128 / 0 | **128 / 0** |
| `portable_migration_ledger_tests.sh` | 19 / 0 | **19 / 0** |
| `portable_identity_write_path_cleanroom.sh` | 18 / 0 | **18 / 0** |
| `portable_identity_atomic_invite_cleanroom.sh` | 23 / 0 | **23 / 0** |
| `spikes/s16-identity && npm test` | 8 files / 62 tests | **8 / 62** |
| `spikes/s16-identity && npm run test:neon` | 1 file / 6 tests | **1 / 6** |
| `git diff --check` | clean | clean |
| Secret sweep with canary | — | passed, canary caught |

**The static assertions did not move**, which is the correct outcome: this
session added neither a baseline function nor a ledger step. Adding `005` to
`PROTECTED_PATHS` extends one existing aggregate check rather than adding one.

### One baseline did not match on arrival, and it was not B2's doing

`npm run test:neon` was **60/61**, not the 61/61 the brief recorded.
`identityStore.neon.test.ts` asserted the live identity store was empty
(`{user: 0, session: 0, account: 0, verification: 0}`).

That premise died on **2026-08-04 at 11:44 UTC**, when S17's first-admin
bootstrap wrote one `user` and one `credential account` — the same event this
brief flagged as ending the "no tenant data" status. The brief noticed the
consequence for four documents and not the consequence for this suite. Two live
`session` rows dated 09:38 UTC on 2026-08-05, from the owner signing in, were
also present. Row-creation timestamps were read from the live store to prove the
failure predates this session rather than assuming it, and B2 touched no identity
table at all.

**Owner decision, 2026-08-05: fix it by strengthening the assertion.** The test's
real intent was never "the store is empty" but "these calls wrote nothing", so it
now captures the row counts in `beforeAll` and asserts they are unchanged. That
is true again, survives a populated store, and is a strictly stronger claim.

A second assertion in the same file had the same defect and was **green only by
luck**: `prunes nothing, because the store is empty` asserted `toBe(0)`. Sessions
expire after 12 hours (S17's deliberate `expiresIn`), so the two sessions created
that morning would have expired the same evening, at which point the test would
have gone red *for correct behaviour* — and would have deleted rows from a live
store while claiming to be read-only. It now asserts what is actually guaranteed:
pruning removes expired rows and only those, with the count carried into the
final check instead of assumed to be zero. The file's header claim that the store
"is empty" was corrected for the same reason.

This is the only file outside B2's own scope that this session changed, and it
was changed on an explicit owner decision after the baseline mismatch was
reported rather than absorbed.

## The four documents whose status claim expired

`G2` listed four documents asserting the Neon project "holds no tenant data, and
none has ever been copied", and predicted that would stop being true "the moment
the B2 session runs".

**The prediction was wrong about the date and about the cause.** The status ended
on **2026-08-04**, one session earlier, when S17's first-admin bootstrap wrote a
real person's name and email into `public.team_members` — real tenant data
arriving through the *identity* path rather than the data path, which is why a
set of documents about business data did not anticipate it. B2 then ran on
2026-08-05 as planned.

The lesson worth carrying: "no tenant data" was being tracked as a property of
the data migration, when it is a property of the project.

All four are corrected, with dated annotations rather than rewrites where they
are historical records, following the treatment `N-S11.md` and `N-S11-phase1.md`
were already given once:

| document | treatment |
|---|---|
| `docs/platform-ops/g2-datacontext-migration-go-no-go.json` | four new dated keys: the mutation record, the parity evidence, B2's outcome (scope, decisions, what could not be carried verbatim, the cutover finding) and the recommendation |
| `docs/implementation-handoffs/N-S12.md` | four dated annotations, including one that records its own prediction failing |
| `docs/implementation-handoffs/N-S11.md` | a second dated annotation, superseding the first outright |
| `docs/implementation-handoffs/N-S11-phase1.md` | same treatment, same reason |

The JSON was verified to be a **strict superset** of its previous content —
nothing removed or altered, 30 nodes added — because the edit reflowed some
compact arrays and that had to be proved harmless rather than eyeballed.

## What this copy does **not** cover

1. **One instance of four.** `karina-1` and the other two notebooks were never
   copied. Parity is evidence about `notebook-1` only.
2. **Two views of seven.** `campaign_metrics` and `daily_activity` were compared.
   `pipeline_metrics`, `campaign_reply_intent`, `campaign_reply_sentiment`,
   `conversation_latest_message` and `conversation_reply_intent` were not.
3. **No write path.** Reads only, in one direction. Nothing here says anything
   about the sync agent writing to Neon.
4. **Not the client-side derivations.** `frontend/src/lib/leads.ts` recomputes the
   same funnel for date ranges the views cannot express (`rangeTotals`,
   `rangedCampaigns`, `stageOf`, `riskOf`). Those were **not** compared. The two
   SQL views agreeing does not prove the client recompute agrees.
5. **`team_members`, and therefore assignee semantics.** Out of scope, and the
   collision above is unresolved for cutover.
6. **A moment in time.** The source is live and syncs continuously. These numbers
   are 2026-08-05; `notebook-1:2`'s `last_activity_at` was that morning.
7. **The copy no longer exists.** Every number here is reproducible from the tool
   and the source, but nothing on Neon can be re-inspected without re-running it.

## Known limits

1. **`events` ids are not the source's.** 419 of 2,553 collided with pre-existing
   fixture ids, so the whole table was re-keyed. Nothing references
   `events.id`, and `daily_activity` parity is computed over `events` and
   matched — but a future check that joins on a source event id will not find it.
2. **Verbatim copy means real bodies and names were on the new provider**, for
   about an hour, by owner decision against this session's recommendation. Backup
   retention on the provider is not something this session can inspect or attest
   to; if the provider takes point-in-time backups, the slice may persist in them
   beyond the deletion proved here. **That is an open question for the owner and
   the deletion above does not answer it.**
3. **The extract was deleted at the end of the session**, along with the copy.
   It lived only in the session scratchpad, outside the repository; it was never
   committed and must not be. Re-creating it is one `extract` away, from the same
   approved scope — but that is a fresh owner decision, not a standing
   permission.
4. **`SUPABASE_SERVICE_ROLE_KEY` is now on this machine**, at
   `~/.config/neon-b2-supabase.env`, mode 600. It is a bypass-RLS credential. It
   should be deleted when no longer needed; nothing in this repository reads it.
5. **The 8 nulled attributions are recorded only in this document.** They are
   intact on the source, which is authoritative.
6. **`team_members.email` still has no unique constraint** — carried forward from
   step 004's limit #4 and S17's limit #9. B2 did not touch `team_members`, so it
   neither worsened nor fixed this.
7. **Parity was measured once, on one day.** It is not a regression test and
   nothing re-runs it. If S13 needs continuing assurance, that is a harness
   somebody has to build.

## Commits

| SHA | Subject |
|---|---|
| `cf42f8c` | `feat(neon): add the B2 bounded tenant-slice copy, parity and deletion tool` |
| `dc12535` | `test(neon): protect ledger step 005 from later edits` |
| `0626f3e` | `test(neon): assert the identity store is unchanged, not that it is empty` |
| `7ee2827` | `docs(neon): record that the Neon project's no-tenant-data status has ended` |
| *(this commit)* | `docs(neon): record B2` — this file. A commit cannot carry its own hash; `git log --oneline main..HEAD` resolves it. |

## Exact starting point for S13

Start from `main` with this session merged. The live Neon project is at ledger
`5/5`, holds the three S06 fixtures plus one real admin in `team_members`, holds
the S11/S12 synthetic fixtures, and holds **no tenant business data** — the B2
slice was deleted.

What B2 hands S13:

1. **Parity is no longer a blocker.** `G2`'s B2 is closed. Real numbers were
   compared and matched. S13 may build its reads knowing the two databases agree
   on `campaign_metrics` and `daily_activity` for `notebook-1`.
2. **The tool is committed and reusable.** If S13 wants real numbers to develop
   against, `extract` → `load` reproduces the slice from the same approved scope,
   and `delete` removes it. **Re-copying is a fresh owner decision each time** —
   the scope constant records what was approved, not a standing permission.
3. **Do not copy `leads.assigned_to` verbatim, ever.** See "What this means for
   the actual cutover". This is the finding most likely to be lost, because
   nothing fails when it is ignored.
4. **B4 is still open and still precedes S13.** `G2` inserted a session for the
   `SECURITY DEFINER` roster function, and S13's reads need it — any join
   resolving an assignee or owner name returns NULL without it. B2 did not do it
   and must not have: it is a schema change, and the ledger is the only
   sanctioned apply path.
5. **The client-side recompute in `frontend/src/lib/leads.ts` is unverified**
   against Neon. Item 4 of "What this copy does not cover". S13 touches exactly
   that code, so it is S13's to check.

`S13` must not edit `001`–`005`, the manifest's existing entries, or any file in
`spikes/s16-identity/`.
