# N-IDENTITY-LEDGER — identity write path, resolver, roster and store schema

Inserted session, no gate. One schema change to the tenant baseline, applied
through the migration ledger and nothing else.

| | |
|---|---|
| Base SHA | `43719c5` (`main`, "docs(neon): record the owner's G3 decision and close the gate") |
| Branch | `codex/neon-identity-ledger` |
| Commits | `7d82075`, then `abdc869` (this document is part of the second) |
| Phase | N4, between `G3` and `S17` |
| Mandate | `G3` owner decision, condition **C3**, which also folded **B4** into this session |
| Applied to a live provider project | **no** — an apply is prepared and requested at the end of this document |

## Why this session exists

The owner decided `G3` on 2026-08-03: `status = approved`, `decision =
accept-candidate`, all six conditions accepted unchanged. Condition **C3**
requires one migration-ledger session before `S17`'s admin endpoints, carrying
four changes to the same tables. The same decision folded **B4** — the roster
function that `G2` had sequenced as its own session — into this one, because it is
the same tables, the same ledger and the same reviewer. `B2`, the bounded
tenant-data copy, is untouched and remains its own session.

Order after `G3`: `[identity ledger] → S17 → [B2 data slice] → S13 → S18`.

Everything in this document was measured, not assumed. Where a design choice was
forced by something the clean room measured, the measurement is quoted.

## Preflight: all eight baselines matched before any edit

| Check | Expected | Measured |
|---|---|---|
| `frontend && npm test` | 10 files / 69 tests | **10 / 69** |
| `frontend && npm run test:neon` | 2 files / 55 tests | **2 / 55** |
| `frontend && npm run typecheck:api` | clean | **clean** |
| `frontend && npm run build` | clean | **clean** |
| `ops && npm test` | 70 passed, 0 failed | **70 / 0** |
| `portable_migration_ledger_static_assertions.mjs` | 75 / 0 | **75 / 0** |
| `spikes/s16-identity && npm test` | 8 files / 62 tests | **8 / 62** |
| `spikes/s16-identity && npm run test:neon` | 1 file / 6 tests | **1 / 6** |

## Changed files

New:

```
postgres/tenant-baseline/v1/004_identity_write_path_and_store.sql
postgres/tenant-baseline/v1/000_identity_store_role_bootstrap.sql
postgres/tests/portable_identity_write_path_catalog_assertions.sql
postgres/tests/portable_identity_write_path_behavior_assertions.sql
postgres/tests/portable_identity_store_isolation_assertions.sql
postgres/tests/portable_identity_write_path_ai_boundary_assertions.sql
postgres/tests/portable_identity_write_path_cleanroom.sh
docs/implementation-handoffs/N-IDENTITY-LEDGER.md
```

Modified:

```
postgres/tenant-baseline/v1/ledger.manifest.json      step 4 + role_bootstrap_extensions
postgres/tenant-baseline/v1/README.md                 documents step 4 and the prerequisite
postgres/tenant-baseline/v1/restore_window_open.sql   extends the window to the identity store
postgres/tenant-baseline/v1/restore_window_close.sql  reverses and asserts the same
postgres/tests/portable_migration_ledger_static_assertions.mjs   counts moved, see below
postgres/tests/portable_migration_ledger_tests.sh     expects four steps; prepares the new role
postgres/tests/portable_dump_restore_cleanroom.sh     runs the prerequisite in all three clusters
postgres/tests/portable_restore_reconciliation.sql    counts moved + identity store coverage
```

The two `restore_window_*` files were not in the plan for this session. They are
here because the dump/restore harness proved they had to be — see "The finding
that changed the design".

No file under `frontend/`, `sync-agent/`, `ops/`, `spikes/`,
`supabase/migrations/` or baseline `001`/`002`/`003` was touched. No application
code was written.

## The design call, its alternatives, and why the losers lost

### 1. The identity write path

**Chosen:** three `SECURITY DEFINER` functions in `public`, owned by `app_owner`,
`EXECUTE` granted to `app_runtime` alone, each gating itself on
`public.is_app_admin()`.

