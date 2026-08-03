# N-S11 phase 1 — the Neon-backed `DataStore`, its lifecycle and the actor-scoped transaction wrapper

**Status: complete.** A concrete Neon adapter for the S03 contract exists, and
the same contract suite is green against both it and `fake.ts` from the same
test bodies. The Neon half runs against the live project, not a stub.

## Identity

| | |
|---|---|
| Base SHA (`main`) | `635121441147438ced1f02d773857c4c9e06ab36` (`6351214`) |
| Branch | `codex/neon-s11-phase1-datastore` |
| Commits | `89e2cd9` driver · `77eec1b` contract suite · `fe669bb` this document |
| Session | S11 phase 1, spec `specs/2026-07-30-neon-migration-and-multitenancy.md` |
| Predecessor | `docs/implementation-handoffs/N-S11.md` (phase 0) |

### Changed files

```
frontend/api/_lib/data/neon.ts                      new   the driver
frontend/api/_lib/data/neonConfig.ts                new   server-only credential resolution
frontend/api/_lib/data/index.ts                      ±5   deliberately does NOT re-export the driver
frontend/api/_lib/data/fake.ts                      +20   rollback-error parity
frontend/tests/support/dataStoreContract.ts         new   the shared suite, written once
frontend/tests/support/fakeContractHarness.ts       new
frontend/tests/support/neonContractHarness.ts       new
frontend/tests/dataStore.test.ts                 rework   shared suite + fake/config specifics
frontend/tests/dataStore.neon.test.ts               new   shared suite + real-provider evidence
frontend/vitest.config.ts                           new   default run, excludes *.neon.test.ts
frontend/vitest.neon.config.ts                      new   the Neon run
frontend/tsconfig.api.json                          new   type-checks api/ and tests/
frontend/package.json                                ±6   pg, @types/pg, two scripts
frontend/package-lock.json                        (lock)
docs/implementation-handoffs/N-S11-phase1.md        new   this document

# added by owner decision after the driver was reviewed (see "Owner decision")
postgres/tests/portable_migration_ledger_static_assertions.mjs  ±14  scope guard narrowed to real invariants
ops/test/hosting-parity.test.ts                                 -18  obsolete S10 scope test removed
```

14 source files under `frontend/`, plus this document, plus the two guard files
changed by the owner decision recorded below. Nothing under
`postgres/tenant-baseline/`, `supabase/`, `sync-agent/`, `frontend/src/`, or
any `frontend/api/` handler. No baseline artifact, ledger artifact or harness
changed; the two guard files are test scripts, carry no pinned digest, and are
not part of the ledger. No page and no handler calls the driver: that is S12's
job.

`frontend/api/_lib/data/contracts.ts` — the S03 contract — was **not** changed.
It did not need to be. The one place it chafed is recorded under Known limits.

## Recorded pre-edit baselines

Measured before any edit, on `main` at `6351214`:

| Suite | Result | Matched the expected figure? |
|---|---|---|
| `cd frontend && npm test` | 9 files / **49 tests passed** | yes |
| `cd ops && npm test` | **71 passed, 0 failed** | yes |
| `node postgres/tests/portable_migration_ledger_static_assertions.mjs` | **75 passed, 0 failed** | yes |

## The four design calls

### 1. Which driver — `pg` over TCP

**Decision: `pg` (node-postgres) over TCP.** Not `@neondatabase/serverless`.

Measured on this host against the live project (macOS dev host → Neon Free,
AWS `eu-central-1`, PostgreSQL 17.10), 12–15 samples each after warmup:

| path | min | p50 | p95 |
|---|---|---|---|
| one bare round trip, pooled | 36.7 | **38.5** | 137.8 |
| `pg`/TCP, warm pool, actor txn, 4 round trips (pooled) | 151.9 | **158.9** | 241.3 |
| `pg`/TCP, warm pool, actor txn, 4 round trips (direct) | 153.3 | **208.6** | 279.9 |
| `pg`/TCP, warm pool, actor txn, 6 round trips (pooled) | 225.8 | **274.1** | 314.4 |
| `pg`/TCP, cold connect per call, 6 round trips (pooled) | 553.9 | **578.8** | 679.4 |
| `@neondatabase/serverless` HTTP, one `SELECT` | 38.3 | **40.1** | 125.7 |
| `@neondatabase/serverless` HTTP, 5-statement batch | 40.9 | **41.9** | 100.6 |
| `@neondatabase/serverless` WebSocket, warm pool, 6 round trips | 239.2 | **321.1** | 332.4 |

All figures are milliseconds.

