# uitop — first real tenant onboarding — handoff

## uitop is live at 13/13, and two defects were only visible after it was — 2026-08-11

Operation `op_df52aade0edabc19d09cf8251733c27906727190` — **succeeded**, all
**13/13** steps, plan `pln_98cf19580aa4f944f066d2e8`, digest
`sha256:f9f0a64b…`, expected registry version 399, idempotency key
`uitop-20260811-02`. Registry **439**, audit chain **verified**. Tenant `uitop`
is `active`/`active` on `https://uitop.ciphercross.dev` (HTTP 200), Neon project
`dry-mode-26725161`, Vercel project `prj_gMKtZ4wfKgUFMDLwHCpdyd7fmSFT`.
Step 12 sent the real invitation to `ivan@uitop.design`.

Two code fixes made it possible, both of the S26 family — a guard or a value
keyed on something the real provider cannot produce:

- **`d9bb5ce` — the zone and the hostname are different questions.**
  `#domainInspect` derived all three domain facts from
  `GET /v6/domains/{host}/config`, which answers none of them: `configuredBy` is
  a DNS-configuration enum (`A`/`CNAME`/`dns-01`/`http`), so
  `existingBindingOwned: configuredBy === VERCEL_TEAM_ID` could never once be
  true, and `misconfigured` reports whether DNS already resolves to Vercel —
  which a not-yet-created subdomain never does. Ownership now asks the zone
  (`GET /v5/domains/{zone}`, **status only**: 200 owned, 404 not in the account,
  anything else throws), and availability keeps answering about the exact host
  through the single-domain project probe. The two branches are now one.
- **`af28aaf` — the tenant's origin travels with the request.**
  `IDENTITY_BASE_URL` and the invite link both came from one Worker variable
  pinned to the drill tenant's hostname, so uitop's step 7 bound *another
  tenant's dashboard* into uitop's production environment. `site_url` is now
  required on `hosting.environment-bind` and `identity.company-admin-invite`,
  like `expected_hostname` on promote. `BETTER_AUTH_BASE_URL` is deleted.

Deployed Worker: **`09db7e8e-8464-4ccf-a511-5897f4a69001`**. Verification before
the commits: `npm test` 127/127, `worker:test` 42/42, `worker:types:check` and
`worker:typecheck` clean, ledger static assertions 193/193, `git diff --check`
clean.

### The tenant was inert behind its own front page

13/13 passed while the dashboard could not open its database at all:
`GET /api/identity?op=session.current` answered **500** (`resolveRequestActor`
failed), and so did `team.roster`.

**Every app-facing Neon role has no password, and never had one.** The bootstrap
creates them with `CREATE ROLE … LOGIN` and no `PASSWORD`
(`000_control_plane_role_bootstrap.sql:50,59-60`), so Neon holds no credential
for them; `#connectionUri` (`backend.ts:939-956`) hands back whatever Neon has,
which for `app_runtime`, `app_ai_runner` and `identity_store` is a URI with an
empty password. Probed on both tenants — only `neondb_owner` comes back with
one. So `NEON_DATABASE_URL`, `NEON_AI_DATABASE_URL` and
`IDENTITY_STORE_DATABASE_URL` were unusable in **every** tenant ever onboarded,
`s26-disposable-lab` included; nobody noticed because nobody ever signed in, and
step 11 compares environment names, types and scopes, never values, and never
connects the way the application does.

**Not fixed in the control plane.** uitop was repaired out of band: `ALTER ROLE`
gave the three roles generated passwords, the three production bindings were
rewritten with composed URIs, a fresh release was built and promoted (the
bridge's build route would have adopted the stale deployment, so only the build
was direct; promotion went through the reviewed route). `session.current` then
answered **401** instead of 500 and a real sign-in returned **200**. The proper
fix belongs in the Worker: generate the password, `ALTER ROLE` it, and compose
the URI — the same shape the other `generated_secret` values already use.

### The invite flow cannot complete as shipped

`admin.invite` and step 12 both create an account with a random passphrase that
is never returned, and tell the recipient to use the reset flow — but this
deployment builds `BetterAuthIdentityProvider` with no `sendResetLink`, so
`dropResetLink` discards the link (`betterAuthProvider.ts:81`, which records it
as a known limit). `password.change` exists precisely for an out-of-band
passphrase. **ivan therefore cannot sign in yet**: his credential row exists and
its password is unknown to everyone.

### Recorded divergences — the registry does not know about these

1. The three production database bindings were rewritten outside any operation,
   and the serving release is `dpl_2aC9vR8YDMSrmw3mQPBStnMxPxDF`, built out of
   band. The registry still names the step-9 build.
