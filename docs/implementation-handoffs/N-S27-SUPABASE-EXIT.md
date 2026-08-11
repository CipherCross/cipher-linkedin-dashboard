# S27 — cut Supabase out and run the dashboard on Neon — handoff

The owner's decision, 2026-08-11: **Supabase goes away**. The dashboard runs on
Neon end to end. This session plans and executes that; nothing here has been
started.

Read `N-UITOP.md` first. It records the tenant this decision came out of, the
three out-of-band repairs it needed, and — the constraint that shapes this whole
plan — that **there is no sanctioned repair path for an active tenant**.

## What triggered it

The owner saw this on the uitop dashboard:

```
Supabase error: hypotheses.campaigns: Could not verify team access
```

Both halves of that line are worth reading carefully, because they are two
different defects and only one of them is about Supabase.

- **The label is a lie.** `Layout.tsx:567` renders `Supabase error: {message}`
  for *every* failure the dashboard reports, whatever path produced it. The
  message itself — `hypotheses.campaigns: Could not verify team access` — is
  thrown by the **Neon** read client (`dashboardReads.ts:312`, which prefixes
  the operation name), so this alert is a Neon-path read being blamed on a
  provider the tenant does not even have. Fix the label with the migration;
  until then no alert in this deployment can be trusted about its own cause.
- **The 500 behind it is real but was not reproduced.** `Could not verify team
  access` is what an endpoint returns when actor resolution *throws*
  (`activity-daily.ts:770`, and the same line in four other endpoints) — as
  opposed to 401 `Authentication required`, which is what an absent session
  gets. Under a fresh session all 22 read operations answered 200, including
  `hypotheses.campaigns`, both singly and as one parallel burst. So the failure
  is intermittent. The two candidates worth investigating first: connection
  pressure on Neon Free (every warm function instance holds its own pool), and
  warm instances that outlived the credential repair recorded in `N-UITOP.md`.
  **Do not treat this as fixed by the migration** — it is a separate defect and
  it is the one the owner actually sees.

## The state this starts from

Verified live against `https://uitop.ciphercross.dev`, 2026-08-11:

- `config.readPath` → `{"readPath":"neon","photoPath":"disabled"}`;
- all 22 dashboard read operations return 200 on the Neon path;
- identity: sign-in 200, `session.current` returns subject + actor + role;
- the reset flow works end to end — the owner set their own password through it.

So the read slice, the write slice, the identity surface and the AI path all
exist on Neon already. **This session is not a port. It is a deletion**, plus one
genuine data migration (below).

## Two deliverables that must not be confused

**1. Tenants (uitop, and every tenant after it) never had Supabase at all.**
`CANONICAL_TENANT_ENVIRONMENT` binds no `VITE_SUPABASE_*` and no service-role
key, so `src/lib/supabase.ts` builds a `null` client there. Every Supabase branch
that survives is unreachable code that can still *fail visibly* — the alert above
is one instance. For tenants this is dead-code removal and honest labelling, and
it carries no data risk.

**2. The owner's own dashboard is live on Supabase.** It is the original
deployment, with real campaigns, leads, messages and photos, and its sync agents
push to Supabase as their authoritative target. For it, this is a real migration:
schema, data, storage objects, agents and cron. **This is where the risk is.**
Decide explicitly, with the owner, whether the plan covers it in this session or
whether the session ends at "tenants are clean and the owner's deployment is
scheduled".

## What still depends on Supabase

### Browser (`frontend/src`)

| Where | What |
| --- | --- |
| `lib/supabase.ts` | the client; `null` when the two `VITE_` values are absent |
| `lib/DataContext.tsx` | the whole Supabase read branch, and `rosterPath: 'supabase'` |
| `lib/AuthContext.tsx` | the Supabase auth path, chosen by `VITE_AUTH_PATH` |
| `lib/leadPhotos.ts` | Supabase Storage signing, behind `photoPath` |
| `pages/LeadsExplorer.tsx:267` | a direct `supabase.from('coaching_digest')` fallback |
| `lib/api.ts`, `lib/rosterWrites.ts`, `lib/usePipelineActions.ts`, `lib/conversationPaging.ts` | Supabase branches behind the write/read flags |
| `components/ConversationDrawer.tsx`, `FollowUpPanel.tsx`, `LeadNotesPanel.tsx` | the same, page-local |

