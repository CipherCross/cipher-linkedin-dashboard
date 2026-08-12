# S28 — migrate the owner's live dashboard data from Supabase to Neon — handoff

Step 5 of `N-S27-SUPABASE-EXIT.md`. Steps 1–4 are done and pushed
(`origin/main` = 5e3fe90).

## GATE 7 SCOPED — session 4, 2026-08-12 ~08:4x UTC

**Gate 7 is closed.** The delta was seven items; five were copied (128 rows, one
transaction, idempotent) and two — this morning's `pipeline_auto_advance()` output
— were dropped by owner decision. The fixture database, the third store and the
one a session following the plan literally would never have looked in, holds
**nothing** that needed recovering: proven by scanning all 61 of its timestamp
columns. `verify` went 29/18 → **36/11**, with every remaining failure named and
accounted for. Full account under **Gate 7** below.

**Gate 9 followed, so S28 is complete.** `NEON_AI_DATABASE_URL` is bound and
deployed — the crons write to the live database from their next run, the delta
cannot reopen, and Slack reply alerts work again. Scheduled auto-advance is
**retired by decision**, and the code now says so where it used to blame an
unapplied ledger step that is in fact applied here.

**What remains is N-S27 step 6, Delete — and auth blocks it harder than it
looks.** `VITE_AUTH_PATH` is unset, so Supabase is still the identity provider,
and flipping it today would lock all five teammates out: their Better Auth
credentials are gate 2's placeholders, no session has ever been created, and the
one way back — `password.requestReset` — silently drops the mail because
`RESEND_API_KEY` is unbound on Production. Bind mail and prove one reset first.

## CUTOVER DONE — session 3, 2026-08-12 ~00:0x UTC

**Production serves the owner's real data from Neon. The incident is closed.**
Gates 1–6 are done. Gates 7–9 remain.

What session 3 did, in order, all verified:

1. **`counts`** — the drift since session 2's watermark was **4 rows, all
   `sync_runs`**. The "2,376 leads changed" reading is an artefact: every sync
   re-upserts and touches `updated_at`, so that column cannot be used as a delta
   predicate. No lead, message or event data had changed.
2. **Full refresh instead of delta tooling.** Extract first (read-only, 27,342
   rows, watermark **`2026-08-11T21:32:29.911Z`**), *then* `rollback --confirm`,
   then `load`. Extracting before deleting is what made this safe — the data was
   on disk before the target was emptied. `verify` → **47 passed, 0 failed**.
3. **Gate 5 — photos.** 672 distinct `photo_path` values, **all 672 copied** to
   `t/ciphercross/lead-photos/<instance>/<file>`; bucket now holds 680 objects
   (672 photos + the 8 pre-existing control-plane objects). A second run reported
   `already present 672` — that is R2 recomputing the SHA-256 it stores and
   agreeing, not the tool trusting its own hash. **The "36 dangling" figure did
   not reproduce: zero dangled.** 707 was a count of non-null values; 672 is the
   count of *distinct* ones, and every one downloaded.
4. **Gate 6 — repoint.** On Vercel Production: `NEON_DATABASE_URL` and
   `IDENTITY_STORE_DATABASE_URL` replaced with `autumn-snow-04881924`,
   `NEON_MACHINE_DATABASE_URL` added (inert — no `agent_credential` rows exist
   yet). `npm test` 939 passed, `npm run build` and `typecheck:api` clean before
   deploying.
5. **Proved live, not inferred.** A real owner session against `ciphercross.dev`:
   `campaigns.performance` returns `karina-1:3 "Campaign 10 (Web2Mobile)"`,
   `activity.dailySeries` returns real notebook history, `identity.teamRoster`
   returns the five real teammates. `leads.photoUrls` signs an R2 URL that
   fetches **200 image/jpeg, 3865 bytes**. Before the cutover these same calls
   would have answered with fixture instances.

Verified before the flip, and the reason it was safe: all five teammates'
**real** Supabase auth UUIDs resolve through `identity_resolve_actor` on the new
database, every one as `admin`. That is precisely what failed on the fixture
database (owner demoted to `member`, other four 403).

### Still open after session 3

- ~~**Gate 7 / gate 8 — the dashboard's data is frozen.** All four notebooks still
  sync into Supabase. Nothing new reaches Neon until the agents move.~~
  **Superseded 2026-08-12:** gate 8 is closed. All four notebooks cut over to the
  Neon gateway (agent 1.15.1, `ingest_mode: only`) and the last notebook write to
  Supabase was `2026-08-11T23:25:07Z`. The dashboard's data is live again.
- ~~**The AI path is still `supabase`** (`NEON_AI_DATABASE_URL` unbound). All three
  crons — `classify`, `notify-replies`, `briefing` — branch on
  `deploymentAiPath`, so they read *and* write Supabase consistently. No
  split-brain, but tomorrow's briefing and any new sentiment labels land in
  Supabase and will **not** appear on the dashboard.~~
  **Superseded 2026-08-12 (gate 9):** bound and deployed. It played out exactly as
  written first — the 2026-08-12 briefing and 100 leads' worth of new sentiment
  and demographics did land in Supabase, and gate 7 is what brought them across.
- **Preview lost two variables.** `NEON_DATABASE_URL` and
  `IDENTITY_STORE_DATABASE_URL` were `Preview, Production` and are now Production
  only, so preview deployments resolve to `supabase`. Harmless, but preview
  identity smoke tests will not run until rebound to the fixture project.
- `npm run test:neon` is safe to run against the fixture project. Session 4 held
  it back one more time while the fixture database was still unexamined evidence,
  then cleared it: that database is now proven to hold no unique record of
  anything (see gate 7).

## Where this stood — end of session 2

**Gates 1–4 are done. The owner's real data is in its new home and verified at
47/47 parity. Nothing points at it yet, and the production incident is still
open.**

| Gate | State |
| --- | --- |
| 1 — target exists, empty, ledger 10/10 | ✅ session 2 |
| 2 — identity and the measured roster map | ✅ session 2 |
| 3 — extract, watermarked | ✅ session 2 |
| 4 — load + parity | ✅ session 2 — **47 passed, 0 failed** |
| 5 — storage (671 objects → R2) | not started |
| 6 — repoint production (**closes the incident**) | not started |
| 7 — delta reconcile from the watermark | ✅ session 4 — 5 items copied (128 rows), 2 dropped by decision; verify 36/11, all 11 accounted for |
| 8 — agents onto the R2 release channel | ✅ S29 — 1.15.1 live on all four notebooks |
| 9 — cron + the auto-advance decision | ✅ session 4 — AI path bound + deployed; auto-advance **retired by decision** |

**Still true and still the most urgent thing in this file:** production resolves
`readPath: neon` against the *fixture* database (`proud-voice-47907246`), not the
new one. Gate 6 is what fixes it. Nothing was deployed and **no Vercel variable
was changed** in either session.

Do not run `npm run test:neon` until gate 6 — it writes to the fixture database
that production is currently reading.

### What session 2 added, in one place

- Neon project **`autumn-snow-04881924`** ("linkedin-dashboard-production"),
  `aws-eu-central-1`, PG 17, endpoint `ep-polished-art-b2swajhh`, database
  `neondb`. Ledger **10/10**. Credentials in
  **`~/.config/neon-s28-production.env`** (0600), six of them, each verified by
  connecting as the application would.
- The roster: 5 `users`, 5 `team_members` with **source ids 1–5 preserved**, 10
  `user_identities`, and 5 `identity."user"`/`"account"` pairs.
- **27,338 business rows** loaded across 24 tables, watermark
  **`2026-08-11T20:59:00.223Z`**.
- Verify runs in ~33s and reports **47 passed / 0 failed**.

### The agent decision the owner made, not yet implemented

Publishing 1.14.0 through Supabase would **strand all four notebooks**: its
`self_update` requires `ingest_token` and `release_public_key`, both
**local-only by design**, and its docstring records that "the old Supabase Storage
read is intentionally gone". A stranded notebook has no channel left once Supabase
is deleted.

Owner's decision: **embed the Ed25519 trust anchor in the build and fetch the
signed release from a presigned R2 URL.** The signature is the trust anchor, not
the transport, so no secret has to reach a notebook and no machine access is
needed. Accepted cost: rotating the key then requires a release. See gate 8.

