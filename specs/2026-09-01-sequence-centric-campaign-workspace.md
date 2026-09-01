# Sequence-centric campaign workspace

## Goal

Make sequences the main operating object of the dashboard without replacing Overview as the home page. The top of Overview should answer what is running, where it is running, what needs attention, and where new replies arrived. Sequence Builder should become a primary navigation item and evolve into a unified Sequence Hub where the team can author a master sequence, inspect its deployments across LinkedIn accounts/notebooks, read leads and replies, and evaluate performance.

The same visual model must also cover campaigns created directly in Linked Helper 2. They should appear automatically after sync as externally sourced sequence cards, with their synced steps, leads, replies, and performance available even though they do not have Builder authoring history.

One master sequence remains the source of truth. A specific notebook/account may override any individual message, including replacing the whole message, without creating a second sequence or misusing A/B/C branches.

## Non-goals

- Replacing Overview with Sequence Builder or removing the global business summary.
- Turning A/B/C branches into account/persona overrides. Branches remain alternative sequence variants; notebook overrides are a separate axis.
- Introducing fixed CEO, SDR, founder, or other role profiles. Overrides are attached to a concrete notebook/account so future profiles require no schema change.
- Building a normalized company/employer CRM. In this plan, “old companies” is interpreted as old **campaigns**; lead company names remain filterable display data.
- Reconstructing missing Builder drafts, comments, branches, version history, delays, or authoring intent from Linked Helper telemetry.
- Editing a Linked Helper campaign remotely from the dashboard or reverse-syncing changes into an externally created campaign.
- Automatically starting campaigns, adding leads, or changing notebook state as part of browsing the new UI.
- Adding a general conditional-template language. V1 supports base text plus explicit per-notebook message overrides and the existing recipient variables.
- Deleting historical ICP, hypothesis, or campaign-context data. Their standalone navigation is retired, but existing records remain readable for compatibility, AI, and briefings until a later migration is explicitly approved.
- Creating production test campaigns or mutating existing production campaigns during implementation or verification without separate permission.

## Research findings

### Current product gaps

- `Overview.tsx` leads with global KPIs, operational notices, account cards, and a global funnel. Account and campaign cards then repeat many of the same lead, invite, acceptance, reply, and P3 numbers. The page describes the fleet but does not make the sequence the operating unit or show what deserves attention now.
- `CampaignDetail.tsx` already receives campaign-scoped leads and latest/intent-bearing inbound messages from the route snapshot, but does not render a lead/reply workspace. It instead repeats KPI cards, funnel, cohort, demographics, additions, message sequence, lag charts, and activity. To read a conversation, the user must leave the campaign and find the lead elsewhere.
- `LeadsExplorer.tsx` already has the useful primitives the campaign page lacks: campaign filtering, reply snippets, sentiment/intent, company labels, and the global `ConversationDrawer`. These should be extracted and reused rather than reimplemented.
- Full conversations are correctly loaded on demand by `(instance_id, profile_url)`. Campaign and sequence snapshots should keep only summary/snippet data so the dashboard does not regress to loading every message body.
- The Sequence Builder library currently describes only authored documents. Deployment jobs are visible only after opening an editable sequence, and job status labels have drifted from the persisted status vocabulary. The page therefore cannot reliably answer which sequence/revision/branch is live on which account.
- Existing publish jobs already preserve the immutable document snapshot, revision, target instance/account, selected branch, resulting LH campaign ID, and action chain. A live Builder deployment can be joined to the synced campaign using `target_instance_id + ':' + lh_campaign_id`; the missing layer is a coherent read model and UI.
- Synced `campaign_steps` contain enough data to show a readable externally sourced sequence and per-step counts. They do not contain the original Builder document, comments, branches, precise authoring history, or necessarily all timing details.
- The current Builder variables include recipient and sender-name values, but the publish compiler has no safe model for account-specific full-message changes. Using branches for this would mix two independent questions: “which copy are we testing?” and “which sender/account is this written for?”
- ICPs, hypotheses, and free-text campaign briefing context overlap conceptually but live in separate areas. They are used by AI/coaching/briefings, while the authoring and publishing workflow does not require the team to look at them. This explains why the visible sections feel like documentation storage rather than part of daily work.
- Funnel metrics are milestone-based and replies mature over days or weeks. Sequence comparisons must use invite cohorts and show cohort maturity; same-period invites divided by same-period replies would be misleading.

