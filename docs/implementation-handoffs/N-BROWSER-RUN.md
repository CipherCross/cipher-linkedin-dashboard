# N-BROWSER-RUN — the check the coaching slice could not run, run

`N-COACHING.md` Known limit 1 was the whole of this session's work: the coaching
slice moved the last two reads onto `NEON_READS_DEFAULT` with **no browser
driver available**, so five page-local `.tsx` branches and twenty-five reads were
covered by `tsc -b` and by nothing that opened them.

A driver was available here. **All twenty-five reads plus `config.readPath` were
exercised in a single browser session against the live Neon project — 96
requests, and the only non-200s were four this run deliberately caused.** The
Playbook page's editor lock and the digest panel's error slot, the two behaviours
the slice's design calls exist to protect, were observed failing correctly rather
than argued about.

No repository code changed. This document is the session's only commit.

## Identity

| | |
|---|---|
| Branch | `codex/neon-browser-run`, on `main` at `bc68efc` |
| Merged in first | `codex/neon-coaching-reads` → `main` by `git merge --ff-only`, as N-COACHING § "Exact starting point" item 1 asked. `main` moved `e857159` → `bc68efc` |
| Pushed | **no.** `origin/main` is still `e7741f3`; **thirteen** commits from four sessions are unpushed. A push deploys production |
| Ledger step | none. `008` remains written and unapplied |
| Migration | none. No DDL |
| Code changed | **none.** The mutation pass applied and reverted fourteen edits; `git status` is clean |

## Preflight: all six baselines matched

Measured on `bc68efc` after the fast-forward, before anything else.

| Suite | Expected | Measured | Match |
|---|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** | yes |
| `npm run build` | clean | **clean**, 2.47 s | yes |
| `npx vitest run` | 19 files / 435 | 19 / **435 passed**, 847 ms | yes |
| `npm run test:neon` | 12 files / 276 | 12 / **276 passed**, 382.33 s | yes |
| `cd ops && npm test` | 70 / 0 | **70 / 0**, 4.1 s | yes |
| ledger static assertions | 165 / 0 | **165 / 0** | yes |

Two notes for whoever repeats this:

* **The three credential files are load-bearing**, exactly as N-COACHING records.
* **The ledger assertions run from the repository root**, not from `ops/`. Run
  from `ops/` they fail `MODULE_NOT_FOUND`, which looks like a broken harness.

## The driver, and why this session had one

N-COACHING recorded no browser driver and noted Playwright is not a dependency of
this repository. Both remain true. What is available and was used instead:

* **puppeteer 24.43.1**, already on this machine inside the globally-installed
  `@mermaid-js/mermaid-cli`;
* **Chrome for Testing 148.0.7778.97**, already in `~/.cache/puppeteer`.

Nothing was installed, and nothing was added to `frontend/package.json`. The
driver is one `.mjs` file in the session scratchpad that imports puppeteer by
absolute path. Recording this because it is the difference between this session
and the last one, and the next person will otherwise conclude the same absence.

## The browser run — 96 requests, all 25 reads, four deliberate failures

The harness `N-S13-switch.md` § "The browser run" and `N-ROSTER.md` § "The
browser run" describe, rebuilt from those descriptions in a session scratchpad
and gone with it: a Vite dev server rooted at `frontend/` whose middleware
answers `/api/activity-daily` by calling `createActivityDailyHandler` directly,
over the live Neon project's `s13-rest` fixture, with `NEON_READS_DEFAULT=neon`.
`vercel dev` was again not used, for the reason `N-S13-switch.md` § "Why the
obvious setup does not work" records.

**Three stubs, and this run proved there were exactly three.** The stubs are
applied by a `resolveId` hook that compares the *resolved absolute path*, not the
import specifier — these three modules are imported under five different
spellings, and an alias on the specifier could silently miss one or catch a
fourth. The hook logs each first application, and the server log carried three
lines and no more:

