# S26 owner-runtime configuration

## Goal

Make the reviewed S26 operations core runnable through an explicit, owner-local
`--s26` runtime mode. It will assemble `createS26Runtime` from a fresh,
catalog-backed disposable profile and concrete provider clients while keeping
credentials in macOS Keychain and preserving the existing
`preflight → plan → owner approval → apply/resume → verify` boundary.

This work prepares read-only preflight and fresh-plan generation only. A plan
created through the new runtime must still stop for the owner's exact G4
approval before any provider-changing operation.

## Non-goals

- Do not apply or resume onboarding, create a tenant, deploy, bind a domain,
  send an invite, perform a restore, or start S27/S28.
- Do not reuse the expired S26 plan, its approval, digest, registry version, or
  idempotency key.
- Do not use `p4c-sdk.ts`, fake provider bundles, raw provider calls, raw SQL,
  shell, HTTP, DNS, environment, or secret escape hatches.
- Do not put credentials, URLs containing credentials, tokens, or provider
  responses in plans, the registry, logs, arguments, environment variables, or
  documentation.

## Research findings

- `createS26Runtime` is available but library-only: it needs a `Registry`, a
  complete `DisposableOnboardingProfile`, and an `S26OperationsApiBundle`.
- `createS26ConcreteApiBundle` currently needs seven HTTPS client
  configurations and adapter-private credential resolvers. The existing CLI and
  MCP start either provider-free or the legacy `--p4c` path; neither can build
  S26.
- The current fixed S26 routes are not direct configurations for Neon, R2, or
  Vercel public APIs. Better Auth, SMTP, domain verification, and source
  inspection additionally require an application-owned control-plane bridge.
- Registry/Keychain contracts already provide closed secret labels and redacted
  adapter-private lookup. S26 needs new closed names; values must be installed
  interactively and never supplied to the CLI, MCP, config file, or plan.

## Decisions

| Decision | Chosen value |
|---|---|
| Provider integration | Map Neon, Cloudflare R2, and Vercel to their official HTTPS APIs through reviewed named adapters. Use a distinct S26 control-plane bridge only for Better Auth, SMTP, domain verification, and source-repository inspection. |
| Owner runtime | Add an explicit `--s26` selector to the existing owner CLI and STDIO MCP. It is mutually exclusive with `--p4c`; the default remains provider-free and fail-closed. |
| Generated disposable identity | Reserve logical defaults only: tenant slug `s26-disposable-lab`, hostname `s26-disposable-lab.app.ciphercross.dev`, source SHA `51f7eefaff62edb7e5c5c4bef5a2cab254a532a0`, baseline `053`, and ordered migrations beginning at `054`. The hostname is a proposed resource name, not authorization to bind it. |
| Unknown provider identity | Neon organization ID, Vercel team ID, Cloudflare account ID, bridge base URL, bridge owner, SMTP sender profile, catalog entries, and provider scopes remain explicit fail-closed prerequisites. They must not be invented from the generated logical identity. |
| Secrets | Extend the closed Keychain vocabulary with S26 capability-specific labels and use a resolver that obtains values only inside the client. Values are entered interactively after the labels and scopes are approved. |
| S26 gate | Once configuration has reviewed values and catalog snapshots, run only concrete-client `preflight → fresh disposable plan`, then stop for new exact G4 approval. |

## Approach

1. Replace the current route assumptions with reviewed adapters that translate
   the S26 named operations to official Neon, R2, and Vercel APIs. Each adapter
   keeps its API base, owner/account scope, request mapping, response validation,
   redaction, ownership markers, and outcome-unknown handling private.
2. Define and build the missing owner-controlled S26 bridge for Better Auth,
   SMTP, domain, and source inspection. It exposes only the existing fixed
   named operations, returns typed secret-free results, performs no work at
   construction, and is separately configured with a non-secret HTTPS base URL
   plus Keychain-backed credential label.
3. Add an S26 configuration schema/profile loader that contains only validated
   non-secret values: logical identity, provider owner/account scopes,
   approved catalogs, source/release data, recovery profile, smoke IDs, and
   Keychain label references. Unknown/missing values block startup or
   preflight.
4. Add S26 Keychain secret names and a resolver factory. Each provider uses its
   own least-privilege label/scope; only `SecretStore.get()` inside the adapter
   resolves a value and registers it with the redactor. No resolver result can
   cross the provider interface.