### Product patterns worth borrowing

- [HubSpot sequence analytics](https://knowledge.hubspot.com/sequences/analyze-sequence-enrollment-and-performance-data) keeps sequence performance, sender/company filters, and contact-level enrollment detail within the sequence context.
- [Apollo's sequence overview](https://knowledge.apollo.io/hc/en-us/articles/4409237165837-Sequences-Overview) and [sequence reporting](https://knowledge.apollo.io/hc/en-us/articles/9386141889549-Report-on-Sequences) make contacts and performance drilldowns part of the sequence workflow instead of treating the sequence as copy alone.
- [Outreach step analytics](https://support.outreach.io/support/solutions/articles/159000425630-sequence-step-analytics-email) supports inspecting results at the individual step level, which maps naturally to the existing synced `campaign_steps` data.
- Sender variables such as `sender.title` exist in products like [Outreach](https://support.outreach.io/support/solutions/articles/159000425990-outreach-variables-overview), while products such as [Apollo](https://knowledge.apollo.io/hc/en-us/articles/4409494161677-Use-Custom-Dynamic-Variables) also support custom variables. For this product, an explicit notebook override is safer and more understandable than adding role conditionals because the user sometimes needs to replace an entire message.

## Decisions

- Overview remains `/` and the home page. Its upper section becomes sequence-centric; global analytics remain available below it in a compact form.
- Sequence Builder moves from the collapsed Strategy group into primary navigation and becomes the Sequence Hub.
- A sequence detail has four stable work areas: **Build**, **Deployments**, **Leads & replies**, and **Performance**.
- A campaign detail is a deployment drilldown, not a second analytics dashboard. Its default view is **Leads & replies**, followed by **Performance** and **Sequence**.
- The canonical model is one master sequence with zero or more deployments. Different branches or notebook overrides do not create duplicate master-sequence cards.
- A notebook override is keyed to a concrete instance/account and a stable message variation ID. It stores a complete replacement message, not a character diff. An unmodified message inherits the base text.
- Override precedence is: immutable base sequence revision → notebook-specific variation replacement → existing recipient/sender token resolution. Publishing stores the effective snapshot so an old deployment stays reproducible even after the base or override changes.
- A/B/C branches remain copy-selection variants. The deployment matrix shows branch and notebook override independently.
- Campaigns created directly in Linked Helper appear automatically after sync in the same card shell as Builder sequences. They carry a visible **Linked Helper source** badge and are read-only as authoring sources.
- An external campaign can later be explicitly converted into a new editable master sequence. Conversion copies the currently synced steps into a new Builder draft and records lineage; it never silently fabricates Builder history or merges unrelated campaigns by similar text.
- The Sequence Hub uses one union read model rather than inserting fake editable sequence documents for every external campaign. A synced campaign with no Builder linkage is an external item; a published/linked campaign is a deployment under its master sequence.
- A compact **Campaign brief** lives with the master sequence and contains audience, offer, hypothesis, source/search context, and notes. It is visible while writing and inherited by deployments.
- ICPs and Hypotheses are removed from visible primary/Strategy navigation. Existing routes and data remain available for compatibility during the first release, and existing references can be surfaced inside Campaign brief rather than forcing a separate workflow.
- Existing `CampaignBriefingContext` is displayed as legacy deployment context and can be folded into the master Campaign brief only through an explicit migration/linking action.
- All active members can view the Sequence Hub, deployments, leads, replies, and performance. Existing edit permissions remain; publishing and other machine-affecting actions stay admin-only.

## Approach

### 1. Introduce a unified sequence read model

Add a route-local `sequenceHub` operation that returns two item kinds through one UI contract:

- **Managed sequence** — Builder document metadata plus current revision, branch summary, publish/deployment lineage, joined live campaigns, account/notebook identity, sync freshness, aggregate metrics, and newest reply preview.
- **External sequence** — synced campaign plus ordered `campaign_steps`, instance/account identity, sync freshness, aggregate metrics, and newest reply preview, with no claim of editable Builder history.

For Builder deployments, derive the initial association from immutable publish branch/job data and the canonical campaign ID. Add a small append-only `campaign_sequence_links` domain only where durable state is required: explicit external-to-Builder conversion/linking, source attribution, and idempotent duplicate prevention. One campaign can link to at most one master sequence; a master sequence can have many campaigns/deployments.

The API should normalize publish states to the actual persisted vocabulary (`queued`, `claimed`, `preflight`, `publishing`, `success`, `partial_failure`, `conflict`, `failed`). The UI polls only while a job is non-terminal and then refreshes both deployment and campaign linkage.

### 2. Redesign the top of Overview around active sequences

The first viewport should contain:

1. **Active sequences** — compact cards/rows showing sequence name, source, deployed accounts, branch/override indicators, campaign state, leads, replies/P3, last sync, and an attention state.
2. **New replies** — the newest unread/unreviewed inbound replies across active deployments with lead, company label, sender account, sequence/campaign attribution, snippet, and one-click conversation opening.
3. **Primary actions** — open Sequence Hub, create sequence, and continue a draft. Machine-changing publish actions remain inside the sequence flow rather than becoming an unsafe Overview shortcut.
4. **Compact global summary** — the small set of portfolio KPIs still needed to understand overall health.

Account cards become a secondary fleet-health section instead of repeating a miniature dashboard per account. The global funnel and detailed historical charts move below the operational section under an Analytics heading. Duplicate campaign KPIs are removed from Overview when the same information is already available on the sequence card or deployment detail.

The Overview query must return bounded aggregates and reply previews, not complete lead/message collections.

### 3. Make campaign detail useful for daily reply work

Refactor the reusable parts of Leads Explorer into a campaign/sequence-scoped leads-and-replies workspace. The campaign header shows its master sequence and deployment metadata, or **Created in Linked Helper** if external.

The default **Leads & replies** tab includes:

- filters for All, Replied, P3, Needs follow-up, and No reply;
- lead identity, company label, current milestone, latest reply snippet/time, sentiment, intent, and follow-up state;
- sender account/notebook and explicit campaign attribution;
- opening the existing full `ConversationDrawer` without leaving the page;
- URL-persisted filters so a reply or segment can be shared and reopened.

The **Performance** tab keeps compact KPIs, mature-cohort conversion, step results, and activity where it informs a decision. Demographics, additions, lag charts, and other diagnostic blocks move into a collapsed/secondary Analyze area instead of competing with reply work. The repeated funnel/KPI combinations are reduced to one canonical presentation.

The **Sequence** tab shows the exact deployed Builder revision, selected branch, and notebook override differences. For an external campaign it shows synced Linked Helper steps and counts with the source limitation clearly stated.

Campaign-to-campaign comparison moves to the parent sequence's Deployments/Performance tabs, where the compared campaigns share context.

### 4. Turn Sequence Builder into the Sequence Hub

Keep the library/editor route, but make every card operational. A card shows:

- Builder or Linked Helper source;
- draft/active/paused/attention state derived from deployments rather than an ambiguous document status;
- deployment/account count and account avatars/names;
- current branch and notebook-override indicators;
- leads, replies, P3, mature-cohort rate, and newest reply;
- last sync/publish state and direct navigation to the relevant work area.

Opening a managed sequence exposes:

- **Build** — existing authoring, branches, comments, preview, autosave, and Campaign brief;
- **Deployments** — a matrix grouped by account/notebook and live campaign, showing selected branch, override state, published revision, campaign status, sync freshness, counts, and errors;
- **Leads & replies** — the reusable workspace aggregated across linked deployments, with deployment/account filters and source labels;
- **Performance** — sequence-level mature cohorts, step performance, and comparisons across deployments, branches, and account overrides.

Opening an external item uses the same shell, defaults to Leads & replies, replaces Build with a read-only synced-sequence view, and offers **Create editable master**. Once converted and linked, it becomes a managed sequence with the original external campaign shown as a deployment, preventing duplicate cards.

Sequence-level lead identity remains `(instance_id, profile_url)`. The same LinkedIn person contacted from two accounts remains two explicit account-scoped conversations. Aggregation must show the deployment source and avoid accidental cross-account thread merging.

### 5. Add notebook-specific message overrides

Persist overrides in an append-only schema domain keyed by sequence document, target instance/account, and stable variation ID, with its own revision/concurrency check. Each row/document records the full replacement text, editor, timestamp, and the base sequence revision against which it was last reviewed.

In Build, an **Account versions** control lets the user select a notebook and then:

- inherit the base message by default;
- choose **Override for this account** on any variation;
- replace part or all of the message using the same token validation and preview;
- compare effective text with the base;
- reset to base;
- see **Base changed — review override** when the underlying variation changed after the override was last reviewed.

Deleting or changing stable variation IDs must not silently redirect an override. A missing target becomes an explicit stale override that blocks publishing for that account until it is remapped, removed, or reviewed.

The publish review shows base revision, branch, every applied notebook override, and the final effective message chain. The immutable publish job/branch snapshot stores enough data to reproduce exactly what was sent to Linked Helper.

### 6. Fold strategy context into Campaign brief

Add a compact brief alongside sequence authoring with five optional fields: audience, offer, hypothesis, source/search, and notes. It should be quick enough to complete while writing, not a mandatory strategy form.

Existing ICP/hypothesis records can be linked as references and summarized into these fields, but the sequence workflow does not depend on maintaining standalone records. Remove ICPs and Hypotheses from visible navigation in the same release. Preserve their routes, data, and API contracts while AI briefings/coaching still consume them; mark them legacy in code and documentation so a later cleanup can measure whether any dependencies remain.

Briefing and coaching should receive the master Campaign brief plus clearly attributed legacy context. Do not present a hypothesis or note as measured evidence.

### 7. Migration and rollout behavior

No backfill is required merely to display old campaigns: the union read model makes every unlinked synced campaign appear automatically as an external item. This also covers any future campaign created directly in Linked Helper after the next successful sync.

Builder-published campaigns are matched deterministically from their immutable publish lineage. If a publish succeeded but the LH campaign has not synced yet, the deployment remains visible as **Awaiting sync** rather than temporarily appearing external or disappearing.

Explicit conversion/linking must be idempotent and preserve source metadata. Ambiguous historical matches based only on names or message similarity are never auto-linked; they remain external until a human selects the relationship.

### Alternatives considered

- **Make Sequence Hub the home page:** rejected; Overview remains the cross-account home and becomes sequence-centric at the top.
- **Create a separate sequence per sender role:** rejected because roles will expand and this duplicates the master offering.
- **Use A/B/C branches for account wording:** rejected because experimentation and sender adaptation are independent dimensions.
- **Store text diffs for overrides:** rejected because whole-message rewrites are common and diffs are brittle when the base changes.
- **Insert a fake editable Builder document for every LH2 campaign:** rejected because telemetry cannot recreate authoring history. The shared card/read model provides visual consistency without false provenance.
- **Add a company/employer workspace now:** deferred. Lead company is currently raw text; normalizing company identity is a separate product/data-model decision and is not necessary to make campaign conversations usable.

## Implementation phases

1. **Shared contracts and deployment read model (L)** — Normalize publish statuses; add the route-local Sequence Hub/Overview operations; join publish lineage to live campaigns; define managed/external item contracts; add durable campaign-to-sequence linkage only for explicit conversion; update schema documentation and provider-contract tests.
2. **Campaign Leads & replies redesign (L)** — Extract reusable lead/reply list and filters from Leads Explorer; make it the campaign default; integrate `ConversationDrawer`; add deployment/source header; consolidate existing performance blocks into tabs and secondary analysis.
3. **Sequence-centric Overview and navigation (M)** — Move Sequence Builder to primary navigation; remove ICP/Hypothesis navigation entries; build Active sequences, New replies, primary actions, compact global summary, and secondary account fleet health; keep reads bounded.
4. **Sequence Hub cards and Deployments tab (L)** — Render managed and external cards in one shell; add deployment matrix, status polling/refresh, awaiting-sync handling, external read-only steps, and campaign drilldowns.
5. **Notebook-specific overrides (L)** — Add append-only persistence, revision/conflict handling, account-version editor, base-change warnings, diff/effective previews, compiler precedence, publish review, and immutable effective snapshots.
6. **Sequence-level Leads & replies and Performance (L)** — Aggregate the reusable workspace across deployments; add account/branch/override filters, explicit attribution, mature-cohort metrics, step analytics, and safe comparisons.
7. **Campaign brief and legacy strategy transition (M)** — Add the compact brief to Build; feed it to coaching/briefings with attribution; expose optional legacy ICP/hypothesis references; document and test hidden-but-compatible legacy routes.
8. **External conversion and rollout verification (M)** — Add idempotent Create editable master/linking; test automatic appearance of new direct-LH2 campaigns; perform desktop/mobile/accessibility QA, provider/schema checks, builds, and authenticated read-only production verification. Any production data mutation remains separately approved.

Phases 1–4 deliver the main navigation, Overview, old-campaign cards, and conversation workflow before the more invasive override/compiler work. Phases 5–7 can then ship behind focused feature flags if needed.

## Affected files/modules

- `frontend/src/lib/navigation.ts`
- `frontend/src/App.tsx`
- `frontend/src/pages/Overview.tsx`
- `frontend/src/pages/SequenceBuilder.tsx`
- `frontend/src/pages/CampaignDetail.tsx`
- `frontend/src/pages/LeadsExplorer.tsx`
- `frontend/src/components/ConversationDrawer.tsx`
- `frontend/src/components/MessageSequence.tsx`
- Existing and new `frontend/src/components/sequence-builder/**` modules
- New shared `frontend/src/components/leads-and-replies/**` modules
- `frontend/src/lib/types.ts`
- `frontend/src/lib/leads.ts`
- Sequence document/compiler/publish helpers under `frontend/src/lib/**`
- `frontend/src/lib/dashboardReads.ts` and route-local data hooks
- `frontend/api/sequence-builder.ts`
- `frontend/api/_lib/core.ts`
- `frontend/api/_lib/data/operations/routeSnapshots.ts`
- `frontend/api/_lib/data/operations/**` Sequence Hub, Overview, linking, conversion, and override operations
- Current publishing operations and contracts under `frontend/api/_lib/**`
- New append-only files under `postgres/tenant-baseline/v1/ledger/` and `ledger.manifest.json`
- `frontend/src/styles.css`
- Navigation, route snapshot, sequence publishing, override, conversion, cohort, authorization, accessibility, and responsive UI tests

## Risks & how to verify

- **False Builder provenance for old campaigns:** verify every external card and sequence view carries its Linked Helper source; ensure conversion creates a new draft and preserves lineage instead of inventing history.
- **Duplicate or disappearing cards:** cover linked, unlinked, awaiting-sync, partial-failure, conflict, renamed campaign, and explicit-conversion cases. Enforce one active link per canonical campaign ID and idempotent conversion.
- **Incorrect publish association:** join only through immutable job/branch target data and canonical campaign IDs; never auto-link from campaign name or approximate message similarity.
- **Override applied to the wrong message:** key by stable variation ID; test reorder, branch changes, deletion, copy, restore, and base edits. Missing/stale mappings must fail closed before publish.
- **Lost concurrent override edits:** require revision-aware writes and simulate two clients editing the same account version.
- **Published content cannot be reproduced:** assert that publish review and stored snapshots contain base revision, branch selections, effective overridden bodies, target account, and compiled action chain.
- **Metrics double-count the same person or mix conversations:** test `(instance_id, profile_url)` scoping, multi-campaign history, cross-account duplicates, and explicit deployment attribution.
- **Misleading performance comparisons:** test invite-cohort denominators, maturity labels, incomplete recent cohorts, zero-denominator states, and branch/override segmentation.
- **Overview performance regression:** enforce bounded result sizes and query budgets; load only aggregate counts/latest reply previews and continue fetching full threads on demand.
- **Unread/new reply ambiguity:** define the first release as newest inbound replies needing attention using existing durable message/follow-up state; do not invent a read receipt if none exists. Add a true per-user read model only if product usage proves it necessary.
- **Legacy context silently lost:** confirm ICP/hypothesis routes remain directly accessible, current AI/briefing queries keep working, and Campaign brief fields are attributed separately from measured data.
- **Permission regression:** test active-member reads, existing authoring permissions, admin-only publish/conversion where machine-affecting actions occur, signed-out behavior, and direct API calls.
- **UI becomes another dense dashboard:** visually verify the first viewport, information hierarchy, empty/loading/error states, long sequence names, many deployments, desktop/mobile layout, keyboard navigation, and drawer focus return.
- **Schema/provider drift:** run portable baseline clean-room creation, ledger inventory/hash checks, API provider-contract tests, SQL validation, frontend build, and `npm run typecheck:api` before any release.
- **Production verification overclaims success:** distinguish local tests/build, deployed HTTP readiness, authenticated read-only UI verification, and any separately authorized live publish/write test.

## Definition of done

- Overview remains the home page and its first viewport shows active sequences, their account/deployment state, attention items, and newest replies, with a compact global summary and no repeated mini-dashboards.
- Sequence Builder is a primary navigation destination; ICPs and Hypotheses are absent from visible navigation without breaking their existing data consumers.
- Every synced campaign appears in the Sequence Hub: Builder-linked campaigns under their one master sequence, and direct/legacy Linked Helper campaigns as clearly labeled external cards.
- A newly created Linked Helper campaign appears automatically after sync without a manual backfill or fake Builder document.
- A managed sequence exposes Build, Deployments, Leads & replies, and Performance; an external item uses the same shell with a read-only synced sequence and an explicit conversion path.
- Campaign detail opens on a useful lead/reply list, supports the agreed filters, shows latest reply/intent/context, and opens the full conversation without leaving the campaign.
- The same leads/replies workspace works across all deployments of a sequence with clear account and campaign attribution.
- A master sequence can override any individual message for a concrete notebook/account, including a full rewrite, while every other message inherits the base.
- The UI shows base versus effective text, detects stale overrides, supports reset-to-base, and blocks ambiguous publishing.
- Published deployments preserve the exact base revision, branch, account overrides, and effective action chain needed for audit and reproduction.
- Deployment and sequence performance uses mature invite cohorts, avoids cross-account thread merging, and exposes step-level results where available.
- Campaign brief is available inside sequence authoring and feeds existing AI/briefing context with provenance; legacy context is preserved rather than silently deleted.
- Route-local reads remain bounded, full threads load on demand, and the new UI has focused automated coverage plus desktop/mobile/accessibility visual QA.
- No production campaign, lead assignment, notebook state, or historical Builder record is mutated without explicit approval.
- The implementation is delivered in independently reviewable logical commits with unrelated user changes preserved.