**The measured cost is round trips, not the driver.** A warm `pg` transaction
costs almost exactly `statements × RTT`; WebSocket costs the same round trips
plus a proxy hop; HTTP costs one. So the actionable finding was not "which
driver" but "how many statements". The driver therefore collapses the three
`SET LOCAL`s into a single `SELECT set_config(...), set_config(...),
set_config(...)`, taking an actor-scoped read from 6 round trips to 4:
**p50 274.1 ms → 158.9 ms, a 42% reduction, measured.**

These absolute numbers are dominated by the ~38 ms dev-host RTT to Frankfurt
and are **not** production latency. A Vercel function co-located with the
project pays single-digit milliseconds for the same four round trips. What
transfers is the shape: every statement is an RTT, so the preamble had to be
one statement.

**Why not HTTP — and a correction to the premise.** The brief says HTTP mode
"carries no multi-statement transaction". Measured, that is not quite right,
and the distinction matters. `neon(...).transaction([...])` sends an array of
statements in one HTTP request and the Neon proxy executes them as one real
transaction on one backend; `SET LOCAL` set in statement 1 was read back
successfully in statement 2 (verified: the batch's second statement returned
`00000000-0000-0000-0000-000000000001`). What HTTP mode cannot do is be
**interactive**. Every statement must be known before the request is sent. The
S03 contract's `transaction(actor, work)` hands the caller an arbitrary async
callback whose later statements depend on earlier results — unrepresentable in
a batch. HTTP is ruled out by interactivity, not by transactions, and that
leaves a real option open for later: a single-shot read-only path could
legitimately use HTTP at ~40 ms instead of ~160 ms. It is not built here.

**Why not WebSocket.** It does support interactive transactions, at ~2 round
trips' worth of extra cost at the same statement count (321 vs 274 ms) plus a
`ws` dependency. Its reason to exist is runtimes without TCP — Cloudflare
Workers, Vercel's edge runtime. The S03 contract already declares execution as
`server-runtime`, and Vercel Node functions have TCP. Nothing was bought.

**What `pg` cost.** It is CommonJS, so `import pg from 'pg'` and destructure;
named ESM imports fail.

### 2. Pooled or direct endpoint — pooled, with the direct one derived

**Decision: the pooled (PgBouncer transaction-mode) endpoint for the request
path.** `NEON_DATABASE_URL_UNPOOLED` exists for the cases that genuinely need a
session and is derived from the pooled string by stripping `-pooler`, so it
needs no second secret.

Phase 0's measurement was confirmed independently here, as three assertions
rather than one observation — see "the actor context cannot leak" below.

**What was given up.** Anything that needs session state to outlive a
transaction: `SET` without `LOCAL`, session-level GUCs, session advisory locks,
`LISTEN`/`NOTIFY`, `WITH HOLD` cursors, and prepared-statement reuse across
transactions. The driver uses none of them — every setting is `SET LOCAL`,
every statement goes through the unnamed extended-protocol path, and no
statement is ever named — so PgBouncer transaction mode costs it nothing. The
constraint is real but it is now a stated invariant of this driver, not an
accident: **anything added to this driver that needs session state is a design
error, and the unpooled endpoint is where such work belongs.**

### 3. Where the driver lives — `frontend/api/_lib/data/neon.ts`, and it is a *different* driver from the ops one

**Decision: two drivers, not one.**

They are different planes, with different credentials, lifetimes and
identifier hygiene:

- **This one is the data plane.** It holds a least-privilege runtime
  connection string (`app_runtime`: not an owner, no `BYPASSRLS`), runs inside
  a request, and its entire job is actor-scoped, RLS-governed reads and writes
  behind the S03 allowlist.
- **S24/S25's Neon adapter is the control plane.** Neon's management API,
  project/branch/role/endpoint provisioning, plan digests, idempotency keys —
  run from the `ops` CLI with an operator credential. Its resource IDs
  (`prj_…`, `ep-…`) are exactly the strings the S08 static sweep forbids from
  reaching anywhere near the application, and exactly what the data plane must
  never see.

One module would mean the request path linking against a management-API client
and, worse, a single credential surface spanning two trust levels. `ops/` is
also a separate npm package with its own toolchain (`node --test` over a `tsc`
build into `dist/`); importing across would couple two build graphs for no
gain.

What they will eventually share is connection-string parsing and redaction
helpers — not the driver. That is a small, obvious extraction and it is left
for S25 to make, rather than pre-built here against a guess at S25's shape.

### 4. Where the connection secret lives and how tests reach it