2. `IDENTITY_BASE_URL` was corrected by the owner in the Vercel console; step 7
   adopts a binding by name and had kept the drill tenant's origin.
3. A second active admin (`mykyta.shevchenko@ciphercross.com`, member 3) was
   added through `identity_admin_invite_member_atomic` with the existing admin
   as the authorizing actor, with a known initial passphrase.

**There is no sanctioned repair path for an active tenant**, which is why all
three are out of band: step 1 moves the tenant to `provisioning`, and
`state-machines.ts:23` only allows `active → suspended | offboarding_planned`.
A second onboarding operation is refused. That capability is the obvious next
session, and it is what these divergences are waiting for.


Onboarding the first tenant that is not the S26 drill. Read
`docs/implementation-handoffs/N-S26.md` first: it holds the 13-step procedure,
the one-call-per-step discipline, and the nine defects that made the machinery
work at all.

## Owner intent

A real external user, but a personal friend of the owner. **Explicitly no
subscriptions, no legal review, no compliance work.** They need three things:

1. a subdomain,
2. their own database,
3. the dashboard with the AI agents.

The owner wants the hostname on **`ciphercross.dev`**, which they **purchased on
Vercel** — so the zone is in the Vercel account and Vercel manages its DNS.

## What exists now

Owner profile: `~/.config/lh2-platform/uitop-owner-runtime.json`, mode 0600,
created as a copy of the S26 profile with exactly three fields changed:

| Field | Value |
| --- | --- |
| `profile.allowed_tenant_slug` | `uitop` |
| `profile.selections.company_name` | `uitop` |
| `profile.selections.admin_email` | `ivan@uitop.design` |

Everything else is inherited: `platform_domain: vercel.app`, Neon Free,
`vercel-hobby`, same source SHA `b2c287af…`, same catalogs, same recovery profile,
`release_channel: canary`. The runtime hardcodes `workspace_class: disposable`
(`s26-config.ts:207`) and that is **load-bearing**: `provider-preflight.ts:342`
only passes `legal_review` for `disposable` + `canary` + the profile's single
allowlisted slug. Do not switch the class to `external` to make it feel more
"real" — that blocks preflight by design and is a separate project.

Operation in flight:

- plan `pln_c1ac973c11ab463379bac037`;
- digest
  `sha256:ccb389501b3fd236644973a343d1207a8127dce28b00ecc3802836484f681723`;
- expected registry version at apply: 370;
- idempotency key `uitop-20260811-01`;
- operation `op_405a052da4d1a3e85475e17f78b01d792ecb8508` — **failed**,
  `outcome_unknown`.

Steps: **1–7 `succeeded`**, step 8 `domain_binding` `outcome_unknown` attempt 1,
steps 9–13 `pending`. Registry version **398**, audit chain **verified**.

So the tenant already owns a Neon project, R2 storage, identity and email
configuration, a Vercel project, and its production environment bindings. Only
the hostname is unresolved.

## The blocker: `uitop.vercel.app` belongs to someone else

Step 8 failed with `outcome_unknown: Provider request failed with status 409`.
`assignDomain` GETs the project's own domain first and got 404, then POSTed and
got 409 — so the hostname is not bound to our project, and Vercel says it is in
use. `*.vercel.app` is a **global** namespace.

Verified by unauthenticated request:

| Hostname | Result |
| --- | --- |
| `uitop.vercel.app` | **HTTP 200, a stranger's page** — claimed, unusable |
| `uitop-app.vercel.app` | 404 `DEPLOYMENT_NOT_FOUND` — free |
| `uitop-deck.vercel.app` | 404 — free |
| `uitop-outreach.vercel.app` | 404 — free |
| `uitop-dashboard.vercel.app` | 404 — free |

**Preflight had reported this hostname usable.** `#domainInspect`'s `.vercel.app`
branch decides availability with `#vercelHostnameBoundInTeam`, which scans only
**our own team's** projects (`backend.ts:1653`), and its own comment admits the
shared zone "cannot answer availability". A foreign claim is therefore invisible
to preflight, which promises a hostname it cannot guarantee.

## Why `uitop.ciphercross.dev` is blocked today, and how to fix it

A read-only probe with `platform_domain: ciphercross.dev` gives
`preflight.domain` **blocked** (`CHECK_DOMAIN`), 8/9 passing.

The cause is exact. For a non-`.vercel.app` hostname, `backend.ts:1769` computes:

```ts
zoneOwned: response.value.misconfigured !== true
```

