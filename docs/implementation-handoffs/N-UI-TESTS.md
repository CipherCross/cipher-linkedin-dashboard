# N-UI-TESTS — the decision S13 declined three times, taken on its own

Four handoffs in a row recorded the same hole in the same words: `tsconfig.api.json`
declares no `jsx`, so a test cannot import a component, so every `.tsx` branch the
Neon read path added is covered by `tsc -b` and by a browser run that is gone with
its session. `N-ROSTER.md` mutations 9 and 10 measured it. `N-BROWSER-RUN.md`
mutations 11 and 12 measured it again from the other side. Each time the fix was
named — jsdom and `@testing-library/react` — and each time it was declined as too
large to smuggle in under a migration slice.

It is taken here, on its own, deliberately.

**Five rendering suites, +36 tests, and twenty-one mutations that previously
reddened nothing now all redden.** No behaviour changed: the only edits outside
the new test files are two configs and five comments that had become false — three
of them in `src/`, two in `tests/`.

## Identity

| | |
|---|---|
| Branch | `codex/neon-ui-test-harness`, on `main` at `ceb017e` |
| Merged in first | `codex/neon-browser-run` → `main` by `git merge --ff-only` |
| Pushed | **no.** `origin/main` is still `e7741f3`; **twenty** commits from five sessions are unpushed. A push deploys production |
| Ledger step | none. `008` remains written and unapplied |
| Migration | none. No DDL, no schema change, no Neon write |
| Behaviour changed | **none.** Two config files, five comments, five new test files, three new devDependencies |

## Preflight: all six baselines matched

Measured on `bc68efc` — the tree `ceb017e` inherits, which differs from it by one
Markdown file and nothing else.

| Suite | Expected | Measured | Match |
|---|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** | yes |
| `npm run build` | clean | **clean**, 2.47 s | yes |
| `npx vitest run` | 19 files / 435 | 19 / **435 passed** | yes |
| `npm run test:neon` | 12 files / 276 | 12 / **276 passed**, 382.33 s | yes |
| `cd ops && npm test` | 70 / 0 | **70 / 0** | yes |
| ledger static assertions | 165 / 0 | **165 / 0** | yes |

## The design calls

### 1. `jsx` goes into `tsconfig.api.json`, not into a seventh baseline

The obvious alternative was a third config (`tsconfig.ui-tests.json`) plus a
`typecheck:ui` script, keeping the API surface's config untouched. Rejected, and
the reason is the chain's own discipline rather than taste: **every session in this
migration opens by measuring six baselines**, and a seventh command is a cost paid
by every future session forever, in exchange for isolating an option that is inert
where it is not wanted.

`tsconfig.api.json` already includes `tests`, so one line makes the rendering
suites type-checked by a command that is already a baseline. Nothing under `api/`
contains JSX, so the option changes nothing there. The file gained a header comment
saying so, because a JSON file cannot otherwise explain itself.

### 2. `environment` stays `node`; jsdom is opted into per file

The `.tsx` suites carry `// @vitest-environment jsdom` in their own docblock. A
global switch would have been one line shorter and was rejected on two grounds:
nineteen pre-existing files are node suites, several import server code from
`api/`, and a `window` appearing underneath code written to assert it has none is
the kind of change that passes for months and then fails somewhere unrelated.
Second, jsdom construction is measurably the slowest part of these runs — 200–400 ms
per file against a total suite time of 1.45 s.

### 3. No `@vitejs/plugin-react`, and that was measured rather than assumed

The plugin was added first, on the assumption that JSX in test files needs it. It
produced esbuild/oxc deprecation warnings on every run, so it was **removed and the
suites re-run**: Vitest 4's own transform compiles JSX in both the test files and
the components they import. The plugin's other job, Fast Refresh, has no meaning in
a test process. It is not a dependency of this work.

### 4. `cleanup()` is explicit, because `globals` is false

RTL's automatic cleanup registers itself on a *global* `afterEach`, which does not
exist in this repository's configuration. Without an explicit `afterEach(cleanup)`
every render accumulates in one document and `getByRole` fails with "found multiple
elements" — which reads as a component bug and is not one. Every rendering file
declares it, with that sentence beside it.

### 5. The hooks are driven through their public surface, not through `mutate`