**Decision: `NEON_DATABASE_URL` (and optional `NEON_DATABASE_URL_UNPOOLED`),
server-only, resolved by `neonConfig.ts`, never written into the repository.**

- Not `VITE_`-prefixed. `readRequired` refuses outright if the variable name
  starts with `VITE_`, and refuses to resolve at all when
  `typeof window !== 'undefined'`.
- The value lives in `~/.config/neon-s11-datastore.env`, mode 0600, outside
  the repository, and reaches the test process only through inherited
  environment variables — never a process argument.
- `frontend/api/_lib/data/index.ts` deliberately does **not** re-export
  `neon.ts` or `neonConfig.ts`. Importing the contract or the fake must not
  drag in `pg`, Node built-ins, or a credential resolver.

**Fail-closed, verified.** `dataStore.neon.test.ts` calls
`requireNeonTestConnection()` at module scope, so an absent credential fails
the file at import. Run with the variables unset:

```
Test Files  1 failed (1)
      Tests  no tests
NeonConfigurationError: NEON_DATABASE_URL is not set. The Neon data store needs a
server-only PostgreSQL connection string for the least-privilege runtime role.
Set it in the server environment (never as VITE_NEON_DATABASE_URL) and re-run.
Refusing to continue: an unconfigured data store would report success without
touching a database.
```

The Neon run is a separate script (`npm run test:neon`) rather than a
conditional skip inside `npm test`. A skip inside the default suite would let
`npm test` report green while claiming coverage it never had; a separate
command makes the claim explicit and, once made, non-negotiable.

## How the actor context reaches the database

Not invented here — read out of
`postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql`.

Every transaction opens with, in one round trip:

```ts
await client.query(
  'SELECT set_config($1, $2, true) AS statement_timeout,' +
  ' set_config($3, $4, true) AS timezone,' +
  ' set_config($5, $6, true) AS actor_id',
  ['statement_timeout', String(statementTimeoutMs),
   'timezone', 'UTC',
   'app.actor_id', actor.actorId],
)
```

`set_config(name, value, is_local => true)` **is** `SET LOCAL`, with the
advantage that it is parameterized, so no caller-supplied value is ever
interpolated into SQL text. Every policy reads the value back through
`current_setting('app.actor_id', true)` behind a strict UUID regex, a `CASE`
yielding `NULL::uuid` for anything malformed, and active-`users` plus
active-`team_members` `EXISTS` checks.

**The driver does not authorize.** It publishes the actor and passes it
through unvalidated beyond the contract's own `assertActorContext`; a
malformed actor id is deliberately sent to the database so the *policy*
refuses it. This is asserted rather than asserted-about: with the actor id
pinned to a constant in the driver, five tests go red (below).

There is no path to the database that skips the preamble: `query()` runs
inside its own `BEGIN READ ONLY` transaction using the same wrapper.

### The exact assertion that the actor context cannot leak across pooled connections

Three assertions, in `frontend/tests/dataStore.neon.test.ts`:

1. **`gives each interleaved actor its own context on a single pooled
   connection`** — a store with `maxConnections: 1`, so every transaction is
   forced onto the same client-side connection. Four transactions alternating
   two actors:

   ```ts
   const order = [activeMember, activeAdmin, activeMember, activeAdmin]
   for (const actor of order) seen.push((await readSession(store, actor)).actorId)
   expect(seen).toEqual(order.map((a) => a.actorId))
   expect(store.poolStats.total).toBe(1)   // one connection served all four
   ```

2. **`discards app.actor_id and statement_timeout at COMMIT on the very same
   backend`** — the tightest form. A single raw `Client` on the **direct**
   endpoint, so the physical backend is guaranteed to be reused and
   `pg_backend_pid()` can be asserted equal:

   ```ts
   expect(inside.pid).toBe(before.pid)
   expect(after.pid).toBe(before.pid)     // same backend throughout
   expect(inside.actor).toBe(activeMember.actorId)
   expect(inside.timeout).not.toBe('0')
   expect(after.actor).toBe('')           // and yet nothing survived COMMIT
   expect(after.timeout).toBe('0')
   ```

   This one uses the direct endpoint on purpose: through PgBouncer the next
   transaction may land on a different backend, which would make pid equality
   unassertable and weaken the proof to a coincidence.

3. **`confirms the same transaction scoping through the pooled endpoint`** —
   the same before/after check on the pooled endpoint, plus
   `expect(connection.pooledEndpointConfirmed).toBe(true)` so the test cannot
   silently pass against a direct URL.