Read `N-S27-SUPABASE-EXIT.md` step 4 first, then the incident below — **step 4's
central premise was false at deploy time**, and that is the state this session
actually starts from, not the one the plan describes.

## The incident this session opened with

Step 4's table says: *"the owner's, today | `NEON_*_URL` absent | flag unset |
resolves to `supabase` — unchanged, no env edit needed."* That premise was
already false when the code merged.

| Fact | Measured |
| --- | --- |
| `5e3fe90` committed | 2026-08-11 **17:26 UTC** |
| Production `dpl_DtCf3jdYV2QZLRzz1s4C43ZZgcF7` | created **17:33 UTC**, aliased to `ciphercross.dev` |
| `GET /api/activity-daily?op=config.readPath` | **`{"readPath":"neon","photoPath":"neon"}`** |
| `NEON_DATABASE_URL` on Vercel Production | **present since ~2026-08-05** — added for the S17/S18 identity smoke |
| `NEON_READS_DEFAULT` / `NEON_WRITES_DEFAULT` | absent |

So the merge flipped reads, writes **and** photos by itself, seven minutes after
the commit, with no environment change by anyone. `deploymentWritePath` derives
from the same `dataStoreConfigured(NEON_DATABASE_URL)` presence check, so writes
went with reads.

**The lesson is not "the derived default was wrong."** Deriving the default is
right, and it is what makes the rest of this migration safe. The defect is that
the credential's *presence* was treated as evidence of intent, when
`NEON_DATABASE_URL` had been bound six days earlier for an unrelated purpose —
an identity smoke test. A presence check cannot distinguish "this deployment is
ready to serve from Neon" from "somebody needed a connection string once."

### What the deployment was actually pointed at

Read-only Neon API enumeration — three projects, and only one is reachable from
the owner's deployment:

| Project | Purpose |
| --- | --- |
| `dry-mode-26725161` | uitop tenant |
| `cool-king-95851663` | `s26-disposable-lab` drill tenant |
| `proud-voice-47907246` "LinkedinDashboard" | **one branch, one endpoint (`ep-bold-art-a2iy6z2e`), one database (`neondb`)** |

`neondb` is the S11/S13 test-fixture database that `npm run test:neon` writes to:

```
instances:    notebook-test, s11-contract, s12-activity, s13-dashboard, s13-rest
leads:        4443   (s13-dashboard 2300, s13-rest 2140, notebook-test 3)
team_members: Active One | Active Two | Inactive Three | Mykyta Shevchenko(5)
```

Zero real leads. So the live dashboard was reading test fixtures.

### The user-visible symptom, and why it was not "empty"

`public.user_identities` on that database holds:

```
supabase | 7015c8cd-395d-4afc-b9d1-98c298c815e9 | -> Active One | active-one@example.test
```

That subject is the owner's **real** Supabase auth UUID. Auth is still Supabase
(`VITE_AUTH_PATH` unset), so the owner presents a legacy bearer, `resolveActor`
matches that row, and the owner is served as the fixture **"Active One" with role
`member`** — a silent demotion from `admin` — reading 4,443 fixture leads. The
other four teammates have no `supabase` identity row, so `resolveActor` returns
zero rows and they get **403 "Your account is not an active team member."**

An outright empty database would have been *more* honest. This is the failure
shape S27 keeps meeting: a green 200 over the wrong data.

### Damage assessment

**No real write landed on Neon.** Nothing in any app-written table is dated after
2026-08-07 except synthetic fixture rows with future timestamps
(`pipeline_events` max `occurred_at` 2026-08-27 is fixture data).
`conversation_follow_up_state` max `updated_at` 2026-08-05,
`agent_ingest_batch` 2026-08-07, `saved_searches` 2026-08-05 — all from earlier
test sessions. The team's last sign-ins predate the flip.

Supabase was never written to by the flipped deployment and remains authoritative
and complete.

### The hold-back, if the dashboard is needed before the migration lands

Two variables, no code change. Photos follow reads on their own
(`activity-daily.ts:291` returns `supabase` whenever the read path is not
`neon`), the AI path is already `supabase` (no `NEON_AI_DATABASE_URL` is bound),
and auth is already Supabase:

```bash
cd frontend
printf 'supabase' | vercel env add NEON_READS_DEFAULT production
printf 'supabase' | vercel env add NEON_WRITES_DEFAULT production
vercel --prod
```

Owner decision 2026-08-11, 22:00 local: **not applied.** Only the owner was
online, no other teammate could hit the fixture path, and the migration ends by
repointing `NEON_DATABASE_URL` at the new project anyway — which resolves the
incident in the same motion. The commands stay here because they are the cheapest
reversal if that changes mid-flight.

## Measured state, both sides, before anything is written

### Supabase — live, 2026-08-11

25 of 25 business tables present, **27,304 rows**. PostgREST exposes 32
relations = 25 tables + 7 views, so there is **no Supabase-only table** whose
rows would have nowhere to land.

| Table | Rows | Table | Rows | Table | Rows |
| --- | --- | --- | --- | --- | --- |
| `sync_runs` | 11032 | `pipeline_events` | 511 | `icp_personas` | 3 |
| `messages` | 6498 | `campaign_steps` | 240 | `hypotheses` | 1 |
| `events` | 4895 | `follow_up_events` | 108 | `icps` | 1 |
| `leads` | 3742 | `briefings` | 43 | `playbook` | 1 |
| `campaigns` | 14 | `lead_notes` | 42 | `coaching_digest` | 1 |
| `instances` | 4 | `briefing_jobs` | 40 | `annotations` | 0 |
| `team_members` | 5 | `conversation_follow_up_state` | 37 | `saved_searches` | 0 |
| `icp_industries` | 23 | `lead_gender_reviews` | 33 | | |
| `conversation_coaching` | 22 | `hypothesis_campaigns` | 8 | | |

Views, which are the parity targets rather than rows to copy:
`campaign_metrics` 14, `daily_activity` 799, `pipeline_metrics` 54,
`campaign_reply_intent` 28, `conversation_reply_intent` 192,
`campaign_reply_sentiment` 45, `conversation_latest_message` 3366.

Instances, all four syncing on a ~30-minute cadence, last runs 17:13–17:22 UTC:
`karina-1`, `notebook-1`, `notebook-2`, `notebook-3` — all reporting
`agent_version` **1.12.2**.

### Schema drift: 24 of 25 tables are column-identical

Compared live PostgREST OpenAPI against the live Neon catalog. Exactly one table
differs, and it differs precisely at the identity boundary:

| Table | Only on Supabase | Only on Neon |
| --- | --- | --- |
| `team_members` | `auth_user_id` (uuid → `auth.users`) | `user_id` (uuid **NOT NULL** → `public.users`) |

Everything else matches column-for-column, including `leads` (36),
`messages` (20), `icps` (22), `follow_up_events` (17), `saved_searches` (14).
This is why the copy is mechanical and the identity layer is the only part that
has to be rebuilt rather than moved.

## Three scope discoveries that the plan as written did not contain

### 1. The notebooks run agent 1.12.2, not 1.14.0

`AGENT_VERSION` in the published `agent/agent.py` object is **1.12.2**; the repo
is at 1.14.0. All four instances report 1.12.2. So S22's `ingest_mode` transport
(1.13.0) **has never reached a notebook** — the dual-transport work is entirely
untested against a real LH2 machine.

Worse, the self-update channel *is* a Supabase bucket. `deploy.sh` publishes to
the private `agent` bucket, and notebooks poll it. So the release path has to
either move to R2 before Supabase is deleted, or the final agent release has to
go out through Supabase while it still exists. This is a step-6 dependency that
step 5 must not strand.

### 2. Seven roster-reference columns, not two

The plan names `leads.assigned_to` and `conversation_follow_up_state.owner_id`.
The catalog holds four FK references:

| Column | Non-null rows | Referenced ids |
| --- | --- | --- |
| `leads.assigned_to` | 168 | `{1:123, 2:6, 3:39}` |
| `conversation_follow_up_state.owner_id` | 37 | `{2:14, 3:23}` |
| `follow_up_events.previous_owner_id` | 71 | `{2:13, 3:58}` |
| `follow_up_events.new_owner_id` | 86 | `{2:22, 3:64}` |

