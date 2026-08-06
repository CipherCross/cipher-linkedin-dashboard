# N-ROSTER — `team_members` moves on the read flag, and the Team page stops saying zero

S13's switch left one read behind on purpose and recorded the cost in its own
browser run: with `NEON_READS_DEFAULT=neon` the Team page rendered **"0 Active
teammates · 0 Login-enabled · 0 Active admins"** over an empty table. That is a
confidently wrong number, not a missing label, and it is the class of defect this
chain refuses everywhere else.

It is closed. `identity.teamRoster` is the dispatching endpoint's twenty-third
read, `DataContext.teamMembers` is filled from it on the Neon path, and the page
now states the *other* provider's model rather than a blank one.

**The inversion is the whole argument.** "The roster must not cross" was never a
fact about the roster — it was a fact about `leads` coming from the other
provider. `leads.assigned_to` is a `team_members.id`, the same integer names
different people on the two databases (`N-B2.md`), and S13's answer was to serve
no roster rather than a mislabelled one. Once `leads.directory` feeds
`DataContext`, both ends of that join arrive from one database and the integers
agree. So the roster moves on the **same** flag, not a new one.

What did not invert is the *write* direction, and that is the second half of this
session: `/api/pipeline`'s member-keyed actions have no Neon branch at all, so a
Neon member id sent there would commit against a different person. Those writes
are refused, with the reason stated, rather than left to succeed.

Nothing is deployed, nothing is pushed beyond the fast-forward described below,
and no flag is set anywhere that persists.

## Identity

| | |
|---|---|
| Base SHA | `50d8d1f` — the previous session's branch, reviewed and integrated into `main` with `git merge --ff-only` (step 0 of the brief). `main` moved `e7741f3` → `50d8d1f` and is **not pushed**. |
| Branch | `codex/neon-roster`, not merged, not pushed |
| Commits | see "Commits" below |
| Session | the roster slice — `team_members` migrating with `leads` |
| Predecessor | `N-S13-switch.md` (design call 4, "The browser run", Known limits 1–4), `N-B2.md`, `N-S18.md`, `N-S13-part3.md` |
| Gate carried | none. G2 was decided 2026-08-03 (`approved` / `conditional-go`) |

### The previous session's claims, checked against the tree

All three checked out, which is worth stating because this chain has had a
handoff's forward-looking section disagree with the tree three times.

| claim in `N-S13-switch.md` | measured |
|---|---|
| `frontend/api/` holds exactly 12 top-level function files | **12**, listed |
| nothing under `frontend/api/`, `postgres/`, `ops/`, `sync-agent/` changed | confirmed by `git diff --stat main..codex/neon-s13-switch` |
| the six baselines | all six matched exactly — see "Preflight" |
| `activity-daily.ts` is already an `?op=` dispatcher with 22 reads | confirmed; **this session's server work was one allowlist entry and no new file** |

### The uncommitted `.gitignore` line

The brief flagged an uncommitted `+.env*` in `.gitignore` written by neither the
previous session nor this one. It is accounted for and **deliberately left
uncommitted**: a repository-root `.env.local` exists, dated 2026-08-06 15:43,
whose first line is `# Created by Vercel CLI` and whose contents begin with a
`VERCEL_OIDC_TOKEN`. Somebody ran a Vercel CLI command in the repository root and
added the ignore rule that keeps that credential out of git.

It is a security-positive one-line change by another hand, so this session did
not adopt it into its own commits. **It is worth committing on its own** — while
it lives only in the working tree, a `git checkout .` removes the only thing
stopping a token from being committed. That is the owner's call.

## Preflight: all six baselines matched

Measured on `50d8d1f`, clean tree, before any edit.

| Suite | Expected | Measured | Match |
|---|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** | yes |
| `npm run build` | clean, ~2 s | **clean**, 2.05 s | yes |
| `npx vitest run` | 18 files / 403 | 18 / **403 passed** | yes |
| `npm run test:neon` | 12 files / 267, 0 skipped | 12 / **267 passed**, 0 skipped, 378.65 s | yes |
| `cd ops && npm test` | 70 / 0 | **70 / 0** | yes |
| ledger static assertions | 165 / 0 | **165 / 0** | yes |