4. **`does not let a transaction that failed leave its actor behind`** — after
   a failed admin transaction on a one-connection pool, the next transaction
   sees only its own (different) actor.

## How risk R3 was closed

PostgreSQL arms `statement_timeout` when the outer statement *begins*. A guard
installed inside a call already in flight cannot abort it, so the timeout must
be established in its own round trip before any work statement is sent — which
is what the preamble does.

**Asserted, not assumed**, in three parts:

```ts
// 1. the configured value, read back from inside the transaction — and again
//    from inside an explicit read-write transaction, not just the read path
expect(fromQuery.statementTimeoutMs).toBe(STATEMENT_TIMEOUT_MS)        // 1500
expect(fromTransaction?.statementTimeoutMs).toBe(STATEMENT_TIMEOUT_MS)

// 2. it actually fires: a 30-second statement, aborted at the timeout
await expect(rejection).rejects.toBeInstanceOf(DataStoreTransactionError)
await expect(rejection).rejects.toThrow('statement timeout')
expect(elapsed).toBeGreaterThanOrEqual(STATEMENT_TIMEOUT_MS - 250)
expect(elapsed).toBeLessThan(10_000)     // nowhere near the 30s it asked for

// 3. the guard comes from the driver, not from a server default
expect(timeoutOnASessionTheDriverDidNotOpen).toBe('0')
```

The read-back is unit-free —
`(extract(epoch FROM current_setting('statement_timeout')::interval) * 1000)::bigint`
— so it cannot break on PostgreSQL's `'1500ms'` vs `'10s'` formatting.

The mutation check below confirms these assertions bite.

## Connection lifecycle and pooling

- One `pg.Pool` per store. `max` defaults to 4; serverless callers should keep
  it small. `allowExitOnIdle` is on, and the pool's `error` event is swallowed
  so a backend disappearing while idle cannot crash the process — the failure
  surfaces on the next acquisition instead.
- A transaction acquires a client, runs the preamble, runs the work, commits,
  and **always** releases in `finally`. If `ROLLBACK` itself failed, the
  connection's state is unknown and it is destroyed via `client.release(err)`
  rather than returned.
- Validation happens before acquisition: an invalid actor, a malformed request
  or an unallowlisted operation costs no connection at all. Asserted:
  `expect(store.poolStats.total).toBe(0)` after a refused operation.
- Nested transactions are detected across async boundaries with
  `AsyncLocalStorage`, not a boolean — the fake can use a boolean because it is
  synchronous around its awaits; the driver cannot.
- `close()` ends the pool and is idempotent; afterwards every call throws
  `Data store is closed`.
- The runtime principal is verified once per store and refused if it is a
  superuser, holds `BYPASSRLS`, or has `row_security` off. On the live project
  it is `app_runtime`: all three checks pass.

Asserted in `Neon driver — connection lifecycle`:

```ts
expect(store.poolStats.total).toBe(0)              // nothing acquired yet
await readSession(store)
expect(store.poolStats.idle).toBe(store.poolStats.total)   // released, not leaked
await Promise.all(Array.from({ length: 8 }, () => readSession(store)))
expect(store.poolStats.total).toBeLessThanOrEqual(2)       // ceiling honoured
```

and, for a failed transaction returning its connection rather than poisoning
it, five consecutive failures on a one-connection pool:

```ts
expect(store.poolStats.total).toBe(1)
expect(store.poolStats.idle).toBe(1)
const session = await readSession(store)   // still works
```

**Consequences.** The pool is per-store, so a serverless invocation that
constructs a store per request pays a cold connect — measured at p50 578.8 ms
from here versus 158.9 ms warm. S12 must hoist the store to module scope so it
survives warm invocations. That is the single most load-bearing thing this
handoff has to say about the next session.

## Contract parity evidence

The suite is written once, in `frontend/tests/support/dataStoreContract.ts`,
and driven by a harness. `runDataStoreContractSuite(label, createHarness)` is
called twice — from `dataStore.test.ts` with the fake and from
`dataStore.neon.test.ts` with Neon. There are no forked bodies. Both harnesses
use the **same actor identities** (`CONTRACT_ACTORS`, matching the identity
fixture rows in `postgres/tests/portable_identity_roles_rls_fixture_seed.sql`),
so a parity failure cannot hide behind different inputs.

Sixteen shared assertions, each run twice:

- security contract: `server-runtime`, `owner: false`, `bypassRowSecurity: false`
- an offset-bearing range (`23:00+02:00` → `01:00+02:00`) selects exactly the
  two rows in `[21:00Z, 23:00Z)`
