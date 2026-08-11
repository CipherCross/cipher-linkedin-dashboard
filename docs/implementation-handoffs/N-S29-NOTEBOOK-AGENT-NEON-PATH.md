# S29 — make the notebook agent path runnable on Neon — handoff

> **SESSION 2 — 2026-08-11.** Session 1 stopped mid-flight with fixes G and H
> unreviewed and their gates never run. Session 2 read that diff, ran every ops
> gate against it, and fixed the one defect session 1 left named in the agent.
> All five fixes (A, D, G, H, J) are now complete, reviewed and green. Nothing
> is committed. See **Where session 2 stopped** at the end.

N-S27 step 5, N-S28 gate 8. Read `N-S28-OWNER-DATA-MIGRATION.md` first for the
owner's side; this file is the *tenant's* side of the same gate, plus the two
control-plane defects that block both.

The goal: a `uitop` notebook can sync into Neon with **no Supabase credentials**
and can self-update from the signed R2 release channel.

**Status in one line: the code is complete and green; the path is still dark,
because everything that remains is provisioning the owner has to do.** That
distinction is the whole point of this session — the trace that opened it found
three separate things that were "done in code" and dead in practice, and this
file is written so that nobody reads this one the same way.

## What is code-complete versus provably working

| | Code | Deployed | Proven against a real notebook |
| --- | --- | --- | --- |
| `/api/import` serves GET (fix A) | ✅ | ❌ | ❌ |
| Agent Supabase-off mode `only` (fix D) | ✅ 1.15.0 | ❌ published nowhere | ❌ |
| `ops` role passwords (fix G) | ✅ | ❌ Worker not deployed | ❌ |
| `APP_TENANT_ID` in the contract (fix H) | ✅ contract `v4` | ❌ | ❌ |
| R2 release bucket (finding B) | n/a — pure provisioning | ❌ **does not exist** | ❌ |
| `NEON_MACHINE_DATABASE_URL` on uitop | n/a — out-of-band value | ❌ | ❌ |

Nothing in this session ran against live infrastructure. No migration, no
deploy, no `deploy.sh`, no bucket, no `ALTER ROLE`. Every command the owner
needs is in **The provisioning checklist** below.

## Fix A — `/api/import` never served its two GET operations