## The decision the brief left open: `team_roster()`, and it costs no ledger step

The brief framed this as a trade — the function is tidier, but it "does not
return `auth_user_id`", `Team.tsx:236-239` renders a "Login enabled" label from
that column, and so choosing the function would need a ledger step. **Both halves
of that framing turn out to be wrong in the same direction, and the answer is not
close.**

### Reading `team_members` directly does not return the roster

`postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql:223` —
`team_members_active_actor_select` — restricts `app_runtime` and `app_readonly`
to the row whose `user_id` **is the caller**. A direct table read through the data
store therefore returns exactly **one** member, and the Team page would state "1
Active teammate" over a one-row table. That is not a smaller version of the right
answer; it is a new confident lie in place of the old one.

Making the table readable would mean widening an RLS policy on the identity
boundary in a new ledger step `009`, applied live, for a read the baseline
already provides through a `SECURITY DEFINER` function that is already granted to
`app_runtime` and already gated on `is_active_team_member()`.

### The `auth_user_id` price does not exist

`public.team_roster()` returns `user_id uuid`, and in the portable baseline
`team_members.user_id` is **`NOT NULL`** (`002`, line 39). So on that provider
every member *is* a login: "assignment only" is not a row shape that is missing a
column, it is a state that **cannot exist**. The label has a source — the schema —
and it needs no DDL.

What it must *not* be given is the uuid. `identityAuth.ts#toTeamMember` already
decided this for the identity path and the reasoning is binding here: filling
`auth_user_id` with `users.id` makes an id from one space answer a question about
another, and the Supabase path reads that field to mean "has a Supabase login",
which would then be wrong in both directions. So the projection is reused
verbatim, `auth_user_id` stays `null`, and `Team.tsx` derives "is a login" from
`rosterPath` instead.

**Decision: `identity.teamRoster`, through `public.team_roster()`, no ledger
step, no new file, no second flag.** Ledger artifacts `000`–`008` and the
manifest are byte-identical, and `008` remains written and unapplied.

## What changed

```
frontend/api/activity-daily.ts                   ±50   the 23rd allowlist entry + the header argument
frontend/src/lib/dashboardReads.ts               ±80   READ_OPS.teamRoster, the walk, the projection, rosterPath
frontend/src/lib/rosterWrites.ts                 new  +109  the write rule, and why
frontend/src/lib/DataContext.tsx                 ±43   rosterPath on `Fetched` and on the commit
frontend/src/lib/types.ts                        ±18   RosterPath, DashboardData.rosterPath
frontend/src/lib/usePipelineActions.ts           ±56   assignableMembers, the assign refusal
frontend/src/lib/useFollowUpActions.ts           ±20   the owner refusal, at the one choke point
frontend/src/pages/Team.tsx                      ±85   the third case, rendered rather than smoothed
frontend/src/pages/Pipeline.tsx                  ±13   the card's owner select disables
frontend/src/components/ConversationDrawer.tsx   ±11   same
frontend/src/components/FollowUpPanel.tsx        ±10   the owner chooser empties
frontend/tests/dashboardSlice.test.ts            ±112  the tripwire, narrowed to a named permission
frontend/tests/dashboardReads.test.ts            ±168  the client tripwire + the roster's own reads
frontend/tests/dashboardReadsRest.neon.test.ts    +90  the roster, live, on the S06 fixtures
frontend/tests/dashboardSlice.neon.test.ts        ±14  400 → 200, and what replaced the assertion
frontend/tests/rosterWrites.test.ts              new   +92
frontend/tsconfig.tsbuildinfo                      ±2  tracked build artifact
docs/implementation-handoffs/N-ROSTER.md         new   this document
```

889 insertions, 84 deletions across 17 files.

**Nothing under `postgres/`, `supabase/migrations/`, `ops/`, `sync-agent/` or
`spikes/s16-identity/` changed**, and `frontend/api/` still holds exactly **12**
top-level function files.

