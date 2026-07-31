# Neon provider decisions

Status: **G0 accepted — S02 complete**

Decision date: **2026-07-31**

Scope: this is a documentation and checkpoint decision. It creates no provider
resource, credential, user, bucket, deployment, or data copy. Provider names
below identify adapters behind internal contracts; they do not change the
canonical business schema.

## Evidence classification

- **Confirmed** means an owner decision or a fact documented by the linked
  official provider documentation as reviewed on 2026-07-31.
- **Estimate** is planning input, not a provider commitment or an approved
  catalog price.
- **Architecture conclusion** is the team's design inference from the confirmed
  facts and source measurements.

## Source measurements summary

| Item | Measured source baseline |
|---|---:|
| PostgreSQL | 17.6 |
| Database | 29,224,083 bytes |
| Storage | 602 objects / 18,359,103 bytes |
| Users | 4 |
| Initial tenants | 2 |
| Default data migration | `pg_dump` / `pg_restore` |
| Preliminary full maintenance window | 60–90 minutes |

The complete evidence and limitations are in
[`neon-migration-source-measurements.md`](./neon-migration-source-measurements.md).
Logical replication remains a fallback only if rehearsal timings cannot meet the
approved window.

## Constraints

- Full Supabase exit covers Database, Auth, Storage, PostgREST and
  service-role transport.
- Each tenant has a separate Neon project and separate provider credentials.
- Production dependencies must be GA-only. Neon Data API, managed Neon Auth and
  Neon Storage are excluded from the production baseline.
- No residency obligation was supplied. Region is a latency/cost choice and
  remains an explicit provisioned input.
- Four users may be re-invited and sign in again.
- The existing Vercel deployment is not a separate migration project.
- RPO/RTO cover the recovery surface, not just a Neon database branch: database,
  application identity, private objects and deployment/configuration evidence.

## Neon comparison

### Tier and region

