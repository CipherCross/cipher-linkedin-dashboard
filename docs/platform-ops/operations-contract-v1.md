# Platform operations contract v1

Status: **P2 accepted contract**

Decision date: 2026-07-29

Applies after: `v053` tenant baseline and shared migration `054`

Machine-readable schemas:

- `contracts/onboarding-plan.v1.schema.json`
- `contracts/release-plan.v1.schema.json`
- `contracts/apply-request.v1.schema.json`

This document fixes the inputs, state, cost, recovery, and safety boundaries that
P3 and later sessions must implement. It does not authorize provider writes and
does not create an `ops/` implementation.

## Contract invariants

1. Planning and preflight are read-only. A plan contains no secret values and no
   raw provider request or response.
2. Every object accepted from a caller uses a closed schema. Unknown properties,
   unknown contract versions, unknown regions, unknown tiers, unknown backup
   profiles, and unknown release/protocol versions are blockers.
3. A write requires an unexpired, blocker-free plan, its digest, the registry
   version observed by the plan, and a caller-stable idempotency key.
4. Provider state that affects the result is represented by an allowlisted,
   redacted snapshot digest. Drift invalidates the plan.
5. A provider resource ID is persisted immediately after its successful effect.
   Resume continues the same operation; it does not create a replacement resource.
6. Failure never triggers automatic provider deletion, a down migration, or an
   admin invitation. The tenant becomes `quarantined` until a reviewed resume.
7. Registry and audit contain Keychain labels, never Keychain values. Tool output,
   errors, fixtures, logs, and plan artifacts follow the same rule.
8. Physical Supabase/Vercel deletion and down migrations are outside the MCP and
   operations core. They are manual break-glass procedures.

## Versioned catalogs and closed vocabulary

Provider choices change independently of this repository. The operations core must
load a signed or repository-pinned catalog snapshot and refer to entries by ID; it
must never accept a free-form provider SKU or region payload.

Each catalog snapshot has:

- `catalog_kind`: `regions`, `provider_tiers`, `pricing`, `backup_profiles`,
  `release_compatibility`, `capabilities`, or `subprocessors`;
- `catalog_version`: immutable identifier;
- `source_revision` and `published_at`;
- `entries` with stable IDs and allowlisted typed fields;
- `digest`: SHA-256 of canonical JSON;
- `review_status`: only `approved` is plan-eligible.

Required allowlisted entry fields are fixed as follows:

| Catalog | Entry fields |
|---|---|
| `regions` | ID, provider region code, jurisdiction, residency-policy IDs, allowed workspace classes, availability, legal-review status |
| `provider_tiers` | ID, provider, kind (`plan`/`compute`), capacity/feature limits, backup capability IDs, billable flag, pricing SKU ID, availability |
| `pricing` | SKU ID, provider, currency, integer minor-unit fixed/usage price, unit, tax treatment, effective/expiry time, source reference |
| `backup_profiles` | ID, maximum RPO/RTO, provider backup/export/drill cadence, retention choices, required coverage set, compatible tier IDs |
| `release_compatibility` | ID, baseline/schema/application/agent/launcher/protocol ranges, workspace classes/channels, approved migration and verification bundle digests |
| `capabilities` | ID, metering unit, required secret names, allowed overage actions, cost SKU IDs |
| `subprocessors` | profile ID, approved processors/data flows, region restrictions, legal-review status, effective time |

Entries are closed typed records when implemented; adapters may not attach provider
response fragments to them.

Semantic validation resolves every `*_id` in a plan against the exact pinned
catalog version. Missing, deprecated, unpriced, or unapproved entries produce a
blocker. JSON Schema validates shape; catalog resolution validates meaning.

Provider availability and prices must be refreshed before their catalog's declared
`valid_until`. An expired price does not silently become zero: it blocks apply and
requires a new plan. Paid tiers and optional paid features must be explicitly
selected in business inputs; no default may upgrade a tenant.

## Tenant identity, names, and ownership markers

### Slug

- Lowercase ASCII, `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`.
- Globally unique in the local registry, including retained/offboarded tenants.
- Immutable after the first provider resource is created.
- Reserved words include `api`, `app`, `admin`, `auth`, `canary`, `internal`,
  `ops`, `preview`, `prod`, `staging`, `support`, and `www`.

### Deterministic names

Given slug `<slug>`:

| Resource | Name |
|---|---|
| Logical tenant | `tenant/<slug>` |
| Supabase project display name | `lh2-<workspace-class>-<slug>` |
| Vercel project | `lh2-<workspace-class>-<slug>` |
| Production hostname | `<slug>.<platform-domain>` |
| Keychain tenant namespace | `lh2-platform/tenant/<slug>/<secret-name>` |
| Operation lock | `tenant:<slug>` |