`useFollowUpActions` exposes `schedule` / `reschedule` / `reassign` / `complete` /
`skip` / `cancel` and keeps `mutate` private. Testing `mutate` directly would have
been easier and would have proved less: `mutate` *receives* `ownerId`, so the
question worth answering is which wrapper **supplies** one. `reschedule` echoes
`state.owner_id` on an action whose visible subject is a date — the case a
per-control check misses, and the one N-ROSTER's browser run caught by clicking Save
owner. A test against `mutate` would pass unchanged if that echo disappeared.

### 6. `rosterPath`'s provenance is tested as a property, not as a value

The interesting test makes `fetchNeonDashboard` answer `rosterPath: 'supabase'` on
the Neon path and asserts the provider **follows it**. That combination cannot occur
in production — the real fetcher's field is typed `'neon'` — which is exactly what
makes it a probe: the only way `DataProvider` can answer `'supabase'` here is by
*reading* the fetcher's field. Any literal reintroduced in `DataContext.tsx`, naming
either value, fails it. Asserting `rosterPath === 'neon'` would have passed against
a hard-coded literal, which is precisely the defect N-ROSTER mutation 8 found.

### 7. The Supabase client is a chainable `Proxy`, not a per-table script

`fetchSupabaseDashboard` builds thirteen chained PostgREST queries plus four paging
walks. A hand-written stub per table would be a second copy of the fetcher, wrong
the first time the real one gains an `.order()`. The stub answers `{ data: [], error:
null }` to any chain, which also terminates every `.range()` walk on its first
iteration. What is under test is the dispatch and the marker, and the fetcher's own
column ladders run for real above it.

### 8. `ConversationDrawer` is excluded, and that is stated rather than skipped

Four of the five page-local read branches are covered. `messages.thread` lives in a
thousand-line component with a dozen contexts; mounting it is its own slice. It is
Known limit 1 rather than a quiet gap.

### 9. The Supabase digest branch's swallowed error is pinned as-is

`LeadsExplorer`'s Supabase branch discards its read error, so a failure renders as
"no digests computed yet". N-COACHING design call 5 left it that way on the argument
that narrowing a working path was not that slice's job, and made the *Neon* branch
fill an error slot instead. That asymmetry is now a passing test with a comment
saying it is pinned rather than endorsed — so that someone fixing it discovers the
divergence was written down, not overlooked.

### 10. Five comments were corrected, because they had become false

Five files asserted, in prose, that this repository cannot test a component. Leaving
that in place after changing it is worse than never having written it: the next
person reads it as a constraint and re-derives the workaround. All five were
rewritten to say what was true, what changed, and why the extracted `.ts` modules
stay anyway — the separation is still right, and `rosterWrites.ts` now says the
sharper version of it: **a predicate proved in isolation says nothing about whether
its call sites consult it**, which is what mutations 9 and 10 demonstrated.

## What changed

| file | change |
|---|---|
| `package.json` | +`jsdom`, +`@testing-library/react`, +`@testing-library/dom` (dev) |
| `vitest.config.ts` | `include` gains `tests/**/*.test.tsx`; a docblock on why `environment` stays `node` and why there is no React plugin |
| `tsconfig.api.json` | `"jsx": "react-jsx"`, with a header comment |
| `tests/writeRefusals.test.tsx` | **new.** 10 tests — `usePipelineActions.assign`, all six `useFollowUpActions` wrappers |
| `tests/playbookPage.test.tsx` | **new.** 6 tests — the editor lock, the three read outcomes, both paths |
| `tests/leadsExplorerDigest.test.tsx` | **new.** 6 tests — the digest panel's rows and its error slot, both paths |
| `tests/dataContext.test.tsx` | **new.** 6 tests — dispatch, both `rosterPath` markers, two failure modes |
| `tests/panelReadBranches.test.tsx` | **new.** 8 tests — the notes panel and the follow-up history walk |
| `src/lib/rosterWrites.ts`, `src/lib/dashboardReads.ts`, `src/lib/conversationPaging.ts`, `tests/rosterWrites.test.ts`, `tests/dashboardReads.test.ts` | comments corrected |

## Checks, with real numbers

| suite | before | after |
|---|---|---|
| `npx vitest run` | 19 files / 435 | **24 / 471** (+5 files, +36) |
| `npm run test:neon` | 12 / 276 | **12 / 276**, 374.50 s — unchanged |
| `cd ops && npm test` | 70 / 0 | **70 / 0** |
| ledger static assertions | 165 / 0 | **165 / 0** |
| `npx tsc -p tsconfig.api.json --noEmit` | clean | **clean** |
| `npm run build` | clean | **clean**, 1.98 s |