**Rejected: a distinct privileged login role for the admin endpoints.** Three
reasons, in order of weight:

1. It needs an eighth role in the seven-role control-plane bootstrap, and that
   file's digest is recorded in `app_ledger.role_bootstrap` — a **single-row,
   append-only** table. The runner hard-fails with `role_bootstrap_sha_mismatch`
   when the recorded digest and the manifest disagree, and the row cannot be
   updated, deleted or replaced. Editing that bootstrap would therefore
   permanently break the ledger of every already-provisioned database, including
   the live tenant, with no in-contract remedy and no way to apply any further
   step to it. This is the single most consequential finding of the session and it
   constrains every future role decision, not just this one.
2. A second credential to distribute, rotate and keep out of the repository.
3. A login role holds blanket DML on the identity tables for the whole request
   path. The functions expose three specific, validated operations instead.

**Why the authorization is inside the function and not on the grant.** The owner's
condition was "an ordinary member must not be able to reach it, and that must be
proved by a test rather than by a grant statement". Both an admin and an ordinary
member arrive on the same `app_runtime` connection with the same `EXECUTE` grant;
only the actor differs. So the grant *cannot* be the control, and the function's
own `is_app_admin()` check is. The proof is behavioural, from a real `app_runtime`
session, and a mutation check confirms it bites (below).

The three functions, and what each does **not** do:

| Function | Writes | Does not |
|---|---|---|
| `identity_admin_invite_member(email, name, role, provider, subject)` → `jsonb` | one `users` row, one `team_members` row, one `user_identities` row, in one transaction | does not touch the identity store, so an invite is not yet atomic across both stores (see "the first thing S17 needs"); does not send email; does not create a credential |
| `identity_admin_set_member_active(user_id, active)` → `jsonb` | `users.active` and `team_members.active` together | does not revoke sessions — the candidate owns session state and `S17` owns the revocation call (`C2`); does not delete anything |
| `identity_admin_set_member_role(user_id, role)` → `jsonb` | `team_members.role` | does not touch `users`; does not bypass the final-admin invariant |

All three take the **same advisory lock** the baseline's `admin_update_team_member`
takes (`hashtext('outreach_deck_active_admin_invariant')`), so the final-active-admin
invariant is serialised across every path that can change the roster, not merely
within each function.

**A correction to the premise, worth recording.** `F6` lists four denied attempts,
one of which is `UPDATE team_members`. Direct DML on that table is indeed denied,
but a write path for it already existed: the baseline's
`admin_update_team_member` is `SECURITY DEFINER` and already granted to
`app_runtime`. It is keyed by member id and — unlike the three functions above —
performs **no authorization of its own**; under the old provider, being reachable
only by the service role was the authorization. It is immutable and unchanged.
`S17` should prefer `identity_admin_set_member_role`, which is keyed the way the
rest of the identity surface is keyed and refuses a non-admin caller itself.
What was genuinely missing is every write to `public.users` and
`public.user_identities`, and any way to create a member at all.

### 2. `identity_resolve_actor(provider, subject)`

Reviewed from the `S16` draft rather than copied. The draft was sound; adopted
essentially as proposed, with the header rewritten to state the exposure in terms
of what it refuses. What it **does not** do is now asserted rather than argued:

- not an enumeration primitive — matching is by equality, so `('fixture','%')`,
  `('%','%')` and `('fixture','')` all return zero rows;
- an unknown subject, an inactive user and an inactive membership are
  indistinguishable — all three are zero rows, so a caller learns nothing about
  who exists;
- exposes no email, no name, nothing about any other person, and cannot write.

It is the **one** function in the step deliberately reachable with no actor
context, because it is what establishes the actor. That is asserted explicitly so
a later reader does not "fix" it.

The rejected account-side `canonicalUserId` proposal appears nowhere in the
baseline; a catalog assertion fails if that column is ever added.

### 3. The candidate's own schema

Four tables in schema `identity`, owned by role `identity_store`. The DDL is the
candidate's own `compileMigrations()` output with exactly two deliberate
differences: the schema is not called `identity_spike`, and `canonicalUserId` is
absent.

