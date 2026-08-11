# uitop — first real tenant onboarding — handoff

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