`workspace-class` is one of `internal`, `disposable`, or `external`. Provider
length limits are validated during preflight. A collision is a blocker; the core
does not append a random suffix.

### Logical ownership tags

Every resource plan carries this closed tag set:

| Tag | Value |
|---|---|
| `managed-by` | `lh2-platform-ops` |
| `tenant-slug` | the immutable slug |
| `workspace-class` | `internal`, `disposable`, or `external` |
| `contract-version` | `p2.v1` |
| `registry-owner-id` | stable non-secret owner UUID |

Adapters materialize these only through provider-supported, allowlisted metadata.
If a provider has no suitable tag field, deterministic naming plus the registry
resource reference is the ownership proof. Arbitrary metadata maps are forbidden.
Adoption is allowed only when name, organization/team, logical tags, and expected
provider kind all match; otherwise the operation is quarantined.

## Production prerequisite contract

An onboarding plan is not applicable until all required prerequisites are `passed`.
`manual` means evidence must be recorded before a replacement plan can pass.

### Organization and access

- Approved Supabase organization ID and Vercel team ID are selected from local
  platform configuration.
- Read-only preflight proves provider credentials can inspect the selected
  organization/team. Secret values are neither accepted nor returned.
- Domain zone and the exact tenant hostname are owner-controlled and available.
- The source revision is a full 40-character Git SHA present in the approved
  release catalog; working-tree content is never a deploy input.

### Region and data residency

- `residency_policy_id`, provider region ID, and the region catalog version are
  required.
- The catalog states jurisdiction, allowed workspace classes, and legal-review
  status. An external tenant cannot use a region whose legal status is unknown.
- Moving an existing tenant to another region is not onboarding or resume; it is
  a separate data-migration project and is blocked by this contract.

### Provider tier and capacity

- Supabase plan, compute size, and Vercel plan are explicit catalog IDs.
- The selected entries must expose backup capabilities, function count/body/time
  limits, Auth/SMTP compatibility, and expected recurring price.
- Preflight counts the repository's current serverless functions and scheduled
  jobs plus the planned generated slot. Insufficient or unknown capacity blocks.
- A billable tier cannot be inferred from company size or instance count.

### Auth and SMTP

- Custom SMTP profile ID, Keychain labels for credentials, verified sender domain,
  `from` identity, template-set ID, production Site URL, and exact redirect
  allowlist are required.
- SMTP provider access and DNS ownership are preflighted without sending an admin
  invite. Delivery smoke testing occurs during apply before the invite step.
- Default Supabase SMTP is not production-eligible.
- The first admin receives a personal invite and sets their own password. A
  generated/shared password is forbidden.

### Backup and recovery

- A known backup profile and a complete coverage matrix are required.
- The profile must cover database schema/data, Auth configuration and identities,
  Storage metadata, private `lead-photos` objects or an approved reconstruction
  source, and deployment/configuration metadata needed for recovery.
- Missing coverage is a blocker, not an accepted implicit risk.

### External-ingest readiness

External onboarding remains blocked until the pinned release compatibility entry
includes a machine-scoped, revocable ingest protocol that does not place a
Supabase service-role key or shared `NOTIFY_SECRET` on a client machine. The
current direct transport is `internal` only.

## Plan envelope and digest

The JSON schemas define the exact shape. Both onboarding and release plans use:

- a unique `plan_id`;
- `contract_version = "p2.v1"` and a plan-specific schema version;
- `generated_at` and `expires_at`;
- `expected_registry_version`;
- a closed `spec` object;
- `plan_digest = "sha256:<64 lowercase hex>"`;
- typed blockers and prerequisites.

The digest is:

```text
sha256(JCS(plan.spec))
```

where JCS is RFC 8785 canonical JSON encoded as UTF-8. `plan_id`,
`plan_digest`, `generated_at`, and `expires_at` are envelope metadata and are not
part of `spec`. The complete desired inputs, catalog versions/digests, provider
snapshot digests, resource names/tags, pinned revisions, effects, costs, budgets,
recovery targets, and verification gates are inside `spec`.

Identical `spec` objects therefore have identical digests. Any change to a
business input, catalog, provider snapshot, resource name, version, effect,
budget, or gate changes the digest. Apply also rejects a plan when:

- current time is at or after `expires_at`;
- registry version differs;
- a blocker exists or a required prerequisite is not `passed`;
- a provider snapshot no longer matches;
- the plan was already consumed by a different idempotency key;
- the plan or contract version is unsupported.