and **three more that carry no foreign key at all**, so an FK-only scan misses
them: `pipeline_events.from_assignee`, `pipeline_events.to_assignee`,
`pipeline_events.actor`. Plus `lead_notes.author`,
`saved_searches.author`, `conversation_follow_up_state.updated_by`.

Those seven are all **`text`**, holding display names
(`Mykyta`/`Karyna`/`Anastasia`, plus `auto`, `unknown`, `airtable-import`), not
ids. Names are provider-independent, so they copy verbatim — but that had to be
checked rather than assumed, because a `text` column named `actor` is exactly
where an id would hide.

**Every referenced roster id is in `{1, 2, 3}`** — Mykyta, Karyna, Anastasia —
and all three have live accounts. So decision (d) resolves to its strict form:
**no attribution loss is necessary**, and an unresolvable reference is a bug, not
a trade-off.

### 3. Thirteen identity columns, not two

B2 handled `messages.id` and `events.id`. The real set is
`annotations`, `events`, `follow_up_events`, `hypotheses`, `icp_industries`,
`icp_personas`, `icps`, `lead_gender_reviews`, `lead_notes`, `messages`,
`pipeline_events`, `saved_searches`, `team_members` — all `id`, all
`GENERATED ALWAYS`. Every one needs `OVERRIDING SYSTEM VALUE` on insert and a
`setval` past the copied maximum, and the set is discovered from the catalog so a
table that gains one later cannot silently start re-keying.

The FK graph among `public` tables is a **DAG** (31 edges, verified acyclic), so
load order is computed by topological sort at run time rather than hardcoded.

## Two live verifications that settle inherited questions

- **The auto-advance grant is real.** On the live database,
  `public.pipeline_auto_advance()` has
  `acl = app_owner=X/app_owner app_runtime=X/app_owner app_system=X/app_owner`
  and `has_function_privilege('app_system', …, 'EXECUTE')` is **true**. The
  `AUTO_ADVANCE_BLOCKED` reason string in `classify.ts` — *"ledger step 008 is
  written and not applied"* — is confirmed **stale**. Step 008 is applied; the
  ledger reads **11/11, `complete: true`**. Enabling the capability is now a
  decision about running a real mutation on live data, not a blocked dependency.
- **`CRON_SECRET` is set** on Vercel (Production + Preview, ~32 days). The
  memory note claiming it was unset is wrong. `vercel env pull` masks sensitive
  values as `[SENSITIVE]`, so presence is confirmable and the value is not.

## Owner decisions, 2026-08-11

| # | Decision | Consequence |
| --- | --- | --- |
| a | **A new, dedicated Neon project** | Full isolation from the S11/S13 fixtures and from `test:neon`, which writes to the existing database. A fresh `team_members` identity space means ids 1–5 can be preserved exactly and B2's remap hazard disappears. Costs one more Neon project. Requires `ALTER ROLE … PASSWORD` out of band — the `N-UITOP` bootstrap defect is still unfixed in the control plane. |
| b | Deferred to step 6 | `postgres/tenant-baseline/v1` is the target schema. `supabase/migrations/` is not applied to the new project at all, so the `054_private_lead_photos.sql` delta question is answered by whether the baseline already covers `leads.photo_path` — it does; the column is present and identical. |
| c | **Quiet window, then Supabase read-only** | The four notebooks are paused for the copy, so there is no torn copy to reconcile in the common case. A watermark + delta pass exists anyway, because a pause that silently fails must not produce a silent gap. |
| d | **Invite + self-service reset**, and no attribution loss | Five `admin.invite` calls, then `password.requestReset` / `password.completeReset` per person — the flow the owner used already. The roster id mapping is **measured by email afterwards and asserted**, never assumed from invite order. |

The fixtures in `proud-voice-47907246` are **not** being deleted. The owner's
phrasing was "remove all fixtures completely"; with a new project that is
satisfied by construction for everything production reads, and deleting the old
project's fixtures would red the 226 live `test:neon` assertions that use them as
a baseline. If they are ever to be removed, that is a separate decision with that
cost attached.

## Why this is a new tool and not an extension of `b2_tenant_slice.mjs`

The instruction was to extend it or argue why not. Arguing why not.

`b2_tenant_slice.mjs` opens by explaining that its scope is *"a constant rather
than a flag so that the approved slice and the code that copies it cannot drift
apart, and so `delete` removes exactly what `load` wrote."* Extending it to serve
S28 means making `SCOPE` variable — turning the one property its header claims
into a parameter, on a tool whose `delete --confirm` path is scoped by that same
constant. The blast radius of getting that wrong is a `DELETE` against real rows.

Beyond that, almost nothing survives contact:

| | B2 | S28 |
| --- | --- | --- |
| Tables | 6, hardcoded order | 25, topologically sorted from the catalog |
| Rows | ceiling 8039 | 27,304, no ceiling |
| Instances | one (`notebook-1`) | all four |
| Identity columns | 2, and it *re-keys on collision* | 13, and re-keying is forbidden |
| Assignees | `ASSIGNEE_REMAP` **drops** attribution by decision | every reference must resolve or the load fails |
| Identity/roster | out of scope, not copied | the hard part |
| Storage | none | 671 objects to R2 |

Its `ELSE` branch that re-keys a colliding identity value is actively wrong for
S28: on a dedicated target a collision means the load is running twice, which
must abort, not silently produce a second copy under new ids.

What *is* reused is the hard-won machinery, carried over deliberately and cited
in the new tool's header: `count=exact` on every page (without it the source
reports `*` and every table over 1000 rows truncates silently — the defect that
bit B2 on its first run), `countCsvDataRows` honouring quoted newlines, taking
the column list from the **target** and demanding it of the source, staging
tables so the load can assert before it commits, `setval` past the copied
maximum, and `normalise`/`compareRows` for parity across a JSON reader and a SQL
reader. `b2_tenant_slice.mjs` is left byte-identical.

## The rehearsal, and the two defects only it could have found

Before any of the gates below, the whole data path was rehearsed end to end
against a **throwaway PostgreSQL 17 container**: ledger 000–010 applied from
scratch, a stand-in roster, then `roster-map` → `extract` → `load` → `verify`
over the **real 27,334 live rows**. It cost about fifteen minutes and it found two
defects that would otherwise have been found against the owner's new database.

Final rehearsal result: **47 parity checks passed, 0 failed** — every one of the
five funnel views agreeing cell for cell, NULL counts matching across all 305
columns, and the milestone invariant clean over 3,743 leads.

The container and the extracted CSVs were deleted afterwards: they held real
names, LinkedIn URLs and message bodies, and a rehearsal that leaves a copy of
production in a throwaway container has not finished.

### Defect 1 — the source's CSV cannot be trusted for `jsonb`

`b2_tenant_slice.mjs` states that CSV is requested *"so the source renders every
value in the text form COPY reads back, including jsonb. Nothing re-encodes a
value here."* **That is false.** PostgREST's CSV writer backslash-escapes inside
the field and `COPY … FORMAT csv` does not unescape backslashes:

```
source value     [{"body": "Anastasia \"Standart Offering\""}]
PostgREST CSV    "[{""body"": ""Anastasia \\""Standart Offering\\""""}]"
after COPY csv   [{"body": "Anastasia \\"Standart Offering\\""}]
                                       ^^ a literal backslash, then a quote
                                          that terminates the JSON string
```

The load aborted with `invalid input syntax for type json … Token "Standart" is
invalid`. `\n` corrupts identically, becoming a literal backslash and an `n`.

**The same defect is latent in `b2_tenant_slice.mjs`.** Its six-table slice has
exactly one jsonb column, `instances.config`, whose values are flat keys with no
quote, backslash or newline — so it has never fired. This is the same family as
the reply-intent truncation: a real defect that green runs cannot see because the
data never exercised it.

The fix is to stop relying on an escaping contract that does not hold. Values are
fetched as **JSON**, and this tool encodes the CSV that COPY reads, using the
**target's** declared type per column. 12 `jsonb` columns and 11 `text[]` columns
depend on it, including `leads.raw` and `events.raw` — the two largest. `text[]`
needed its own encoding besides: a Postgres array literal, not JSON, or
`{"a","b"}` would have been stored as the string `["a","b"]`.

