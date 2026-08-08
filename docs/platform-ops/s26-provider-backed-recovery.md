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

## Reviewed direct-control-plane mappings

Only provider capabilities with a bounded, documented official REST operation
are called directly by the S26 adapters. The code contains no generic provider
request surface.

| Provider | Direct official mapping | Deliberately bridged |
|---|---|---|
| Neon | `POST /v2/projects` creates the deterministic project with `org_id` and `project.name`/`project.region_id`; `GET /v2/projects/{project_id}` observes readiness. | Inspection that combines catalog/ownership evidence, portable baseline and ordered migration application, SQL/RLS smoke checks, and schema/data recovery. Neon’s project API is not a portable migration or recovery API. |
| Cloudflare R2 | `POST /client/v4/accounts/{account_id}/r2/buckets` creates the fixed `lead-photos` bucket. R2 buckets are private by default. | Object/RLS smoke checks and metadata/private-object recovery, which need server-held data-plane access and recovery controls. |
| Vercel | `POST /v11/projects?teamId=…` and `POST /v10/projects/{id}/domains?teamId=…`. | Inspection, environment-value resolution, pinned build/promotion/schedule evidence, rollback/verification, and deployment recovery. These require source/value/recovery evidence that is not accepted from an owner caller. |

The adapter privately normalizes official responses to the canonical operation
results and derives ownership evidence only from the deterministic name,
approved scope, and registry marker. An existing resource is never adopted from
a direct response alone; mismatched or incomplete ownership stays quarantined.

Better Auth, SMTP, domain, and source-repository operations are carried through
the closed [`s26-control-plane.v1` bridge contract](./s26-control-plane-bridge.md).
The bridge is not deployed by this contract; an absent bridge blocks concrete
preflight rather than falling back to a raw request or legacy provider path.

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