## The design calls

### 1. One allowlist entry, not one endpoint

`identity.teamRoster` is already registered in `buildApplicationRegistry` and
already served by `/api/identity?op=team.roster`. Adding it to
`activity-daily.ts`'s `READ_OPERATIONS` creates no file, so the Vercel budget was
never in play — the same correction the previous session recorded, still true.

It takes **no parameters** (the function projects the same seven columns for
every caller and refuses a non-member by returning zero rows, so there is nothing
to scope) and is **not tolerant** (`team_members` is in the baseline's first
artifact; tolerating its absence would convert a broken deployment straight back
into "0 Active teammates").

### 2. Walked, not capped

`/api/identity?op=team.roster` reads one page of 200 and reports `hasMore` —
N-S18 states that limit rather than hiding it. The dashboard client walks
instead, because `memberName(lead.assigned_to)` resolves *any* assignee: a
truncated roster leaves the owners past the cap nameless, which is the same
failure one page further down.

The operation has no keyset, so the driver pages it with `LIMIT/OFFSET`, which is
correct only over a **total** order. `ORDER BY r.name, r.id` — `name` alone is not
unique, `id` is the primary key. Asserted as text offline and as a walk live.

### 3. `rosterPath` is a provenance marker, and it is load-bearing

`DashboardData.rosterPath` is `'supabase' | 'neon'`, committed beside the roster
it describes (never carried over from the previous state — the two must move
together or a refresh could label one provider's ids as the other's).

The Neon value **originates in `dashboardReads.ts`**, not in `DataContext.tsx`.
That is not tidiness: the mutation pass caught it. A literal in a `.tsx` file is
one no test in this repo can reach, and this literal decides whether a member id
may be written back to the other provider — see mutation 8 below.

The brief offered "either the roster arrives, or the slice gets an availability
marker like `followUpsAvailable`". This is both: the roster arrives, and the
marker says whose ids these are, because three separate renderings depend on the
answer and one of them is a write.

### 4. The write refusal, and exactly what it is not

`/api/pipeline` routes five actions to Neon under `NEON_WRITES_DEFAULT`
(`set_stage`, `add_note`, `delete_note`, `set_gender`, `set_instance_config`).
**Every member-keyed action is absent from that list**: `assign`,
`invite_member`, `update_member`, `add_member`, `set_member_active` and all six
follow-up actions resolve ids against Supabase unconditionally. So a Neon member
id sent there is an integer naming somebody else, on a request that succeeds —
ids 1–5 exist on both sides.

Before this session the hazard was masked by an accident: the roster was empty,
so no dropdown offered anything. Filling it removes the accident, so the rule is
made explicit in `rosterWrites.ts` and applied at four places:

| surface | what happens on a Neon roster |
|---|---|
| `usePipelineActions.assign` | refuses with the reason; `null` (unassign) still allowed — it names nobody |
| `useFollowUpActions.mutate` | refuses whenever `ownerId` is non-null, **including the value `reschedule`/`reassign` echoes back out of the state it just read** — the case a per-control check misses |
| owner *selects* that also display the current owner (drawer, Pipeline card) | **disabled**, options kept — a select whose value matches no option renders as "Unassigned", so emptying the list would turn a blocked write into a wrong reading |
| owner *choosers* that display nothing (`FollowUpPanel`) | list emptied, reason printed beneath |

**This is not a fix for the read/write split in general**, and saying so matters
because it could be mistaken for one. With the read flag on and the write flag
off, a stage change, a note or an imported conversation lands in the database the
dashboard is not reading and simply never appears. None of those is member-keyed,
none is refused here, and the gap is Known limit 3.

### 5. The Team page renders three cases, not two

`Team.tsx` already split by *authenticator*. The third case sits inside the
Supabase half: the Supabase authenticator with a Neon roster, which is the only
combination the flags currently permit (`VITE_AUTH_PATH=identity` plus
`NEON_READS_DEFAULT=neon` is a recorded blocker — Known limit 4). What it renders,
each from the model rather than from a fabricated column:

- **"Login enabled" on every row, and the Login-enabled count equals the
  roster.** From `user_id NOT NULL`, not from `auth_user_id` — which is `null` on
  every row and would otherwise report the whole team as assignment-only.
- **No invite button, no Edit, no name field, a stated read-only subtitle.**
  `invite_member`/`update_member` are keyed on `team_members.id`.
- **No "You" badge.** `currentMember.id` comes from the Supabase authenticator and
  the rows' ids come from Neon; the same integer names two people, so the badge
  would land on the wrong row. This is the quietest of the three and the reason
  the marker had to reach the page at all.
- **"No teammates to show."** added to the Supabase table body, which previously
  rendered an empty `<tbody>` with the summary numbers above it.

The Supabase path's rendering is unchanged in every particular.

## Checks, with real numbers

| Check | Baseline (`50d8d1f`) | After |
|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** |
| `npm run build` | clean, 2.05 s | **clean**, 1.93 s |
| `npx vitest run` | 18 files / 403 | 19 files / **421 passed** (+18) |
| `npm run test:neon` | 12 files / 267, 0 skipped, 378.65 s | 12 files / **273 passed** (+6), 0 skipped, 371.05 s |
| `cd ops && npm test` | 70 / 0 | **70 / 0** — unchanged |
| ledger static assertions | 165 / 0 | **165 / 0** — unchanged |

### The two tripwires, narrowed rather than deleted

Both fired on the first run, which is what they are for.

1. **`tests/dashboardReads.test.ts`** asserted the client's operation set **equals**
   `READ_OPERATION_NAMES`. The twenty-third read failed it in both directions;
   the counter in the test name moved to twenty-three, deliberately, and the
   equality assertion is untouched.
2. **`tests/dashboardSlice.test.ts` and `dashboardReads.test.ts`** both asserted
   that no name matches `roster|team_members|team.`. That is now a **named
   permission** — the same narrowing S13 part 3 applied to `owner_id`: exactly
   one operation may read a roster relation, it is `identity.teamRoster`, and
   every other read still may not mention `team_members` or `team_roster` in any
   spelling. `ROSTER_READING` is a one-element list, and lengthening it has to be
   written as a decision.

Two further invariants were added rather than assumed: the roster read must
contain `public.team_roster()` and must **not** match `from public.team_members`
(the RLS argument above, as an assertion), and `identity.teamRoster` must stay
out of `TOLERANT_OPERATION_NAMES`.

`tests/dashboardSlice.neon.test.ts` previously asserted `op=identity.teamRoster`
answers **400**. It is 200 now; what replaced it is stronger — the actor resolver
and all **three** admin commands are still 400, which proves widening the
allowlist to one read widened it to nothing else.

### `tests/rosterWrites.test.ts` — 9 tests, no network

The predicate, the fail-closed direction (anything that is not exactly
`supabase` blocks), the two-list split, that `assignableMembers` copies rather
than aliases, and that the message names the cause rather than the symptom
("no teammates to choose" would read as an empty team — the very message this
slice removed).

### Live, through the real endpoint (`dashboardReadsRest.neon.test.ts`, +6)

Asserted on the three **immutable S06 fixtures**, whose ids, names and uuids are
already committed in `postgres/tests/portable_identity_roles_rls_fixture_seed.sql`.
The project also holds S17's real admin; nothing counts, prints or asserts that
row — a count would break the day a real teammate is added, and a real person's
name does not belong in a repository test.

| assertion | result |
|---|---|
| the whole team comes back to an ordinary member, not just the caller | all three fixtures present — the proof it goes through the function, not the table |
| inactive members are included | `Inactive Three` present with `active: false` |
| roles survive | `Active Two` admin, `Active One` member |
| the bigint reaches the browser and the uuid does not | no fixture uuid anywhere in the payload; `auth_user_id` null on every row |
| the order is total | strictly increasing on `(name, id)`, ids distinct |
| no credential, no roster | 401 |