For `state = valid`, `blockers` is empty and every prerequisite is `passed`. For
`state = blocked`, at least one blocker is present. `manual` prerequisite evidence
always requires a replacement plan after it is reviewed; apply never treats
`manual` as passed.

Default maximum TTL is 30 minutes. A shorter provider snapshot validity wins.

## Onboarding plan contract

Safe business inputs are limited to:

- company name, immutable slug, workspace class, admin email;
- expected instance count and release channel;
- residency, region, Supabase/Vercel tier, compute, pricing, backup, retention,
  and subprocessor profile IDs;
- SMTP and integration Keychain labels, never values;
- support-access policy;
- explicit per-tenant capabilities and budgets.

The resulting plan completely describes:

1. exact logical/provider names, hostname, tags, owner organization/team, and
   stable cron slot;
2. pinned Git SHA, baseline version `053`, ordered shared migrations beginning
   with `054`, application version, agent release, and ingest protocol;
3. redacted provider snapshots and their digests;
4. ordered typed effects for Supabase, schema, private Storage, Auth/SMTP,
   support identity, Vercel, env scopes, domain, build, deployment, smoke tests,
   company-admin row, and invite;
5. Production and Preview policy;
6. itemized recurring/one-time cost and usage ceiling;
7. capability budgets;
8. backup coverage, RPO/RTO, exports, retention, and restore rehearsal;
9. exact smoke-test IDs, prerequisites, blockers, and manual actions.

Effect inputs are references to fields already in the plan. A plan never embeds a
provider URL, HTTP body, SQL string, shell command, environment value, or arbitrary
key/value payload.

The only allowed onboarding sequence is:

| Step | Transition gate |
|---:|---|
| 1 | Reserve slug and operation under `tenant:<slug>` lock |
| 2 | Create or strictly adopt owner-marked Supabase project; persist ID |
| 3 | Wait ready; apply immutable v053 baseline and ordered shared deltas |
| 4 | Verify private Storage; configure Auth URLs/templates/custom SMTP |
| 5 | Create disabled/expired `platform_support` membership |
| 6 | Create or adopt Vercel project; disable Git auto-promotion |
| 7 | Write allowlisted Production-only env values from Keychain/generated refs |
| 8 | Bind the pre-approved hostname |
| 9 | Build the pinned SHA with tenant-specific public values |
| 10 | Deploy and promote that verified build |
| 11 | Run schema/Auth/RLS/Storage/API/cron/preview-isolation/SMTP smoke tests |
| 12 | Create company-admin row and send invite only after every required test passes |
| 13 | Persist final observed state and mark operation succeeded |

## Release plan and compatibility contract

A release bundle pins:

- Git SHA/application version;
- minimum/maximum compatible schema version and ordered migration set;
- tenant baseline version;
- ingest protocol range;
- agent/launcher version and allowed channel;
- deployment-config digest;
- verification checklist and release notes digest.

Version comparisons use catalog-defined monotonically ordered integers, not
lexicographic strings. A target is eligible only if its observed versions fall
inside every required range and every migration from observed to target is present
and approved.

The rollout order is fixed:

```text
expand migrations
→ internal workspace
→ designated canary workspace
→ canary agent and verification window
→ remaining tenant migrations
→ per-tenant builds/deployments from the same Git SHA
→ stable agent rollout
→ later, separately approved contract cleanup
```

The designated canary is stored as a stable registry tenant ID, not inferred by
name. It must be `active`, have no critical drift, have a successful recent
backup, heartbeat, and cron health, and use an approved `internal` or `canary`
channel. Canary failure blocks fan-out. It never auto-skips to stable.

A release plan records an independent target result for every tenant. One failed
tenant may leave the overall operation `partially_succeeded`, but cannot hide the
failure or roll back/delete resources automatically.

## Apply and idempotency contract

The only caller fields are defined in `apply-request.v1.schema.json`:

- `plan_id`;
- `plan_digest`;
- `expected_registry_version`;
- `idempotency_key`;
- optional existing `operation_id` for resume.

An idempotency key is 16–128 visible URL-safe characters, generated once by the
caller and reused for all retries of the same approved intent. Registry uniqueness
is `(operation_kind, tenant_or_release_scope, idempotency_key)`.

- Same key + same plan digest returns or resumes the same operation.
- Same key + different digest is `idempotency_conflict`.
- Different key + consumed plan is `plan_already_consumed`.
- Concurrent apply for the same tenant/release target is `lock_conflict`.
- Provider timeout is `outcome_unknown`; reconcile by deterministic name and
  ownership marker before retrying create.