Because the encoder is now this tool's responsibility, `verify` gained a generic
net under it: **per-column NULL counts on both sides, every column of every
table**. A jsonb `null` coerced to SQL NULL, an empty string read as NULL, an
array that arrived as a string — none change a row count and most change no funnel
view, but all of them move a NULL count.

### Defect 2 — parity compared by position, and collation is not portable

With the encoding fixed, `conversation_reply_intent` reported **12 differing
cells** over data that was in fact identical. The cause was the comparison, not
the copy: `daniël-huizinga-865722174` and `daniel-jasewicz` sort in a different
order under the source's collation than under the target's, so a positional walk
was comparing two different rows against each other.

Rows are now matched **by the view's grain**, never by position. That removes a
whole class of false failure, and it makes a genuinely missing row say so instead
of shifting every subsequent row and reporting hundreds of differences. The
comparison also now asserts that the declared grain is actually unique on both
sides, so a wrong `keys` list cannot silently hide duplicates.

This one matters beyond this tool: `b2_tenant_slice.mjs` compares positionally
too, and its `daily_activity` parity check passed only because that view's keys
happen to be ASCII.

### Two things the rehearsal proved rather than found

- **The remap path works, and was tested on a scrambled roster.** The stand-in
  roster was deliberately inserted in an order that does *not* match the source
  ids (source 1→3, 2→2, 3→4, 4→5, 5→1), so the run exercised the remap rather
  than the lucky case where ids line up. Had the roster been seeded in source
  order, a tool that ignored the map entirely would have passed.
- **`load` → `rollback` → `load` is re-runnable**, and `rollback` run twice is
  idempotent and leaves the roster and identity rows untouched.

### A usability defect fixed on the way

Running `load` twice was correctly refused — nothing was duplicated — but it
reported `EPIPE`. psql raises the exception and exits while the tool is still
writing 8 MB to its stdin, so the database's own message was lost behind a
plumbing error. That is precisely the shape S27 step 2 was about: every cause
arriving at the log as one label. Now psql's stderr wins whenever it said
anything, **and** the emptiness check runs as one round trip before any SQL is
generated, so the common mistake costs nothing and names itself. The
in-transaction guard is kept as the race-safe backstop and was confirmed to still
fire.

## The gates

Each gate ends in a state that can be stopped at, and nothing before gate 4
writes to a database that anything reads.

### Gate 0 — hold-back (optional, owner-run, skipped)
The two `vercel env add` commands above. Declined; see the incident section.

### Gate 1 — the target exists and is empty — ✅ DONE 2026-08-11

| | |
| --- | --- |
| Neon project | `autumn-snow-04881924` — "linkedin-dashboard-production" |
| Region | **aws-eu-central-1**, PostgreSQL 17, autoscale 0.25–2 CU |
| Branch / endpoint / database | `br-mute-thunder-b2z1b874` `main` / `ep-polished-art-b2swajhh` / `neondb` |
| Ledger | **10/10**, `verify` → *"ledger consistent: 10/10 steps, order 1 → … → 10"* |
| Structure | 29 tables in `public`, 7 views, 4 in `identity`, **0 rows** |
| Credentials | `~/.config/neon-s28-production.env`, mode 0600 |

**Region: chosen deliberately, and it is not reversible.** The live Supabase
project is in **eu-west-1** and the existing Neon project in **eu-central-1**, so
the data is in the EU today; `aws-eu-central-1` keeps it there. Vercel's functions
run in **iad1**, so every query already crosses the Atlantic — that is unchanged,
not newly introduced. `us-east-1` would have removed ~90 ms per round trip (and
connection pressure on Neon Free is a named suspect for the intermittent 500), but
it would also have moved EU personal data to the US as a side effect of a
migration, which is not a call to make silently. **The better version of that win
is to move the compute, not the data**: pinning Vercel functions to `fra1` would
put them ~10 ms from this database and beat any US arrangement. Worth doing, out
of scope here.

The four role bootstraps were applied as `neondb_owner`, then the five login roles
(`app_migration`, `app_runtime`, `app_system`, `app_machine`, `identity_store`)
were given generated 36-character alphanumeric passwords with `ALTER ROLE` —
**the `N-UITOP` defect is still unfixed in the control plane**, so Neon holds no
credential for roles the bootstrap creates. Alphanumeric only, so a password can
never be mangled by URL-encoding on its way into a connection string, which is one
of the ways N-UITOP shipped empty ones.

**Each of the six credentials was then verified by connecting as the application
would** and asserting `current_user`, pooled and unpooled. That is the check
tenant step 11 does not do — it compares environment names, types and scopes and
never connects — and it is why uitop passed 13/13 while being unable to open its
own database.

Two procedural notes for the next database:

- **Do not apply `000_migration_ledger.sql` by hand.** The runner applies it *and*
  records the role-bootstrap digest together, but only when the ledger is absent.
  Applying it manually first makes every subsequent `apply`/`verify` fail with
  `role_bootstrap_missing`. Recovered here by dropping the `app_ledger` schema and
  letting the runner do both.
- The ledger refuses a superuser (`apply_principal_invalid`), which is why the
  bootstraps run as the owner role and the ledger runs as `app_migration`.

Nothing in production points at this project yet. `s28_owner_migration.mjs counts`
against it reports **27,338 source rows / 0 target rows**.

### Gate 2 — identity, and the measured roster map — ✅ DONE 2026-08-11

Seeded directly as `app_owner` rather than through
`identity_admin_invite_member_atomic`, for one reason: that function gates on
`public.is_app_admin()`, so the **first** admin is a chicken-and-egg on an empty
database. The seed replicates exactly what the function does — the five inserts
are visible in `005_identity_atomic_invite.sql` — and is then **verified through
the function the application actually calls**, which is a stronger check than
trusting either path:

```
better-auth | 1 | Mykyta     | d6eb4d94… | admin | matches roster
supabase    | 1 | Mykyta     | d6eb4d94… | admin | matches roster
…all five, both providers, 10/10 resolve
```

Three decisions inside it that are load-bearing:

- **Both provider rows per person, not one.** This is the one that would have
  reproduced the current incident on the new database. `VITE_AUTH_PATH` stays
  unset through gate 6, so every teammate signs in through **Supabase** and
  presents a legacy bearer that `resolveActor` looks up under provider
  `supabase`. With only a `better-auth` row, all five would get **403 "Your
  account is not an active team member"** the moment gate 6 landed. Each person
  therefore has a `better-auth` row (a fresh subject uuid) *and* a `supabase` row
  carrying their **real** `auth_user_id`. The fixture database's defect was
  precisely this row pointed at the wrong person.
- **Source ids 1–5 preserved.** `team_members.id` is `GENERATED ALWAYS`, so the
  seed needs `OVERRIDING SYSTEM VALUE` — the same rule the load applies to all 13
  identity columns, and the reason `roster-map` reports *"id preserved"* for all
  five rather than a remap. The sequence is then moved past the maximum.
- **Password hashes are structurally scrypt-shaped but random**
  (`<32 hex>:<128 hex>`), so credential verification returns false cleanly instead
  of throwing on a malformed hash. Nobody knows a matching password; everyone
  arrives through `password.requestReset`, which works on this deployment. All
  five are `role='admin'`, matching the source, and `emailVerified` is false.

**Stop state reached:** roster present and resolving, no business rows yet.

### Gate 3 — extract (read-only against Supabase) — ✅ DONE 2026-08-11

**27,338 rows** across 24 tables, watermark **`2026-08-11T20:59:00.223Z`**,
milestones captured for **3,743 leads**. Every request a `GET`; Supabase untouched.

**The notebooks were not paused** — there is no remote "pause sync" control, and
`auto_update` is not one. So the copy ran against a moving source and the drift is
real and measured: over the session `sync_runs` went 11032 → 11060, `messages`
6498 → 6503, `leads` 3742 → 3743. This is exactly what the watermark is for, and
why gate 7 exists rather than being optional. Supabase stays authoritative until
gate 6, so drift costs nothing until then.