| stubbed | why it is not what this run looks at |
|---|---|
| `api/_lib/auth.ts#requireUser` → the baseline's `subject-one` | the same stub the live suites apply; verifying a Supabase JWT is not the read path |
| `src/lib/AuthContext.tsx` → a provider already `ready` as an admin, **with `member.id = 1`** | N-ROSTER's choice, kept: deliberately the Supabase id space, so the Team page's "You" suppression is exercised rather than bypassed |
| `src/lib/api.ts#authFetch` → a placeholder bearer | there is no Supabase session in the harness |

The harness's `envDir` points at itself, so the repository's real `.env.local` —
the one holding a `VERCEL_OIDC_TOKEN` — was never loaded. Its own
`VITE_SUPABASE_URL` is `http://127.0.0.1:9`, the discard port, which Chrome
refuses outright as `ERR_UNSAFE_PORT`. **So a Supabase-branch attempt is visible
in the network log while provably never leaving the browser**, and the real
Supabase project was neither read nor written by anything in this session.

### What it measured

| observation | result |
|---|---|
| total API requests | **96** |
| non-200 | **4**, all four caused on purpose (see the failure states) |
| distinct operations | **26** — all twenty-five reads **plus** `config.readPath` |
| browser console | no errors and no exceptions except the four deliberate 500s |
| page errors / exceptions | **none** |
| Overview | 4,443 leads in pipeline, 560 replies, P1/P2/P3 = 182/·/189, P3 ghosted 140 (74.1%) — identical to the previous two sessions' runs |
| Team | four rows with roles, statuses and "Login enabled"; the read-only-directory subtitle; no invite button |
| Pipeline, Follow-ups, Leads Explorer | render, no crash, no non-200 |

Most operations appear **twice** per load: React 18's StrictMode double-invokes
effects in dev. It is a property of the harness, not of the path.

### The Playbook page — the slice's sharp case, both ways

| check | result |
|---|---|
| loads and renders content | yes, 127 characters into the textarea |
| the "last saved" stamp | **`· last saved Aug 6`** — this is `updated_at`, the column the slice widened the projection by, rendered |
| the Markdown preview pane | rendered from the same content |
| editor on a successful load | **enabled** (admin, no error) |
| **the read killed mid-session** | error banner `Couldn't load playbook: coach.playbook: Could not load dashboard data`, with a Retry button |
| **the editor under that failure** | **`textarea.disabled === true`**, and the Save button `{"text":"Saved","disabled":true}` |

That last row is the check this session existed for. The lock is what stops an
admin typing into a blank box and saving a fragment over the real playbook, and
it is the reason design call 2 refused `tolerateMissingRelation` on this read. It
fired.

### The coaching digest panel

