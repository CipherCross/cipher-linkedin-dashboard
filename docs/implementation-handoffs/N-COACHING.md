# N-COACHING — the last two reads move, and the read flag starts meaning what it says

`playbook` and `coaching_digest` were the two relations `N-ROSTER.md` Known limit
5 named: read from Supabase **unconditionally, on both paths**, so a dashboard
with `NEON_READS_DEFAULT=neon` still opened a Supabase connection for the
Playbook page and for the Leads Explorer's digest panel. They are on the flag
now. Twenty-three reads became twenty-five, and no read on either page reaches
past the application API any more.

## Identity

| | |
|---|---|
| Branch | `codex/neon-coaching-reads`, on `main` at `e857159` |
| Merged in first | `codex/neon-roster` → `main` by `git merge --ff-only`, as N-ROSTER § "Exact starting point" item 1 asked |
| Pushed | **no.** `origin/main` is still `e7741f3`; eight commits from the two previous sessions plus this session's are unpushed. A push deploys production |
| Ledger step | **none needed** — see below |
| Migration | none |

### The `.gitignore` line, committed

N-ROSTER § "The uncommitted `.gitignore` line" left `+.env*` in the working tree
and called committing it the owner's call. It is committed here **on its own**,
untouched, as the first commit of the branch. The reasoning is that handoff's:
the repository root holds a real `.env.local` whose first line is
`# Created by Vercel CLI` and whose contents begin with a `VERCEL_OIDC_TOKEN`,
and while the ignore rule lives only in the working tree, a `git checkout .`
removes the only thing keeping that token out of git. Nothing else in the commit.

## Preflight: all six baselines matched

Measured on `e857159`, before any edit.

| Suite | Expected | Measured | Match |
|---|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** | yes |
| `npm run build` | clean, ~2 s | **clean**, 2.02 s | yes |
| `npx vitest run` | 19 files / 421 | 19 / **421 passed** | yes |
| `npm run test:neon` | 12 files / 273 | 12 / **273 passed**, 375.10 s | yes |
| `cd ops && npm test` | 70 / 0 | **70 / 0** | yes |
| ledger static assertions | 165 / 0 | **165 / 0** | yes |

### `test:neon` needs three credential files, not one

`neon-datastore-driver` in the assistant's memory names
`~/.config/neon-s11-datastore.env` alone, and with only that file **two of the
twelve files fail at import** — `identityStore.neon.test.ts` and its sibling
raise from `readIdentityConfig`, and the run reports 10 passed / 2 failed / 222
tests rather than 12 / 273. The whole run needs:

```bash
set -a && . ~/.config/neon-s11-datastore.env \
       && . ~/.config/neon-s17-identity-store.env \
       && . ~/.config/neon-s15-ai.env && set +a
npm run test:neon
```

That is not a change anything in this slice made; it is a baseline that reads as
a regression if you source one file and compare against a handoff that sourced
three.

## The decision the slice had to make: one new operation, not two

`coaching_digest` had no operation and got one. **The playbook already had one**
— `AI_WRITE_OPERATIONS.coachPlaybook`, which `/api/coach` uses to ground its
analysis — and this slice **borrows that name rather than declaring a second**.

That is the roster slice's rule applied a second time: the dashboard needed the
same row `/api/identity?op=team.roster` already returned, so `identity.teamRoster`
was served from the read endpoint too, because *a second spelling of one read is
a second thing to keep correct*. The playbook is the same shape of question with
a sharper answer: it is a **singleton**, one row in the entire database, and two
SQL statements over one row is two places a column can be forgotten.

Three things follow, and each is in the code rather than only here:

* **The projection widened by one column.** `coach.playbook` now selects
  `content, updated_at`. The coach reads `content` and declares its own narrow row
  type at the call site (`coach.ts:434`), so it neither sees nor cares about the
  addition; the Playbook page's header renders `updated_at` as "last saved".
* **`ORDER BY id` was added**, and it is ornamental on its own terms —
  `playbook_singleton` is a CHECK that `id` is true, so there is at most one row.
  It is there because the read endpoint wraps every query in `LIMIT/OFFSET` and
  `dashboardSlice.test.ts` asserts "orders its rows" across the whole slice. An
  exemption for one operation would have been a hole in a guard that is cheap to
  satisfy honestly.