from `GET /v6/domains/uitop.ciphercross.dev/config` — the **subdomain's** config.
A subdomain that does not exist yet has no DNS record, so Vercel reports it
misconfigured, so `zoneOwned` is false and `provider-preflight.ts` refuses.

That conflates two different questions. The zone `ciphercross.dev` **is** owned —
the owner bought it on Vercel — and because Vercel manages its DNS, attaching
`uitop.ciphercross.dev` to the project creates the record automatically.

**The fix is to ask about the apex zone, not the subdomain**: derive `zoneOwned`
from `ciphercross.dev` being present in the Vercel account (e.g. `GET
/v5/domains/{apex}` or the team domain list) and keep `hostnameAvailable` /
`existingBindingOwned` answering only about the exact hostname — the
single-domain project probe at `backend.ts:1660` is the proven shape for that.
Do not guess response keys: two defects this session came from exactly that, so
confirm each shape against a real call or a shape already used in this file.

## Recommended path

1. Fix the `zoneOwned` derivation as above, with tests.
2. Change `profile.platform_domain` to `ciphercross.dev` in the uitop profile.
   The hostname is derived as `` `${tenant_slug}.${platformDomain}` ``
   (`onboarding-planner.ts:132`) — there is **no** hostname override — so this is
   the only way to keep the slug `uitop` and change the hostname.
3. Because the profile changes, generate **one** fresh plan and a new operation.
   Steps 1–10 all adopt, which S26 proved twice, so this is cheap. Keeping the
   slug `uitop` means the existing Neon/Vercel/R2 resources are adopted rather
   than orphaned.
4. Drive one step per call, inspecting after each, through 13, then
   `tenant verify --s26` and `registry audit-verify`.

Fallback if the zone turns out not to be usable: a free `*.vercel.app` name from
the table above. That requires changing the **slug** (e.g. `uitop-deck`), which
creates a new tenant and orphans the seven steps already applied — so prefer
fixing the zone check.

## Two more defects worth fixing while here

- **Step 8's 409 should be deterministic, not ambiguous.** "The hostname is
  claimed" is a decided answer, and reporting `outcome_unknown` quarantines the
  operation over it. The bridge already forwards the upstream status and the
  provider's own error token (`51f8f0c`, `cc37f9f`); the same attribution should
  reach `assignDomain`, which uses the **direct** transport where any 409 is read
  as ambiguous.
- **Preflight should not claim a `*.vercel.app` hostname is available.** It cannot
  know. Better to report it as unknown and let step 8 be the arbiter — provided
  step 8 fails attributably per the point above.

## Fixed just before this handoff

`7b5880e` — the Neon ownership marker is now retried while a freshly created
project is still locked. The first uitop attempt lost that race: Neon answered
`423 Locked` on the branch operation issued right after `POST /projects`, leaving
a project with **no ownership marker**, which reads back as foreign, so its name
was taken and it could never be adopted. The owner deleted that orphan manually;
nothing in the registry referenced it, because step 2 had not recorded a resource
reference. Preflight returning from `blocked` to 9/9 is what confirmed the
deletion.

Diagnosing it needed no provider access: `provider_access` requires
`deterministicNameAvailable || existingResourceOwned`, so preflight going from
9/9 to blocked meant "the project exists but is unmarked".

## Environment notes

- **Vercel is now Pro.** Nothing validates the live plan: `hosting_tier_id` is
  only checked as an approved catalog reference, and
  `scheduleCapacityAvailable` is hardcoded to `<= 4` (`backend.ts:823`). So
  `vercel-hobby` in the profile stays valid and needs no change.
- Deployed control-plane Worker: `20072fbd-0018-4d49-a5e5-28fa38bdaba1`.
  The marker-retry fix is CLI-side and needs no deployment.
- The S26 drill tenant `s26-disposable-lab` is complete (13/13) and **still
  live**; its resources were deliberately not deleted. Physical deletion has no
  sanctioned path — `operations-contract-v1.md:549` lists it among the
  contract's refusals — so any teardown is an owner action in the provider
  consoles, and the registry would then need a recorded divergence.

## Rules that still apply

One onboarding effect per call, inspect the operation after every call. Never
repeat a mutation recorded `outcome_unknown` without reviewed evidence. No raw
SQL, no raw provider commands, no decoded Keychain secrets, no edits under
`postgres/tenant-baseline/`. Before any push run: `cd ops && npm test`,
`npm run worker:types:check`, `npm run worker:typecheck`, `npm run worker:test`,
`node postgres/tests/portable_migration_ledger_static_assertions.mjs`,
`git diff --check`.

Step 12 sends a real invitation email to `ivan@uitop.design`. It has not been
reached yet.