Suite wall clock went 847 ms → 1.45 s. The five jsdom environments are most of it.

### The mutation pass — twenty-one, and none silent

Three passes, each mutation applied alone, offline suite run, file restored, tree
verified clean. **Every one of these previously reddened nothing.**

`DataContext`, and the marker N-ROSTER mutation 8 found:

| # | mutation | red |
|---|---|---|
| R8 | the Neon fetcher labels its roster as Supabase's | **2** |
| R8b | the Supabase fetcher labels its roster as Neon's | **1** |
| D | the read-path dispatch is inverted | **5** |
| C | the unconfigured-Supabase guard is removed | **1** |

The two write refusals, N-ROSTER mutations 9 and 10:

| # | mutation | red |
|---|---|---|
| R9 | the `assign` guard is removed | **1** |
| R9b | the `assign` guard stops distinguishing an unassignment | **1** |
| R10 | the follow-up owner guard is removed | **4** |
| R10b | the guard toasts but does not throw | **4** |
| R10c | `reschedule` stops echoing the state owner | **1** |

The coaching pair, N-BROWSER-RUN mutations 11 and 12:

| # | mutation | red |
|---|---|---|
| B11 | Playbook's Neon branch does not set `loadError` | **1** |
| B11b | the editor lock ignores `loadError` | **2** |
| B11c | an unwritten playbook is treated as a failure | **1** |
| B12 | the digest branch swallows its error | **1** |
| B12b | the panel's error slot is removed from the markup | **1** |

The two panel branches, which no previous pass had pointed at:

| # | mutation | red |
|---|---|---|
| N1 | the notes panel swallows its read error | **1** |
| N2 | the notes panel refetches on every expand | **2** |
| N3 | the notes panel fetches on mount | **1** |
| H1 | the history walk resends `null` instead of the server's cursor | **1** |
| H2 | the walk replaces instead of appending | **1** |
| H3 | the walk keeps offering "Load more" with no cursor | **1** |
| H4 | the history read swallows its failure | **1** |

### The finding: one of these tests was vacuous, and the mutation pass is what said so

**N3 initially reddened nothing.** The notes panel's effect awaits
`resolveReadPath()` before it reads, so the test's synchronous
`expect(fetchNeonLeadNotes).not.toHaveBeenCalled()` passed even with the `!open`
guard deleted. The test was green, the assertion was real, and it measured nothing.

Fixed by flushing microtasks (`await act(async () => {})`) before the negative
assertion, which is now commented as being part of the assertion rather than
setup. Recorded prominently because it is the honest lesson of this slice: **a
rendering suite can be green and empty in exactly the way the code it replaced
was**, and the only thing that distinguished them was running the mutations. Adding
jsdom did not close the hole; measuring did.

## Invariants confirmed

* **No behaviour changed.** Production code edits are four comments. Every
  assertion in this slice was written against the code as it stood, and the
  mutation pass restored every file it touched — `git status` clean after each of
  the three passes.
* **The Neon suite is untouched and unchanged**: `vitest.neon.config.ts` still
  matches `*.neon.test.ts` only, and it re-measured at 12 / 276.
* **No Neon read or write** from anything in this slice. The rendering suites mock
  the transport; nothing in them can reach a database.
* **No Supabase read or write.** The client is a stub or `null` in every file.
* **No flag set or flipped.** `NEON_READS_DEFAULT`, `NEON_WRITES_DEFAULT`,
  `NEON_AI_PATH_DEFAULT`, `VITE_AUTH_PATH` untouched.
* **No DDL, no migration, no ledger step.** `000`–`008`, the manifest and
  everything under `spikes/s16-identity/` unmodified; `008` still unapplied; static
  assertions 165 / 0.
* **The three new devDependencies add 47 packages.** `npm audit` reports **12
  vulnerabilities before and after** — verified by stashing the change and
  re-running, so none of them is introduced here.
* **No `supabase db push`, no `sync-agent/deploy.sh`, no Vercel deploy, no
  `git push`.**
* **No credential, connection string, provider resource identifier or real person's
  name** entered the repository, a test, a fixture or this document.

## Known limits

1. **`ConversationDrawer` is still uncovered** — design call 8. `messages.thread`'s
   branch is a thousand-line component away; it is covered by `tsc -b` and by two
   browser runs, which is what every branch here had until today.