## The browser run — 115 requests, all 23 reads, zero failures

Same harness shape as `N-S13-switch.md` § "The browser run", rebuilt from that
description in a session scratchpad and gone with it: a Vite dev server rooted at
`frontend/` whose middleware answers `/api/activity-daily` by calling
`createActivityDailyHandler`, over the live Neon project's `s13-rest` fixture,
with `NEON_READS_DEFAULT=neon`. `vercel dev` was again not used, for the reason
that handoff records.

**Three substitutions, and nothing else:**

| stubbed | why it is not what this run looks at |
|---|---|
| `api/_lib/auth.ts#requireUser` → the baseline's `subject-one` | the same stub the live suites apply; verifying a Supabase JWT is not the read path |
| `src/lib/AuthContext.tsx` → a provider already `ready` as an admin, **with `member.id = 1`** | deliberately the Supabase id space, so the Team page's "You" suppression is exercised rather than bypassed — id 1 also exists on the Neon roster |
| `src/lib/api.ts#authFetch` → a placeholder bearer | there is no Supabase session in the harness |

The harness's `envDir` points at itself, so the repository's real `.env.local` was
never loaded and **the Supabase project was not read by the browser run**.

| observation | result |
|---|---|
| total API requests | **115**, **0** non-200 |
| distinct operations | **24** — all twenty-three reads **plus** `config.readPath` |
| browser console | no errors or exceptions |
| Overview | 4,443 leads, 5 instances, 560 replies, P1/P2/P3 = 182/189/189 — identical to the previous session's run, so the roster changed nothing else |
| **Team** | **3 Active teammates · 4 Login-enabled · 2 Active admins**, four rows with roles and statuses, "Login enabled" on each, read-only subtitle, no invite button, no Edit column, no "You" badge |
| **Follow-ups** | owner chips render **"Active One" / "Active Two"** — resolved from `conversation_follow_up_state.owner_id` against the Neon roster. These were blank before this session; this is the read the slice exists for |
| owner filters (queue, Leads) | populated with the four names; enabled, because filtering is a read |
| lead Owner select (drawer) | `disabled: true` with the reason on `title`, options retained |
| follow-up "Change task owner" | one option (`Choose owner…`) and the reason printed beneath |
| **the write refusal, live** | "Reassign" pre-fills `ownerId` from the state, so **Save owner was enabled and clicking it submitted a Neon id**. `useFollowUpActions.mutate` refused it: toast plus inline error, no request. This is the case the dropdowns alone would have missed, and it fired |
| flag off (`NEON_READS_DEFAULT` unset, hard reload) | `config.readPath` answers `supabase`, the SPA takes the Supabase branch, and the Team page reverts to its old subtitle and its invite button |

### The mutation pass — and the three that measured nothing

Each mutation applied alone against the offline suite, restored afterwards, tree
verified clean at the end. Baseline 420 passing at the time of the run.

| # | mutation | red |
|---|---|---|
| 1 | the roster dropped from the endpoint allowlist | **4** |
| 2 | the roster marked `tolerateMissingRelation` | **1** |
| 3 | the roster read takes its first page instead of walking | **1** |
| 4 | `toTeamMember` fills `auth_user_id` with the canonical uuid | **2** |
| 5 | `memberWritesAllowed` returns `true` unconditionally | **3** |
| 6 | `assignableMembers` ignores provenance | **1** |
| 7 | the roster is sent the delta watermark | **2** |
| 8 | **the Neon fetcher labels its roster as Supabase's** | **0 → fixed → 1** |
| 9 | the `assign` guard removed | **0** |
| 10 | the follow-up owner guard removed | **0** |
| 11 | the roster read from `public.team_members` instead of the function | **1** |
| 12 | the roster order loses its unique tiebreak | **1** |

**Mutation 8 is the finding, and it was fixed rather than recorded.** Setting
`rosterPath: 'supabase'` in `DataContext.tsx`'s Neon fetcher reddened nothing —
and that literal is what decides whether a Neon member id may be written back to
Supabase. A silent flip there re-opens the misattribution this session exists to
close, with every suite still green. The value now originates in
`fetchNeonDashboard` (typed `'neon'`, one test), and `DataContext` spreads it
instead of writing it. Re-run afterwards: **1 red**. Offline suite 420 → 421.