* **Being registered never made an operation reachable.** The endpoint's
  allowlist is a list precisely so that the registry — which also holds the AI
  layer, the business writes and the three identity admin *commands* — is not a
  surface. Allowlisting a name that lives in `aiWrites.ts` is what the list is
  for, and the two are still the only AI-module names on it.

### No ledger step, and the reason is the grant table

Both relations are in the baseline's first artifact
(`001_portable_business_baseline.sql:113` and `:386`), `GRANT SELECT ON ALL
TABLES IN SCHEMA public TO app_runtime` covers them, and each carries a
`FOR ALL TO app_runtime, app_readonly` active-member policy
(`002_identity_roles_actor_rls.sql:316` and `:511`). Unlike `team_members`, which
needed `public.team_roster()` because its policy restricts `app_runtime` to the
caller's own row, these two are readable as tables by any active member. Nothing
to widen, so nothing to apply.

## What changed

| file | change |
|---|---|
| `api/_lib/data/operations/coaching.ts` | **new.** `COACHING_OPERATIONS.digests` = `coaching.digests`, one query over `public.coaching_digest` ordered on its primary key |
| `api/_lib/data/operations/aiWrites.ts` | `coachPlaybookOperation` projects `updated_at` and orders by `id`; the header note records the second caller |
| `api/_lib/data/operations/index.ts` | imports, re-exports and registers `coaching.digests`; a comment states why the playbook needs no second registration |
| `api/activity-daily.ts` | two allowlist entries, neither tolerant, neither parameterized |
| `src/lib/dashboardReads.ts` | `READ_OPS.playbook`, `READ_OPS.coachingDigests`, `fetchNeonPlaybook`, `fetchNeonCoachingDigests`, `PlaybookDocument` |
| `src/pages/Playbook.tsx` | `load()` branches on `resolveReadPath()` |
| `src/pages/LeadsExplorer.tsx` | the digest effect branches, and fills the panel's error slot on the Neon path |
| `tests/dashboardSlice.test.ts` | 23 → 25, both names in the intolerant enumeration, both definitions in `READ_SLICE` |
| `tests/dashboardReads.test.ts` | 23 → 25, the two reads named page-local rather than part of the load, four new client tests |
| `tests/dashboardReadsRest.neon.test.ts` | a live block for both, seeded and restored |

## The design calls

### 1. Page-local, not part of the dashboard load

Neither read joins `fetchNeonDashboard`. The playbook is one page's entire
content and the digest panel is **collapsed by default** on another, so folding
either into the first load would pay for a request on every dashboard open that
most opens do not use. `dashboardReads.test.ts` asserts the load requests exactly
twenty of the twenty-five and names these two in the page-local list, so moving
one into the load later has to be written as a decision.

### 2. Neither tolerates a missing relation, and the playbook is the sharp case

Ten reads answer an absent relation with `items: []` and `unavailable: true`.
These two do not, and the argument is not symmetry with the library — it is what
the page does with an empty answer.

`Playbook.tsx` keeps `loadError`, and **the editor is disabled while it is
non-null**. That lock exists so an admin cannot type into a blank box and Save a
fragment over the real playbook. An `unavailable` marker rendered as an empty
document would clear the error, unlock the editor, and reintroduce exactly the
failure the lock was written for. The digest panel has its own error slot for the
same reason the thread and the notes reads are intolerant.

Both tables are in the baseline's first artifact, so on this provider the
tolerant branch would be unreachable in a correct deployment anyway; the point is
that the *wrong* setting here is one word and would be silent.

### 3. `null` is the unwritten singleton, and a throw is the failure

`fetchNeonPlaybook` returns `PlaybookDocument | null`. Zero rows means nobody has
written a playbook — the table ships with no seeded row — and the page renders
that as an empty editor on its placeholder, which is what `maybeSingle()` already
produces on the Supabase path. A failure is a rejection, never `null`. Three
offline tests pin all three outcomes apart, because collapsing the middle one
into either neighbour is how the editor lock gets defeated.

### 4. The digest read is walked, not capped

Same reason as the roster. The panel looks up `digests[instance.id]` for every
instance the dashboard knows about, so a first-page answer would leave the
accounts past the cap indistinguishable from ones whose digest has never been
computed. It is one row per notebook — four on this team — so the walk is one
request in practice.