`frontend/api/import.ts` exported only `POST`. `agent.config` and `agent.release`
are GETs (`machineOps.ts:78`, `:252`; the agent calls them with `requests.get` at
`agent.py:289`, `:414`), so on Vercel the platform answered 405 before `handle`
was ever entered. 405 is not in the agent's silently-ignored set `(400, 404,
503)`, so self-update failed loudly on every notebook that had a credential —
and remote config fell back to "local config.yaml only" on every sync.

`export const GET` now sits beside `POST`, exactly as `notify-replies.ts:531` and
`identity.ts:796` already do.

**The widening is confined to the four machine ops.** After the op dispatch,
`handle` refuses any non-POST with 405. Without that, an authenticated GET
would have fallen through to the human import actions, which read a JSON body,
and been answered `invalid JSON body` by an action that was never meant to see
it. The op dispatch is unchanged and still runs before the body read and before
`guardAdmin`; the human path's guard, order and error text are untouched.

### Why no test caught it, and what the new one does differently

`tests/agentS23.test.ts:232` calls the handler *factories*. Every one of those
tests was green while two of the four operations were unreachable in every
deployment, because the defect was in the **export list**, not in a handler.

`tests/importRoute.test.ts` (new, 11 tests) imports the module the way the
platform loads it and calls the exported verb symbols: four machine ops × both
verbs, written out as a table rather than derived, plus the fall-through 405 and
the unknown-op 400. With no machine credential configured a machine op answers
503, which is the signal wanted — 503 means the request *reached* the operation,
where 405 means it never arrived. The environment is stubbed empty rather than
read, so a developer's own `.env` cannot decide the result.

Mutation-checked twice: removing `export const GET` reddens **9 of 11**;
removing the fall-through 405 guard reddens **1**.

## Fix D — the agent's Supabase-off mode (`only`)

Agent **1.15.0**. The design rule is the one `5e3fe90` already adopted for the
server: *let each path decide from the credential it holds, not from a flag
nobody set.*

### `load_config` no longer demands Supabase

`instance_id` is required of everyone. The destination credentials are an **OR**:
either `supabase_url` + `supabase_service_key`, or `ingest_url` + a well-formed
`ingest_token`. A config with neither is refused at startup with a message
naming both alternatives.

This was the hard blocker. `load_config` is the first statement of `cmd_sync`
and runs *before* `self_update`, so a tenant's notebook exited before it could
reach the only transport that would have worked for it.

The token's **shape** is part of the predicate (`machine_configured` calls
`parse_ingest_token`). `ingest_token: "paste-it-here"` is not a credential, and
accepting it would move the failure from a legible exit to a silent no-op.

### `only` is derived, not defaulted

`INGEST_MODES = ("off", "shadow", "dual", "only")`. `resolve_ingest_mode`:

| Notebook holds | flag | resolves to |
| --- | --- | --- |
| Supabase | unset / unrecognised | `off` — unchanged |
| Supabase | `shadow` / `dual` | itself — unchanged |
| Supabase + machine | `only` | `only` — the cutover rehearsal |
| machine only | anything, including unset | **`only`**, with a printed note |

The last row is the one that matters. A machine-only notebook resolving to `off`
would extract its whole LH2 database, deliver it nowhere, and report success.
That is not a flag being overridden — `off`/`shadow`/`dual` all mean "and
Supabase gets the authoritative copy", and there is no Supabase to get one, so
the flag simply cannot describe the machine.

The refusal comment at the old `:515-518` is replaced with the reasoning that
now justifies the member: the decision it was protecting ("making the new store
authoritative is a whole-cutover decision") was right about the owner's fleet
and wrong about everyone else. A tenant never had Supabase, so for its notebooks
there is no cutover to decide. That decision is still not made by this flag — it
is made by which credential a notebook is given.

### Three invariants that `only` inverts, each stated where it stops being true

- **"Nothing here can make a sync fail."** In `only` it must. `push_ingest` and
  `run_ingest_transport` still never *raise* — a failure arrives as `(False,
  note)` — but `sync_machine_only` exits non-zero on it, because nothing was
  written anywhere and cron must not be told the notebook synced.
- **"The Supabase push runs first and stays authoritative", so the parity check
  compares against it.** In `only` there is no second copy. The check keeps
  exactly the meaning it always literally had — this batch is a faithful,
  complete, sendable projection of one extraction — and the refusal is
  *stronger*, not weaker: it is the last thing between a mis-projected
  extraction and the only store there is, and it fails the run rather than
  skipping a mirror. (Note the old docstring was already loose: it said "against
  what the Supabase push just sent" while the code compared against the same
  in-memory lists. That is now written accurately.)
- **"The run row is inserted before the work starts."** Supabase inserts
  `sync_runs` with status `running` first, so a notebook that dies mid-extraction
  leaves evidence. The gateway writes its `sync_runs` row inside an accepted
  batch, so a run that never delivers leaves **no row at all**. That is a real
  reduction in observability and it is not hidden: the failure is printed, the
  process exits non-zero, the notebook's own cron log has it, and
  `instances.last_sync_at` going stale is what the Health page shows.

### What still travels, and one thing that did not before

`agent.upsertInstance` (`operations/agentIngest.ts:377`) sets `last_sync_at =
now()` and COALESCEs the account fields, so the heartbeat travels inside the
payload rather than as a separate PATCH.

The extracted **owner** now travels with it. `build_ingest_payload` used to read
`account_name` / `account_url` / `account_avatar` from **config only**, so a
notebook whose avatar comes from the LH2 `mapping.owner` query delivered an empty
one — invisibly, because the gateway COALESCEs an empty value away and the row
keeps whatever it had. LinkedIn media URLs are signed and expire, so the copy
that refreshes each sync is the only one that keeps working. `extract_owner`'s
result is now threaded through `run_ingest_transport` /
`preview_ingest_transport` / `build_ingest_payload`. This also changes the
payload digest, and therefore the idempotency key, for `shadow`/`dual`
notebooks — harmless, because a new key is a new batch of upserts.

### Preserved deliberately

- `ingest_token` and `release_public_key` stay in `LOCAL_ONLY_CONFIG_KEYS`.
- `ingest_url` / `ingest_mode` stay remote-config keys.
- The idempotency key is still `sync.<UTC date>.<digest of that batch's content>`.
- The parity check still refuses delivery on any disagreement.
- The Supabase path in `cmd_sync` is unchanged; `only` branches to a separate
  `sync_machine_only` before `Supabase(cfg)` is ever constructed.

