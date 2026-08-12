# S26 catalog evidence and disposable-policy decision

Status: **approved local catalog policy; configuration-valid and plan-blocked**
Retrieved/reviewed: **2026-08-10**
Scope: disposable, non-production, non-regulated data only. This is not a
provider preflight, plan, apply/resume/verify, recovery capture, or live
readiness result.

## Result

The owner approved the recommended bounded disposable policy. The repository
now contains all seven reviewed snapshots in
[`catalogs/s26-disposable-policy-v1.json`](catalogs/s26-disposable-policy-v1.json),
and the permission-restricted owner-local configuration is materialized at
`/Users/mykytashevchenko/.config/lh2-platform/s26-owner-runtime.json` with
Keychain label references only.

The catalog mechanics are closed without changing schema version:

1. `digest` is SHA-256 of RFC 8785/JCS canonical JSON after removing only the
   top-level `digest` member, and both the core and S26 loader recompute it.
2. Public mutable-source evidence is repository-pinned through source revision
   `96f4e5228f9d058617151ac4246469b9fef44a26` and retains its official URL and
   retrieval/effective time in the reviewed artifact.
3. Fractional public prices use exact scaled units. For example, R2 storage is
   1,500 USD minor units per 1,000 GB-months, and Neon Launch compute is 10,600
   USD minor units per 1,000 CU-hours.
4. `sync-agent-1.14.0`, `agent-ingest.v1`, the pinned 053→054 portable bundle,
   the eight closed future smoke IDs, zero optional-capability budgets, 24-hour
   RPO, 8-business-hour RTO, daily encrypted export, 30-day retention, and a
   90-day drill cadence are reviewed selections. The agent release remains
   unavailable until its signed manifest is verified.

The policy is deliberately **not plan-eligible**. Vercel commercial entitlement,
the approved source release's `fra1` pin, the control-plane R2 bucket's EU
jurisdiction, and the selected agent's signed release manifest are not verified.
Their tier/region/release/subprocessor entries are
`availability: "unavailable"`, so catalog semantics must block planning. This
is the final S26 blocker disposition, not a prompt for another repair loop.

## Historical evidence used for the decision

## Evidence discipline and repository provenance

Public documentation establishes product facts, not access to a particular
account. The reviewed IDs below are repository evidence only and must be
reconfirmed by a separately authorized future read-only preflight. No provider
dashboard, provider API, source-repository API, Keychain item, or secret was
read for this package.

| Reviewed selection or artifact | Provenance and current evidence status |
| --- | --- |
| Neon organization `org-damp-hill-86577285` | Closed non-secret selection in `ops/wrangler.jsonc`; account/plan access cannot be proved publicly. **Availability: unknown pending preflight.** |
| Cloudflare account `eb89cc458183927bebefdebe1f751880` | Reviewed S26 owner selection. `N-S26` records the already-deployed fixed bridge and its existing `linkedin-campaign-dashboard` R2 binding, but does not prove current R2 subscription, quota, jurisdiction, or billing state. **Availability: unknown pending preflight.** |
| Vercel team `team_AB0nAOId1mR7gHxPldsG9f2u` | Closed non-secret selection in `ops/wrangler.jsonc`; public docs cannot establish the team's plan, commercial eligibility, quota, or region configuration. **Availability: unknown pending preflight.** |
| Neon region `aws-eu-central-1` | Neon publicly identifies this as AWS Europe (Frankfurt). This establishes product-region availability, not legal approval or organization entitlement. |
| `neon-free`, `autoscale-0.25-2cu`, `neon-free-restore-6h` | Closed non-secret S26 selections in `ops/wrangler.jsonc`; current public Neon pricing supports the product limits recorded below. Entitlement remains unverified. |
| `s26-neon-hosting-v1`, `s26-b2c287a` | Closed compatibility/application identifiers in `ops/wrangler.jsonc`. They are reviewed repository vocabulary, not provider product IDs. |
| Source SHA `b2c287af68b5afe46deee27aa3eb829ed0297c60` | The local tracking ref `origin/main` contains this commit at this checkpoint. This package did **not** call a source-repository API; a future approved source inspection must verify remote availability and compatibility again. |
| `ciphercross.dev` | Reviewed owner domain/sender-domain selection. Public documentation cannot prove zone ownership, sender verification, or a future hostname's availability. **Availability and legal status: unknown pending owner decision/preflight.** |
| Current S26 deployment/release metadata | `ops/wrangler.jsonc` pins schedule manifest `sha256:688baed28906755e59c836917b63626a44d00b2c544a7a82fe98b2cafe492ebc`; its current file SHA-256 is `9d190d72327d89e998275ed3ab9a91c994d4c9096e33c5bffdc9a57e123a2584`. The four repository schedules are recorded in `frontend/vercel.json` (file SHA-256 `92ef7f22bfa40c776379815b2ee0efa7a43a5969710a6a591dfd317af32b929e`). |