### Server (`frontend/api`)

- `_lib/core.ts` — the service-role client `db()` and `executeSql`, which on the
  Supabase branch is the `ai_execute_sql` RPC. The Neon branch already exists and
  is selected by `deploymentAiPath()`.
- Six endpoints still call `db()` directly: `briefing.ts`, `coach.ts`,
  `classify.ts`, `notify-replies.ts`, `pipeline.ts`, `playbook.ts`. Establish for
  each whether a Neon branch exists behind a flag or whether it is Supabase-only —
  that inventory is step 1 of the plan and is not yet done.
- Every path flag **defaults to Supabase**: `deploymentWritePath`,
  `deploymentAiPath`, `deploymentApplicationAuthPath` and the read path all treat
  anything other than the exact string `neon` as Supabase. Deleting the flags is
  therefore a behaviour change for any deployment that has not set them — which
  is exactly the owner's deployment.

### Sync agent (`sync-agent/agent.py`)

The agent's **authoritative** target is Supabase: `supabase_url` and
`supabase_service_key` are bootstrap keys, and the Neon `ingest_mode` transport is
additive (`off` / `shadow` / `dual`) with the Supabase push running first. There
is deliberately no Supabase-off mode — CLAUDE.md calls that "a whole-cutover
decision, not a per-notebook flag". **This session is that decision.** Expect to
add the mode, prove it on one notebook, and only then move the rest.

### Schema and environment

- `supabase/migrations/` is the schema of record for the owner's deployment;
  `postgres/tenant-baseline/v1` is the schema of record for tenants. They are not
  the same artefact and this session must say which survives.