Approval is recorded by the adapter/core as audit metadata. It does not widen the
schema and cannot authorize a different digest.

## State machines

### Plan

```text
draft → valid → consumed
           ↘ expired
           ↘ invalidated
draft → blocked
blocked → invalidated
```

Only `valid` can be consumed. A blocked/expired/invalidated plan is immutable; a
fresh plan is required.

### Tenant lifecycle

```text
absent → planned → provisioning → verifying → active
                         ↘ quarantined ↗
active ⇄ suspended
active|suspended → offboarding_planned → retained
```

- `planned` has no provider effects.
- `provisioning` has provider effects but cannot invite an admin.
- `verifying` has all required resources and is running gates.
- `active` requires all gates and a company admin.
- `quarantined` blocks invites, machine enrollment, release promotion, and normal
  jobs; resume must use the original operation or a reviewed reconcile plan.
- `suspended` is reversible and blocks users, machines, and tenant jobs without
  deleting data/resources.
- `retained` means access is suspended, final export/checklist is recorded, and
  resources await manual break-glass deletion after the retention window.
- There is no `deleted` transition in the operations core.

Desired and observed lifecycle are stored separately. A mismatch is drift, not an
instruction to force state.

### Operation

```text
pending → running ⇄ waiting_provider
running|waiting_provider → failed → running
running|waiting_provider|failed → quarantined → running
running → succeeded
running → partially_succeeded   (release fan-out only)
```

Every transition appends audit and increments registry version in the same local
transaction. `failed` is retryable after the cause is fixed. `quarantined` requires
explicit reviewed resume. No generic cancel/delete transition exists in v1.

### Step

`pending → running → succeeded`, with `running → waiting_provider|failed|
outcome_unknown`. A step cannot be skipped unless its plan marks it
`not_applicable`; that value is fixed before apply. Provider references are written
before a step becomes `succeeded`.

## Logical registry schema v1

P3-A implements this logical model in SQLite. Column types and indexes may be
adapted to SQLite, but fields, uniqueness, and secret boundaries are contractual.

| Entity | Required fields and constraints |
|---|---|
| `registry_meta` | singleton `schema_version`, monotonic `registry_version`, owner UUID, last backup digest/time |
| `tenants` | tenant UUID, unique immutable slug, company name, workspace class, desired/observed lifecycle, release channel, region/tier/backup/catalog IDs, cron slot, created/updated timestamps |
| `plans` | plan ID, kind, schema/contract versions, digest, immutable canonical spec JSON, generated/expiry time, expected registry version, state, consumed operation/key; unique digest is not required |
| `operations` | operation ID, kind, scope, plan ID/digest, idempotency key, state, actor, approval time, error code/redacted summary, created/updated/completed time; unique `(kind, scope, idempotency_key)` |
| `operation_steps` | operation ID, ordinal, closed step kind, state, attempt, provider request ID, started/updated/completed time, redacted error; unique `(operation_id, ordinal)` |
| `resource_refs` | tenant ID, provider kind, resource kind, provider organization/team ID, resource ID, deterministic name, ownership-marker digest, observed lifecycle/time; unique provider resource identity |
| `locks` | lock name, owner operation ID, fencing token, acquired/expires/heartbeat time; unique lock name |
| `releases` | release ID, bundle digest, Git SHA, version compatibility IDs, channel, state, created/completed time |
| `release_targets` | release ID, tenant ID, observed/target version tuple, state, last step/error; unique `(release_id, tenant_id)` |
| `capability_budgets` | tenant ID, capability catalog ID, enabled, unit, soft/hard limit, period, overage action, usage snapshot time |
| `recovery_profiles` | tenant ID, backup profile/catalog IDs, RPO, RTO/business calendar, coverage matrix, export/restore cadence, last successful backup/export/drill |
| `secret_refs` | scope, tenant ID if applicable, closed secret name, Keychain service/account label, version, rotated time; no secret value or value-derived digest |
| `audit_entries` | monotonic sequence, previous hash, entry hash, timestamp, actor, event kind, plan/operation/key IDs, state transition, provider request ID, redacted structured detail |

Canonical plan specs may be stored because they are secret-free. Raw provider
responses, environment values, access tokens, passwords, SMTP credentials,
enrollment codes, webhook URLs containing secrets, and secret hashes are forbidden
in every registry column.

Registry version is incremented once per committed state-changing transaction.
Read-only refreshes that change observed state also increment it and invalidate
plans based on the previous version.

## Cost and capability budget contract

All monetary amounts are integer minor currency units. A plan uses one ISO 4217
currency and declares whether tax is included. Floating-point money is forbidden.

