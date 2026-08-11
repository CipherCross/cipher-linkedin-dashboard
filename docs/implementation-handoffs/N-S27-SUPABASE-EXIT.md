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