- returned instants are ISO-8601 UTC, compared by **exact spelling** as well as
  by instant, so neither adapter can drift into a local-time representation
- `asUtcTimestamp` / `utcRange` reject non-UTC and inverted input
- pagination past the 1000-row cap over 2,500 rows: page sizes exactly
  `[1000, 1000, 500]`, 2,500 distinct values, in order, no duplicates, no gaps
- page limits of 0 and 1001 rejected
- a cursor is refused for a different actor, different params, or a different
  operation
- cursors leak no operation name, actor id or tenant id
- missing, blank and kind/role-mismatched actors rejected at the boundary
- a valid active actor reads its own row
- unknown, malformed and inactive actors read **zero rows**
- a valid active actor writes; unknown, malformed and inactive actors are
  refused with `DataStoreAuthorizationError` and leave nothing behind
- per-operation authorization (admin-only) on top of the database
- unallowlisted operations refused, on both `query` and `execute`
- commit: two writes plus a read that sees the transaction's own writes
- rollback on a caller throw, and rollback on a command failing
  mid-transaction — both verified through an **out-of-band** channel, because
  a store that both wrote and reported the write could hide a partial commit
  from itself
- the store still works after a failed transaction
- nested and post-transaction use rejected

### What the driver had to do that the fake did not

1. **Real cursors.** The fake mints a token into an in-process registry, which
   cannot survive a serverless invocation. The driver's token is
   `base64url(sha256(operation + params + range + tenantId + actorId) + '.' +
   offset)` — self-contained, opaque, and scope-bound without a server secret.
   A forged offset can only re-request a page the same actor could have asked
   for directly, so integrity buys nothing that the digest check does not.
2. **`limit + 1` fetching** to compute `hasMore` without a second query.
3. **Wrapping arbitrary operation SQL** in
   `SELECT * FROM (<op>) AS datastore_page LIMIT $n OFFSET $m`, renumbering the
   appended placeholders after the operation's own.
4. **Timestamp normalization.** `pg` returns `timestamptz` as a `Date` in the
   process time zone; a per-pool type parser converts OIDs 1184/1114 to ISO-8601
   UTC strings. Applied per-pool, not through the global `pg.types` registry, so
   nothing else in the process is affected. The fake stores strings and never
   had the problem.
5. **`AsyncLocalStorage`** for nesting detection.
6. **SQLSTATE translation**: `57014` → `DataStoreTransactionError`, `42501`
   (which is how an RLS `WITH CHECK` violation arrives) →
   `DataStoreAuthorizationError`. Contract errors pass through untouched so
   callers keep discriminating on them.
7. **Runtime-principal verification** — a fake has no principal.
8. **Connection return and destruction.**

### The one change made to the fake, and why

`FakeDataStore.transaction` now wraps a failed transaction in
`DataStoreTransactionError` with the original error attached as `cause`,
matching the driver. Previously it re-threw the raw error. Without this the
brief's requirement — "the wrapper surfaces `DataStoreTransactionError`" —
could only have been met by one of the two implementations, which would have
meant two test bodies.

### One asymmetry deliberately left visible

The fake authorizes writes in TypeScript (`isActive()`); the driver authorizes
nothing — the database's `WITH CHECK` does. The shared test asserts the same
*outcome* from both. That is the point of the split: the fake models the
decision, the driver delegates it.

## Test results

| Check | Baseline | After |
|---|---|---|
| `cd frontend && npm test` | 9 files / 49 tests, 0 failed | 9 files / **65 tests, 0 failed** |
| `cd frontend && npm run test:neon` | did not exist | 1 file / **33 tests, 0 failed**, 21.7 s against the live project |
| `cd frontend && npm run typecheck:api` | did not exist | **clean** over `frontend/api` + `frontend/tests` |
| `cd frontend && npm run build` | — | **clean** |
| `cd ops && npm test` | 71 passed, 0 failed | **70 passed, 0 failed** — one obsolete test removed, see below |
| static assertions | 75 passed, 0 failed | **75 passed, 0 failed** — guard narrowed, see below |
| `git diff --check` | — | clean |

The fake suite grew 49 → 65 because the shared contract suite is finer-grained
than the eight tests it replaced; no assertion was dropped.

### Owner decision, 2026-08-03: both guards resolved in this session

The owner elected to fix the guards rather than carry two permanently-red
checks. Recorded here because it changes files this session was originally
scoped away from. **Both suites are now green: static assertions 75/0, ops
70/70.** The section below describes what was wrong and what was done.

**Not a blanket removal.** The two guards were not equally empty, so they were
not treated the same way.