### 5. The Neon branch fills an error slot the Supabase branch never did

`LeadsExplorer`'s existing read destructures `{ data: rows }` and **discards the
error**, so a failed digest read has always rendered as "no digests computed
yet". The Neon branch sets `digestErr` instead, which the expanded panel already
renders. This is a small, deliberate divergence in the same direction as the rest
of the path: fewer silently-empty answers. The Supabase branch is left exactly as
it was — narrowing a working path was not this slice's job.

### 6. No write refusal, and that is a fact about the ids rather than an omission

The roster slice needed `rosterWrites.ts` because `team_members.id` denotes
different people on the two providers. Nothing here carries a member id.
`coaching_digest.instance_id` is a notebook id — `notebook-1` and friends,
written by the sync agent and identical in both databases — so a digest row read
from Neon and a `/api/coach` recompute landing in Supabase name the *same*
account. What the split costs is freshness, not correctness; see Known limit 2.

## Checks, with real numbers

| suite | before | after |
|---|---|---|
| `npx vitest run` | 19 files / 421 | **19 / 435** (+14) |
| `npm run test:neon` | 12 / 273 | **12 / 276** (+3) |
| `tests/dashboardReadsRest.neon.test.ts` alone | 19 | **22**, 24.16 s |
| `cd ops && npm test` | 70 / 0 | **70 / 0** |
| ledger static assertions | 165 / 0 | **165 / 0** |
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** |
| `npm run build` | clean | **clean**, 2.06 s |

### The offline tests, and what each would catch

`tests/dashboardReads.test.ts`, four new:

* the playbook read sends **`op` and nothing else** — a parameter added to a
  singleton read is a way to ask for less than the page needs;
* an empty page answers **`null`**, not an empty document;
* a 500 **rejects** with the operation named, which is the assertion the editor
  lock depends on;
* the digest read **walks**, proved by a two-page transport.

`tests/dashboardSlice.test.ts` — the tripwires, edited rather than widened: the
count in the test name went 23 → 25 with both names spelled out, both operations
joined `READ_SLICE` (so they are subject to the read-only, ordered, roster-free
and member-id assertions the whole slice carries), and both were added to the
enumeration of reads that **must not** be tolerant.

### Live, through the real endpoint (+3)

Seeded inside the new block rather than in `dashboardRestFixture`, because
neither belongs to the shared load and the playbook has nothing to scope by:

* the digest row is inserted for `s13-rest` and **deleted** afterwards;
* the playbook singleton is read, overwritten with a marker and **put back** —
  the same discipline `librarySlice.neon.test.ts` already applies to the same
  row. If the project had no playbook, the restore deletes rather than leaving an
  empty string, because absence and emptiness mean different things to the page.

What the three assert: the playbook comes back with a parseable `updated_at`
(the column that would still pass every offline test if the projection dropped
it), `patterns` crosses as a **JS array** rather than a JSON string (`.map` in
the panel would throw on the latter), and both reads **401 without a
credential** — the flag lookup is still the only unauthenticated operation on
the endpoint.

## Invariants confirmed

* `config.readPath` is still the one unauthenticated operation; both new reads
  401 anonymously, asserted live.
* The endpoint is still read-only end to end — both new entries are registered
  *queries*, and `store.query()` runs in `BEGIN READ ONLY`.
* No read on the endpoint mentions `team_members`, `team_roster`, `assigned_to`
  or `owner_id` except the three that are named as permitted; both new operations
  are in the checked set.
* Every read is ordered, and both new ones order on a column that is unique by
  constraint (`coaching_digest.instance_id` is the primary key; `playbook.id` is
  a singleton CHECK).
* The ten-read tolerance set is unchanged.
* `/api/coach`'s use of `coach.playbook` is unchanged in behaviour — it reads
  `content`, and the added column is ignored at its call site.

## Known limits

1. **No browser run this session.** The two previous sessions verified their
   `.tsx` call sites against a scratchpad Vite harness driven by a browser; this
   session had **no browser driver available**, and Playwright is not a
   dependency of this repository. So the two page branches are covered by
   `tsc -b`, by the live suite exercising the client functions they call, and by
   nothing that opened them. This is the *only* verification the previous two
   slices had that this one does not, and it is the reason to run one before the
   flag is flipped rather than after.
