# S26 provider-backed operations and recovery surface

Status: implementation readiness contract. This document records local code and
mocked-contract evidence only; it does not record a provider call, disposable
apply, restore drill, or owner approval.

## Composition

`ops/src/providers/s26-provider-backed.ts` is the only S26 provider composition
point. It accepts reviewed, named provider implementations and exposes the
existing provider-neutral operations core with these fixed capabilities:

- Neon/Postgres data: project lifecycle, portable baseline/migration application,
  data/RLS smoke checks, and schema/data recovery artifacts;
- Better Auth: configuration, disabled support membership, company-admin invite,
  identity smoke checks, and configuration/identity recovery artifacts;
- Cloudflare R2: private storage configuration, object/RLS smoke checks, and
  storage metadata plus private-object recovery artifacts;
- Vercel: deployment target, environment descriptors, domain, pinned build,
  promotion, runtime checks, and deployment/configuration recovery artifacts;
- approved SMTP, domain, and source-repository named capabilities required by
  the 13-step plan.

The composition cannot use `p4c-sdk.ts`: the S26 bundle requires recovery
capabilities that the retained Supabase/P4-C compatibility path does not
provide. `ops/src/runtime/s26-runtime.ts` wires the composition into
`ProviderPreflightService`, `DisposableOnboardingPlanner`, and
`DisposableOnboardingCore`; it therefore preserves
`preflight → plan → owner approval → apply/resume → verify` rather than calling
providers from a CLI or recovery helper.

## Recovery behavior

`TenantRecoveryService` captures opaque, secret-free provider artifacts and
requires all five coverage entries before it returns a
`tenant-recovery.v1` manifest. The manifest is protected by a canonical digest
and includes evidence of the existing encrypted local registry backup. Restore
is target-specific and verifies every provider surface after restoration. It
does not expose bytes, connection strings, identity credentials, environment
values, SMTP values, or raw provider responses.

The manifest schema is
[`tenant-recovery.v1.schema.json`](./contracts/tenant-recovery.v1.schema.json).
Any incomplete coverage, digest mismatch, ownership mismatch, provider failure,
or outcome-unknown response fails closed; the surrounding operation remains
quarantined until a reviewed resume through the same idempotency contract.

## Evidence boundary

The S26 tests use mocked named provider contracts to prove adapter composition,
the full recovery coverage, manifest integrity, target-specific restore, and
post-restore verification. They are not evidence of a live Neon project, Better
Auth deployment, R2 bucket, Vercel target, email, domain, or source repository.
The next session must generate a fresh read-only disposable plan and stop for
an exact new G4 approval before any provider call or apply.