### Gate 4 — load and prove parity — ✅ DONE 2026-08-11

Loaded in one transaction after a clean `--dry-run`. All three roster remaps
fired (`leads.assigned_to`, `conversation_follow_up_state.owner_id`,
`follow_up_events.new_owner_id`+`previous_owner_id`) — and because gate 2
preserved the ids, every remap was an identity mapping, which the tool reported
rather than assumed.

**Parity: 47 passed, 0 failed**, in ~33 s:

- per-table row counts, all 24 tables, source against target;
- the five funnel views **cell by cell** — `campaign_metrics` (14),
  `daily_activity` (800), `pipeline_metrics` (54), `campaign_reply_intent` (28),
  `conversation_reply_intent` (192) — each also asserting its grain is unique on
  both sides;
- **per-column NULL counts across all 305 columns**, both sides;
- **no milestone regressed to NULL**, and every one of the 3,743 source leads
  present on the target.

One tool fix was needed here: the NULL-count check spawned one Docker `psql` per
column and timed out at two minutes. It is now **one query per table** (a single
scan with `count(*) FILTER`) with the source's unavoidable per-column requests run
at bounded concurrency — 305 process spawns became 24.

**Stop state reached.** `rollback --confirm` remains the way back and leaves the
gate-2 roster intact.

### Gate 5 — storage
Copy `lead-photos` → R2 under `OBJECT_STORAGE_TENANT_ID=ciphercross`, bucket
`linkedin-campaign-dashboard`, preserving the `<instance>/<slug>.jpg` key so
`leads.photo_path` still resolves. Verify **bytes** via SHA-256 on HEAD, which R2
does return.

Known and pre-existing: **36 of 707 `photo_path` values have no object**
(`karina-1` 300 paths/273 objects, `notebook-2` 87/78, `notebook-1` 87/87,
`notebook-3` 233/233). Dangling at the source must be reported as such, never
counted as a transfer loss.

**Stop state:** 671 objects in R2 with matching digests, and a named list of the
36 dangling paths.

### Gate 6 — repoint production
Swap `NEON_DATABASE_URL` to the new project; add `NEON_AI_DATABASE_URL` and
repoint `IDENTITY_STORE_DATABASE_URL`. This is the cutover **and** the incident's
resolution: the read path is already `neon`, so pointing it at loaded data is the
whole change. `VITE_AUTH_PATH` stays unset until gate 2's resets are done, which
is the deliberately supported transitional combination.

**Stop state:** the dashboard serving real data on Neon. Reversible by the two
hold-back variables.

### Gate 7 — delta reconcile — ✅ DONE 2026-08-12

The plan's recipe above ("un-pause the notebooks, let one cycle run, copy the
delta since gate 3's watermark, re-run parity") **does not describe this job and
must not be followed.** Gate 0 was skipped, so the notebooks were never paused;
they have since cut over to the Neon gateway entirely (S29, agent 1.15.1,
`ingest_mode: only`). Three facts changed the shape of the work:

1. **The agent re-extracts everything each run and upserts idempotently**, so each
   notebook's first `only` sync pushed its whole current extraction into the new
   database. Almost all agent-owned data self-reconciled — measured below, not
   assumed.
2. **What could not self-reconcile** is anything Supabase holds that the agent no
   longer produces, plus every table the agent never writes.
3. **There is a third store.** From the S27 step-4 deploy until gate 6,
   production's read *and write* path resolved `neon` against the **fixture**
   database `proud-voice-47907246`. Anything the dashboard or the crons wrote in
   that window would have landed there, not in Supabase and not in the new
   project.

Everything below was measured read-only on 2026-08-12 08:1x–08:4x UTC against all
three stores. Nothing was written.

#### The three stores, and the two epochs that separate them

| Boundary | When | Evidence |
| --- | --- | --- |
| Extract watermark (what the load contains) | `2026-08-11T21:32:29.911Z` | session 3 |
| Incident window opens (prod writes → fixture DB) | 2026-08-11 17:33 UTC | `dpl_DtCf3jdY…` |
| Gate 6 repoint (prod writes → new project) | 2026-08-11 ~22:1x UTC | Vercel env `NEON_DATABASE_URL` |
| **Notebooks stop writing to Supabase** | **`2026-08-11T23:25:07Z`** | `max(sync_runs.started_at)` on Supabase; no notebook wrote to it after |
| Crons still writing to Supabase | **ongoing, daily** | `briefings.created_at` = `2026-08-12T07:33:56Z` |

The last boundary is the one that matters most: **Supabase is not frozen.** The AI
layer resolves from its own credential, `NEON_AI_DATABASE_URL`, which is **not
bound on Vercel Production** — confirmed by `vercel env ls production`. So
`deploymentAiPath()` is `supabase`, and `classify` (06:00), `notify-replies`
(06:30) and `briefing` (07:00) still read *and write* Supabase every morning,
where the dashboard cannot see the result. Today's run is already in the delta;
tomorrow's will be too.

#### The third store holds nothing — measured, not assumed

Every one of the 29 `public` tables in `proud-voice-47907246` carries at least one
`timestamptz` column (verified from the catalog, so the scan below has no blind
spot). Scanning **all 61 timestamp columns** for any value in
`[2026-08-11 17:00Z, 2026-08-12 12:00Z]` returns exactly two hits:

```
playbook.updated_at        1 row  2026-08-11 17:24:36Z   content = "shared fixture"
pipeline_events.occurred_at 7 rows 2026-08-12 11:00:00Z   (a future round hour — synthetic fixture)
```

The `playbook` write predates the 17:33 deploy by nine minutes and is a test-session
row. The `pipeline_events` rows are dated in the future relative to now and are
fixture data of the same family the damage assessment already identified.

Corroborating, from the same database:

- **Zero rows naming a real notebook.** `leads`, `messages` and `sync_runs`
  filtered to `karina-1|notebook-1|notebook-2|notebook-3` all answer **0**;
  `instances` holds only `notebook-test`, `s11-contract`, `s12-activity`,
  `s13-dashboard`, `s13-rest`.
- `sync_runs` is **empty** and `briefings`/`briefing_jobs` are **empty** — the
  crons never wrote here, because they were on the Supabase branch throughout.
  Supabase's own `messages.notified_at` maximum of `2026-08-11T18:49:44Z` sits
  *inside* the incident window and proves where `notify-replies` was writing.
- `identity.session` is **empty**, so nobody signed in through Better Auth;
  `agent_ingest_batch`'s newest row is `2026-08-07`, from the S21 session.

**Conclusion: nothing has to be recovered from the fixture database.** The reason
is structural rather than lucky — the two write paths that were pointed at it
(dashboard CRM writes, and photos) went unused in a ~4.5-hour window in which the
only teammate who could authenticate was demoted to `member` and shown fixture
data, while the three cron writers were on a separate flag that never moved.

This also settles the standing caution: **`npm run test:neon` is safe to run
again.** It writes to this database, which production no longer reads and which is
now proven to hold no unique record of anything.

#### The delta that is real: Supabase → `autumn-snow-04881924`

Diffed row by row, both sides read in full, matched **by each table's real grain**
(the surrogate `id` is not the grain for `events` or `messages` — both sides
allocate it independently). All 24 business tables covered.

**Supabase is ahead here — these rows/values are absent from the new database:**

| # | Table | What is missing | Rows | Origin |
| --- | --- | --- | --- | --- |
| 1 | `briefings` | `ef83b560-cca3-4a41-b133-b2c818b97a36`, date 2026-08-12 | 1 | briefing cron, 07:33 UTC today |
| 2 | `briefing_jobs` | `(2026-08-12, daily)` | 1 | same run |
| 3 | `messages` | sentiment + intent, 9 columns each | 3 | classify cron, 06:00 UTC today |
| 4 | `leads` | `gender`, `gender_confidence`, `gender_model_version`, `demo_model`, `demo_inferred_at`, `gender_inferred_at` | **100** | classify demographics, 06:00 UTC today |
| 5 | `leads` | `pipeline_stage` + `pipeline_stage_changed_at` | 5 | `pipeline_auto_advance()`, 06:00 UTC today |
| 6 | `pipeline_events` | source ids 516–520, all `actor='auto'` | 5 | the same auto-advance |
| 7 | `sync_runs` | 23 rows, `2026-08-11 21:43Z` → `23:25Z`, all `ok` | 23 | notebook syncs between the extract and the cutover |