2. **Three flags, and the coaching pair now spans all three.** Reads follow
   `NEON_READS_DEFAULT`, the playbook Save follows `NEON_WRITES_DEFAULT`
   (`/api/playbook` → `deploymentWritePath`), and Recompute follows
   `NEON_AI_PATH_DEFAULT` (`/api/coach` → `deploymentAiPath`). With reads on Neon
   and either of the others on Supabase, a save or a recompute **appears to
   work** — both handlers answer 200 and the page updates from the response —
   and the change is gone on the next reload, because the read comes from the
   other database. No wrong data, no wrong person: just a write that lands
   somewhere invisible. It is N-ROSTER Known limit 3 pointed at two more pages,
   and another reason the read flag is not flippable alone.
3. **The call sites are still uncovered by a repeatable suite.** Unchanged from
   N-ROSTER Known limit 1: `tsconfig.api.json` declares no `jsx`, so a test
   cannot import a component. Everything the path *decides* is in
   `dashboardReads.ts` and is tested; the two `if ((await resolveReadPath()) ===
   'neon')` branches are not.
4. **`VITE_AUTH_PATH=identity` and `NEON_READS_DEFAULT=neon` remain
   incompatible.** Unchanged from N-ROSTER Known limit 4 and untouched here.
5. **Parity is against synthetic fixtures.** Unchanged. The digest this suite
   reads is one row it wrote itself, and the playbook is a marker string.
6. **The Neon suite mutates the shared project**, and this slice adds a
   singleton to the list of things it mutates. The restore is in `afterAll`; a
   run killed mid-file leaves the marker playbook in place, and re-running the
   suite does **not** repair it — the next `beforeAll` records the marker as the
   value to restore. If a run is interrupted, check
   `SELECT content FROM public.playbook` before trusting it.
7. **`coaching_digest` has no `updated_at` and no touch trigger.** Its freshness
   column is `computed_at`, written by `/api/coach`. Nothing here depends on
   that, but a delta-refresh watermark cannot be added to this read later without
   a schema change.

## Exact starting point for the next session

1. **Review this branch and integrate it with `git merge --ff-only`.** `main` is
   at `e857159` locally and **not pushed**; twelve commits are now unpushed. A
   push deploys production.
2. **Every read is on the flag.** `NEON_READS_DEFAULT=neon` now means what it
   says as far as the read path is concerned — there is no remaining Supabase
   read behind it. What stands between here and flipping it is not read-path
   work: the identity/read incompatibility (Known limit 4), the writes landing in
   the other provider (Known limit 2 and N-ROSTER Known limit 3), and the Neon
   project holding only synthetic fixtures. All three are owner decisions.
3. **A browser run is the cheapest thing worth doing next**, because it is the
   one check the previous two slices had and this one did not, and it now has
   five page-local branches and twenty-five reads to exercise at once. It needs a
   browser driver in the session.
4. **The highest-value coverage is still `DataContext`**, and it still needs the
   jsdom / `@testing-library/react` decision S13 declined to take under a
   migration slice. Taking it deliberately would also close Known limit 3 above.
5. **Ledger step `008` remains written and unapplied**, declined by the owner on
   2026-08-06. When applied: through the runner as `app_migration`, then promoted
   to `PROTECTED_PATHS` **and** `IMMUTABLE_BASELINE` in the same edit, with the
   step-count assertion bumped to eight. **This session needed no new step.**
6. **Source three credential files for `test:neon`**, not one — see the preflight
   section. Sourcing one file looks like two broken test files.

**The next session must not edit** ledger artifacts `000`–`008`, the manifest's
existing entries, `PROTECTED_PATHS`, `IMMUTABLE_BASELINE`, or any file under
`spikes/s16-identity/`.

## Commits

| SHA | Subject |
|---|---|
| *(1)* | `chore: keep a Vercel token out of git` — the `.gitignore` line, alone |
| *(2)* | `frontend: read the playbook and the coaching digest where the leads come from` |
| *(3)* | `test: pin the coaching pair on the read slice` |
| *(4)* | `docs(neon): record the coaching slice` — a commit cannot carry its own hash; `git log --oneline main..HEAD` resolves all four |

**Not pushed and not merged.** Nothing is deployed, and `NEON_READS_DEFAULT` is
set in no Vercel environment, so nothing running reads any of this.