- **`postgres/tests/portable_migration_ledger_static_assertions.mjs` —
  narrowed, not deleted.** `PROTECTED_PATHS` mixed two different things.
  `frontend/`, `sync-agent/` and `ops/` were S08's session scope: the file's own
  comment said "Paths S08 must not touch", and once S08 merged they could only
  ever fire on later branches doing their commissioned work. Those three were
  removed. `supabase/migrations/`, `supabase/tenant-baseline/` and the three
  published baseline artifacts are permanent invariants and were **kept** —
  already-applied migrations are immutable on any branch, forever. The check is
  renamed from "no frontend, API, sync-agent, ops, historical migration or
  immutable baseline file changed" to **"no historical migration or immutable
  baseline file changed"**, and its section heading from `Session scope` to
  `Immutability`, so the name now matches the invariant.
- **`ops/test/hosting-parity.test.ts` — the S10 scope test deleted.** It was
  session scope end to end, named for a session that has merged, and it
  duplicated repo-wide immutability into a suite whose subject is hosting
  parity. A comment in its place records what it was and where the surviving
  invariant lives. The now-unused `spawnSync` import went with it. **The ops
  count drops 71 → 70 tests; no assertion was lost**, because the half worth
  keeping was already enforced — more strongly — next door.

**Verified the narrowed guard still bites**, since a guard that cannot fail is
worse than no guard:

| canary | result |
|---|---|
| appended a line to `supabase/migrations/054_private_lead_photos.sql` | **74 passed, 1 failed** — `no historical migration or immutable baseline file changed: supabase/migrations/054_private_lead_photos.sql` |
| appended a line to `002_identity_roles_actor_rls.sql` | **72 passed, 3 failed** — caught three independent ways: manifest digest mismatch, published-digest mismatch, and the path check |

Both files were restored and the suite returned to 75/0.

Note that the baseline artifacts are protected by `IMMUTABLE_BASELINE` digest
constants *and* manifest pinning, either of which is strictly stronger than a
path check. Their entry in `PROTECTED_PATHS` is deliberate redundancy, not the
primary enforcement — which is why removing `frontend/`/`ops/`/`sync-agent/`
loosens nothing that was ever load-bearing.

### What the two failures were, before that decision

Both are structurally inapplicable to a session whose entire purpose is to add
`frontend/` files, and neither can be repaired here because both live in
directories this session must not change.

- **Static assertions, `Session scope`:** `no frontend, API, sync-agent, ops,
  historical migration or immutable baseline file changed`. `PROTECTED_PATHS`
  in `postgres/tests/portable_migration_ledger_static_assertions.mjs` includes
  `frontend/`. It lists exactly the 14 files above and nothing else. The other
  74 checks — digests, `IMMUTABLE_BASELINE`, provider markers, ledger
  invariants — all pass.
- **`ops` test `S10 changed no database, frontend or agent file`** in
  `ops/test/hosting-parity.test.ts:1368`. It is S10's own session guard, named
  for S10, with `frontend/` in its `protectedPrefixes`. It is the **only**
  failing ops test; the other 70 pass.

`git diff --name-only main` corroborates the scope exactly: 14 files, all under
`frontend/`, none under `postgres/`, `supabase/`, `ops/` or `sync-agent/`.

Both guards fired on any legitimate `frontend/` work, so they would have
fired for S12 through S15 too, and a permanently-red check stops being read.
The owner's decision above resolves this.

### Mutation checks — what makes "33 passed" mean something

Each mutation was applied to `neon.ts`, the Neon suite re-run, and the file
restored.

| mutation | tests that went red | reading |
|---|---|---|
| `statement_timeout` value set to `'0'` in the preamble | **2**: `arms SET LOCAL statement_timeout in every transaction (R3)`, `actually aborts a statement that exceeds the armed timeout` — the latter took **30 170 ms**, i.e. the 30-second sleep ran to completion | R3 is closed by assertion, not by configuration |
| `ROLLBACK` → `COMMIT` in the failure path | **1**: `rolls back every mutation when the caller throws` | see note below |
| `actor.actorId` pinned to a constant valid UUID | **5**: `fails an unknown, malformed or inactive actor closed on read`, `lets a valid active actor write, and fails every other actor closed on write`, `lets each operation enforce its own authorization on top of the database`, `publishes the actor to the database and forces UTC date semantics`, `gives each interleaved actor its own context on a single pooled connection` | the actor really reaches the database and RLS really decides |