**Mutations 9 and 10 measured nothing and are recorded rather than fixed.** They
remove the refusal from `usePipelineActions.assign` and
`useFollowUpActions.mutate` — both React hooks, neither reachable from a node
environment suite that cannot import `.tsx` or render. The predicate they call is
tested (mutations 5 and 6 redden it); that they *call* it is proved only by the
browser run, where clicking "Save owner" on a pre-filled Neon `owner_id` was
refused. That is real evidence and it is not repeatable, which is Known limit 1.

A fourth measurement worth stating as a negative: mutation 2 makes the suite
report `421` tests rather than `420`, because `it.each` over
`TOLERANT_OPERATION_NAMES` gains a case. The count moving is itself the signal.

## Invariants confirmed

- **The Supabase path is unchanged in behaviour.** Its thirteen queries, ladders,
  walks and tolerated-error set are untouched; `rosterPath: 'supabase'` makes
  every new branch resolve the way the old code did. `NEON_READS_DEFAULT` is set
  in no environment, so `resolveReadPath()` answers `supabase` everywhere.
- **Nothing under `frontend/api/` was added**, and the function count is **12**,
  verified by listing.
- **No flag was set or flipped**: `NEON_READS_DEFAULT`, `NEON_WRITES_DEFAULT`,
  `NEON_AI_PATH_DEFAULT` and `VITE_AUTH_PATH` are where S18 left them.
- **`acceptLegacyBearer` is untouched.**
- **Exactly one operation reads a roster relation**, it reads
  `public.team_roster()` and not `public.team_members`, and it is asserted by
  name in two suites.
- **No DDL, no migration, no ledger step.** `000`–`008`, the manifest and
  everything under `spikes/s16-identity/` are unmodified; `008` remains
  unapplied. Static assertions unchanged at 165 / 0.
- **`ai_execute_sql` was not touched** and was not used.
- **No `supabase db push`, no `sync-agent/deploy.sh`, no Vercel deploy, no
  `git push`.** `main` is at `50d8d1f` (fast-forwarded locally, **not pushed**);
  this branch is on top of it.
- **No `set_config(..., false)`** anywhere.
- **No credential, connection string, provider resource identifier or real
  person's name** entered the repository, a test, a fixture or this document.
- **The Supabase project was neither read nor written** by anything in this
  session.

## Known limits

1. **The call sites are still uncovered by any suite.** Everything the path
   *decides* is in `dashboardReads.ts` and `rosterWrites.ts` and is tested; the
   `.tsx` call sites and the two React hooks are covered by `tsc -b`, by the
   browser run, and by nothing repeatable. `tsconfig.api.json` declares no `jsx`,
   so a test cannot import a component — unchanged from S13, and mutations 8–10
   below measure exactly this hole.
2. **`DataContext` itself is untested**, and the Supabase fetcher's
   `rosterPath: 'supabase'` is still an untestable literal. The Neon one was
   moved out after mutation 8 measured nothing; the Supabase one stays, because
   it is the *permissive* value and therefore the one already reached by every
   default. Mutating it to `'neon'` would only over-restrict a working
   dashboard — a visible failure, not a silent one. Closing it properly still
   needs the jsdom decision S13 declined to smuggle in under a migration slice.
3. **Every non-member write still lands in the provider the dashboard is not
   reading.** With reads on Neon and writes on Supabase, a stage change, a note or
   an import commits somewhere invisible. Member-keyed writes are refused;
   everything else is not, and this is a whole-cutover problem rather than a
   defect of this slice. It is another reason the read flag is not flippable
   alone.
4. **`VITE_AUTH_PATH=identity` and `NEON_READS_DEFAULT=neon` remain
   incompatible** — `activity-daily.ts` constructs no identity provider, so an
   identity-path browser sends no bearer and every read 401s. Unchanged from
   `N-S13-switch.md` Known limit 4, and untouched here.