- Env to retire: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`.
- Retiring `VITE_AUTH_PATH` means the identity path stops being optional. Check
  `N-S18` first: it was left unset deliberately until `DataContext` moved.

## Step 1 — the inventory (done; no edits were made for it)

Read against `HEAD` = `de70f79`. Three verdicts, and the distinction between the
first two is what decides whether a line can be deleted:

- **flag-selected** — a real Neon branch exists and a flag picks it. The
  Supabase half is unreachable on a Neon deployment, and it becomes deletable
  the moment nothing selects it. This is almost everything.
- **dead** — unreachable on *both* paths already. Deletable today.
- **Supabase-only** — no Neon counterpart at all. These are the holes, and they
  are the whole of step 3.

### The six `db()` endpoints — all six have a Neon branch

Every one of them is flag-selected, and in each the flag is read once per
invocation and decides the whole handler. There is **no Supabase-only endpoint**
among the six; the hole the plan expected here does not exist.

| Endpoint | Flag | Where the Neon branch is taken | Coverage |
| --- | --- | --- | --- |
| `briefing.ts` | `NEON_AI_PATH_DEFAULT` | admin POST → `briefingOnNeon` (`:1503`); cron GET → `systemBriefingData()` (`:1522` → `:1438`) | complete — the Supabase-only `loadTeamContextRows` (`:217`) has its own Neon implementation at `:1384` |
| `coach.ts` | `NEON_AI_PATH_DEFAULT` | `:703` → `coachOnNeon` (`:651`) | complete — both `mode:'digest'` and the per-lead call |
| `classify.ts` | `NEON_AI_PATH_DEFAULT` | cron GET `:219` → `classifyCronOnNeon`; admin POST `:220` → `classifyOnNeon`; `?mode=reclassify` `:1224` → `reclassifyOnNeon` | complete for labelling and `?mode=demographics`; **auto-advance is refused on the cron** — see the Neon-path gaps below |
| `notify-replies.ts` | `NEON_AI_PATH_DEFAULT` | `:527` → `neonNotifyData()` (`:257`) | complete — `messages` through step 007's DML, `campaigns`/`instances` through the SELECT-only guard |
| `pipeline.ts` | `NEON_WRITES_DEFAULT` | `:899`, then per action at `:110 :181 :267 :340 :371 :670 :851` | complete — every action the dispatcher can still reach |
| `playbook.ts` | `NEON_WRITES_DEFAULT` | `:405`, then per action at `:72 :117 :172 :228 :283 :307 :342 :380` | complete — all thirteen `case`s |

`pipeline.ts` also carries four **dead** functions: `addMember`, `setMemberActive`,
`inviteMember`, `updateMember` (`:383`–`:650`, plus `findAuthUserByEmail`). The
dispatcher returns 410 for those four actions at `:951` *before* the provider
switch, on both paths, so no deployment can reach them.

### The rest of the server

| Where | Verdict | Detail |
| --- | --- | --- |
| `_lib/core.ts:78,95` — `executeSql` / `executeNamedSql` | flag-selected | Supabase = `ai_execute_sql` RPC; Neon = the AI store's guard operation |
| `_lib/core.ts:34` — `db()` | flag-selected (by every caller) | no caller reaches it on a Neon deployment except `loadIcpRoster` — see the holes |
| `_lib/core.ts:111` — `loadIcpRoster` | **Supabase-only** | see the holes |
| `_lib/auth.ts:34,74` — the anon-key verifier and `requireMember` | flag-selected | `guardMember`/`guardAdmin` are called only in the `else` of a provider branch, in all nine call sites |
| `_lib/identity/session.ts:122` — `requireUser` | flag-selected | the transitional bearer, reached only when `VITE_AUTH_PATH` is not `identity` |
| `_lib/conversationImport.ts:127,237,263` | flag-selected | `NEON_WRITES_DEFAULT` |
| `_lib/tools.ts:163` — `executeSaveSearch` | flag-selected | `:296` (MCP) and `:356` (chat) both take the Neon path first |
| `chat.ts:36` | flag-selected | `NEON_AI_PATH_DEFAULT`; `guardMember` only on the Supabase side |
| `mcp.ts:107` | flag-selected | `MCP_SECRET` only; its data ops are `executeSql` / `executeSaveSearchAsSystem`, both flagged |
| `import.ts:119`, `review-digest.ts:36` | flag-selected | `NEON_WRITES_DEFAULT` |
| `activity-daily.ts` | Neon-only | the read endpoint itself never touches Supabase; it only *answers* `config.readPath` |
| `identity.ts` | Neon-only | resolves through `identity_resolve_actor` |

### Browser (`frontend/src`)

Every one of these is flag-selected, and every one of them is unreachable on a
tenant. Listed so step 6 has the full set rather than a sample.

| Where | Selected by |
| --- | --- |
| `lib/supabase.ts` | the module itself — `null` when the two `VITE_` values are absent |
| `lib/DataContext.tsx:784,803` | `resolveReadPath()` |
| `lib/AuthContext.tsx:162` → `SupabaseAuthProvider` (`:338`) | `deploymentAuthPath()` |
| `lib/api.ts:36` — `authFetch` | `deploymentAuthPath()` |
| `lib/leadPhotos.ts:300–325` | `resolvePhotoPath()` |
| `lib/conversationPaging.ts` | its caller passes the client; only the Supabase branch does |
| `lib/rosterWrites.ts:28`, `lib/usePipelineActions.ts:45`, `lib/types.ts:456` | `rosterPath`, which the Neon fetch pins to `'neon'` (`dashboardReads.ts:521`) |
| `pages/LeadsExplorer.tsx:266` — the `coaching_digest` fallback | `resolveReadPath()` at `:250` — it is **not** unguarded |
| `pages/Playbook.tsx:80`, `pages/Team.tsx:73` | `resolveReadPath()` / `deploymentAuthPath()` |
| `components/ConversationDrawer.tsx:196`, `FollowUpPanel.tsx:146`, `LeadNotesPanel.tsx:54` | `resolveReadPath()` |

### What is genuinely Supabase-only

Three things, and only the first is a code hole:

1. **`api/_lib/core.ts:111` `loadIcpRoster`, called from `api/chat.ts:66`.** The
   call site reads `const roster = neon ? '' : await loadIcpRoster()` — so on the
   Neon path the copilot's always-on system prompt carries **no ICP or hypothesis
   roster at all**. It degrades silently rather than failing, which is why 22/22
   green reads never showed it. It is the one surface that needs writing, not
   deleting.
2. **`sync-agent/agent.py` (1.14.0).** `supabase_url` / `supabase_service_key`
   are bootstrap keys, the Supabase push is authoritative and runs first, and
   `INGEST_MODES = ("off","shadow","dual")` (`:520`) has no Supabase-off member.
   Unchanged from what the plan already says.
3. **`supabase/migrations/` — 54 files.** Schema of record for the owner's
   deployment only; tenants get `postgres/tenant-baseline/v1` (steps 000–010).

### Neon-path gaps found while doing the inventory

Not Supabase dependencies, but they are what step 3 is actually for, and they
would have been missed by looking only for the word `supabase`.

- **The scheduled classifier never advances the pipeline on Neon.**
  `classify.ts:706` hardcodes `AUTO_ADVANCE_BLOCKED` for the cron, with the
  reason *"ledger step 008 is written and not applied"*. Step 008
  (`postgres/tenant-baseline/v1/008_ai_system_auto_advance_execute.sql`) exists
  and grants `app_system` exactly that `EXECUTE`, and `N-S21` records the ledger
  at 10/10. So the reason string is stale and the capability is refused on a
  tenant that already holds the grant. Confirm against the live ledger before
  flipping it — the constant is the only thing standing between the cron and a
  real `pipeline_auto_advance()` on live data.
- **A failed path lookup strands a tenant on a provider it does not have.**
  `dashboardReads.ts:188,204` resolve **every** failure to `readPath:'supabase'`,
  and `resolveDeploymentPaths` (`:253`) memoises that answer for the page's
  whole lifetime. On a tenant `supabase` is `null`, so one transient failure of
  the unauthenticated `config.readPath` request turns into
  `"Supabase is not configured — set VITE_SUPABASE_URL…"` until the tab is
  reloaded. The fail-open direction is correct *today* and wrong the moment
  step 4 flips the default; it is the same edit.
- **`CANONICAL_TENANT_ENVIRONMENT` binds no `ANTHROPIC_API_KEY`.** Nor
  `SLACK_WEBHOOK_URL` or `DASHBOARD_URL`. Every AI endpoint on a tenant is
  therefore unusable regardless of provider — orthogonal to this plan, and a
  contract version bump when it is fixed.

## Step 2 — the alert (done)

Both halves, and they turned out to be independent in the way the plan
predicted: the label was a one-line lie, and the 500 was undiagnosable rather
than unfixed.

### The label

`Layout.tsx` announced **every** failure as `Supabase error:`, so a tenant that
binds no Supabase value at all reported a Neon read failure under a Supabase
headline. It now reads `Couldn’t load the dashboard: {message}` and names no
provider. The message already carries the operation and the server's reason,
which are the only parts of that line that identify anything.

Nothing asserted the banner's text before — which is why a literal that was wrong
on every tenant survived the whole migration. `tests/errorBanner.test.tsx`
asserts the *absence* of any provider name rather than the wording, so the
sentence can be edited and the defect stays caught. `ErrorBanner` is exported for
it; the mutation pass (restoring `Supabase error:`) reddens two of its three
tests.

### The 500 — what was actually wrong

The intermittent `Could not verify team access` was **not reproduced**, and it is
not claimed to be fixed. What was found is why it could not be diagnosed, and
that is fixed.

Every candidate cause arrived at the log as the same label. `toContractError`
(`data/neon.ts`) classified four SQLSTATEs and dropped everything else into
`DataStoreTransactionError/TRANSACTION_INVALID`, and all three `pool.connect()`
catch sites routed through it. So a pool that exhausted its ceiling and timed
out, a login the database refused, and a backend that vanished under an in-flight
statement were **one label** — and the two hypotheses this handoff names,
connection pressure and warm instances outliving the credential repair, are
precisely two of those three. `safeErrorLabel` then logs `name`/`code` and
nothing else, correctly, so no amount of reading the logs could separate them.

Three codes now exist (`DataStoreUnavailableError`, `data/contracts.ts`):

| Code | What it means | Which hypothesis it settles |
| --- | --- | --- |
| `DATASTORE_CONNECT_FAILED` | no connection obtained — pool ceiling waited out, refused socket, DNS, `53300` | connection pressure on Neon Free |
| `DATASTORE_CREDENTIAL_REJECTED` | reached the database, login refused (SQLSTATE class 28) | a credential that outlived a repair — the `N-UITOP.md` shape |
| `DATASTORE_CONNECTION_LOST` | an established connection died mid-statement (class 08, `57P0x`, socket codes, `pg`'s own `Connection terminated unexpectedly`) | a frozen instance whose warm socket was closed under it |

The phase matters and is part of the classification: the same class-08 SQLSTATE
means `CONNECT_FAILED` while acquiring and `CONNECTION_LOST` mid-statement.

### The 500 — what the caller now says

All **eleven** actor-resolution catch sites (`activity-daily`, `briefing`,
`classify` ×2, `coach`, `identity`, `import`, `pipeline`, `playbook`,
`review-digest`, `chat`) answered `500 Could not verify team access` for any
throw. For these three codes that sentence is a claim about a membership check
that was never reached. Each site now consults `unavailableResponse`
(`data/availability.ts`) first, which answers:

- **503** for the two transient causes, with `retry in a moment`;
- **500** for a rejected credential, saying plainly that retrying will not help.

`activity-daily.ts` also consults it on its two *read* failure branches (the
allowlisted read at `:865` and the photo read at `:341`), which answered
`Could not load dashboard data` for a database that could not be reached. That is
the sentence `readAll` prefixes with the operation name, so it is the one that
lands in the banner.

The code token is **in the message**, so the next occurrence is diagnosable from
the banner itself rather than only from a log the owner cannot see. It is safe to
publish: three fixed tokens, no driver text, no hostname, no credential.

### What was deliberately not done

- **No retry, and no change to any pool ceiling.** Both are plausible fixes for a
  failure that has not been observed once with a cause attached. The next
  occurrence now names its cause; that is the right order.
- **The identity store's own pool is not classified.** `getSession` →
  `assertStoreReachable` (`identity/betterAuthProvider.ts:323`) acquires from a
  *second* pool (`identity_store`, `max: 2`) and its `pool.connect()` is
  unguarded, so a failure there still reaches a log as a bare `Error`. It is the
  other half of the same request path and the same argument applies to it.
- **`Could not verify team access` still stands for everything else**, which is
  correct: for any failure that is not one of the three, no claim about the cause
  is being made.

### Verification

`frontend`: 891 passed (was 878; +13, and both new files were mutation-checked —
reverting the banner literal reddens 2, unclassifying the connect sites reddens
1, making the classifier never decline reddens 1). `typecheck:api` clean, `build`
clean. `ops`: 127 passed, `worker:test` 42 passed, `worker:types:check` and
`worker:typecheck` clean. Ledger static assertions 193 passed, immutability ok.
`git diff --check` clean.

**Neither half reaches uitop yet.** `APPROVED_SOURCE_GIT_SHA` in
`ops/wrangler.jsonc` is pinned at `d7d585e`, and a tenant picks up application
changes only through a new approved SHA plus a rebuild. That pin lives in four
places (see the traps above) and moving it is the owner's call, not this step's.

### One correction to this file

The "Open when this was written" note below says `ops/` carries an uncommitted
approved-SHA bump. It does not — the working tree was clean at `de70f79`. The pin
is at `d7d585e`, one commit behind, and `de70f79` is docs-only, so nothing was
lost; the bump is still owed for anything this session ships.

## Suggested sequencing

Each step ends in a state the owner can stop at.

1. **Inventory, no edits.** Every Supabase call site, classified: dead on the
   Neon path / flag-selected / Supabase-only. The six `db()` endpoints are the
   ones that matter. Output is a table in this file.
2. **Fix the alert.** The banner label, and the intermittent
   `Could not verify team access`. Independent of everything else and the only
   part the owner currently feels.
3. **Close the Supabase-only holes** found in step 1, so every surface has a
   Neon branch. Until this is done, deleting anything is premature.
4. **Flip the defaults.** Make `neon` the default and `supabase` the opt-in,
   with the owner's deployment explicitly opted in. This is the reversible
   midpoint and the right place for a gate.
5. **Migrate the owner's data**, if in scope: schema, rows, storage objects,
   then agents (`ingest_mode` → a Supabase-off mode), then cron.
6. **Delete.** Client, branches, flags, env, `supabase/migrations`, the
   dependency. Only after nothing selects them.

## Traps this platform has already sprung

Every one of these cost a session or a production defect today.

- **Verification never compares values.** Step 11 checks environment names,
  types and scopes. A binding with a wrong value passes 13/13 in silence — that
  is how a tenant shipped pointing at another tenant's dashboard, and how three
  database URLs shipped with no password.
- **Step 7 adopts by name, never by value.** A binding that already exists is
  never rewritten, so changing a value needs the owner's console or an
  out-of-band write.
- **There is no repair operation for an active tenant.** Step 1 moves the tenant
  to `provisioning`, and `state-machines.ts:23` allows `active` → only
  `suspended` or `offboarding_planned`. Every repair today was out of band.
  **Building that operation may be the real prerequisite for this session.**
- **Changing `CANONICAL_TENANT_ENVIRONMENT` is a contract version bump.**
  `HOSTING_ENVIRONMENT_CONTRACT`, the Worker's own env var, the plan schema's
  descriptor count and the fixture digests all move together — see the v2 → v3
  commit for the exact set.
- **The approved SHA is pinned in four places**: `wrangler.jsonc`
  (`APPROVED_SOURCE_GIT_SHA`, `APPROVED_APPLICATION_VERSION`),
  `test/s26-worker-config.test.ts`, `scripts/materialize-s26-owner-config.mjs`
  and the owner profile. A tenant cannot build a revision that is not approved.
- **A dead flow can hide another.** The reset link was discarded *and* pointed at
  a route the candidate does not serve *and* landed on a screen that did not
  exist. Each defect made the next one invisible. Expect the same shape here.

## Rules that still apply

One onboarding effect per call, inspect the operation after every call. Never
repeat a mutation recorded `outcome_unknown`. No raw provider commands and no
decoded Keychain secrets in output. No edits under `postgres/tenant-baseline/`.
Do not weaken the digest, ledger or ownership checks. Before any push:

```bash
cd ops && npm test && npm run worker:types:check && npm run worker:typecheck && npm run worker:test
node postgres/tests/portable_migration_ledger_static_assertions.mjs
cd frontend && npm test && npm run typecheck:api && npm run build
git diff --check
```

Worker edits need `npx wrangler deploy`; edits under `ops/src/providers|core|state`
need only a build. A tenant picks up application changes only through a new
approved SHA plus a rebuild — see `N-UITOP.md` for the out-of-band procedure,
which is still the only one that exists.

## Open when this was written

- `ops/` carries an uncommitted approved-SHA bump to the head commit; fold it
  into the first commit of this session.
- The three uitop divergences in `N-UITOP.md` are still unrecorded in the
  registry, and still have no sanctioned path to become recorded.