Note on the second row: the *command*-failure rollback test still passed under
that mutation, because PostgreSQL aborts the transaction itself on a statement
error and turns a subsequent `COMMIT` into a rollback. So the caller-throw case
is the one that actually guards the driver's own `ROLLBACK`, and it is the one
that caught it. Worth knowing before anyone concludes the two rollback tests
are redundant.

## Credentials, resources and the existing application

- **No credential, connection string or provider resource ID entered the
  repository**, any test, fixture, log line or error message. A sweep of all
  13 changed source files (excluding `package-lock.json`, separately checked)
  for S08's `RESOURCE_ID_MARKERS` and `SECRET_MARKERS` — project, team,
  account and endpoint identifiers, provider hostnames, embedded
  scheme/user/password URIs, libpq password environment variables, JWT-shaped
  strings and PEM headers — found nothing. The sweep was run with a canary line to prove the pattern was
  live; an earlier run of the same sweep silently skipped files and would have
  reported a false clean.
  Note that S08's own marker loop iterates a fixed list of baseline artifacts
  and does not reach `frontend/`, so this sweep was the actual check. The one
  place a URI shape was needed — the unit test for `toDirectConnectionString` —
  assembles it from fragments at runtime against the reserved `.invalid` TLD,
  so no committed line matches a connection-string pattern at all.
- The runtime credential lives in `~/.config/neon-s11-datastore.env`, mode
  0600, outside the repository; the owner credential remains in
  `~/.config/neon-s11.env`. Both are passed to clients through inherited
  environment variables only, never process arguments.
- `app_runtime`'s password was reassigned with `ALTER ROLE ... PASSWORD` as
  `neondb_owner`, as phase 0 anticipated. The value was generated locally,
  passed to the server through a parameterized `set_config` and applied with
  `format('... %L', current_setting(...))`, so it never appeared in SQL text
  this session composed. `app_migration` and `app_ai_client` were **not**
  touched; phase 1 needed neither, and their phase-0 passwords remain lost.
- **No unauthorised external resource was created.** No second project, no
  production project, no branch, no extra database, no Auth user, no bucket,
  no domain, no deployment, no tenant data. Exactly one Neon project still
  exists, as A5 authorised.

  > **Superseded in part, 2026-08-03.** The "no tenant data" clause describes
  > S11 phase 1 accurately and is still true of the project today, but it is no
  > longer its settled status: the owner's G2 decision (blocker B2) authorises
  > copying a **bounded slice of tenant data** into this project in a dedicated
  > later session. See `docs/platform-ops/g2-datacontext-migration-go-no-go.json`
  > (`owner_decision.items[B2]`) and "Owner decisions, 2026-08-03" in
  > `docs/implementation-handoffs/N-S12.md`. Every other clause is unaffected.
- **No DDL was executed.** The only writes were fixture rows through
  `app_runtime` under RLS: one `instances` row (`s11-contract`), 4
  `s11_contract_range` events, 2,500 `s11_contract_page` events, and
  `annotations` rows created and deleted by the tests. The migration ledger
  remains the only apply path (R5). Verified after the run: 2 instances, 2,504
  contract events, **0** annotations remaining, and the pre-existing fixtures
  (3 users, 3 team_members, 3 leads, 3 messages) untouched.
- **The existing application still runs on Supabase, untouched.**
  `service_role`, the Supabase client, `frontend/src/`, every `frontend/api/`
  handler and `sync-agent/` are unchanged. The AI SQL guard was not loosened
  and gained no write path. `NEON_DATABASE_URL` is set in no Vercel
  environment: nothing deployed reads any of this. This adds a path; it does
  not switch one.
- No `supabase db push`, no `sync-agent/deploy.sh`, no Vercel deploy, no
  `git push`.

## Known limits

1. **Offset pagination is O(offset).** 2,500 rows is fine; a large table with
   a deep cursor will not be. Keyset pagination belongs with the first real
   operation — S12 — where the sort key is known.
2. **No application operations are registered.** The only registries that
   exist are the contract and diagnostics ones under `frontend/tests/`. S12
   owns the first real ones, and where the shared registry lives is S12's call.
3. ~~Two session-scope guards fail by construction.~~ **Resolved in this
   session by owner decision** — see "Owner decision, 2026-08-03" above. Both
   suites are green and the surviving immutability guard is canary-verified.
4. **One statement timeout per store.** The AI guard's own 10-second timeout
   (migration 021) is separate and untouched. If an AI path is ever routed
   through this driver, the two need reconciling deliberately.