**Nothing was archived out of the source.** `leads` 3743 = 3743 with **zero**
source-only ids, `campaigns` 14 = 14, `campaign_steps` 240 = 240, `events` 4901 =
4901 with zero source-only rows on the natural key, `messages` **zero**
source-only rows. The scope discovery this gate was most likely to find —
excluded campaigns or archived leads stranded in Supabase — **does not exist
here**. `annotations` and `saved_searches` are empty on both sides;
`lead_notes` (42), `conversation_coaching` (22), `icps`/`icp_industries`/
`icp_personas`, `hypotheses`, `hypothesis_campaigns`, `playbook` and
`coaching_digest` are byte-identical.

**Item 6 is a genuine hazard, not a copy.** `pipeline_events.id` is
`GENERATED ALWAYS`, and both databases have allocated past the load's high-water
mark independently. Ids **516 and 517 exist on both sides as different rows** —
on Supabase they are two of today's auto-advance rows, on Neon they are
Anastasia's 07:18 stage change and assignment. These five cannot be copied by id;
they have to be re-keyed, and the table has no natural key to make that
idempotent.

**Neon is ahead here — this is live work that a copy must not clobber:**

| Table | Neon-only | What it is |
| --- | --- | --- |
| `sync_runs` | +41 | post-cutover notebook syncs, all four instances |
| `messages` | +14 | post-cutover agent extraction (8 outbound sent today) |
| `follow_up_events` | +12 (ids 109–120) | Anastasia, 06:03–07:18 UTC today |
| `conversation_follow_up_state` | +1 row, 8 rows advanced | same |
| `lead_gender_reviews` | +1 (id 34) | a manual gender set, 07:18 UTC today |
| `pipeline_events` | ids 516, 517 | a stage move to `following_up` and an assignment |
| `leads` | 1 lead's `pipeline_stage`, `assigned_to`, `first_message_at`, `gender` | the same lead, `fb60e9f9…` |
| `campaign_steps` / `instances` | 226 / 4 rows of counters and stamps | ongoing sync |

That list is the proof the cutover took: **the dashboard is being used against the
new database and the notebooks are feeding it.**

**Differences that are not a delta and must not be "fixed":**

- **`messages.body`, 179 rows — trailing whitespace only.** Source longer in
  **179 of 179**, target longer in **0**, substantive differences **0**, and the
  `content_hash` is identical on both sides. Agent 1.15.1 / the ingest gateway
  trims; the target holds the normalised form.
- **`events`, 1 surrogate `id`.** Same `(instance_id, campaign_id, profile_url,
  event_type)` — the table's own unique key — same `occurred_at`. Two independent
  sequences, one logical row.
- **`leads.age_inferred_at` (2411) and `updated_at` (2428)** — stamps, target
  newer, `age` itself agrees.
- **`leads.status` and `last_action_at`, 5 leads** where Supabase is ahead
  (`status` 2 vs 1; `last_action_at` up to 45 minutes later, in each case the
  `sent_at` of an inbound reply). This is **not** migration drift: the current
  agent rewrites both columns on every sync, and wrote the *older* value into Neon
  as recently as today 06:22 and 08:13 UTC. Copying them would be reverted within
  the half-hour. It is a behavioural difference between agent 1.12.2 → Supabase
  and 1.15.1 → gateway, worth its own investigation (the `person_external_ids`
  one-slug-per-person dedup is the usual suspect). The funnel is unaffected:
  the milestone columns and all `messages` agree, and `daily_activity` is
  cell-for-cell identical across all 801 rows.

#### The parity verify, re-run — and why "passing" is now the wrong bar

`s28_owner_migration.mjs verify`, read-only, 2026-08-12: **29 passed, 18 failed.**
Every failure is one of the two directions above, and the checks that carry the
funnel all pass:

```
ok    daily_activity: 801 rows both sides, grain unique, every cell agrees
ok    campaign_metrics: 14 rows, every source row has a counterpart
ok    every source lead is present on the target (3743 checked)
ok    no milestone regressed to NULL
FAIL  briefings 44/43, briefing_jobs 41/40, pipeline_events 516/513   (source ahead — today's cron)
FAIL  messages 6503/6517, sync_runs 11087/11105, follow_up_events 108/120,
      conversation_follow_up_state 37/38, lead_gender_reviews 33/34   (target ahead — live work)
FAIL  campaign_metrics: 7 cells — all last_activity_at, target newer in all 7
FAIL  pipeline_metrics / campaign_reply_intent / conversation_reply_intent
FAIL  41 columns differ on NULL count
```

**The verify's premise has expired.** It asserts that Supabase is authoritative and
the target is a copy of it. Since gate 6 that is false in both directions at once:
Supabase is frozen for notebook data and still moving for AI data, while Neon is
the live system of record for everything else. A green `verify` against this pair
is no longer achievable *and would no longer mean anything if it were* — it would
require reverting Anastasia's morning. The bar for gate 7 has to be restated as:
every Supabase row either present on the target or explicitly accounted for, plus
the funnel checks (`daily_activity`, milestone presence, no milestone regression)
still green. Those are the checks that survive the change of authority, and all
three pass today.

#### The bleed had to stop before this could close — and it did, under gate 9

*(Written while it was still open; the binding landed later the same day. Kept in
the present tense of the moment because the reasoning is what makes gate 7
durable rather than a one-off copy.)*

Copying today's seven items closes a gap that reopens at 06:00 UTC tomorrow. The
crons write to Supabase because `NEON_AI_DATABASE_URL` is unbound; binding it to
the `app_system` URL from `~/.config/neon-s28-production.env` moves the whole AI
layer — reads and writes together, by design — onto the new database. The
prerequisites are all in place there and were re-verified today: the ledger reads
**10/10 including step 007** (the system write path) **and step 008**, and
`has_function_privilege('app_system', 'public.pipeline_auto_advance()', 'EXECUTE')`
is **true**.

Two consequences the owner has to weigh, because they are not reversible by
themselves:

- **Auto-advance is running right now, on Supabase, invisibly.** Items 5 and 6
  above are `pipeline_auto_advance()` output from this morning. Moving the AI path
  to Neon **stops it**: `classifyCronOnNeon` passes the hard-coded
  `AUTO_ADVANCE_BLOCKED` constant, whose reason string — *"ledger step 008 is
  written and not applied"* — is stale on this database. So the choice is not
  "enable or retire"; it is "keep it running where nobody can see it", "let it
  stop when the path moves", or "correct the constant and let it run where the
  dashboard is". That is gate 9's decision and it now blocks gate 7's durability.
- **New inbound replies are not reaching Slack.** `notify-replies` follows the same
  flag, so it is watching Supabase, where no new reply will ever arrive again. No
  damage yet — Neon has **zero** unnotified inbound messages since the cutover,
  because no reply has come in — but the next one will be silent.

#### Photos, checked while here

`leads.photo_path`: **708 non-null / 672 distinct on both sides**, identical sets.
Gate 5 copied all 672 distinct values, so there is no new object to move and no
new dangling path. Forward-looking only: `sync_photos` refuses on the machine
path, so a lead that gains a photo after the cutover will have no object behind
it. Not a gate 7 item.

#### The copy, applied 2026-08-12 ~10:2x UTC

Owner decisions taken on the scope above, before anything was written:

| Item | Decision |
| --- | --- |
| 1, 2, 3, 4 | copy |
| **5, 6 — auto-advance** | **drop, recorded as deliberate** |
| 7 — `sync_runs` | copy |
| the daily bleed | **bind `NEON_AI_DATABASE_URL`, leave auto-advance stopped** |

Items 5 and 6 were dropped for three reasons that compound: they are a machine
decision taken against a database that is no longer the system of record; one of
the five would have overridden the stage Anastasia set by hand on the target at
11:08 the previous day; and `pipeline_events.id` had already collided, so copying
them meant re-keying into a table with no natural key to make the re-key
idempotent. Their absence is visible and expected in `pipeline_metrics` below.