5. Wire the loader, concrete bundle, and `createS26Runtime` into CLI/MCP
   `--s26` startup. Planning routes through the existing owner adapter; the
   apply/resume tool remains present but is not invoked in this session.
6. Add contract tests for selector exclusivity, closed configuration, no
   P4-C/fake imports, Keychain-only resolution, direct-provider route mapping,
   bridge route mapping, redaction, blocker propagation, and successful
   concrete-bundle preflight/plan using test transports.

## Implementation phases

1. **S26 configuration contract and Keychain vocabulary (M).** Add closed
   configuration and secret-label schemas, generated logical defaults, and
   fail-closed catalog/scope validation.
2. **Direct provider adapters (L).** Implement reviewed official Neon, R2, and
   Vercel operation mappings, including ownership/adoption and read-only
   inspection behavior.
3. **S26 control-plane bridge (L).** Define, implement, and review the
   Better-Auth/SMTP/domain/source bridge with fixed typed operations and
   redacted results. This phase cannot claim a provider-backed preflight until
   the bridge has an approved deployment and non-secret base URL.
4. **Owner runtime wiring (M).** Add mutually-exclusive `--s26` CLI/MCP mode,
   assemble `createS26Runtime`, and preserve the default fail-closed behavior.
5. **Verification and planning handoff (M).** Run local contract tests and,
   only when every scope/catalog/credential label is configured, execute the
   requested concrete read-only preflight and persist one fresh disposable
   plan. Stop for exact G4 approval.

## Affected files/modules

- `ops/src/providers/s26-concrete-clients.ts` and new focused provider adapter
  modules
- `ops/src/providers/apis.ts`, `ops/src/providers/s26-provider-backed.ts`
- `ops/src/runtime/s26-runtime.ts` and a new S26 configuration/profile loader
- `ops/src/secrets/types.ts`, `ops/src/secrets/service.ts`
- `ops/src/cli/cli.ts`, `ops/src/mcp/main.ts`, and owner-MCP documentation
- S26 bridge source/deployment module and its typed schemas, exact location to
  be chosen with the bridge hosting decision
- `ops/test/s26-*.test.ts` and new selector/configuration/adapter tests
- `docs/platform-ops/s26-provider-backed-recovery.md` and the S26 handoff

## Risks & how to verify

- **A client still targets an invented bridge route.** Verify each direct
  adapter against the relevant official API contract with recorded,
  secret-free fixtures; test the bridge separately against its own fixed
  contract.
- **A token leaks through configuration or errors.** Test that config accepts
  labels only, redaction covers resolver values, and output has no credential
  material.
- **S26 accidentally selects P4-C or a fake.** Test that `--s26` and `--p4c`
  are mutually exclusive and that the assembled graph contains no
  `p4c-sdk.ts`/fake bundle import.
- **Invented IDs make a plan appear applicable.** Assert missing or unapproved
  owner/account scope, domain, sender, catalog, or bridge URL produces a typed
  blocker; only the logical disposable name may be generated.
- **Planning performs a write.** Test that the runtime reaches only the
  provider inspection methods for preflight/plan and that apply/resume methods
  remain uncalled.
- **A stale G4 identity is accepted.** Test that a new plan has a new generated
  time/expiry/digest identity and that no historical S26 plan/approval is read
  as an authorization source.

## Definition of done

- The owner can start the existing CLI/MCP in explicit `--s26` mode and it
  assembles `createS26Runtime` exclusively from the reviewed S26 bundle.
- Direct Neon, R2, and Vercel mappings and the dedicated bridge have approved,
  fixed, typed, HTTPS-only contracts; none use legacy P4-C or a fake as live
  evidence.
- Every credential is represented by a closed Keychain label and resolved only
  inside its adapter; secret-free output tests pass.
- Configuration fails closed for every unknown provider scope, domain/sender,
  catalog entry, bridge endpoint, or recovery requirement.
- The generated logical disposable profile is ready to receive approved
  provider-specific identifiers without changing its tenant identity or
  releasing a resource.
- After the required values are installed, exactly one fresh read-only
  disposable preflight and plan can be created, reported, and held for a new
  exact G4 approval. No apply, resume, verification, restore, invitation,
  deploy, or provider resource mutation occurs before that approval.