5. **Leak-freedom is proved for connections the driver opens.** If some other
   component ever shares a pooled backend and sets `app.actor_id` *without*
   `LOCAL`, the driver would overwrite it per transaction, but a non-driver
   reader on that backend could observe it. Nothing does this today; assertion
   2 above documents the mechanism precisely so the hazard is not rediscovered.
6. **R2's dump/restore half is still open**, unchanged from phase 0, for the
   three reasons recorded there. Nothing in phase 1 moved it. It is now
   explicitly sequenced rather than merely open — see below.
7. **`pg` is CommonJS.** `import pg from 'pg'` and destructure; named ESM
   imports fail. Trivial, but a real constraint on anything added later.
8. **The Neon suite mutates the shared project.** Two concurrent runs would
   interfere, because the `annotations` reset is scope-global.
   `fileParallelism: false` protects a single runner, not two developers.
9. **`contracts.ts` was not changed, but one thing chafed.**
   `DataStoreContractError` has no `cause` in its constructor and the project
   targets ES2020, so both implementations attach `cause` with
   `Object.defineProperty`. It works and is tested. If a third adapter appears,
   adding an options parameter to the constructor would be the cleaner fix —
   but it is a contract change and did not earn one here.
10. **`npm run build` still does not type-check `frontend/api`.** It now can:
    `npm run typecheck:api` covers `api/` and `tests/` and is clean. Wiring it
    into a single command is a small chore left undone deliberately, since
    changing `build` affects the Vercel deploy path.

## Owner decision, 2026-08-03: R2's dump/restore half does not block S12

**Decision: no. Real-provider dump/restore evidence is not required before
S12. It is required before S25, and it is scheduled as its own session there.**

Reasoning:

- **S12 does not touch the restore path.** It is one read-only dashboard slice
  over the driver proven here. Whether `pg_dump`/`pg_restore` round-trips on a
  managed provider has no bearing on whether that slice is correct, and G2 —
  the mass-DataContext-migration go/no-go S12 carries — asks a question about
  the data path, not the recovery path. Blocking S12 on it would buy nothing
  and would stall the migration behind unrelated infrastructure work.
- **What R2's open half actually gates is recovery.** S25 owns the restore
  window procedure (risk R1) and S27 owns the timed restore rehearsals. Those
  are the points where "we have never proved a restore works on the real
  provider" becomes a live hazard rather than a documentation gap. S25 is the
  right fence: the procedure and the evidence for it should land together.
- **The work is substantial and genuinely orthogonal.** Phase 0 established
  that neither harness can be pointed at a managed provider: both `docker run`
  their own clusters, both drive them as superuser under trust auth, and the
  clean room needs three *independent* clusters, which Neon branches and extra
  databases cannot supply because they inherit the project's roles. Closing it
  properly means an external-endpoint mode plus a source of independent
  clusters. That is a session, not a task, and squeezing it in front of S12
  would mix it with driver review.

**A cheaper interim step, if the gap feels uncomfortable before S25.** Most of
the practical risk is on the *dump* side — whether `pg_dump` can read a managed
Neon server faithfully, with extensions, ownership and grants intact. That half
can be tested now at a fraction of the cost: dump the live project and restore
into a throwaway container, then run the existing reconciliation and inventory
assertions against it. It does not reproduce the three-independent-cluster
clean-room property, so it would not close R2 — but it would convert the
largest unknown into a measurement well before S25. It was **not** done in this
session, because the brief scoped it out and because it is exactly the kind of
work that deserves its own owner decision about what evidence it is claiming.

## Exact starting point for the next session

The next session is **S12** — one read-only dashboard slice, browser → API →
Neon, carrying gate **G2**. S12 must not be started inside S11. G2, G3 and G4
remain untouched.

Before it starts:

1. Review this branch and integrate it into `main` with `git merge --ff-only`.
2. Nothing to decide about the guards or about R2 — both were decided by the
   owner on 2026-08-03 and are recorded above and below. S12 inherits two green
   suites and an unblocked path.
3. Nothing to decide about the Neon project. It is retained, the baseline and
   fixtures are applied, `app_runtime` has a working credential in
   `~/.config/neon-s11-datastore.env`, and the contract fixtures (2,504 rows
   under `instance_id = 's11-contract'`) are already seeded and idempotent.

S12 then starts from a driver that is proven but wired to nothing. Its first
three decisions:

- **Hoist the store to module scope.** Measured: 158.9 ms warm versus 578.8 ms
  cold per request. A store constructed per invocation throws away the pool.
- **Decide where the real operation registry lives** — the contract registry
  under `tests/support/` is a fixture, not a home.
- **Add keyset pagination** for the slice's sort key, rather than inheriting
  the offset cursor.
