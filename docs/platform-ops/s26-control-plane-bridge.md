# S26 control-plane bridge contract

Status: **deployable Worker implemented locally; no bridge deployment or provider request has occurred**

## Purpose

The S26 bridge supplies the application-owned provider capabilities that do not
have a safe, complete direct control-plane mapping: portable Postgres schema,
RLS, smoke, and recovery work; Better Auth configuration and identity recovery;
R2 object/recovery checks; hosting evidence/value/recovery work; custom SMTP
verification; domain authority inspection; and pinned source-repository
inspection. It is not a general HTTP proxy and
never accepts caller-selected URLs, headers, SQL, shell commands, environment
maps, credential values, or arbitrary provider payloads.

The owner-local S26 runtime talks only to the bridge's fixed
`s26-control-plane.v1` paths. The bridge returns strict, secret-free canonical
responses that the existing S26 adapters validate before the operations core
uses them.

## Fixed routes

| Capability | Allowed operations |
|---|---|
| Data | `inspect`, `portable-schema-apply`, `smoke`, `recovery-capture`, `recovery-restore`, `recovery-verify` |
| Better Auth identity | `inspect`, `configure`, `support-membership`, `company-admin-invite`, `smoke`, `recovery-capture`, `recovery-restore`, `recovery-verify` |
| Object storage | `smoke`, `recovery-capture`, `recovery-restore`, `recovery-verify` |
| Hosting evidence | `inspect`, `environment-bind`, `build`, `schedules`, `promote`, `rollback`, `verify`, `recovery-capture`, `recovery-restore`, `recovery-verify` |
| SMTP | `inspect`, `configure`, `smoke` |
| Domain | `inspect` |
| Source repository | `inspect` |

Every route has the shape:

```text
POST /s26/control-plane/v1/<capability>/<operation>
```

The endpoint base is an approved HTTPS-only configuration value. Its bearer
credential is resolved only from the closed `s26.bridge_token` macOS Keychain
label and is redacted before any error or output reaches the registry, MCP, or
CLI.

## Local Worker implementation

`ops/src/bridge/s26-control-plane-service.ts` implements this contract as a
local request handler. `ops/src/worker/index.ts` mounts it as the fixed
`lh2-s26-control-plane` Cloudflare Worker, and
`ops/src/worker/backend.ts` implements only the named operations above. The
HTTP boundary accepts POST only, authenticates with the single
`BRIDGE_BEARER_SECRET` binding using a timing-safe comparison, rejects bodies
over 64 KiB, and never logs a body or authorization value.

Only five genuine deployment/preflight credentials are secret Worker bindings:
`BRIDGE_BEARER_SECRET`, `NEON_API_TOKEN`, `VERCEL_API_TOKEN`,
`RESEND_API_KEY`, and `SOURCE_REPOSITORY_TOKEN`. Provider scopes, approved
catalog/profile IDs, release compatibility/version, schedule digest, source
Git SHA, sender settings, the four fixed application role names, the versioned
hosting contract, and `S26_APPLICATION_DATA_PLANE_READY=false` are closed
non-secret Worker variables. Blank or unapproved selections fail closed and are
never promoted to secret bindings merely to satisfy startup.

Tenant values are not deployment prerequisites. During the exact approved
`hosting.environment-bind` apply route, the Worker first verifies the
registry-owned Neon project and Vercel ownership marker. It then obtains four
role-specific connection URIs from the fixed Neon `connection_uri` operation,
generates the Better Auth and machine-route secrets with Web Crypto, and binds
only the closed `hosting.environment.v2` profile: four Neon URLs, Better Auth
values, exact `neon` read/write/AI flags, and `NEON_PHOTOS_DEFAULT=disabled`.
There is no tenant-scoped R2 application credential. The caller supplies the
complete fixed name/class/source descriptors and owned resource identities;
the Worker validates them against the profile and the digest before any provider
write. Neither request nor response contains a resolved value.

Portable PostgreSQL operations import only the repository's immutable ledger,
migration, smoke, and recovery SQL. Every pinned digest is checked before a
database connection is used, and callers can never supply SQL. Better Auth is
application-hosted against Neon Postgres. R2 recovery copies a bounded snapshot
through the Worker binding. Vercel values resolve only through a fixed
name/class/source allowlist, and build/schedule/rollout verification reads
provider state instead of manufacturing evidence. Timeouts, throttling, 5xx
responses, and ambiguous database or R2 mutations return `outcome_unknown`
with only an opaque request ID.

The current official Neon Data API and Neon-managed Better Auth documentation
labels both products Beta. S26 therefore rejects them under its GA-only rule.
The selected replacement is the repository's self-hosted Better Auth plus
actor-scoped Vercel server APIs backed by least-privilege Postgres roles; its
identity-only request boundary, transactional assignment, and all six
follow-up operations are implemented locally and documented in
`s26-application-data-plane-compatibility.md`. Provider readiness remains
deliberately false: data inspection reports `authConfigurationSupported: false`
and the environment-binding route returns `provider_readiness_blocked` before
any provider request. The bridge does not accept tenant credentials, fabricate
replacement values, or proxy application data.

Recovery artifacts remain metadata-only for hosting configuration: fixed
resource identity, ownership digest, deployment/release identity, closed
environment name/class/source descriptors, provider type/target metadata, and
the binding digest. Database URLs, generated credentials, provider environment
values, photo objects, request bodies, logs, canonical results, and audit-shaped
results never enter R2 recovery artifacts or bridge output.

The Worker has been type-checked, tested in workerd, schema-validated, and
bundled with a local Wrangler deployment dry run. None of those checks deploys
or contacts a provider control plane.

## Deployment and implementation gate

The bridge must be deployed through a separately approved provider change
before a live S26 preflight can use it. Before deployment, the owner must verify:

1. the exact Worker source commit and generated bindings;
2. the five required credential bindings and every approved closed non-secret
   selection listed in `ops/wrangler.jsonc`;
3. the fixed Neon, Vercel, Resend, R2, Better Auth, and source-repository scopes;
4. that an owner-approved full 40-character application Git SHA is configured,
   exists in the fixed repository, and implements the approved Neon/Better Auth
   and fixed hosting-value profile; and
5. that the resulting `workers.dev` base is installed under the closed
   owner-local `s26.bridge_base_url` configuration and its bearer value is
   installed separately under the `s26.bridge_token` Keychain label.

Bridge deployment alone does not authorize tenant creation, schema application,
environment binding, an invite, recovery restore, or any S27/S28 work. After it
is deployed, the next allowed S26 action remains concrete-client read-only
`preflight → fresh plan → exact G4 approval`.