| Option | Confirmed provider facts | Fit and decision |
|---|---|---|
| Free | Up to 100 projects, 100 CU-hours and 0.5 GB storage per project; maximum 2 CU and up to six hours of restore history. [Official pricing](https://neon.com/pricing) | **Selected temporarily.** Two measured databases fit the storage allowance, but usage, recovery procedure and performance must be measured before a production cutover. |
| Launch | Usage-based: up to 100 projects, up to 16 CU, configurable scale-to-zero and up to seven days of restore history. [Official pricing](https://neon.com/pricing) | Revisit if Free compute, restore retention, support or capacity becomes a blocker. |
| Scale | Usage-based: 1,000 projects, up to 56 CU, 30-day restore history, private networking and SLA-oriented features. [Official pricing](https://neon.com/pricing) | Rejected for the initial two small tenants: the source evidence does not justify its added cost or capability. |

**Confirmed G0 choice:** Neon **Free** in **AWS Europe (Frankfurt)**. Frankfurt
is a latency default for the currently Europe-based team, not a data-residency
claim. The Neon project API can create projects with an explicit PostgreSQL
version, cloud provider and region; no project is being created in S02.
[Official project/API documentation](https://neon.com/docs/manage/projects).

Neon made PostgreSQL 17 the default for new projects and continues to support
it. [Official changelog](https://neon.com/docs/changelog/2025-01-10). This is
compatible with the measured PostgreSQL 17.6 source, subject to a later clean
restore rehearsal.

### Backup, restore and connection path

| Capability | Confirmed fact | S02 conclusion |
|---|---|---|
| Instant restore | Free has up to six hours; Launch up to seven days; Scale up to 30 days. Restore-window history has independent storage costs on paid plans. [Official pricing](https://neon.com/pricing) | Free restore history is not the entire backup plan. S08 must prove a daily portable logical export plus object/identity/configuration recovery evidence before G1. |
| Logical migration | Neon documents `pg_dump`/`pg_restore` for migration, and its own migration instructions specify an unpooled connection string for dump/restore. [Migration guide](https://neon.com/docs/import/migrate-from-neon) | Use unpooled endpoints for dump/restore. The small measured source makes this the default; logical replication is contingency only. |
| Application connections | Neon provides pooled connections via PgBouncer and documents up to 10,000 pooled connections. [Compute documentation](https://neon.com/docs/manage/endpoints/) | The application adapter may use pooling; transactional work must use the transaction-capable driver path. This is separate from the unpooled restore path. |
| Serverless driver | `@neondatabase/serverless` 1.0+ is GA and targets serverless environments including Vercel Functions. [Driver documentation](https://neon.com/docs/serverless/serverless-driver) | Selected future `DataStore` adapter candidate, not implemented in S02. |

**Confirmed recovery objectives:** RPO **at most 24 hours**, RTO **at most eight
business hours**, and a maintenance window of **up to 90 minutes**. These are
owner-approved targets, not promises that the Free tier's six-hour restore
history alone satisfies them. A later rehearsal must establish the recovery
procedure and actual timings.

### PostgreSQL, extensions, roles and tenant isolation

- One Neon project is the selected physical boundary for each tenant. A project
  contains its own branches, databases, roles and computes; this supports the
  chosen separate-project topology. [Project model](https://neon.com/docs/manage/projects)
- `pgcrypto`, `uuid-ossp` and `pg_stat_statements` are part of Neon’s supported
  PostgreSQL extension ecosystem; `pg_stat_statements` and `uuid-ossp` are
  documented Neon extensions. [Neon extension overview](https://neon.com/blog/ten-most-popular-postgres-extensions)
  S08 must still execute `CREATE EXTENSION`/inventory tests on the selected
  project and record exact versions before accepting the portable baseline.
- `supabase_vault` is Supabase-specific and has no accepted Neon replacement in
  the baseline. It is excluded; S04/S08 must prove that no business data or
  runtime path still depends on it.
- RLS remains PostgreSQL defense in depth. The runtime role must be non-owner
  and must not have `BYPASSRLS`; the application API sets authenticated actor
  context. Neon also documents Data API/Neon-RLS choices, but neither is selected
  because the former is excluded by the GA-only baseline.
  [Neon RLS documentation](https://neon.com/docs/guides/row-level-security)

The project provisioning API (`POST /projects`) is appropriate for the future
operations adapter only. S02 does not invoke it.

## Identity candidate matrix

| Candidate | Email/password, verification and reset | Sessions, CSRF and administration | Hosting/self-hosting | License and decision |
|---|---|---|---|---|
| **Better Auth embedded in the application** | PostgreSQL adapter and email/password are documented; verification and reset email hooks are available. [PostgreSQL](https://better-auth.com/docs/adapters/postgresql), [email flows](https://better-auth.com/docs/concepts/email) | Secure cookie defaults, origin validation and CSRF protections are documented. The stable admin plugin supports user/session administration and ban/revoke paths. [Security](https://better-auth.com/docs/reference/security), [admin](https://better-auth.com/docs/plugins/admin) | Runs in the application’s server runtime, so it is compatible with the current Vercel adapter. Invite-only onboarding is implemented by application-owned admin/invitation endpoints with signup disabled; it must be covered by S16 security tests. | MIT. [Official repository](https://github.com/better-auth/better-auth) **Selected behind `IdentityProvider`.** No managed Auth service or Auth SaaS is selected. |
| Keycloak self-hosted | Supports password, verification, reset actions and administrator-issued email actions. [Server administration guide](https://www.keycloak.org/docs/latest/server_admin/) | Mature administrative UI/API and session controls, but with a substantially larger operational surface. | Requires a separately operated Keycloak service and database; it is not a fit for a Vercel-only runtime without adding hosting operations. | Apache-2.0 open source. **Rejected for the initial baseline:** unnecessary service/operations cost for four users. Retain as a future alternative behind `IdentityProvider`. |
| Managed Neon Auth | Coupled to Neon and currently excluded by the project’s GA-only baseline. | Not evaluated as a production dependency. | Would add provider coupling. | **Rejected.** |

The canonical application `users.id` and `team_members` model remain separate
from an authentication subject. A mapping table will link `user_id`, provider
name and provider subject in S06/S17. The existing four Supabase accounts are
not migrated as sessions or password hashes; the approved path is controlled
re-invite/password reset.

## Object storage candidate matrix

| Candidate | Private/signed operations and portability | Isolation, lifecycle and versioning | Cost at measured 18.4 MB | Decision |
|---|---|---|---|---|
| **Cloudflare R2 Standard** | S3-compatible API works with standard SDKs; presigned URLs allow scoped GET/PUT/HEAD/DELETE with a 1 second–7 day expiry. [S3 API](https://developers.cloudflare.com/r2/get-started/s3/), [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) | Buckets are private by default. The API can create buckets; tokens can be scoped to a specified bucket; lifecycle rules and S3 versioning APIs are documented in its compatibility matrix. [Create API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/), [tokens](https://developers.cloudflare.com/r2/api/tokens/), [compatibility](https://developers.cloudflare.com/r2/api/s3/api/) | **$0 at the present size** under the published 10 GB-month free storage allowance. Standard thereafter is $0.015/GB-month, with no direct egress charge; request costs remain usage-dependent. [Official pricing](https://developers.cloudflare.com/r2/pricing/) | **Selected.** Create one private tenant bucket per tenant plus a separately scoped agent-artifact bucket; use short server-generated URLs and bucket-scoped credentials. |
| AWS S3 Standard | Native S3 API, private buckets and presigned uploads/downloads. [Presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), [CreateBucket API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateBucket.html) | Mature IAM, Block Public Access, versioning and lifecycle controls. [Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html), [versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html), [lifecycle](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html) | Exact price depends on a future selected AWS region and account credits; at 0.0184 GB the storage component would be negligible, but request and egress pricing can apply. It is not an approved plan price without a current catalog entry. | **Rejected for the initial baseline:** no measured need outweighs the extra IAM/account and egress-cost surface. Keep as the first portable alternative. |

**Architecture conclusion:** never store object bytes in Neon. The database stores
application object keys and metadata only. Large object bytes would inflate
dump/restore and wrongly couple database recovery to private-object recovery.
S19/S20 own the object manifest, checksums, copy tooling, bucket setup and
allow/deny tests.

## Hosting decision

**Confirmed:** Vercel remains the temporary concrete hosting adapter at current
zero cost. Its future contract is `HostingControlPlanePort`; Vercel resource
identifiers stay inside the adapter. A hosting migration is not part of the Neon
cutover. Reconsider it only after two tenants have 30–60 days of measured cost,
reliability and runtime-limit evidence.

## Recommended G0 defaults and owner decisions

| Decision | G0 result |
|---|---|
| Neon tier | **Free** — temporary, explicitly capacity/recovery-gated |
| Neon region | **AWS Europe (Frankfurt)** — latency/cost default, not residency |
| Tenant database boundary | **One separate Neon project per tenant** |
| RPO | **At most 24 hours** across the full recovery surface |
| RTO | **At most eight business hours** |
| Maintenance window | **Up to 90 minutes** |
| Auth | **Self-hosted Better Auth** behind `IdentityProvider`; no managed Auth service |
| Object storage | **Cloudflare R2 Standard**, private bucket per tenant and separate agent-artifact bucket |
| Hosting | **Vercel temporary adapter** behind `HostingControlPlanePort` |
| Maturity | **GA-only**; no Neon Data API, managed Neon Auth or Neon Storage in the production baseline |

## Rejected alternatives

- **Neon Launch/Scale now:** measured data volume and initial tenant count do
  not justify paid capacity. They remain the defined upgrade path after actual
  usage, recovery or support needs are measured.
- **Neon Data API, managed Neon Auth and Neon Storage:** excluded by the
  GA-only policy and would weaken the provider-neutral boundary.
- **Keycloak now:** technically credible, but adds a separate operated service
  with no proportional benefit for four users.
- **AWS S3 now:** capable but not preferable at the measured size and no-region
  requirement; retain behind `ObjectStorageProvider`.
- **Object bytes in PostgreSQL:** harms portable dump/restore and recovery
  separation.
- **Hosting migration now:** independent risk and scope; not needed to remove
  Supabase runtime dependencies.

## Security implications

- Browser clients receive application sessions and server-generated, short-lived
  object URLs; they receive neither database credentials nor storage credentials.
- Better Auth is configured with public self-signup disabled, verified email,
  reset/re-invite, secure cookies, trusted origins and CSRF controls. S16 must
  verify disable/ban, session revocation, invite redemption and cross-user denial.
- Neon runtime connections use a non-owner, non-`BYPASSRLS` role. Owner/
  migration and runtime identities remain distinct.
- R2 uses private buckets, per-bucket scoped tokens, object-key allowlists and
  deterministic tenant object prefixes. A URL is a bearer token until expiry.
- Provider IDs remain only in operation registry/adapters and identity mappings;
  none enter the canonical business schema.

## Cost assumptions

- The selected Neon Free plan has no billed base price but has hard limits:
  100 CU-hours, 0.5 GB/project, 2 CU maximum and up to six-hour restore history.
  These values are provider facts, not performance guarantees.
- R2 Standard is free for the current 18.4 MB under the published free tier.
  Cost estimates must include operations when real traffic is known.
- Vercel’s current measured cost is zero. No cost prediction beyond its existing
  adapter is made here.
- Before any production apply, the operations catalog must record an approved,
  unexpired region/tier/pricing/backup profile. S02 does not bypass that
  fail-closed contract.

## Open questions and review triggers

1. **Free-tier capacity:** review before G1 and whenever either project exceeds
   70% of its storage or monthly CU-hour allowance, or performance/recovery
   rehearsal fails. The candidate upgrade is Launch, not an automatic change.
2. **Recovery evidence:** S08 must prove portable daily export, object manifest,
   identity/configuration recovery and a restore drill meeting RPO/RTO.
3. **Extension parity:** S04/S08 must prove PostgreSQL 17 plus `pgcrypto`,
   `uuid-ossp` and `pg_stat_statements` on the actual project; it must prove
   removal of `supabase_vault` dependency.
4. **Identity spike:** S16 is G3. It may retain or replace Better Auth only after
   invite/reset/disable/cookie/CSRF/Vercel tests pass.
5. **Storage adapter:** S19/S20 must prove private-bucket isolation, URL expiry,
   lifecycle/versioning configuration, checksum reconciliation and copy time.
6. **Region:** review when the primary user/agent geography, latency evidence or
   a real legal/residency requirement changes.
7. **Hosting:** review after the stated 30–60 day two-tenant observation period
   or a measured Vercel cost/reliability/runtime-limit blocker.

## Sources

All provider claims in this document use the official links placed next to the
relevant statement. They were reviewed on 2026-07-31; pricing, free-tier limits,
regions and feature maturity must be refreshed into the operations catalogs
before any plan or apply.
