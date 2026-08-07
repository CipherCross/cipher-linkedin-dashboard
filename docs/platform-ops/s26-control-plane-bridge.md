# S26 control-plane bridge contract

Status: **local contract only; no bridge deployment or provider request has occurred**

## Purpose

The S26 bridge supplies the application-owned provider capabilities that do not
have a safe, complete direct control-plane mapping: Better Auth configuration
and identity recovery, custom SMTP verification, domain authority inspection,
and pinned source-repository inspection. It is not a general HTTP proxy and
never accepts caller-selected URLs, headers, SQL, shell commands, environment
maps, credential values, or arbitrary provider payloads.

The owner-local S26 runtime talks only to the bridge's fixed
`s26-control-plane.v1` paths. The bridge returns strict, secret-free canonical
responses that the existing S26 adapters validate before the operations core
uses them.

## Fixed routes

| Capability | Allowed operations |
|---|---|
| Better Auth identity | `inspect`, `configure`, `support-membership`, `company-admin-invite`, `smoke`, `recovery-capture`, `recovery-restore`, `recovery-verify` |
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

## Deployment and implementation gate

The bridge must be implemented and deployed through a separately approved
provider change before a live S26 preflight can use it. Its implementation must:

1. authenticate and authorize the owner-local bridge credential;
2. validate each request and response against the named operation contract;
3. keep provider credentials server-side and redact provider failures;
4. classify timeout, throttling, and 5xx outcomes as `outcome_unknown` with an
   opaque provider request ID;
5. verify ownership markers before returning an adoption, recovery, or domain
   result; and
6. expose no apply/restore behavior until the operations core reaches that
   owner-approved effect.

Bridge deployment alone does not authorize tenant creation, schema application,
environment binding, an invite, recovery restore, or any S27/S28 work. After it
is deployed, the next allowed S26 action remains concrete-client read-only
`preflight → fresh plan → exact G4 approval`.