**The copy ran as `postgres/tools/s28_gate7_delta.mjs`** — a new, separate tool.
It is not a `delta` mode on `s28_owner_migration.mjs`, and the reason is in its
header: that tool copies whole tables into an *empty* database and its `rollback`
empties them again, whereas gate 7's target is **live and ahead of the source in
eight tables**. A whole-row upsert would have reverted a teammate's morning.
`s28_owner_migration.mjs` and `b2_tenant_slice.mjs` are both left byte-identical.

Its two properties that matter:

- **Every write is column-scoped and fill-only.** The two INSERTs carry
  `ON CONFLICT … DO NOTHING` on the target's own natural key; the two UPDATEs
  name a fixed column list and match only rows where the target value is still
  absent (`gender IS NULL`, `sentiment IS NULL AND classified_at IS NULL`). The
  column lists are load-bearing beyond tidiness: `leads` carries
  `BEFORE UPDATE OF` triggers on `full_name`, `headline`,
  `education_start_year` and `first_job_start_year`, so naming a column that does
  not need writing has side effects.
- **It re-measures at apply time and refuses a shape it was not approved for.**
  The crons write to the source every morning, so the delta drifts by design; a
  changed shape stops the tool rather than copying whatever happens to be there.

`apply` ran **106 statements, 128 rows, in one transaction**, with per-table
count assertions inside it before `COMMIT` so a partial application could not
survive. Re-running `plan` afterwards reports **0 outstanding** — the writes are
idempotent, proven by running it.

**The fill-only guard earned its place immediately.** Two leads were deliberately
*not* written:

- `fb60e9f9…` (Ana Cecilia Maza) — the target holds `gender='female'`,
  `demo_model='manual'`, set by Anastasia at 07:18 that morning. The source holds
  NULL. An unguarded copy would have destroyed a manual gender review, which
  `classify.ts` is explicitly built to preserve.
- `0d57a388…` (Ken DeCesare) — both sides infer the same gender; only the
  *stamp* differs (source re-inferred today, target on 2026-07-30). Copying would
  have moved a timestamp for no gain.

#### Gate 7 result — CLOSED

`s28_owner_migration.mjs verify`, re-run after the copy: **36 passed, 11 failed**,
up from 29/18 before it. Against the restated bar — every source row present or
explicitly accounted for, and the funnel checks green — this passes:

```
ok    daily_activity: 801 rows, grain unique, EVERY CELL AGREES
ok    campaign_metrics: 14 rows, every source row has a counterpart
ok    every source lead is present on the target (3743 checked)
ok    no milestone regressed to NULL
ok    briefings 44/44 · briefing_jobs 41/41 · events 4901 · leads 3743 · campaigns 14
ok    campaign_reply_intent and conversation_reply_intent — both now clean
```

The 11 remaining failures are the accounted-for set, and each is named here so a
future reader does not re-investigate them:

| Failure | Why it is expected |
| --- | --- |
| `messages` 6503/6517, `sync_runs` 11087/11128, `follow_up_events` 108/120, `conversation_follow_up_state` 37/38, `lead_gender_reviews` 33/34 | **target ahead** — post-cutover agent syncs and Anastasia's 06:03–07:18 work |
| `pipeline_events` 516/513 | the five dropped auto-advance rows, minus the target's own two |
| `pipeline_metrics` 56/54, 2 missing buckets, 3 differing counts | the same five, seen through the view |
| `campaign_metrics` 7 cells | all `last_activity_at`, target newer in all seven |
| 39 columns of NULL-count drift | the row-count differences above, seen per column |

Independently re-diffed outside the tool, matching on each table's real grain:
`briefings` and `briefing_jobs` **0 differences**, `sync_runs` **0 source-only**,
`messages` classification columns **gone from the diff entirely**, `leads`
demographic columns down from 101 rows to the 2 deliberate skips above.

**Every row that existed in Supabase or the fixture database at cutover is now
either present in `autumn-snow-04881924` or accounted for above.**

#### The durability problem this left, closed under gate 9 the same day

The copy fixed today. On its own it would **not** have stopped the bleed —
tomorrow's 06:00 classify and 07:00 briefing would have written to Supabase again
and a new delta would have existed by 08:00 UTC. **This was closed later the same
day under gate 9**: `NEON_AI_DATABASE_URL` is now bound and deployed. Kept here
because the command is the reversal too, and because the reasoning is what makes
gate 7 durable rather than a one-off:

```bash
cd frontend
# the app_system URL from ~/.config/neon-s28-production.env
printf '%s' "$NEON_AI_DATABASE_URL" | vercel env add NEON_AI_DATABASE_URL production
vercel --prod
```

Verified on the target today, so this is unblocked: the ledger reads **10/10
including step 007** (the AI system write path) **and step 008**, and
`has_function_privilege('app_system', 'public.pipeline_auto_advance()', 'EXECUTE')`
is **true**.

What binding it does, in one place:

- sentiment, intent, demographics, briefings and `notify-replies` all move to the
  live database. **Slack reply alerts resume** — they are currently watching
  Supabase, where no new reply will ever arrive again. No damage yet: the target
  has **zero** unnotified inbound messages, because none has come in since the
  cutover.
- **auto-advance stops**, because `classifyCronOnNeon` passes the hard-coded
  `AUTO_ADVANCE_BLOCKED` constant. Its reason string —
  *"ledger step 008 is written and not applied"* — was **false on this database**.
  **Corrected under gate 9**: it now names the decision rather than a migration
  that is already applied, and the block is documented where it actually lives —
  the missing `classify.autoAdvance` registry entry, not the grant graph. Until
  the binding landed, the asymmetry was that auto-advance was running that
  morning, on Supabase, where nobody could see it.

Two smaller things this session established that belong to other gates:

- **`leads.status` and `last_action_at` differ on 5 leads, source ahead**, and it
  is not migration drift — the current agent rewrites both columns every sync and
  wrote the *older* value into the target as recently as 08:13 UTC today. It is a
  behavioural difference between agent 1.12.2 → Supabase and 1.15.1 → gateway,
  worth its own look (the `person_external_ids` one-slug-per-person dedup is the
  usual suspect). The funnel is unaffected: milestones and `messages` agree and
  `daily_activity` is cell-for-cell identical.
- **`sync_photos` refuses on the machine path**, so a lead that gains a photo
  after the cutover will have no object behind it. Photo *state* is currently
  clean — 708 non-null / 672 distinct `photo_path` on both sides, all 672 copied
  at gate 5 — so this is a forward-looking gap, not a backlog.

### Gate 8 — agents
Deploy the agent release, add the Supabase-off `ingest_mode` member, prove it on
**one** notebook, then move the other three. `ingest_token` and
`release_public_key` stay local-only; `ingest_url` / `ingest_mode` are
remote-config.

### Gate 9 — cron and the auto-advance decision — ✅ DECIDED 2026-08-12

`CRON_SECRET` was already set. Both halves are now settled.

**The cron half is done.** `NEON_AI_DATABASE_URL` is bound on Vercel Production
and deployed, so `classify` (06:00), `notify-replies` (06:30) and `briefing`
(07:00) all read *and* write the live database from the next run. That is what
stops gate 7's delta reopening every morning, and it is what makes Slack reply
alerts work again — they had been watching Supabase, where no new reply will ever
arrive.

**The auto-advance half: retired, deliberately.** Owner decision 2026-08-12. Not
by default and not by omission — the alternative was live and was chosen against.

Three things about it that are easy to get wrong, and that the code now states:

- **It was running, invisibly, right up to today.** `pipeline_auto_advance()`
  executed on Supabase at 06:00 UTC on 2026-08-12 and moved five leads. Those five
  stage changes and their five `pipeline_events` are exactly the items gate 7
  dropped. Nobody could see them, because the dashboard had been serving Neon
  since the previous evening.
- **The block is structural, not a missing grant.** On this database ledger step
  008 **is** applied and `has_function_privilege('app_system',
  'public.pipeline_auto_advance()', 'EXECUTE')` is **true**. What keeps the cron
  off the pipeline is that `classify.autoAdvance` is not registered in the system
  operation registry at all (`aiSystem.ts`), with a test in `aiSlice.test.ts`
  asserting the omission. That test has quietly changed character: it began as a
  backstop behind an unapplied migration and is now the *only* thing standing
  between the 06:00 cron and a real mutation on live data.