`identity."user".id` stays `text` — a provider subject belonging in
`public.user_identities.provider_subject` — so it cannot be joined to the `uuid`
`public.users.id` even by accident. There is **no foreign key in either direction**
between `identity` and `public`, asserted by catalog query.

Privileges, asserted in both directions: nothing to `PUBLIC`; no `USAGE` for
`app_runtime`, `app_readonly`, `app_machine`, `app_system` or `app_ai_runner`; and
`identity_store` holds no `USAGE` on `public` and `SELECT` on **no** relation
there — so a compromise of the identity service is not a read of the workspace it
authenticates people into. `account.password` holds the candidate's hash and no
product role can read it. No RLS in the schema: the only principal with any
privilege is the table owner, and a policy evaluated for the owner does nothing.

**The eighth role, and why it is a separate artifact.**
`000_identity_store_role_bootstrap.sql` is an additive control-plane prerequisite
declared in the manifest under a new `role_bootstrap_extensions` block, pinned by
digest and asserted. It creates `identity_store` (LOGIN, no other attribute; the
credential is assigned out of band exactly as for `app_runtime`) and grants
`app_owner` membership `WITH INHERIT FALSE`, mirroring the existing
`GRANT app_ai_runner TO app_owner` which exists for the same reason. Roles are
cluster objects that `pg_dump` never carries, so this could not live inside the
step: a restore target must find the role already present or the restore of an
object owned by it fails.

**Two ownership orderings that do not work**, both measured in the clean room and
both now recorded in the artifact so nobody re-discovers them:

- `CREATE SCHEMA identity` as `app_owner` then `ALTER TABLE … OWNER TO
  identity_store` fails with `permission denied for schema identity`. Since
  PostgreSQL 16 the incoming owner must hold `CREATE` on the schema, and the store
  holds nothing on a schema `app_owner` owns.
- Transferring the schema first and the tables second fails the same way in the
  other direction: once the schema belongs to `identity_store`, `app_owner` has no
  `USAGE` on it and cannot alter anything inside it — not the tables, not even the
  schema `COMMENT`.

What works, and what the artifact does: `CREATE SCHEMA identity AUTHORIZATION
identity_store`, then `SET ROLE identity_store` to create the tables, indexes,
comment and revokes as their own owner, then `SET ROLE app_owner` so the step ends
as it began and the runner records `app_migration/app_owner`.

### 4. The B4 roster function

`public.team_roster()` returns `id, user_id, name, email, role, active,
created_at` for every member, to any **active member** actor.

The gate is membership, not admin, because an ordinary member needs the roster to
see who owns a conversation. The column set is not a widening: today's client
already reads `id,name,active,created_at,auth_user_id,email,role` for all members
(`frontend/src/lib/DataContext.tsx:622`), so this is what parity requires once
reads move behind the server-owned API. `auth_user_id` is replaced by the
portable `user_id`.

It exposes nothing from `public.users` beyond the id already in
`team_members.user_id`, no provider subject, no identity-store row, no password
material, and no ability to write. There is no admin-only projection: it is the
same seven columns for every caller. With no actor, a malformed actor, an unknown
actor or an inactive one it returns **zero rows**, because `is_active_team_member()`
is false.

Granted to `app_runtime` only. `app_readonly` was deliberately left out — nothing
reads through it yet, and a later step can grant it when something does.

## Keeping the AI SQL guard and the write surface separate

The guard is not touched, gains no write path and is not loosened. Three
independent things keep it away from the new functions:

1. **The ACL.** Every new function follows `003`'s pattern exactly: `REVOKE ALL …
   FROM PUBLIC`, then `GRANT EXECUTE … TO app_runtime`. `app_ai_runner` — the role
   the guard executes as — and `app_system` — the only role that may execute the
   guard — receive nothing. Asserted per function, per role, in the catalog file.
2. **Measured from inside the sandbox.** The AI boundary file runs as the AI
   execution principal and asks the guard itself whether `app_ai_runner` holds
   `EXECUTE` on any of the five functions, and whether it holds `USAGE` on the
   `identity` schema. Both must be false.
3. **The guard's own filter is unchanged** — still a single `SELECT`/`WITH`, still
   refusing an `UPDATE`, asserted in the same file so a future loosening shows up
   here.

Point 2 exists **because of a mutation check, not by foresight**. Calling a write
function through the guard and catching `insufficient_privilege` turned out to be
insufficient evidence: the write functions also refuse a non-admin actor with the
same SQLSTATE 42501, so when `EXECUTE` was deliberately granted to
`app_ai_runner`, the call-based tests still passed — the guard *did* reach the
function and the function's own gate turned it away. That is welcome defence in
depth, but it means the call tests alone cannot distinguish "the sandbox has no
grant" from "the gate refused it". The direct ACL measurement can, and it is what
fails if the grant is ever widened. This is written down because the weaker
version of the test would have looked entirely convincing.

## The finding that changed the design: an isolated schema cannot be dumped

The first complete version of this step isolated the identity store from
*everything*, `app_owner` included. It applied cleanly, passed every assertion,
and broke the backup:

```
pg_dump: error: query failed: ERROR:  permission denied for schema identity
pg_dump: detail: Query was: LOCK TABLE ... identity."user", identity.session,
                            identity.account, identity.verification IN ACCESS SHARE MODE