The cost summary contains:

- fixed monthly provider components;
- bounded usage components with low/high estimates;
- one-time components;
- a monthly usage ceiling;
- catalog SKU IDs, quantity/unit, pricing version, and assumptions;
- whether the estimate is contractually included or owner-paid.

Every component must resolve to an approved, unexpired pricing entry. Unknown
price, currency conversion, tax treatment, or usage ceiling is a blocker. The
plan shows cost but never authorizes purchasing a different tier than selected.
For the summary and every component, high estimate must be greater than or equal
to low estimate, and the usage ceiling must be greater than or equal to the
recurring high estimate.

The initial capability vocabulary is:

- `ai.classification`
- `ai.coaching`
- `ai.briefing.daily`
- `ai.briefing.weekly`
- `slack.reply_alerts`
- `slack.briefings`
- `airtable.imports`

Each capability is explicitly enabled or disabled and has a metering unit,
monthly soft limit, monthly hard limit, and overage action:
`pause_and_alert`, `queue_and_alert`, or `disable_and_alert`. Hard limit must be
greater than or equal to soft limit. Enabled paid capabilities require a non-zero
hard limit and a priced cost component. Disabled capabilities cannot require a
secret. Shared provider credentials never imply shared or unlimited budget.

`cron_slot` is an integer `0..4`, stable per tenant. Slot allocation must avoid a
collision among active external tenants unless the capacity catalog explicitly
allows it.

## Recovery contract

### Standard production profile

Unless a client contract selects a stricter approved profile:

- RPO: at most 24 hours;
- RTO: at most one business day, represented as 8 business hours plus an explicit
  IANA timezone and business calendar;
- provider backup: at least daily;
- encrypted logical/recovery export: at least every 7 days;
- restore rehearsal: at least every 92 days in a disposable project;
- restore verification: DB schema/data, Auth configuration and access cases,
  private Storage inventory/objects or approved reconstruction, RLS, application
  build/config metadata, and a signed completion report.

The plan must specify retention for provider backups, encrypted exports, final
offboarding export, and audit. No retention duration is inferred from the recovery
profile because it depends on the client data policy.

### Enhanced/PITR profiles

A stricter profile is eligible only when the pinned Supabase tier/compute and
backup catalogs prove the requested RPO/RTO, its recurring cost is priced, and an
approved restore procedure covers the same recovery surface. “PITR enabled”
without a successful restore drill is not a met recovery objective.

### Registry recovery

The registry has an encrypted backup with digest and timestamp. Replacement-Mac
recovery restores the registry, rotates platform provider tokens, relinks Keychain
labels through no-echo input, and read-only reconciles deterministic provider
resources. Reconcile may restore observed references but cannot read secret env
values, adopt ambiguous resources, or perform writes.

## Forbidden and destructive actions

The operations core, CLI, and MCP must not expose or internally route:

- physical Supabase/Vercel project deletion;
- down migrations, migration-history repair, or repository-root
  `supabase db push` against a tenant;
- arbitrary shell, SQL, HTTP, DNS, provider payload, environment read/set, or
  secret read/return operations;
- raw provider responses in outputs, registry, audit, or errors;
- automatic cleanup/delete/rollback after a partial failure;
- adoption by name alone or creation with a random collision suffix;
- apply of a blocked, stale, expired, unknown-version, or digest-mismatched plan;
- company-admin invite before all required smoke tests pass;
- production secrets in Preview, external auto-preview, or Git auto-promotion;
- a shared build artifact across tenants when public Supabase values differ;
- service-role or shared notification secrets on external client machines;
- overwrite of immutable baseline/release/agent artifacts;
- stable rollout before a successful designated canary gate;
- support access without reason and expiry;
- treating `platform_support` as the last company admin;
- physical offboarding deletion through a generic suspend/offboard operation.

Potentially destructive but reversible tools (`tenant_suspend`, `machine_revoke`,
and `support_access_disable`) require explicit approval and destructive MCP
annotations in P4. Their effects must remain limited to the named tenant/resource.

## P2 acceptance gate

P2 is accepted when:

- all three JSON Schemas compile under Draft 2020-12;
- their root and nested objects reject unknown properties;
- onboarding inputs and plan effects contain no secret-value or arbitrary-provider
  payload field;
- catalog resolution rules make unknown plan/tier/region/price/backup/protocol a
  blocker;
- onboarding, release, plan, tenant, operation, and step transitions are fixed;
- naming/tags, registry entities, cost/budgets, canary, RPO/RTO, recovery coverage,
  and forbidden actions are explicit;
- no `ops/` implementation or production provider write is made in P2.