The existing deployed bridge remains a closed `s26-control-plane.v1` boundary.
This package neither changes it nor makes it a generic source of catalog facts.

## Official public sources

All source URLs are official public documentation. "Mutable" means the page is
current evidence as retrieved, but is not an immutable source revision suitable
for an approved snapshot by itself.

| Source | Retrieved | Supported facts and limitations |
| --- | --- | --- |
| [Neon pricing](https://neon.com/pricing) | 2026-08-10 | Free is USD 0, with 100 CU-hours/month/project, 0.5 GB/project, sizes up to 2 CU (8 GB RAM), autoscaling, and up to six-hour restore history. The restore FAQ on that page limits Free to six hours **or 1 GB of data changes, whichever comes first**. Launch is usage priced at USD 0.106/CU-hour and USD 0.35/GB-month. Mutable pricing page. |
| [Neon Frankfurt capacity update](https://neon.com/docs/changelog/2026-02-20) | 2026-08-10 | Names AWS Europe (Frankfurt) as `aws-eu-central-1` and records capacity expansion. It does not prove the selected organization can create a project there. |
| [Neon Free autoscaling announcement](https://neon.com/docs/changelog/2024-08-30) | 2026-08-10 | States Free autoscaling from 0.25 CU (1 GB RAM) to 2 CU (8 GB RAM) and describes it as GA. Historic release note; current limit is cross-checked against pricing. |
| [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) | 2026-08-10 | Free allowance is 100,000 requests/day and 10 ms CPU per invocation. It is capacity evidence only; it does not attest the selected account's billing configuration. |
| [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) | 2026-08-10 | Standard: USD 0.015/GB-month, USD 4.50/million Class A, USD 0.36/million Class B; included monthly usage is 10 GB-month, 1M Class A, 10M Class B, and no direct R2 egress charge. Usage above included levels is billable; rounding applies. |
| [Cloudflare R2 limits](https://developers.cloudflare.com/r2/platform/limits/) | 2026-08-10 | 1,000,000 buckets/account, unlimited objects/bucket, 5 TiB objects, 50 bucket-management operations/second/bucket, and R2 REST API 1,200 requests/five minutes/account. These are platform limits, not a guaranteed quota. |
| [Cloudflare R2 data location](https://developers.cloudflare.com/r2/reference/data-location/) | 2026-08-10 | Location hints are best effort, not residency guarantees. The `eu` jurisdiction guarantees storage and processing in the EU, is immutable after bucket creation, and must be included in a Worker/S3 access path. |
| [Vercel Hobby plan](https://vercel.com/docs/plans/hobby) and [Vercel Terms](https://vercel.com/legal/terms) | 2026-08-10 | Hobby is free but restricted to personal, non-commercial use. It includes 1M function invocations/month, 100 GB-hours duration/month, 200 projects, and 60-second maximum function duration. It is therefore **not** an approved business hosting selection for this dashboard. |
| [Vercel runtime limits](https://vercel.com/docs/functions/runtimes) and [cron pricing/limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) | 2026-08-10 | Hobby permits at most 12 Vercel Functions/deployment; 100 cron jobs/project, each no more than daily, with hourly scheduling precision. Existing four daily-or-less schedules fit the public cron count/frequency rule, but the selected team's plan and function count still require preflight. |
| [Vercel function regions](https://vercel.com/docs/functions/configuring-functions/region) and [region list](https://vercel.com/docs/regions) | 2026-08-10 | New projects default to `iad1` (Washington, DC); `fra1` is Frankfurt. A region must be explicitly configured to avoid the default. CDN delivery is global, and multi-region failover has plan-specific constraints. |
| [Neon subprocessors](https://neon.com/subprocessors), [Cloudflare DPA](https://www.cloudflare.com/en-gb/cloudflare-customer-dpa/), [Vercel DPA](https://vercel.com/legal/dpa), [Resend subprocessors](https://resend.com/legal/subprocessors), and [GitHub subprocessors](https://docs.github.com/en/site-policy/privacy-policies/github-subprocessors) | 2026-08-10 | These are current legal/subprocessor references. Neon currently redirects its subprocessor URL to the Databricks list. Cloudflare and Vercel document processors and changing subprocessor lists; Resend's list is dated 2026-07-15 and identifies US-based processors; GitHub lists processor locations. None is a completed owner legal review. |

## Seven-catalog evidence matrix

### 1. `regions`

Recommended candidate: `aws-eu-central-1` / AWS Europe (Frankfurt).

- **Availability:** public region/product availability is evidenced; the selected
  Neon organization entitlement is not.
- **Jurisdiction:** Germany/EU geographic inference is not a replacement for
  owner legal review. Record `legal_review_status: pending`, not approved.
- **Workspace recommendation:** disposable only. Do not allow an external
  workspace from this evidence package.
- **Residency restriction:** database selection may be Frankfurt, but end-to-end
  EU residency is blocked until R2 uses an EU jurisdiction, Vercel execution is
  explicitly set to `fra1`, and the owner accepts the relevant processor flows.
- **Catalog blocker:** no immutable source revision for the mutable public source
  and no owner legal approval.

### 2. `provider_tiers`

| Candidate | Public capacity/availability evidence | Recommendation and limitation |
| --- | --- | --- |
| `neon-free` | USD 0; 100 CU-hours/month/project; 0.5 GB/project; maximum 2 CU; scale-to-zero when idle. | Disposable-only candidate. Soft warning at 80 CU-hours or 0.4 GB; hard stop at 100 CU-hours or 0.5 GB. A quota/entitlement check is required before use. |
| `autoscale-0.25-2cu` | Free autoscaling is documented from 0.25 to 2 CU. | Candidate only. This is a capacity limit, not a cost or availability guarantee. No automatic upgrade to Launch/Scale. |
| Cloudflare Workers/R2 | Workers Free and R2 included usage are documented, but R2 requires an account subscription and can accrue overages. | Existing bridge/R2 binding is not a planner-approved tier. Do not infer that its account is free, entitled, or EU-jurisdictional. |
| Vercel hosting tier | No plan is selected in the reviewed S26 configuration. Hobby is non-commercial only. | **Blocked.** Do not select Hobby for the business dashboard. The owner must select a commercial-eligible Vercel plan and an explicit ceiling, or keep S26 hosting unconfigured. |

### 3. `pricing`

The public price evidence is sufficient to describe exposure, but not to create
a conforming integer-minor-unit snapshot:

- Neon Free is USD 0. Paid Neon Launch compute is USD 0.106/CU-hour and storage
  is USD 0.35/GB-month; neither paid SKU is selected.
- R2 Standard storage is USD 0.015/GB-month, which is 1.5 US cents and cannot
  be represented in `minor_unit_price: integer` without loss. Class A and Class
  B operation charges apply beyond the free monthly allowance.
- Vercel has no selected commercial plan or account-specific price/credit/usage
  evidence. Hobby must not be used to create a false zero-cost business plan.
- Resend and all AI/Slack/Airtable paid capability prices remain out of scope
  because those capabilities are disabled by the default below.

**Owner recommendation:** set a zero discretionary-spend ceiling. Do not enable
a paid SKU, paid plan, overage, automatic tier change, or paid add-on. On an
unknown cost, price, currency, tax treatment, capacity, or billing boundary,
pause and alert; do not estimate zero.

### 4. `backup_profiles`

The reviewed ID `neon-free-restore-6h` is a useful supplemental restore-window
selection, but must not be described as a six-hour backup guarantee. Neon states
that Free history is up to six hours **or 1 GB of data changes**, whichever
comes first. It cannot by itself establish the contract's complete recovery
surface or a successful restore drill.

Recommended owner parameters, all unapproved:

| Parameter | Recommendation | Evidence/status |
| --- | --- | --- |
| Maximum RPO | 24 hours across database schema/data, Better Auth configuration/identities, R2 metadata plus private objects/reconstruction, and Vercel deployment/configuration metadata. | Contract standard; not a completed backup. |
| Immediate database recovery window | Treat `neon-free-restore-6h` as best-effort supplemental history only, bounded by 1 GB of changes. | Public Neon pricing; not sufficient alone. |
| Logical export cadence | Every 24 hours, encrypted and integrity checked. | Required to support the proposed RPO; not configured or executed. |
| Restore target/drill | Disposable recovery target; at least every 92 days. | Contract standard; no capture, restore, or drill occurred. |
| RTO | At most 8 business hours, with the owner's IANA timezone and business calendar selected before approval. | Contract standard; no provider guarantee is claimed. |
| Retention | Owner must select and legally approve provider-history, export, final-export, and audit retention periods. | **Blocked:** no approved retention policy. |

### 5. `release_compatibility`

Reviewed repository evidence supports only these closed selections:

- compatibility ID `s26-neon-hosting-v1`;
- application version `s26-b2c287a`;
- source SHA `b2c287af68b5afe46deee27aa3eb829ed0297c60`;
- baseline 053, migrations beginning at 054, and the repository-pinned
  portable PostgreSQL/smoke artifacts; and
- four current Vercel schedules with the pinned schedule manifest digest above.

It does **not** support an approved compatibility entry. The release catalog is
missing a real signed agent-release selection, a machine-scoped ingest-protocol
selection, an owner-approved complete migration-bundle digest, and a
verification-bundle digest that has been defined as a catalog artifact rather
than inferred from several source-file checksums.

`lh2-agent-release/1` is an artifact-manifest format, not an `agent_release_id`.
Do not substitute it for a release. Similarly, the current machine APIs and
their tests are implementation evidence, not an approved `ingest_protocol_id`.

### 6. `capabilities`

The contract's initial vocabulary is:

`ai.classification`, `ai.coaching`, `ai.briefing.daily`,
`ai.briefing.weekly`, `slack.reply_alerts`, `slack.briefings`, and
`airtable.imports`.

Default recommendation for the disposable/free posture: every one remains
`enabled: false`, with soft and hard limits of zero and
`disable_and_alert`. No capability secret or pricing SKU may be attached while
disabled. If the owner later enables a capability, the only default overage
action is `pause_and_alert`, with a non-zero hard limit and a current, exact
price before a replacement catalog/plan can be considered.

This does not change the existing dashboard's runtime behavior; it is a
recommendation for a future S26 owner profile only.

### 7. `subprocessors`

Recommended profile status: `legal_review_status: pending`; do not set it to
approved. The proposed data-flow inventory is intentionally narrow:

| Service | Proposed S26 data flow | Region restriction / legal disposition |
| --- | --- | --- |
| Neon (and current published subprocessors) | Tenant PostgreSQL data; self-hosted Better Auth tables; managed restore-history metadata. | Database candidate is Frankfurt. The Neon subprocessor list/DPA must be owner-reviewed; no blanket EU-only claim is made. |
| Cloudflare Workers/R2 (and current published subprocessors) | Closed control-plane requests and recovery metadata/artifacts; no generic application data API. | The existing R2 bucket's jurisdiction is not evidenced. Any new tenant recovery bucket must use the immutable `eu` jurisdiction; otherwise block an EU-residency claim. |
| Vercel (and current published subprocessors) | Application build/deployment metadata and function handling after a future approved deployment. | Explicitly configure `fra1`; default is `iad1`. CDN and processor geography mean this is not by itself an EU-only processing claim. Commercial plan and legal review are required. |
| Resend (and current published subprocessors) | Future SMTP sender, recipient, headers, and message content only after a separately approved smoke/apply step. | No mail was sent. Resend's published list includes US processors; keep disabled pending legal acceptance and sender/domain verification. |
| GitHub (and current published subprocessors) | Pinned source SHA and repository metadata only; no tenant data should be sent. | Source-inspection token must remain read-only and server-side. A future authorized inspection must prove the exact SHA is present. |
| Anthropic, Slack, Airtable and other optional integrations | No S26 data flow under the disabled capability default. | Excluded from the proposed active profile. Enabling any requires its own pricing, DPA/subprocessor, regional, and budget evidence. |

## Historical decision checklist resolved by the approved policy

1. **Agent release:** select an actual signed `agent/current.json` manifest
   version plus its SHA-256, release time, Ed25519 verification evidence, and
   allowed channel. Until then, leave `agent_release_id` unselected; do not
   invent a semantic version or reuse a fixture.
2. **Ingest protocol:** select a versioned, machine-scoped/revocable protocol
   that never puts a data-provider service-role key or shared notification
   secret on a notebook. Until its identifier and compatibility evidence are
   approved, leave `ingest_protocol_id` unselected.
3. **Cost and overage:** approve zero discretionary spend. No automatic paid
   upgrade, paid overage, tier change, or paid add-on is permitted. Unknown
   cost/capacity pauses and alerts. Vercel needs a commercial-plan decision
   before hosting can be selected.
4. **Capacity budgets:** use Neon warnings at 80 CU-hours/0.4 GB and hard stops
   at 100 CU-hours/0.5 GB per project; use R2 thresholds strictly below its
   published 10 GB-month, 1M Class A, and 10M Class B allowances until account
   metering/billing controls are evidence-backed. All optional capabilities
   remain disabled with a zero budget.
5. **Recovery:** approve the 24-hour RPO/8-business-hour RTO proposal, explicit
   retention, a daily encrypted export, and a 92-day-or-less disposable restore
   drill. Do not treat Free restore history as the complete recovery control.
6. **Smoke suite:** retain the closed IDs `schema`, `auth`, `rls`, `storage`,
   `api`, `cron`, `preview-isolation`, and `smtp`. They are recommendations for
   the future approved apply sequence only; `smtp` sends a message and must not
   run before its separate approval.
7. **Subprocessors/data/regions:** approve or reject the proposed narrow flow,
   require EU-jurisdiction R2 for new recovery artifacts, explicitly configure
   Vercel `fra1`, decide whether the non-EU processor/edge/CDN exposure is
   acceptable, and confirm domain/sender ownership for `ciphercross.dev`.
8. **Catalog mechanics:** before any JSON is authored, approve an exact
   non-self-referential JCS digest rule, add a catalog-digest verifier, decide
   how immutable official-source evidence is versioned, and repair the
   fractional-price representation. That is separate operations-contract work,
   not a reason to weaken S26 validation.

The approved local policy selects the repository-observed agent version and
machine protocol, zero discretionary spend, zero optional-capability budgets,
the stated recovery/smoke profile, and the narrow disposable-only processor
acceptance. It does not override the four unavailable facts at the top of this
document.

## Explicit actions and non-actions

- Created the owner-local configuration at
  `/Users/mykytashevchenko/.config/lh2-platform/s26-owner-runtime.json` with
  mode `0600`. It contains only non-secret values and the four closed Keychain
  labels; no Keychain value was resolved.
- No owner-runtime/provider-backed preflight or plan, apply/resume/verify,
  tenant/branch/project/bucket/domain action, provider control-plane/API/
  dashboard call, deployment, restore, source inspection, Keychain/secret
  access, email, S27/S28 work, or Git push occurred. Existing unit tests use
  deterministic fakes only and create no reusable plan.
- The seven snapshots are approved as reviewed policy inputs, but the unavailable
  hosting/residency/subprocessor entries keep the policy non-plan-eligible.

## Verification record

Focused tests validate every snapshot against the closed JSON Schema and the
recomputed canonical digest, verify exact scaled prices, and assert the four
unresolved conditions remain unavailable. The owner-local file was
loaded successfully without constructing an adapter operation or resolving a
credential. Full-suite results are recorded in the S26 handoff.