| check | result |
|---|---|
| collapsed at first paint | yes — `.coach-digest-body` is absent until clicked |
| expanding it costs | **0 requests.** The read fires on mount (the effect's deps are `[data]`), so the panel is *rendered* lazily but not *fetched* lazily |
| rows render | five per-account blocks: two with a summary, a `computed_at` date and pattern rows; three with "Not generated yet" |
| `patterns` as a JS array | **four pattern `<li>`s rendered** — `d.patterns.map` in the panel would have thrown on a JSON string |
| **the read killed** | the panel's error slot filled: `Couldn't load the coaching digest: coaching.digests: Could not load dashboard data` |

The error-slot row is design call 5 observed. Note what it does *not* do: the
five per-account blocks still read "Not generated yet" underneath the banner. The
banner is what distinguishes the two states, and it is present — but a reader who
scrolls past it sees the same words a genuinely empty digest set produces. Worth
knowing before deciding that slot is sufficient.

### The other three page-local reads, and how to reach them

They are S13's rather than this slice's, but a run claiming "every read" has to
open them, and each needed a different click than the obvious one:

* `messages.thread` — clicking a row in the Leads table opens the drawer.
* `leads.notes` — **`.conv-coaching-toggle` is shared with the AI coach section**,
  and the coach's toggle comes first in the DOM. Selecting the first one clicks
  the coach and fires no read. The notes toggle is the one whose
  `.conv-coaching-title` starts with `Notes`.
* `conversations.followUpHistory` — `FollowUpPanel` renders only behind the
  drawer's `.conv-follow-btn`, not on the Follow-ups page. "Load more" was absent
  on the lead the run happened to open (one page of history), so the cursor walk
  is the previous session's evidence, not this one's.

### The flag off — every page reverts

Server restarted with `NEON_READS_DEFAULT` unset, one hard reload per page.

| observation | result |
|---|---|
| `config.readPath` answers | **`{"readPath":"supabase"}`** |
| reads through the application API | **0** on every page — `config.readPath` is the only request the endpoint sees |
| what the SPA asks for instead | PostgREST: `/rest/v1/{instances,campaign_metrics,daily_activity,sync_runs,annotations,campaign_steps,team_members,saved_searches,icps,icp_personas,icp_industries,hypotheses,hypothesis_campaigns,leads,messages,pipeline_events,conversation_*}` |
| Team page | the **invite button is back**, so the page took its Supabase branch |
| total | 318 requests across six pages, every one of them a refused Supabase attempt |

**What the flag-off run does not show is that the Supabase path *renders*.** It
cannot: the harness deliberately has no reachable Supabase project, so
`DataContext` never resolves and the Playbook page sits on its skeleton. The
evidence here is *which branch each page takes*, which is the thing the flag
decides. Rendering the Supabase path needs a harness with a real project, and
that is a different run with a different risk.

## The mutation pass — and the four that measured nothing

Fourteen mutations, each applied alone to the merged code, offline suite run,
file restored, tree verified clean at the end. Baseline **435 passing**.

| # | mutation | red |
|---|---|---|
| 1 | `coach.playbook` dropped from the endpoint allowlist | **3** |
| 2 | `coaching.digests` dropped from the endpoint allowlist | **3** |
| 3 | the playbook projection drops `updated_at` | **0** → **1 live** |
| 4 | the playbook read loses `ORDER BY id` | **1** |
| 5 | the digest read loses its order | **1** |
| 6 | the digest read marked `tolerateMissingRelation` | **1** |
| 7 | the playbook read marked `tolerateMissingRelation` | **1** |
| 8 | an unwritten playbook answers an empty document instead of `null` | **1** |
| 9 | the digest read takes its first page instead of walking | **1** |
| 10 | the playbook read swallows its failure and answers `null` | **1** |
| 11 | `Playbook.tsx`'s Neon branch does not set `loadError` on a failure | **0** |
| 12 | `LeadsExplorer`'s Neon branch swallows the error like the Supabase one | **0** |
| 13 | the digest mapper passes `patterns` through unchecked | **0**, live too |
| 14 | the playbook read is sent a parameter | **1** |

**Mutation 3 confirms N-COACHING's claim rather than trusting it.** That handoff
says the added `updated_at` "would still pass every offline test if the
projection dropped it" and is pinned live. Measured: 0 red offline, and
`tests/dashboardReadsRest.neon.test.ts` alone goes 22 passed → **1 failed / 21
passed**. The split is real and it is the split the file was written for.

**Mutations 11 and 12 are the coverage holes, and they are exactly the two
branches this session's browser run covered.** Both are `.tsx`;
`tsconfig.api.json` declares no `jsx`, so neither the offline suite nor the live
one can import them. Mutation 11 deletes the `setLoadError` call that the editor
lock reads — the failure the whole design call exists to prevent — and every
suite stays green. The browser run caught both directly (`textarea.disabled ===
true`, and the filled error slot). That evidence is real and **it is not
repeatable**, which is Known limit 1.

**Mutation 13 measured nothing anywhere, and that is defensible rather than a
gap.** `coaching_digest.patterns` is `jsonb NOT NULL DEFAULT '[]'`, `pg` parses
it to a JS array before the mapper sees it, so `Array.isArray(...) ? ... : []`
has no reachable false branch on this provider. The code's own comment already
says so. Recorded rather than fixed: deleting a defensive guard to make a
mutation score is the wrong trade.

**A negative worth stating:** mutations 6 and 7 report **435 passed with 1
failed** — 436 tests, not 435. `it.each` over `TOLERANT_OPERATION_NAMES` gains a
case when an operation is marked tolerant, so the count moving is itself a
signal. Same observation as N-ROSTER's mutation 2.

## The shared-project hazard N-COACHING warned about, one layer deeper

N-COACHING Known limit 6 says to check `SELECT content FROM public.playbook`
before trusting a restore. Doing that with the S11 runtime credential and **no
actor context** returns `[]` — for the playbook, for `coaching_digest` and for
`instances` alike. Not because they are empty: because every one of them carries
an active-member RLS policy and a connection that set no `app.actor_id` matches
no rows.

The playbook in fact held `shared fixture`. A restore script that believed the
first answer would have **deleted the row it was written to protect**. Any check
of this kind has to run inside a transaction that sets the actor:

```sql
BEGIN;
SELECT set_config('app.actor_id', '<an active member uuid>', true);  -- true: never session-wide
SELECT content FROM public.playbook;
```

`true` is not optional — this is the pooled endpoint, and a session-scoped GUC
leaks to the next client.

This session's own fixture (a playbook marker and two `coaching_digest` rows)
recorded the prior state to a file before writing, and the restore was verified
by re-reading: `content = 'shared fixture'`, `updated_at` byte-identical,
`coaching_digest` back to zero rows. **The project is as this session found it.**

## Invariants confirmed

* **No repository code changed.** The only new file is this document.
  `git status` clean; `npx vitest run` 435, `tsc -p tsconfig.api.json` clean and
  `npm run build` clean re-measured *after* the mutation pass.
* **`config.readPath` is still the one unauthenticated operation**, and with the
  flag off it is the only request the endpoint receives at all.
* **No flag was set or flipped in any deployment.** `NEON_READS_DEFAULT=neon`
  existed only as an environment variable of a scratchpad dev server.
  `NEON_WRITES_DEFAULT`, `NEON_AI_PATH_DEFAULT` and `VITE_AUTH_PATH` untouched.
* **No write reached either provider from the browser.** `/api/playbook` is
  answered 503 by the harness by construction — the Save path follows
  `NEON_WRITES_DEFAULT` and is a different flag's slice.
* **The real Supabase project was neither read nor written.** `envDir` isolation
  plus a discard-port URL Chrome refuses.
* **No DDL, no migration, no ledger step.** `000`–`008`, the manifest and
  everything under `spikes/s16-identity/` unmodified; `008` still unapplied;
  static assertions 165 / 0.
* **No `set_config(..., false)`** anywhere, including the fixture script.
* **No `supabase db push`, no `sync-agent/deploy.sh`, no Vercel deploy, no
  `git push`.**
* **No credential, connection string, provider resource identifier or real
  person's name** entered the repository, a test, a fixture or this document.

## Known limits

1. **The browser run is still not repeatable.** It is a scratchpad harness driven
   by a script that is gone with the session, and mutations 11 and 12 prove the
   suites cannot stand in for it. Every future change to those two branches is
   unguarded again the moment this session ends. This is now the *measured*
   version of N-COACHING Known limit 3 rather than the argued one.
2. **jsdom + `@testing-library/react` was not taken, and deliberately.** The
   session's brief made it the fallback for having no browser driver; there was
   one, so the brief's Step 2 was the work. It remains the highest-value coverage
   left, and it is now better specified than before: the four things that need a
   rendering suite are `DataContext`'s two `rosterPath` literals (N-ROSTER Known
   limit 2), `Playbook.tsx`'s `setLoadError` on the Neon branch, `LeadsExplorer`'s
   `setDigestErr`, and the two React hooks' write refusals (N-ROSTER mutations 9
   and 10). Take it on its own, not under a migration slice.
3. **Three stubs is three fewer things verified.** The authenticator was replaced
   wholesale (S18's slice, smoked live as C5), and `requireUser` was replaced with
   a fixture subject. What ran for real: the SPA, `DataContext`, every page, the
   endpoint, the registry, the driver and the baseline RLS policies.
4. **The digest panel's error banner sits above five "Not generated yet"
   blocks.** The banner distinguishes a failed read from an empty one; the blocks
   beneath it do not. Not wrong, and not obviously enough.
5. **`conversations.followUpHistory` was exercised but not walked.** The lead the
   run opened had one page of history, so "Load more" never appeared. The
   three-page cursor walk is `N-S13-switch.md`'s evidence and was not re-measured.
6. **The flag-off run proves the branch, not the rendering.** See above. No page
   was driven on a *working* Supabase path in this session, which is unchanged
   from N-S13-switch Known limit 1.
7. **Parity is still against synthetic fixtures.** The digests this run rendered
   are two rows it wrote itself and the playbook was a marker. Unchanged from
   N-COACHING Known limit 5.
8. **`VITE_AUTH_PATH=identity` and `NEON_READS_DEFAULT=neon` remain
   incompatible.** Unchanged from N-COACHING Known limit 4. Untested here, and
   untestable in this harness — the stub replaces the authenticator.
9. **Every write still lands in the provider the dashboard is not reading.**
   Unchanged from N-COACHING Known limit 2 and N-ROSTER Known limit 3, and this
   run could not have caught it: the harness refuses writes on purpose.
10. **The reads have never been measured against live volume.** Unchanged from
    N-S13-switch Known limit 7. The fixture is ~10k rows and the first load
    issues twenty concurrent walks; StrictMode made that forty here without
    trouble, which says nothing about a 10 s serverless `maxDuration` over four
    notebooks of real leads.

## Exact starting point for the next session

1. **Review this branch and integrate it with `git merge --ff-only`.** `main` is
   at `bc68efc` locally and **not pushed**; thirteen commits are unpushed. A push
   deploys production.
2. **The read path has now been seen working.** Every one of the twenty-five
   reads was exercised through the real endpoint against the live Neon project in
   one browser session, with no failure that was not caused on purpose. What
   still stands between here and flipping `NEON_READS_DEFAULT` is unchanged and
   is not read-path work: the identity/read incompatibility (Known limit 8), the
   writes landing in the other provider (Known limit 9), and the Neon project
   holding only synthetic fixtures (Known limit 7). All three are owner
   decisions.
3. **The jsdom decision is the next coverage work**, and Known limit 2 lists the
   four call sites that need it by name. Mutations 11 and 12 are its
   justification: a mutation that removes the editor lock's trigger reddens
   nothing today.
4. **Ledger step `008` remains written and unapplied**, declined by the owner on
   2026-08-06. When applied: through the runner as `app_migration`, then promoted
   to `PROTECTED_PATHS` **and** `IMMUTABLE_BASELINE` in the same edit, with the
   step-count assertion bumped to eight. **This session needed no new step.**
5. **Two harness facts worth not rediscovering:** the ledger static assertions
   run from the repository root, and a raw `psql`-style check of any Neon relation
   returns `[]` unless the transaction sets `app.actor_id` — see the shared-project
   section, which is the trap that nearly ate the playbook.
6. **Source three credential files for `test:neon`**, not one. Unchanged.

**The next session must not edit** ledger artifacts `000`–`008`, the manifest's
existing entries, `PROTECTED_PATHS`, `IMMUTABLE_BASELINE`, or any file under
`spikes/s16-identity/`.

## Commits

| SHA | Subject |
|---|---|
| `b74e976` | `docs(neon): record the browser run and the mutation pass` — this file, the session's only commit |

**Not pushed and not merged.** No code changed, nothing is deployed, and
`NEON_READS_DEFAULT` is set in no Vercel environment.
