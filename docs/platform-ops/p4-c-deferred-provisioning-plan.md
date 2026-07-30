# P4-C deferred disposable provisioning plan

Status: **blocked/incomplete — provisioning intentionally deferred**

Recorded: **2026-07-30**

## Decision

End-to-end provisioning of the single reviewed disposable tenant `p4c-lab` is
deferred until the owner can fund the required Supabase Pro organization plan
or supplies another already-paid, reviewed Supabase organization.

This is not P4-C acceptance. P4-C remains the active session boundary; P5 and P7
must not start from this state.

The owner is separately considering a replacement for Supabase. Evaluation or
migration to another database/backend provider is outside this checkpoint and
must be specified in a separate session. If that work changes the approved
backend contract, do not resume this Supabase-specific runtime: replace or
supersede this plan and re-run the required architecture, security, cost,
recovery, baseline, Auth, Storage, and provider-port reviews first.

## Blocking evidence

The live read-only preflight completed without creating a tenant and reported:

- `preflight.provider_access`: passed;
- `preflight.domain`: passed;
- `preflight.region_residency`: passed;
- `preflight.smtp_dns`: passed;
- `preflight.release_compatibility`: passed;
- `preflight.legal_review`: passed;
- `preflight.pricing`: passed;
- `preflight.tier_capacity`: blocker;
- `preflight.backup_coverage`: blocker.

The two blockers have one cause: the reviewed Supabase organization is not on a
paid plan. The P4-C recovery contract requires the explicit
`supabase-pro-daily-7d` profile. A Free project cannot satisfy that profile, so
the planner must remain fail-closed.

The owner confirmed that a Pro subscription is not currently affordable. The
required tier and backup profile must not be silently weakened to make the
preflight pass.

## State at deferral

- No Supabase tenant project was created or adopted.
- No Vercel tenant project, Production environment, build, deployment, or
  tenant domain binding was created.
- No baseline or migration was applied.
- No tenant Auth user, support membership, company admin membership, or admin
  invitation was created.
- No SMTP smoke message was sent.
- No onboarding plan was generated or approved.
- No apply, resume, or final verify operation was started.
- The previously owner-approved `mail.ciphercross.dev` Resend setup and its
  Vercel DNS records remain preparatory platform state; preflight did not create
  or change them.
- Platform credentials remain referenced only by their macOS Keychain labels.

The locally implemented P4-C SDK runtime is unaccepted work in progress. Do not
write `docs/implementation-handoffs/P4-C.md` or label the implementation
complete until the live acceptance gate below passes.

## Resume prerequisites

Resume only when all of the following are true:

1. The owner explicitly confirms that the recurring Supabase cost is affordable.
2. Either the exact reviewed organization `dzfikwgcfdbgxpejzfnk` is upgraded to
   Pro, or a replacement already-paid organization is reviewed and pinned in
   the P4-C configuration and catalogs.
3. Current Supabase pricing, organization-wide project/compute impact, Micro
   availability, and seven-day daily-backup coverage are revalidated. A stale
   price or a cost outside the approved ceiling blocks planning.
4. The Keychain-backed registry passphrase is available and an authenticated,
   encrypted registry backup is created before the first provider write. The
   2026-07-30 checkpoint backup is verified; create a replacement first if its
   registry state is stale when provisioning resumes.
5. The pinned source SHA, baseline/delta digests, provider owners, domains, SMTP
   identity, and exact one-tenant scope remain unchanged or receive a new
   review.

## Required resume flow

Continue the same P4-C boundary in this exact order:

1. Run a fresh read-only `preflight`.
2. Require all nine prerequisites to pass.
3. Generate a new deterministic onboarding `plan`.
4. Present the exact plan ID, digest, registry version, expiry, provider effects,
   recurring/usage cost range, and recovery profile to the owner.
5. Obtain explicit owner approval for that exact unexpired plan.
6. Run one-step-at-a-time `apply/resume` with the exact digest, expected registry
   version, and a caller-stable idempotency key.
7. Stop before the first admin invite until baseline, private Storage,
   Auth/custom SMTP, Production-only environment, domain, tenant-specific
   build/deployment, disabled support membership, and every required smoke test
   have passed.
8. Send the first admin invite only after the complete smoke gate passes.
9. Run final `verify`, record P4-C acceptance evidence, create
   `docs/implementation-handoffs/P4-C.md`, run all checks, and create the
   dedicated logical Git commit.

No external-company provisioning, MCP allowlist expansion, raw provider/SQL/
shell/HTTP/environment/DNS path, arbitrary provider payload, secret read/return,
provider deletion, migration repair/down path, P5 work, or P7 work is authorized
by this deferred plan.
