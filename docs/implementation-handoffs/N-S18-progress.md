# N-S18 — progress record (session stopped mid-slice)

This is a **progress record, not a handoff**. The session was stopped by the
owner partway through the machine-path unblock. The successor replaces this
file with `N-S18.md` when the slice completes.

## Identity

| | |
|---|---|
| Base SHA | `230478c` (S15, fast-forward merged to `main` at the owner's confirmation — step 0 of this session) |
| Branch | `main` directly, not a feature branch; **not pushed** |
| Head SHA | `6741b80` |
| Session | S18 (the number the spec's slice table gives the next slice; this session did not reach S18's own scope — see "What was NOT done") |
| Predecessor | `N-S15.md` |
| Gate carried | none |

## Owner decisions obtained this session

1. **Integration approved.** `codex/neon-s15-ai-layer` fast-forward merged into
   `main`: `00d2260 → 230478c`, six commits, no rebase, no squash, no push.
2. **Ledger step 007 authorised and applied.** See below.
3. **Step 008: write, do not apply.** When the auto-advance blocker surfaced
   (below), the owner chose to have the artifact written and registered but not
   applied, leaving that one stage declared blocked.

## What was done

### Step 007 is applied to the live project

`postgres/tenant-baseline/v1/007_ai_system_write_path.sql`, written but not
applied by S15, is now **applied — ledger 7/7**, as `app_migration`, verified
consistent (`order 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7`).

Verified live afterwards, not assumed:

| probe | result |
|---|---|
| `SELECT/INSERT/UPDATE` on the five relations for `app_system` | all true |
| `DELETE` on any relation for `app_system` | false everywhere |
| `campaigns`, `instances`, `hypotheses`, `hypothesis_campaigns`, `annotations` | no privilege |
| `has_function_privilege('app_system', 'public.ai_execute_sql(text)', 'EXECUTE')` | true |

007 was promoted to **both** `PROTECTED_PATHS` and `IMMUTABLE_BASELINE` in the
same edit that recorded the apply, on the schedule 001..006 followed.

**Runner note for the successor.** `portable_migration_ledger.mjs`'s `--json
PATH` is an **output** path, not an input. Running
`status --json postgres/tenant-baseline/v1/ledger.manifest.json` **overwrites
the manifest** with the status report; the next `apply` then fails with
`manifest_unreadable: manifest must declare down_migrations.supported = false`.
That happened here and was restored from `HEAD` (the manifest is committed, so
`git checkout --` is the whole remedy). The manifest path is fixed in the tool;
`apply`/`verify`/`status` take no manifest argument. The memory note that calls
`status --json PATH` "the readable way to inspect state" is wrong on that point.

The Docker-psql recipe (no local `psql`; `postgres:17-alpine` wrapper,
`LEDGER_DB=neondb`, unpooled endpoint, `app_migration`) worked unchanged. It
was chosen over installing libpq deliberately: it is a real psql binary, the
ledger records the *connection* principal, and it was already the route steps
005 and 006 were applied by.

### Two gaps in S15's "one migration for all machine paths" design

S15 designed 007 as the single remedy for every machine path. Measured against
the live database, it is not sufficient on its own:

1. **`pipeline_auto_advance()`** — `EXECUTE` belongs to `app_runtime` only;
   `app_system` has none, and neither does `app_ai_runner`, so the guard is not
   a way round it (and routing it there would give `ai_execute_sql` a write
   path, which is forbidden). This blocks the auto-advance stage of
   `classify.ts`'s cron. **Remedy written, not applied:** ledger step 008,
   `008_ai_system_auto_advance_execute.sql`, one `GRANT EXECUTE`, registered in
   the manifest as step 8, session `S18`, deliberately absent from
   `PROTECTED_PATHS` and `IMMUTABLE_BASELINE`.
2. **Context reads out of grant** — `campaigns`, `instances`, `hypotheses`,
   `hypothesis_campaigns`, `annotations`. **No migration needed:**
   `app_ai_runner` holds SELECT policies on all of them, so the system path
   reads them through guard-backed named operations. This is settled and the
   pattern is in the tree.

### The app_system vocabulary, and two of the four machine paths

- `frontend/api/_lib/data/operations/aiSystem.ts` (new) — direct statements
  against the five granted relations, guard-backed named queries for the
  out-of-grant reads, composed into `buildAiRegistry()`.
- `notify-replies.ts` — moved to Neon behind a `NotifyData` seam, atomic claim
  preserved.
- `mcp.ts` `save_search` — the explanatory refusal replaced by a real write.
- The header essays in `ai.ts` and `aiStore.ts` claimed `app_system` "holds no
  table grant at all". True when written, false after 007; both corrected.

### Live proofs

`frontend/tests/aiSystemWrites.neon.test.ts` + `tests/support/aiSystemFixture.ts`
— **24 proofs against the live project**, all passing. What they measure:

- the granted DML lands and rows really change;
- **the actor gate is load-bearing** — the same store publishing a non-nil
  actor is refused, tested with both an active human member (so a refusal
  cannot be read as "no such user") and a differently-numbered system actor
  (so the driver's TypeScript `kind` is shown not to be what the database
  checks), each denial carrying its own in-test control;
- out-of-grant direct reads still refuse with 42501 while the same rows come
  back through the guard — same principal, same store, different route;
- no DELETE anywhere;
- `pipeline_auto_advance()` unreachable by both routes — the live justification
  for step 008 existing unapplied;
- the atomic claim under two genuinely concurrent transactions (rendezvous
  after `BEGIN`), each row claimed exactly once.

Worth carrying forward: **RLS refuses reads and updates as invisibility (zero
rows, no throw) and only inserts as 42501.** A test that expects an exception
from a denied UPDATE passes for the wrong reason; denial is measured as "the
row did not change".

Mutation pass, each applied alone and reverted: dropping `AND notified_at IS
NULL` from the claim → red (concurrency proof returned 6 ids for 3 rows);
`SYSTEM_ACTOR.actorId` → non-nil → red (12 failed); guard reads → direct table
reads → red.

## Suites, measured on merged `main` and again at `6741b80`

| Suite | Baseline (merged `main`) | Now |
|---|---|---|
| `npx tsc -p tsconfig.api.json --noEmit` | clean | clean |
| `npm run build` | clean, 2.06 s | clean, 2.18 s |
| `npx vitest run` | 16 files / **321** | 16 / **333** |
| `npm run test:neon` | 10 files / 209 passed, 0 skipped | **11 files / 233 passed, 0 skipped** |
| `cd ops && npm test` | 70 / 0 | 70 / 0 |
| ledger static assertions | 158 / 0 | **165 / 0** |

All six were re-run and read by the session owner-agent directly, not taken
from a subagent's report.

**Correction to N-S15.md.** It records `npx vitest run` as 16 files / 318. The
measured figure on a clean tree at `230478c` is **321** (per-file counts sum to
321; nothing was failing). The recorded number was wrong, as S17's handoff also
had to be corrected. `N-S18.md` should carry 321 as S15's true baseline.

## What was NOT done

1. **`classify.ts`'s cron half** — still declared blocked on Supabase. All its
   operations except auto-advance are in grant, so the move is a refactor that
   lets one body serve both principals (`neonWriter`/`app_runtime` for the human
   POST, AI store/`SYSTEM_ACTOR` for the cron). The auto-advance stage must stay
   behind until step 008 is applied, and a cron run that classified but could
   not auto-advance must not report itself as a complete run.
2. **`briefing.ts`'s cron half** — still declared blocked. Job machine and
   `briefings`/`briefing_jobs` writes are in grant; the five context reads need
   guard-backed operations with the SQL imported from `briefingWrites.ts` so the
   providers cannot drift. The optimistic `WHERE version = $n` predicates must
   survive verbatim. Check each context query against the guard's 1000-row cap.
3. **S18's own scope** — `AuthContext`, route gates and Team admin — was never
   started. Its dependencies (`S17`, `S13`) are satisfied and it remains the next
   slice; read `N-S17.md` before starting it.

## Known limits and carried observations

- **No handler ran end-to-end live.** `notify-replies.ts`'s composition
  (provider selection, the 14-day staleness window, thread grouping, un-claim on
  a Slack 5xx) and MCP's `MCP_SECRET` gate are covered by fakes only. Driving
  them live would claim and announce **real tenant replies** — the claim commits
  before Slack is called — so the operations were driven with fixture ids
  instead. This is a genuine remaining gap, not an oversight.
- `briefing_jobs`/`briefings` are proven at the grant-and-policy level with
  probe statements; no production operations are registered for them yet.
- `aiStore.neon.test.ts` still carries a stale `describe.skipIf` whose message
  says the owner has not applied `000_ai_execution_role_bootstrap.sql`. They
  have (2026-08-05). If the credential file is ever missing, four proofs there
  skip silently while the new file fails loudly. Worth reconciling.
- The `notifyRemaining` delta assertion assumes nothing else mutates
  `messages.notified_at` during a run. True while `NEON_AI_PATH_DEFAULT` is
  unset in every deployment; it would go flaky the moment the flag is set
  somewhere while the suite runs.
- The docker clean-room `portable_migration_ledger_tests.sh` expected-strings
  still stop at step 5 — pre-existing staleness, now two steps further behind.
- `frontend/api/` holds exactly 12 top-level function files. `NEON_READS_DEFAULT`
  / `NEON_WRITES_DEFAULT` / `NEON_AI_PATH_DEFAULT` were not flipped in code or
  deployment env. `ai_execute_sql` gained no write path. No `supabase db push`,
  no `deploy.sh`, no Vercel deploy, no push, and no credential, connection
  string or provider identifier entered the repository.

## Owner actions open

1. **Step 008.** Apply when ready to unblock the classify cron's auto-advance
   stage: through the ledger runner as `app_migration`, then promote to
   `PROTECTED_PATHS` **and** `IMMUTABLE_BASELINE` in the same edit, and bump the
   step-count assertion (it now reads eight).
2. **`NEON_AI_PATH_DEFAULT`** must not be set in any deployment until the two
   cron halves are moved — today setting it would move `notify-replies` and MCP
   `save_search` while classify and briefing crons keep writing to Supabase.

## Commits (on `main`, unpushed)

- `f620a09` postgres: apply ledger step 007, promote it, and write step 008
- `e71518b` frontend: the app_system vocabulary, and the two machine paths it unblocks
- `6741b80` frontend: measure step 007 instead of trusting it
- this commit: the progress record