5. **`playbook` and `coaching_digest` still have no operation.** `Playbook.tsx:63`
   and `LeadsExplorer.tsx:244` read Supabase unconditionally on both paths. The
   brief marked this optional and separable; it was **not done**, so the flag
   still does not mean quite what it says. Shape to copy: `LIBRARY_OPERATIONS`
   plus two allowlist entries plus two page-local branches in the shape
   `LeadNotesPanel.tsx:42` already uses.
6. **Parity is against synthetic fixtures.** B2's tenant copy was deleted the day
   it landed. The roster the browser run rendered is three S06 fixtures and one
   real admin — it proves the read, not that any team figure matches production.
7. **The first load now issues twenty-one concurrent walks**, one more than
   before. The roster is four rows on the fixture and small anywhere; never
   measured against a large team, and the 10 s `maxDuration` per request is
   unchanged.
8. **The Neon path's error policy still differs** — a failure on a library
   relation, the pipeline log **or now the roster** fails the load instead of
   emptying that panel. Deliberate for the roster (see design call 1) and
   unchanged for the rest.
9. **The `assign` refusal permits `null`.** Unassigning names nobody, so it is
   allowed — and it writes to Supabase, where the lead may not exist. It will 404
   rather than misattribute, which is the failure mode this slice is willing to
   have.
10. **The tolerant branch has still never seen a genuinely absent relation.**
    Unchanged from N-S13-part3 Known limit 4.
11. **The Neon suite mutates the shared project.** Unchanged from S11.

## Exact starting point for the next session

1. **Review this branch and integrate it with `git merge --ff-only`.** `main` is
   at `50d8d1f` locally and **not pushed**; the previous session's four commits
   plus this session's are all unpushed. A push deploys production.
2. **`playbook` and `coaching_digest` are now the only reads left off the
   path** (Known limit 5). Two operations, two allowlist entries, two page-local
   branches. Small, and the last thing between here and a read flag that means
   what it says.
3. **After that, the remaining blockers to flipping `NEON_READS_DEFAULT` are not
   read-path defects at all**: the identity/read incompatibility (Known limit 4),
   the writes landing in the other provider (Known limit 3), and the Neon project
   holding only synthetic fixtures (Known limit 6). All three are owner
   decisions, not code.
4. **The highest-value coverage is `DataContext`** (Known limit 2), and it needs
   the jsdom/`@testing-library/react` decision S13 declined to take under a
   migration slice. Taking it deliberately, on its own, would close the hole that
   mutations 8–10 exposed.
5. **Ledger step `008` remains written and unapplied**, declined by the owner on
   2026-08-06. When applied: through the runner as `app_migration`, then promoted
   to `PROTECTED_PATHS` **and** `IMMUTABLE_BASELINE` in the same edit, with the
   step-count assertion bumped to eight. **This session needed no step `009`** —
   see "The decision the brief left open".
6. **Consider committing the `.gitignore` line** on its own (see above). It
   currently exists only in the working tree and it is what keeps a Vercel token
   out of git.
7. **Seed your own fixtures.** `s13-rest`, `s13-dashboard`, `s11-contract` and
   `s12-activity` live on the shared Neon project.

**The next session must not edit** ledger artifacts `000`–`008`, the manifest's
existing entries, `PROTECTED_PATHS`, `IMMUTABLE_BASELINE`, or any file under
`spikes/s16-identity/`.

## Commits

| SHA | Subject |
|---|---|
| `2b50ff9` | `frontend: read the roster where the leads come from` |
| `b32d4b1` | `frontend: refuse to write a member id back to the other provider` |
| `d2416ce` | `test: narrow the roster tripwires instead of deleting them` |
| *(this commit)* | `docs(neon): record the roster slice` — a commit cannot carry its own hash; `git log --oneline main..HEAD` resolves it |

**Not pushed and not merged.** Nothing is deployed, and `NEON_READS_DEFAULT` is
set in no Vercel environment, so nothing running reads any of this.