2. **These suites mock the transport, so they prove the branch and not the
   answer.** A client that asks for the right operation with the wrong parameter
   name passes every test in this slice; that half is
   `tests/dashboardReadsRest.neon.test.ts`'s job and remains so. The split is
   deliberate and is the same one `N-S13-consolidation.md` used for the PostgREST
   filter string — neither half is worth much alone.
3. **A context's *shape* is not covered.** Every file replaces `useData`, `useAuth`,
   `useToast` and friends with a literal, so a field added to `DashboardData` and
   consumed by a component under test is caught by `tsc` and by nothing here. Mocks
   drifting from the real provider is the standing cost of this approach.
4. **jsdom is not a browser.** No layout, no CSS, no real network, and no
   StrictMode double-invoke — the browser run measured every operation twice for
   that reason and these suites measure it once. The two are complementary; neither
   replaces the other.
5. **The suites assert on class names in three places** (`.coach-digest-toggle`,
   `.conv-coaching-toggle`, `.follow-event`) because those panels expose no roles or
   labels to query. A CSS rename silently breaks a test. Fixing that properly means
   adding accessible names to the components, which is a change to production
   markup and out of scope here.
6. **`resolveReadPath`'s memoization is bypassed**, not tested, in the rendering
   files: they mock the module, so each test gets a fresh answer. The memoization
   itself is covered in `tests/dashboardReads.test.ts`.
7. **Everything the migration's own limits say still holds.** This slice closed a
   *coverage* gap and moved nothing else. `NEON_READS_DEFAULT` is still not
   flippable, for the three reasons `N-BROWSER-RUN.md` § "Exact starting point"
   item 2 lists: the identity/read incompatibility, the writes landing in the
   provider the dashboard is not reading, and the Neon project holding only
   synthetic fixtures. All three are owner decisions.

## Exact starting point for the next session

1. **Review this branch and integrate it with `git merge --ff-only`.** `main` is at
   `ceb017e` locally and **not pushed**; twenty commits are unpushed. A push
   deploys production.
2. **The offline baseline is now 24 files / 471.** Sourcing nothing and running
   `npx vitest run` should produce exactly that; five of the twenty-four are jsdom
   files and the suite takes ~1.5 s.
3. **The coverage hole this chain kept naming is closed, and the way to keep it
   closed is the mutation pass, not the test count.** One of these tests was green
   and vacuous until a mutation said so. Any future session adding a `.tsx` branch
   should mutate it before believing the suite.
4. **The next migration work is a whole-cutover decision, not a slice.** Reads are
   done, verified in a browser and now covered by a repeatable suite. What remains
   is: make `/api/activity-daily` accept the identity cookie (which makes the
   identity pool credential a deployment prerequisite), decide whether to re-copy
   tenant data to Neon, and flip `NEON_READS_DEFAULT`, `NEON_WRITES_DEFAULT` and
   `NEON_AI_PATH_DEFAULT` together rather than one at a time. S14 already built the
   twenty-one write actions, so this is sequencing and risk, not construction.
5. **Ledger step `008` remains written and unapplied**, declined by the owner on
   2026-08-06. When applied: through the runner as `app_migration`, then promoted to
   `PROTECTED_PATHS` **and** `IMMUTABLE_BASELINE` in the same edit, with the
   step-count assertion bumped to eight.
6. **Two harness facts from the previous session, still worth not rediscovering:**
   the ledger static assertions run from the repository root, and any raw check of a
   Neon relation returns `[]` unless the transaction sets `app.actor_id` — see
   `N-BROWSER-RUN.md` § "The shared-project hazard".
7. **Source three credential files for `test:neon`**, not one. Unchanged.

**The next session must not edit** ledger artifacts `000`–`008`, the manifest's
existing entries, `PROTECTED_PATHS`, `IMMUTABLE_BASELINE`, or any file under
`spikes/s16-identity/`.

## Commits

| SHA | Subject |
|---|---|
| `b4c848b` | `chore(frontend): add jsdom and testing-library, and let a test import a component` |
| `86311e3` | `test: cover the two write refusals at their call sites` |
| `f94f5b4` | `test: cover the Playbook editor lock and the digest error slot` |
| `834e371` | `test: cover DataContext's dispatch and its rosterPath marker` |
| `0e737d2` | `test: cover the notes panel and the follow-up history walk` |
| `0f0b4ed` | `docs: correct five comments that said a test cannot import a component` |
| `caa7de7` | `docs(neon): record the UI test harness slice` |

**Not pushed and not merged.** No behaviour changed and nothing is deployed.