```

The documented dump runs as the non-superuser `app_migration` login with
`--role=app_owner`. `app_owner` had no `USAGE` on the store's schema, so the whole
database could no longer be dumped — and a schema that cannot be dumped cannot be
restored, which would have quietly destroyed the property the entire ledger exists
to provide. Nothing in the step's own clean room could have caught it; only the
dump/restore harness did, which is the argument for running it even though it was
not on the check list.

**The fix, and why it is not a softening.** Step 004 grants `app_owner` `USAGE` on
the schema and `SELECT` on the four tables — issued **by** `identity_store`, the
owner. This confers no authority `app_owner` did not already hold: the
control-plane prerequisite makes it a member of `identity_store`, so it can
already reach every one of these tables with an explicit `SET ROLE`. The grant
only removes the need for one, which `pg_dump` has no way to issue. It is `SELECT`
and `USAGE` only, and the isolation that matters is unchanged and still asserted:
`app_runtime`, `app_readonly`, `app_machine`, `app_system`, `app_ai_runner` and
`PUBLIC` get nothing, in either direction.

**The second half of the same problem: restore.** Two statements in the resulting
dump cannot be satisfied by a clean target, and they fail in opposite ways:

- `ALTER SCHEMA identity OWNER TO identity_store` **errors**, because the incoming
  owner of a schema must hold `CREATE` on the database and the store never has it;
- `GRANT USAGE ON SCHEMA identity TO app_owner` and the four table grants only
  **warn**. `pg_restore` replays them as `app_owner`, which is a member of
  `identity_store` but `NOINHERIT`, so they silently do nothing — and
  `pg_restore --exit-on-error` reports success. The restored tenant would then be
  one that cannot itself be dumped.

This is precisely the failure shape `S08` documented for the AI SQL guard, so it
gets precisely the same remedy: `restore_window_open.sql` now also grants
`identity_store` `CREATE` on the database and lets `app_owner` inherit
`identity_store` for the duration; `restore_window_close.sql` reverses both,
refuses to succeed while either is open, and asserts that the store's ownership
*and* the backup principal's read actually came back.
`portable_restore_reconciliation.sql` asserts the same properties independently.

Measured after the fix, on `postgres:17-alpine` 17.10: two independent clean
applies of four steps each produced **739** identical inventory lines, the
inventory diff between them was empty, both recorded the same ledger, `pg_dump`
succeeded as a non-superuser, `pg_restore` completed **with no error and no
warning**, the window closed and verified, the post-restore inventory was
identical to the pre-dump inventory, and sequences, row counts and ledger rows
survived unchanged.

## Assertion counts that moved, and why

### `portable_migration_ledger_static_assertions.mjs`: 75 → **109**, 0 failed

Every delta is deliberate; none is a weakening.

| Δ | Where | Why |
|---|---|---|
| ±0 | `manifest declares three steps in order 1 -> 2 -> 3` → `four steps … -> 4` | The manifest declares a fourth step. Same assertion, new expectation. |
| ±0 | `manifest declares the seven-role bootstrap dependency` → `manifest **still** declares …` | **It did not move, and that is the finding.** The session needed an eighth role and deliberately did not add it here; the assertion now pins seven with the reason attached, so a later session cannot quietly edit that bootstrap. |
| +3 | new: extensions declare their roles and owning step; no extension role duplicates a bootstrap role; every step needing an extension names it | The new `role_bootstrap_extensions` block needs its own structural checks, otherwise it is documentation rather than a contract. |
| +2 | pinned-digest loop | Two more pinned artifacts: step `004` and the extension bootstrap. |
| +2 | `IMMUTABLE_BASELINE` | `004` joins the published-digest map (unchanged-since-session, and pinned-at-published-digest). |
| +24 | `S08_ARTIFACTS` sweep | Eight new files x three sweeps each (provider marker, secret, resource id). A new baseline artifact absent from this list is never swept, which is why it was extended rather than left alone. |
| +3 | `EXECUTABLE_SCRIPTS` hygiene | The new clean-room script: executable, refuses an implicit image pull, removes its containers. |
| **+34** | | 75 → 109 |

`004` was **not** added to `PROTECTED_PATHS` in this session. That list is checked
against the diff since the merge base, so a session's own new file would flag
itself — which is exactly why `S08` pinned `001`–`003` rather than `S05`–`S07`
pinning their own. The session after this one should add
`postgres/tenant-baseline/v1/004_identity_write_path_and_store.sql` to
`PROTECTED_PATHS`; the digest map already protects it in the meantime.

### `portable_restore_reconciliation.sql`: two counts moved

Not in the brief, and found by reasoning about what else applies the manifest: the
dump/restore harness applies through the ledger runner, so it now applies four
steps, and this file hard-codes post-restore inventory figures.

| Was | Now | Why |
|---|---|---|
| `13` portable functions | **`18`** | `13` from `S07` plus the five step-004 functions. |
| `8` `SECURITY DEFINER` functions | **`13`** | All five new functions are `SECURITY DEFINER` by design — they exist to hold a privilege the calling role does not have. |
| `3` ledger rows, order `001 → 002 → 003` | **`4`**, order `… → 004` | The ledger legitimately has a fourth row, and the order string is checked literally. |

Left alone, these two would have failed the moment anyone ran the restore drill,
and the failure would have looked like restore corruption rather than an expected
baseline change.

Added in the same file: the identity store must survive a restore with **four
tables owned by `identity_store`**, and `app_runtime` must not gain `USAGE` on the
schema across a restore. The inventory *snapshot* that this file diffs is scoped to
`public` and `app_ledger`, so the identity schema is outside the line-by-line
comparison; these counts are the coverage instead. See "Known limits".

### `portable_functions_triggers_ai_guard_*`: unchanged

The `S07` inventory pins **13 functions and 12 triggers in the `003` artifact**,
and both figures are still exactly right: `003` is untouched, and step `004` adds
five functions and **no trigger**. (The brief's "function count still 12" appears
to transpose the two: 12 is the trigger count, 13 the function count. Triggers are
unchanged at 12; functions in `003` unchanged at 13; functions in `public` are now
18 and asserted at 18 in two places.)

## Clean-room evidence

Every apply went through `postgres/tools/portable_migration_ledger.mjs`. The
runner is unchanged — a deliberate choice: the step self-checks its prerequisite
in SQL instead, so the contract the live project already verifies against did not
move.

`postgres/tests/portable_identity_write_path_cleanroom.sh` — **18 passed, 0
failed**, PostgreSQL 17.10:

- fresh apply of `001 → 002 → 003 → 004` into an empty, control-plane prepared
  database; the ledger records four steps in canonical order;
- catalog assertions as `app_migration`;
- behaviour assertions as **`app_runtime`**, the real request principal;
- store isolation assertions as **`identity_store`** itself;
- AI boundary assertions as **`app_system`**, via the test-only `app_ai_client`
  login;
- `app_runtime` cannot `SET ROLE` `app_owner`, `app_migration` or `identity_store`;
- **re-apply is an idempotent no-op** — `ledger already at step 4/4; nothing to
  apply`, ledger row count unchanged, and `verify` reports `ledger consistent: 4/4
  steps, order 1 -> 2 -> 3 -> 4`;
- the store's rows survive the re-apply, so the step is not destructive on a
  second run;
- **the prerequisite check bites**: on a second, never-prepared cluster the apply
  fails with `[step_apply_failed]` naming
  `000_identity_store_role_bootstrap.sql`, and the database is left at `3` applied
  steps with `to_regnamespace('identity') IS NULL` — nothing partial landed. The
  partially applied ledger still verifies with `--allow-partial`, so the remedy is
  to run the prerequisite and apply again, never to edit the ledger. Running the
  prerequisite then applying succeeds.

The negative case needs its own cluster **because the prerequisite is
cluster-scoped**: every further database in an already-prepared cluster finds
`identity_store` waiting. The unprepared case only exists on a cluster that has
never run it — a fresh provider project, or a restore target.

Regression harnesses, all re-run:

| Harness | Result |
|---|---|
| `portable_migration_ledger_tests.sh` | **19 passed, 0 failed** (matches `G1`) |
| `portable_identity_roles_rls_cleanroom.sh` | **passed** |
| `portable_functions_triggers_ai_guard_cleanroom.sh` | **passed** |
| `portable_dump_restore_cleanroom.sh` | **passed** — and it is the harness that found the dump defect above |

### The mutation check: four deliberate breakages, four detections

Run against live clean-room databases after a successful apply, so the pinned
artifact was never edited. Not committed — it exists to break things.

| Mutation | Detected by | Error |
|---|---|---|
| drop the `is_app_admin()` gate from the invite function | behaviour assertions, and a surgical single-case run of exactly the non-admin block | `a non-admin member invited someone` |
| `GRANT EXECUTE … TO app_ai_runner` | AI boundary assertions (the direct ACL measurement) and catalog assertions | `app_ai_runner holds EXECUTE on public.identity_admin_invite_member, which must be app_runtime only` |
| grant `app_runtime` `USAGE` + `SELECT` on the identity store | behaviour and catalog assertions | `app_runtime read the identity store user table` |
| grant `identity_store` `USAGE` on `public` + `SELECT` on `leads` | store isolation and catalog assertions | `identity_store read public.leads` |
| *control:* no mutation | all four files pass | — |

The surgical run matters: the first mutation was initially "detected" by an
unrelated validation assertion firing earlier in the file, which would have been a
false positive for the property under test. The single-case rerun proves the
non-admin denial itself fires.

## The Neon apply this session is asking for, and its blast radius

**Nothing was applied to the live project.** It is running the baseline at
`3/3`; the manifest now declares four steps, so the project is one step behind by
construction. That is drift the ledger is designed to surface, not damage:
`verify --allow-partial` passes; a plain `verify` correctly reports
`incomplete … pending [4]`.

The apply has **two parts, in this order**, and both need owner authorisation:

1. **Control plane, as the provider's privileged principal** (the same one that
   ran the seven-role bootstrap):
   `000_identity_store_role_bootstrap.sql`.
   Creates the `identity_store` role, gives it `LOGIN` and a role-level
   `search_path`, and grants `app_owner` membership `WITH INHERIT FALSE`. Nothing
   else. It is re-runnable. **A credential for the new role still has to be issued
   out of band** — the artifact deliberately sets none, and no `S17` work can
   connect as the store until the owner does.
2. **Ledger, as the non-superuser `app_migration` login:**
   `node postgres/tools/portable_migration_ledger.mjs apply`, which applies step
   `4` only and records it.

What it changes: adds one schema (`identity`) with four empty tables, and five
functions in `public`. What it does **not** change: no existing table, view,
policy, function, trigger, index or grant; no row of business data; nothing the
running dashboard reads or writes. The dashboard is still on the old provider and
does not connect to this project at all.

Reversibility: the ledger has no down migrations by contract. Reversal is a
break-glass action — `DROP SCHEMA identity CASCADE` plus five `DROP FUNCTION`s —
which would leave an applied ledger row disagreeing with the database, i.e.
deliberate, visible drift. Worth stating plainly: **applying step 4 is
effectively one-way inside this contract.** The blast radius is small and the data
loss risk is nil (the four tables are empty), but the ledger row is permanent.

Recommended sequence, if approved: run part 1, run part 2, then re-run
`portable_identity_write_path_catalog_assertions.sql` against the project as
`app_migration` — the same file the clean room used, which is the point of writing
it as a file rather than as script inlines.

## Invariants confirmed

- **The running dashboard is untouched.** No `frontend/` file, no
  `sync-agent/` file, no `supabase/migrations/` file, no application code of any
  kind. The dashboard still runs on the old provider, unchanged, and its build,
  tests and typecheck are re-reported below.
- **The immutable baseline is intact.** `001`, `002`, `003` byte-identical at
  their published digests, verified by both the `IMMUTABLE_BASELINE` map and the
  merge-base diff check. `supabase/migrations/` untouched.
- **The AI SQL guard is not loosened and gains no write path.** Unchanged file,
  unchanged owner, unchanged grant, unchanged statement filter — and now proved
  from inside the sandbox that it cannot reach any new function or the store.
- **No credential, connection string or provider resource identifier entered the
  repository.** The full sweep runs over every changed file, including this
  document, with `RESOURCE_ID_MARKERS` and `SECRET_MARKERS`. A canary test
  confirmed the sweep is live rather than vacuous: a fake endpoint host and a fake
  connection string were each inserted into a changed file in turn, the assertions
  failed on them, and the canaries were removed.
- **Nothing was created on any provider.** No project, database, role, bucket,
  deployment or user. The one provider action this session needs is requested
  above, not taken.

## Known limits

1. **An invite is not yet atomic across both stores.** The three write functions
   touch only the canonical tables. `F8`'s "one SQL transaction across both
   stores, no compensating write" needs a single principal that can write both
   halves, and `app_runtime` deliberately cannot write `identity`. This was left
   for `S17` on purpose rather than guessed at: the missing function's parameter
   list *is* the candidate's column set and its hashing contract, and pinning that
   into the tenant baseline before `S17` exists is exactly the coupling `F8` warns
   about. See the next section for the two ways out.
2. **`app_owner` can read the identity store.** Deliberate and argued above: the
   backup principal must be able to dump it, and membership already gave it the
   same reach. If a future requirement is that *nothing* outside the store can
   read it, the backup procedure has to change first — a dump-side window, or a
   separate dump per schema — and that is a change to `G1`'s procedure, not to
   this step.
3. **The dump/restore snapshot does not cover the `identity` schema
   line-by-line.** `portable_schema_inventory_snapshot.sql` is scoped to `public`
   and `app_ledger`, and widening it would change the `733`-line figure recorded
   in `G1`'s evidence. Instead, `portable_restore_reconciliation.sql` now checks
   the store's table count, ownership and the absence of an `app_runtime` grant
   across a restore. Widening the snapshot properly belongs to the session that
   next touches the restore harness, or to an owner-approved re-baseline of the
   `G1` figures.
4. **`team_members.email` has no unique constraint.** The invite function refuses
   a duplicate case-insensitively, but two rows could still be created by the
   baseline's older `admin_update_team_member` path or by direct owner DML. Adding
   a constraint to a table that already holds production rows is a data-dependent
   decision, not a schema step, and it is listed here rather than done.
5. **`004` is not yet in `PROTECTED_PATHS`** — see the assertion-count section for
   why, and for who should add it.
6. **The `identity_store` credential does not exist yet.** Deliberate: the
   artifact sets no password, and issuing one is the owner's action.
7. **No `identity` schema RLS.** Correct for one-tenant-per-database, and stated
   so a multi-tenant-per-database change knows to revisit it.

## Exact starting point for S17

Start from this branch merged to `main`. The baseline gives `S17`:

```
public.identity_resolve_actor(provider, subject) -> (actor_id uuid, role text)
public.team_roster() -> id, user_id, name, email, role, active, created_at
public.identity_admin_invite_member(email, name, role, provider, subject) -> jsonb
public.identity_admin_set_member_active(user_id, active) -> jsonb
public.identity_admin_set_member_role(user_id, role) -> jsonb
schema identity: "user", "session", "account", "verification"  (owned by identity_store)
```

Do these first, in this order:

1. **Decide the cross-store invite.** Two sanctioned options, and it is a design
   decision rather than a lookup:
   - *one more additive ledger step* (`005`) granting the identity tables' DML to
     `app_owner` and adding a single `SECURITY DEFINER` function that writes both
     halves in one transaction. No control-plane action, no new role, no new
     credential — the role and its membership already exist after this session.
   - *two transactions with a compensating delete* on the store side. Works today
     with no schema change, and is what `F8` argues against.
2. **Connect as `identity_store`** for the candidate's own pool, never as
   `app_runtime`. The role-level `search_path` is already `identity, pg_temp`, so
   the candidate's unqualified `"user"` resolves correctly — proved in the clean
   room.
3. **Resolve the actor with `identity_resolve_actor`**, then set
   `app.actor_id` transaction-locally for every request. Delete
   `frontend/api/_lib/neonActor.ts`, the S12 development-only bridge — `B1` says
   it is removed in `S17`, and it is the last thing standing between the slice and
   a real session.
4. **Carry the other five G3 conditions**, which this session does not touch:
   `C1` origin/CSRF checks explicit in every environment with an assertion; `C2`
   `revokeSessionsOnPasswordReset: true` with an assertion; `C4` a pruning job for
   `session` and a chosen `expiresIn`; `C5` and `C6` as recorded in
   `docs/platform-ops/g3-auth-candidate-go-no-go.json`.
5. **Do not start `S18`**, and remember `B2` sits between `S17` and `S13`.

`S17` must not edit `001`–`004`, the manifest's existing entries, or any file in
`spikes/s16-identity/`.

## Commits

| SHA | Subject |
|---|---|
| `7d82075` | `test(neon): add the clean-room assertions for identity ledger step 004` — the five assertion/harness files, committed ahead of the artifact they cover so the evidence reads on its own |
| `abdc869` | `feat(neon): land the identity write path and store as ledger step 004` — the two baseline artifacts, the manifest, the restore window, the reconciliation and ledger-test updates, the README and this handoff |

Not pushed. The branch is local, as the brief requires.

## Checks

| Check | Result |
|---|---|
| `frontend && npm test` | 10 files / 69 tests, unchanged |
| `frontend && npm run test:neon` | 2 files / 55 tests, unchanged |
| `frontend && npm run typecheck:api` | clean |
| `frontend && npm run build` | clean |
| `ops && npm test` | 70 passed, 0 failed |
| `portable_migration_ledger_static_assertions.mjs` | **109 passed, 0 failed** (was 75; every delta accounted for above) |
| `portable_migration_ledger_tests.sh` | 19 passed, 0 failed |
| `portable_identity_write_path_cleanroom.sh` | 18 passed, 0 failed |
| `portable_identity_roles_rls_cleanroom.sh` | passed |
| `portable_functions_triggers_ai_guard_cleanroom.sh` | passed |
| `portable_dump_restore_cleanroom.sh` | passed — 739 identical inventory lines on two independent applies, `pg_restore` with no warning |
| `spikes/s16-identity && npm test` | 8 files / 62 tests, untouched |
| `spikes/s16-identity && npm run test:neon` | 1 file / 6 tests, untouched |
| `git diff --check` | clean |
| Secret sweep with canary | passed, canary caught |

Not run, deliberately: `supabase db push`, `sync-agent/deploy.sh`, any Vercel
deploy, any apply to the live provider project, and `git push`.