### One thing a remote blob may not do

`apply_remote_config` **ignores** a remote `ingest_mode: only` when the notebook
holds no machine credential. A local `only` in that state is a stated choice and
fails loudly, exactly as an explicit `neon` with no connection string does on the
server. A *remote* one is a Health-page edit made against a config file the
editor cannot see, and honouring it would stop a working sync from a web form.
Refused for the same reason a malformed `mapping` override is: an override that
cannot describe this machine is not an instruction about it.

The legacy PostgREST remote-config fallback (`:423`, which subscripted
`cfg["supabase_url"]` directly) now returns `{}` for a notebook with no Supabase
credential, before touching either key. It is unreachable rather than merely
unlikely — `load_config` refuses that combination — but a `KeyError` raised out
of a fetch that is supposed to be non-fatal is worth one guard.

### The three Supabase-only commands, decided explicitly

| Command | Verdict | Why |
| --- | --- | --- |
| `ingest-csv` | **ported** | A CSV import is exactly what the ingest contract carries: a campaign, its leads, and the events derived from them. It reuses the same projection, chunking, content-addressed key and parity check as `sync`, so re-importing a file is a replay and a mis-projected import is refused before it is sent. Steps and messages are empty; the gateway COALESCEs an absent collection rather than clearing one, so an import cannot erase what a scheduled sync established. |
| `annotate` | **refuses** | `app_machine` holds no grant on `public.annotations` (ledger step 009 lists the seven tables it may write, and that is not one), and the ingest contract has no annotations collection. Widening either is a schema decision needing its own ledger step. It exits with that reason rather than pretending. |
| `sync_photos` | **refuses, loudly, every run** | Two halves are missing and neither is useful alone — see below. |

### The photo gap, named rather than papered over

`sync_photos` prints `photo sync: skipped — …` on every `only` run and writes
nothing. Building it would need **both** of:

1. **A machine-path candidate query.** The candidate list ("this instance's
   leads with `photo_synced_at IS NULL`") is a Supabase read with no machine
   operation behind it. This half is cheap: step 009 already grants `app_machine`
   `SELECT` on `public.leads` scoped to its own instance, so it is a new
   `MACHINE_OPERATIONS` entry and a fifth GET op, pure TypeScript, no ledger
   change.
2. **A provisioned destination.** `CANONICAL_TENANT_ENVIRONMENT` binds **no**
   `OBJECT_STORAGE_*` value at all and pins `NEON_PHOTOS_DEFAULT` to `disabled`.
   So `agent.photoUpload` would 503 on a tenant, and the dashboard would not
   display the result if it somehow landed.

Doing (1) alone would ship precisely the failure shape this session exists to
kill. Left as one future item, not two.

### Transport tests

`sync-agent/tests/test_ingest_transport.py`: **68 → 90** test methods, all
passing in the agent's virtualenv. New coverage: `load_config`'s OR (5),
credential-derived mode resolution (2), the two remote-config refusals plus the
unreachable legacy fetch (3), the whole `sync_machine_only` wiring (8), and the
ported/refused commands (4).

Mutation-checked, one mutation at a time:

| Mutation | Reddens |
| --- | --- |
| `resolve_ingest_mode` ignores the credential (the old defaulting) | 7 |
| a delivery failure no longer exits non-zero in `only` | 3 |
| `load_config` demands Supabase again | 1 |

## Fixes G and H — the two control-plane defects

Both are in `ops/`, both are what make the machine path unreachable for *any*
tenant, present or future.

- **G**: `000_*_role_bootstrap.sql` create `app_runtime`, `app_system`,
  `app_machine` and `identity_store` with `LOGIN` and **no `PASSWORD`**, so Neon
  holds no credential and every composed URI has an empty password. The Worker
  now generates a password, `ALTER ROLE`s it and rewrites the URI's password
  component, following `pinned-postgres.ts:300-340`'s existing treatment of
  `app_migration`.
  **The correctness constraint**: the ALTER ROLE must happen only for bindings
  that are actually about to be written. Step 7 deliberately adopts an existing
  binding rather than rewriting it, and an eager rotation on retry would change
  the database's passwords while leaving the old ones bound in Vercel — taking a
  live tenant down. The retry-issues-no-ALTER-ROLE case is the test that matters
  most.
  Note for anyone reading `N-UITOP.md`: the AI connection role is **`app_system`**,
  not `app_ai_runner`. `app_ai_runner` is deliberately NOLOGIN and owns
  `ai_execute_sql`; it must not be given a password.
- **H**: `APP_TENANT_ID` was in no tenant environment, so `readDeploymentTenantId`
  returned `null` and every machine operation answered 503 even on a fully
  provisioned tenant. It is now a 17th descriptor, `server_public` /
  `derived_from_plan`, with the tenant slug travelling on the
  `hosting.environment-bind` request exactly as `site_url` does since `af28aaf`.
  This is a contract version bump, `hosting.environment.v3` → `v4`, which moves
  the version string in six places, the plan schema's descriptor count, and
  three pinned fixture digests.

`OBJECT_STORAGE_TENANT_ID` was deliberately **not** added: `readDeploymentTenantId`
accepts either name and requires them equal when both are set, and no
`OBJECT_STORAGE_*` binding exists in this contract, so a second name would be
redundant surface.

### What session 2 verified about G and H

The diff session 1 left behind implements the specification above; session 2
read it whole and ran the gates it had never been run against. It kept it.

The shape of G in code: the four database URLs stopped being four eager awaits
and became a resolver, `#applicationConnectionUri`, reached only from the branch
that is about to write a binding. It `ALTER ROLE`s a freshly generated password
through an injected `databaseMutation` — injected for the same reason `fetch`
is, since the statements sent to Postgres are the entire fix — and rewrites the
URI's user and password components, because Neon's API cannot report a password
set in SQL. `roleIdentifier` proves the configured role name is a plain
identifier before concatenating it into `ALTER ROLE`, which no placeholder can
carry. H adds `APP_TENANT_ID` as the 17th descriptor and makes `tenant_slug`
a required field of the `hosting.environment-bind` request, checked at the
bridge against the platform's own slug regex and again in the Worker against the
shape `readDeploymentTenantId` accepts — verified identical to the application's
`TENANT_ID_PATTERN`, not merely described as such.

`ops/worker-test` grew 42 → **50** tests, `ops/test` 127 → **128**. The three
that carry the weight are the retry cases: a bind whose descriptors are all
already present issues **no** `ALTER ROLE` and writes nothing, a partially bound
tenant rotates only the role whose binding is absent, and a role name that is
not an identifier is refused before any statement runs. The eager version this
replaced would have rotated all four passwords on any retry against a promoted
tenant while Vercel kept the old ones.

Gates run by session 2, all clean: `ops` `npm test` **128**, `npm run
worker:test` **50**, `npm run worker:typecheck`, `npm run worker:types:check`
(`worker-configuration.d.ts` is up to date with the regenerated hash). No stale
copy of the three moved fixture digests survives anywhere in the tree, and no
`hosting.environment.v3` string remains outside this document.

### Still not in the canonical environment, and it should be next

The **release read credentials** — `AGENT_RELEASE_ENDPOINT`,
`AGENT_RELEASE_BUCKET`, `AGENT_RELEASE_ACCESS_KEY_ID`,
`AGENT_RELEASE_SECRET_ACCESS_KEY` (and optionally `AGENT_RELEASE_REGION`) — are
in no tenant environment either. So even after G and H, a tenant's notebooks can
sync but cannot **self-update** without a manual Vercel edit.

Binding them is a further contract bump and should follow the `sender` shape
(`RESEND_API_KEY`, added in the v2→v3 commit): the release bucket is **one
platform resource shared by every tenant**, read out of the Worker's own env,
not derived per tenant. It was not done here because the bucket does not exist
yet, and binding names for an unprovisioned resource is the exact trap this
session is about. Do it in the same session that first publishes a release.

## The provisioning checklist — owner actions

Items 1–2 are platform-wide. Item 3 is uitop-only and is **out of band**
(finding I: there is no sanctioned repair path for an active tenant). Item 1 is
partly done — see its table.

### 0. The order, for the owner's own four notebooks

The owner chose this fleet first, 2026-08-11. Its order is **not** the order of
this checklist, because S28's cutover sits inside it.

**The trap, stated once.** Do not switch a notebook to the gateway before S28
gate 6. Production still resolves `readPath: neon` against the *fixture*
database while the owner's real 27,338 rows sit in `autumn-snow-04881924` at
47/47 parity with nothing pointing at them. A notebook switched first would
write correctly into a database the dashboard is not reading — the S27 step-4
incident again, one layer down. Neon first, agents second.

**The second thing to know before starting: every notebook needs one hand
visit, and no amount of provisioning removes it.** `ingest_token` and
`release_public_key` are in `LOCAL_ONLY_CONFIG_KEYS` by design, and the live
fleet runs **1.12.2**, whose `self_update` reads the Supabase bucket that no
longer receives releases. So the 1.12.2 → 1.15.0 hop is a file copy, per
notebook, once. Every release after that one is automatic.

| Phase | Step | Who |
| --- | --- | --- |
| **1. Release channel** | mint the two bucket-scoped R2 pairs (item 1b) | owner, dashboard |
| | `git push` — `a768854` is committed but unpushed, and Vercel deploys from git | owner |
| | set the four read-scoped `AGENT_RELEASE_*` on the owner's Vercel project | owner |
| | deploy the frontend — **carries fix A**; without it `agent.release` is 405 and nothing can ever self-update | owner |
| | `sync-agent/deploy.sh` with the write pair + `AGENT_RELEASE_SIGNING_KEY_FILE` | either |
| **2. Neon cutover** | S28 gate 5 — 671 photo objects → R2, verify by SHA-256, report the 36 known dangling paths | either |
| | S28 gate 6 — repoint `NEON_DATABASE_URL`, `NEON_AI_DATABASE_URL`, `IDENTITY_STORE_DATABASE_URL`; **closes the incident** | owner |
| | S28 gate 7 — delta reconcile from watermark `2026-08-11T20:59:00.223Z`, re-run parity | either |
| **3. Notebooks** | confirm the deployment has a tenant — `OBJECT_STORAGE_TENANT_ID=ciphercross` may already satisfy it (see below) | either |
| | bind `NEON_MACHINE_DATABASE_URL` (already in `~/.config/neon-s28-production.env`) | owner |
| | mint one machine credential per notebook — **after gate 6**, or the rows land in the wrong database | owner, admin session |
| | one notebook: copy 1.15.0, add the three local keys, `sync --dry-run`, compare to LH2, then `dual`, then `only` | either |
| | the other three, once the first is proven | either |

**On the tenant binding for the owner's own deployment:** `readDeploymentTenantId`
accepts `APP_TENANT_ID` *or* `OBJECT_STORAGE_TENANT_ID` and requires them equal
when both are set. The owner's storage tenant is already `ciphercross`, so if
that variable is bound on Vercel the machine path already has a tenant and
`APP_TENANT_ID` is optional — but if you add it, it must be `ciphercross`
exactly. Check before setting; a disagreement is the one configuration the code
refuses outright.

**Why `dual` before `only`:** with both credentials present, `dual` keeps
Supabase authoritative while the gateway receives the same extraction and a
delivery failure marks the run `partial`. That is the cutover rehearsal, and it
is the cheapest place to find a projection defect. `only` is the commitment.

The credentials each phase needs are already on this machine:
`~/.config/neon-s28-production.env` (all six for the new project),
`~/.config/neon-s20-object-storage.env` (R2 for gate 5),
`~/.config/neon-b2-supabase.env` (the source for gates 5 and 7).

### 1. The R2 release bucket and its two credential pairs

`releaseArtifacts.ts:181-190` refuses a bucket equal to `OBJECT_STORAGE_BUCKET`,
so this is a **second** bucket with its own credentials — not the one holding
lead photos.

**(a) and (c) are DONE, 2026-08-11.** (b) is not, and cannot be: `wrangler r2`
exposes only `object`, `bucket` and `sql`, so minting an S3 API token pair is a
Cloudflare **dashboard** action.

| | State |
| --- | --- |
| a. private bucket | ✅ **`lh2-agent-releases`**, created 2026-08-11 in account `eb89cc458183927bebefdebe1f751880`. `r2.dev` public access confirmed **disabled** — every read is a 120s presigned URL (`RELEASE_DOWNLOAD_TTL_SECONDS`). |
| b. two bucket-scoped token pairs | ❌ **owner, in the dashboard.** One READ-ONLY pair for the dashboard, one WRITE pair for the operator shell. Scope both to `lh2-agent-releases` **only** — the existing `OBJECT_STORAGE_*` pair is scoped to `linkedin-campaign-dashboard` and cannot write here. |
| c. Ed25519 signing keypair | ✅ **`~/.config/agent-release-signing.pem`**, mode 0600. Public half, in the unpadded base64url form the agent expects: **`v-Zb6qV8GZhMjatTKgNo4BUaTIjfHh1MWEq8jQ4A6Is`** |
| d. an S3 client for `deploy.sh` | ✅ `awscli` **2.36.20** installed. `publish_release.py:88` shells out to `aws s3 cp`, and it was absent — `deploy.sh` would have failed at the first upload, *after* passing its own tests. |

The keypair is not merely generated, it is **proved against the consumer**: a
manifest signed the way `publish_release.py` signs one verifies through the
agent's own `verify_release_signature`, the agent rebuilds the identical
canonical message, and both negative controls fail (a tampered `sha256`, and a
different public key). The private half is on this machine only — never on the
dashboard, never on a notebook.

`AGENT_RELEASE_ENDPOINT` for this account is
`https://eb89cc458183927bebefdebe1f751880.r2.cloudflarestorage.com`.

Where each value goes:

| Variable | Value | Goes on |
| --- | --- | --- |
| `AGENT_RELEASE_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | Vercel (owner + each tenant) |
| `AGENT_RELEASE_BUCKET` | the bucket name | Vercel (owner + each tenant) |
| `AGENT_RELEASE_ACCESS_KEY_ID` | **read-only** key id | Vercel (owner + each tenant) |
| `AGENT_RELEASE_SECRET_ACCESS_KEY` | **read-only** secret | Vercel (owner + each tenant) |
| `AGENT_RELEASE_REGION` | optional; defaults to `auto` | Vercel |
| `AGENT_RELEASE_WRITE_ACCESS_KEY_ID` | **write** key id | operator shell only |
| `AGENT_RELEASE_WRITE_SECRET_ACCESS_KEY` | **write** secret | operator shell only |
| `AGENT_RELEASE_SIGNING_KEY_FILE` | path to the PEM | operator shell only |
| `release_public_key` | the base64url public half from (c) | each notebook's `config.yaml`, local-only |

Then publish the first release — `deploy.sh` runs `py_compile`, the transport
tests, and `publish_release.py`, which writes `agent/<v>/agent.py`,
`agent/<v>/manifest.json`, and `agent/current.json` **last**, so a reader never
sees a pointer to half a release:

```bash
sync-agent/deploy.sh
```

Note the live fleet is on **1.12.2** and this repo is at **1.15.0**. The four
existing notebooks have never run the ingest transport at all (it shipped in
1.13.0), so the first `deploy.sh` is also the first time that code reaches a
real LH2 machine. Roll it to one notebook first (`auto_update: false` on the
other three until it is seen to work).

### 2. `app_machine` must be able to log in

Expected to be **already true** on every tenant: `pinned-postgres.ts` applies all
four `000_*_role_bootstrap.sql` artifacts, including
`000_machine_ingest_role_bootstrap.sql`, during onboarding step 3, and step 009
(the grants and policies) is ledger step 9, with uitop recorded at 11/11.

Verify rather than assume, with the Docker psql wrapper recipe
(`neon-ledger-apply-needs-docker-psql`):

```sql
SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = 'app_machine';
```

For the **owner's new Neon project** (S28 gate 1) this is not automatic — confirm
the bootstrap artifacts were applied there too, not only steps 000–010.

### 3. uitop — out of band, and it makes registry facts stale

uitop is `active`, and `state-machines.ts:18-28` allows only
`active → suspended | offboarding_planned`, so a second onboarding operation is
refused. There is no sanctioned repair path for an active tenant, and building
one is deliberately **not** in this session's scope.

The out-of-band repair, in order:

```
a. ALTER ROLE app_machine PASSWORD '<generated>';        (as the project owner)
b. Compose NEON_MACHINE_DATABASE_URL by hand from Neon's connection URI for
   app_machine with that password substituted in — the same shape the three
   URIs already repaired by hand in N-UITOP took.
c. vercel env add NEON_MACHINE_DATABASE_URL production   (uitop's Vercel project)
   vercel env add APP_TENANT_ID production               -> the value is `uitop`
   vercel env add AGENT_RELEASE_ENDPOINT / _BUCKET / _ACCESS_KEY_ID /
                  _SECRET_ACCESS_KEY  production         (from item 1)
d. Redeploy uitop so the new bindings are picked up.
e. Mint one credential per notebook. There is no UI and none is in scope; the
   MCP tool `machine_enrollment_create` throws `unsupported_contract`. It is a
   hand-called operation, requiring a Better Auth ADMIN SESSION COOKIE on
   uitop's own hostname:

     POST https://uitop.ciphercross.dev/api/identity?op=admin.agentCredentialIssue

   The plaintext `lha.<uuid>.<secret>` is in that one response and nowhere else.
   Order matters: mint -> the notebook's FIRST sync creates its `instances` row
   -> only then can remote config edit it. The Health page editor only UPDATEs
   and 404s on an unknown instance_id, and there is deliberately no FK from
   agent_credential.instance_id to public.instances.
```

**Which registry facts this makes stale** — add to the three divergences already
listed in `N-UITOP.md:75-84`:

4. `NEON_MACHINE_DATABASE_URL` holds a password set by `ALTER ROLE` outside any
   operation. The registry believes step 7 bound whatever Neon's API returned.
5. `APP_TENANT_ID` and the four `AGENT_RELEASE_*` values are production bindings
   that exist in **no** environment contract version the registry knows about —
   v4 adds `APP_TENANT_ID`, and uitop was bound under v3.
6. The redeploy in (d) is another out-of-band build, compounding divergence 1.

Once G and H are deployed and the approved SHA moves, a **freshly onboarded**
tenant needs none of item 3 — only item 1 and, until the release variables are
in the contract, the `AGENT_RELEASE_*` half of (c).

## Verification

Run at the end of session 2, across all three toolchains. Session 1's own run is
the "session 1" column; it never reached the `ops` half.

| Gate | Before | Session 1 | Session 2 |
| --- | --- | --- | --- |
| `frontend` `npm test` | 928 | 939 (+11, `importRoute.test.ts`) | **939** |
| `npm run typecheck:api` | clean | clean | clean |
| `npm run build` | clean | clean | clean |
| `python3 -m py_compile sync-agent/agent.py` | ok | ok | ok |
| transport tests (agent venv) | 68 | 90 (+22) | **93** (+3, the merge-order fix) |
| `ops` `npm test` | 127 | never run | **128** (+1, the `APP_TENANT_ID` descriptor) |
| `ops` `npm run worker:test` | 42 | never run | **50** (+8, credentials and tenant) |
| `ops` `npm run worker:typecheck` | clean | never run | clean |
| `ops` `npm run worker:types:check` | up to date | never run | up to date |
| `git diff --check` | clean | clean | clean |

No baseline moved anywhere. Every added test is new coverage, and every group of
them was mutation-checked — the counts are in the sections above.

**`npm run test:neon` was NOT run**, by owner decision, for the reason `N-S28`
records: it writes to the fixture database in `proud-voice-47907246`, which the
S27-step-4 incident left production reading, so running it would mutate what the
live dashboard is currently serving. What that leaves unverified is nothing this
session touched — the changes are the `/api/import` export list, the Python
agent, and `ops/`; no read or write slice operation, no data-store adapter and
no SQL was modified. It should be run again once S28 gate 6 repoints production
off the fixture database.

The ledger static assertions belong to the same pre-push gate as always; no
ledger artifact was touched by either session.

## What remains open

- **Gate 8 is not closed.** The code exists; no notebook has run it. The first
  real proof is a `--dry-run` on one uitop notebook, then one real `only` sync,
  compared against LH2's own numbers.
- **The release channel has never been published to.** Until item 1 is done,
  `agent.release` answers 503 and every notebook stays on whatever build was
  copied to it by hand.
- **Photos are unreachable for tenants** — both halves, above.
- **`annotate` ends with Supabase.** If it matters after the exit, it needs an
  annotations collection in the ingest contract and a grant in a new ledger step.
- **`AGENT_RELEASE_*` in the tenant contract** — the next control-plane bump.
- **Out of scope and still real**: an active-tenant repair capability in the core
  (finding I), and the broken admin-invite / password-reset flow
  (`N-UITOP.md:65-73` — the deployment builds `BetterAuthIdentityProvider` with
  no `sendResetLink`, so ivan still cannot sign in on his own). Neither blocked
  this session. The second one **will** block item 3 step (e), because minting a
  credential needs an admin session cookie on uitop's hostname and ivan cannot
  obtain one — the owner's own second admin account (`N-UITOP.md` divergence 3,
  member 3, known passphrase) is the way through.
- **The end-user notebook installation instruction is deliberately not written
  here.** It belongs to the separate session that owns the Russian setup doc, and
  it needs this work provisioned and proven first.

## Where session 2 stopped

**Nothing is committed.** The working tree is the record, and it now holds all
five fixes, each reviewed and each with its gates run.

| File | State |
| --- | --- |
| `frontend/api/import.ts` | fix A — `export const GET` + the fall-through 405 |
| `frontend/tests/importRoute.test.ts` | new, 11 tests, mutation-checked (9 / 1) |
| `sync-agent/agent.py` | fix D — 1.15.0, the `only` mode, `sync_machine_only`, ported `ingest-csv`, refusing `annotate` and `sync_photos`; plus the merge-order fix below |
| `sync-agent/tests/test_ingest_transport.py` | 68 → 93, mutation-checked (7 / 3 / 1, and 2 for the merge-order fix) |
| `sync-agent/config.example.yaml` | the two-kinds-of-notebook preamble and the four modes |
| `README.md`, `sync-agent/deploy.sh` | fix J — the R2 release channel, replacing the Supabase-bucket description |
| `CLAUDE.md` | the transport paragraph, which stated the refusal this session removed |
| `ops/src/**`, `ops/test/**`, `ops/worker-test/**`, `ops/wrangler.jsonc`, `ops/worker-configuration.d.ts`, `onboarding-plan.v1.schema.json` | fixes G and H — reviewed and gated by session 2, see **What session 2 verified** above |

Session 1 left `ops/` unreviewed and ungated. Session 2 read the whole diff,
confirmed the two claims it could not take on trust — that the Worker's tenant
check is the *same* shape `readDeploymentTenantId` enforces (it is, character
for character), and that the retry path issues no `ALTER ROLE` (it does not, and
two tests hold it there) — and ran every `ops` gate. It is kept, not redone.

### The known defect session 1 named is fixed

`apply_remote_config` asked `machine_configured(cfg)` while the merge was still
in progress, over a `set`, so for a notebook holding a local token and no local
`ingest_url` the answer depended on string-hash iteration order. The predicate
now reads the URL from the config the merge *produces* — `remote.get` falling
back to `cfg.get` — computed once, before the loop starts. A remote value that
is not a string is not a URL, and the predicate says no rather than raising:
`apply_remote_config` is called unguarded at the top of `cmd_sync`, so an
exception there would break a working sync.

Three tests, in `RemoteConfigTest`. Two of them run the same input in **both**
key orders, through an `OrderedKeys` stand-in for `REMOTE_CONFIG_KEYS` — the real
frozenset orders itself by hashes randomized per process, so a test about order
dependence cannot use it and expect to fail reliably. Restoring the old
`machine_configured(cfg)` reddens 2 of the 3 (one failure, one `AttributeError`
raised from inside the merge — the crash the string check now prevents). The
third is the over-correction guard: a remote blob may supply the URL, but never
the token, so a notebook without a local one still cannot be switched to `only`.

### Not this session's files

`docs/implementation-handoffs/N-S27-SUPABASE-EXIT.md`,
`docs/implementation-handoffs/N-S28-OWNER-DATA-MIGRATION.md` and
`postgres/tools/s28_owner_migration.mjs` in the tree belong to **other concurrent
sessions**. A commit of this work must not sweep them up.

### What session 3 does first

Nothing in the code. Everything remaining is **The provisioning checklist**
above, in its own order: the R2 bucket and its keypairs, then the first
`deploy.sh`, then uitop's out-of-band repair. The first honest proof that gate 8
is closed is a `--dry-run` on one uitop notebook followed by one real `only`
sync, compared against LH2's own numbers.