- **The `AUTO_ADVANCE_BLOCKED` reason string was corrected**, because it is
  returned in a response body an operator reads. It used to say *"app_system holds
  no EXECUTE on pipeline_auto_advance(); ledger step 008 is written and not
  applied"* — false here, and it would have sent someone to apply a migration that
  is already applied. It now names the decision instead, which is the part that is
  true on every deployment rather than on one. **No behaviour changed**: the same
  branch is taken, the same field is returned.

Re-enabling scheduled auto-advance is therefore a three-part change made on
purpose — the registry entry, the constant, and the test that asserts the
omission — not a one-line flip.

The admin `POST /api/classify` path is untouched and still advances the pipeline
as `app_runtime`, which is where a deliberate batch belongs.

## How to run it

The tool is `postgres/tools/s28_owner_migration.mjs`. It needs the Supabase
credential, and a psql for the target — there is no local `psql`, so the Docker
wrapper recipe applies (see `neon-ledger-apply-needs-docker-psql`).

```bash
export S28_SOURCE_URL=…            # from ~/.config/neon-b2-supabase.env
export S28_SOURCE_KEY=…
export S28_PSQL=/path/to/psql-wrapper
export S28_DB=neondb
export S28_APPLY_USER=app_migration

node postgres/tools/s28_owner_migration.mjs counts               # read-only, both sides
node postgres/tools/s28_owner_migration.mjs roster-map --out DIR # gate 2 output
node postgres/tools/s28_owner_migration.mjs extract    --out DIR # read-only on Supabase
node postgres/tools/s28_owner_migration.mjs load --in DIR --dry-run   # applies, then ROLLBACK
node postgres/tools/s28_owner_migration.mjs load --in DIR
node postgres/tools/s28_owner_migration.mjs verify     --in DIR # the parity report
node postgres/tools/s28_owner_migration.mjs rollback --confirm  # the way back
```

`--emit-sql PATH` on `load` writes the exact statement stream to a file without
committing anything, so the one command that writes 27k rows can be read before it
runs.

Order matters in one place: `roster-map` must run **after** the five invites and
**before** `load`, because the load refuses any roster reference the map does not
resolve.

## Open

Rewritten 2026-08-12 (session 4). Every bullet below was re-measured; the
previous list had gone stale in five places at once, each of which would have
sent a reader to fix something already fixed.

**Gates 1–8 are done.** Gate 9 is half done: the AI path is bound and deployed,
the auto-advance decision is recorded (retired) — what is left is one deployment
hygiene item and the wider N-S27 step 6.

### Actually open

- **N-S27 step 6 — Delete — is the remaining work, and auth is what blocks it.**
  `VITE_AUTH_PATH` is unset, so all five teammates still sign in through Supabase
  and present a legacy bearer; `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`
  and `VITE_SUPABASE_ANON_KEY` are all still bound on Production. Supabase cannot
  be deleted while it is the identity provider. One constraint has **lapsed** — the
  standing reason for leaving the flag unset was "until `DataContext` moves", and
  `DataContext` moved in S13 — but a **new and harder** one is measured below: the
  flip would lock all five out today.
- ~~**Preview lost two variables** in session 3.~~ **Fixed 2026-08-12.**
  `NEON_DATABASE_URL` and `IDENTITY_STORE_DATABASE_URL` are rebound on Preview,
  both pointing at the **fixture** project (`ep-bold-art-a2iy6z2e`), asserted by a
  guard in the rebinding command — binding these to `autumn-snow-04881924` would
  hand every preview deployment write access to the owner's live data. Production
  was not touched.
- **N-S27 step 6 cannot start: flipping `VITE_AUTH_PATH` today would lock all
  five teammates out with no recovery.** Measured 2026-08-12; a hard stop, not a
  preference:
  - All five `identity."account"` rows still carry gate 2's **placeholder**
    scrypt-shaped hashes (161 chars, random). Nobody knows a matching password —
    that was the design, and the intended way in is `password.requestReset`.
  - `identity.session` has **0 rows**. Nobody has ever signed in through Better
    Auth on this database, so no live session would survive the flip.
  - **`RESEND_API_KEY` and `RESEND_FROM_IDENTITY` are not bound on Production**,
    so `resetMail.ts` keeps its dropping sink and the reset link is silently
    discarded. That is exactly the failure its own docstring records: *"The first
    real tenant reached 13/13 with two accounts nobody could open."*

  The order is: bind the mail credentials -> prove one real reset end to end ->
  flip `VITE_AUTH_PATH` -> step 6. Reversing any two of those takes a production
  dashboard away from five people. The reset-mail path is under active development
  in a parallel session, so this prerequisite is moving.

- **`sync_photos` refuses on the machine path**, so a lead that gains a photo
  after the cutover will have no object behind it. Photo state is clean *today* —
  708 non-null / 672 distinct `photo_path` on both sides, all 672 copied at gate 5
  — so this is a forward-looking gap with no backlog. It is a **design decision,
  not a cleanup**: the machine path has no candidate query, and tenants bind no
  `OBJECT_STORAGE_*` at all, so closing it means extending the ingest contract and
  the tenant environment together.
- **`leads.status` and `last_action_at` disagree on 6 leads** (5 with the source
  ahead, 1 with the target ahead). Characterised below rather than fixed, because
  it cannot be diagnosed from this machine.
- The latent CSV/`jsonb` and positional-comparison defects in
  `b2_tenant_slice.mjs` are recorded here but **not fixed**. That file is an
  owner-approved artifact with a frozen scope; changing it is a decision, not a
  cleanup.

### The 6-lead `status` / `last_action_at` anomaly

Not migration drift, and not a mapping regression — both were checked:

- The **distributions are near-identical**: source `status=2` on 44 leads, target
  on 40; `status=1` 3465 vs 3469. The gap is exactly the 5 lagging minus the 1
  leading, so nothing systematic is being lost.
- The **funnel is provably unaffected**: `replied_at` agrees on all five,
  every `messages` row agrees, and `daily_activity` matches cell for cell across
  all 801 rows.
- It is **live, not residual**: the current agent rewrites both columns every
  sync and wrote the *older* value into the target as recently as 08:13 UTC. So
  copying the source's value would be reverted inside half an hour — which is why
  gate 7 deliberately did not copy it.

The shape, for whoever picks it up: all five source-ahead leads have an inbound
reply, all five move `status` 2 → 1 on the target, and the target's
`last_action_at` is *earlier* by between 58 seconds and four days. Three of the
five have a source `last_action_at` exactly equal to `replied_at`. The prime
suspect is the `person_external_ids` one-slug-per-person dedup that CLAUDE.md
warns about — if the `row_number()` ordering has no deterministic tiebreaker, two
agent versions can select different rows for the same person.

**It needs a notebook to diagnose, not a database.** The one-step reproduction is
`python3 agent.py sync --dry-run` on `notebook-1` and `notebook-3`, comparing the
extracted row for `ronaldtimoshenko` against what LH2's own UI shows. Changing
the mapping or `agent.py` from here would mean deploying to four production
notebooks on a symptom that cannot be reproduced on this machine.

### Closed since the last revision of this list

- ~~Gate 5 is measurably not started~~ — **done session 3**, all 672 distinct
  photos in R2.
- ~~Production is still resolving `neon` against the fixture database~~ —
  **closed at gate 6**, session 3.
- ~~`npm run test:neon` was not run because production reads the fixture
  database~~ — production no longer does, **and** session 4 proved that database
  holds no unique record of anything. It is safe to run.
- ~~The step-4 presence-check lesson deserves a correction in `N-S27`~~ — the
  correction **is written**, as a block quote under step 4's table in
  `N-S27-SUPABASE-EXIT.md`. This bullet appeared **twice** in the previous list,
  both times after the fix had landed.

### Verification, session 4

`npm test` **947 passed**, `npm run typecheck:api` clean, `npm run build` clean,
ledger static assertions **193 passed**, `git diff --check` clean.
`b2_tenant_slice.mjs` and `s28_owner_migration.mjs` are byte-identical — the only
code change this session is the auto-advance wording described under gate 9, which
alters no behaviour.
