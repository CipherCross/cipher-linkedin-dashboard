# Linked Helper campaign runtime status

## Goal

Make the dashboard a faithful read-only view of the campaign state currently observed in Linked Helper 2 on each notebook. A user should be able to open a sequence, see its deployments by notebook, distinguish Draft, Running, Queued, Sleeping, Stopped, Completed, and Archived campaigns, and understand when that state was last synchronized.

This closes the current gap where synced campaigns are broadly presented as active or running even when Linked Helper shows a different state. Linked Helper remains the authority for runtime and archive state; Sequence Builder publish state remains a separate axis.

## Non-goals

- Starting, stopping, pausing, resuming, archiving, unarchiving, renaming, deleting, or otherwise changing a Linked Helper campaign from the dashboard.
- Polling Linked Helper live from a browser request or promising sub-minute status updates. V1 uses the existing notebook sync cadence, normally up to 30 minutes.
- Treating Sequence Builder document state or publish-job state as the current Linked Helper runtime state.
- Inferring a state from recent invites, lead counts, campaign steps, publish success, or message activity.
- Collapsing Archived into a seventh runtime status. Archive membership is a separate dimension in Linked Helper.
- Automatically deleting or tombstoning a dashboard campaign merely because it is absent from a later extraction. The current sync is upsert-only; deletion/disappearance semantics require a separate design.
- Using `exclude_campaigns` as an archive filter. Excluded campaigns remain intentionally absent from all synced campaign, lead, event, step, and message data.
- Reconstructing Builder history for campaigns created directly in Linked Helper or linking them by similar names or message content.
- Rewriting historical performance data when a campaign is later stopped, completed, or archived.
- Creating production test campaigns or mutating notebooks, databases, or production state while validating the plan.

## Research findings

- The existing field travels almost end to end: `config.mapping.campaigns.status` is read by `sync-agent/agent.py`, sent through `/api/import?op=agent.ingest`, stored in `campaigns.status`, exposed through `campaign_metrics`, and copied to `SequenceHubDeployment.campaign_status`.
- That path is not trustworthy enough for product semantics. The example mapping reads `campaigns.state`, the agent replaces a missing value with `active`, and the Neon ingest upsert repeats the same `active` fallback. The contract accepts any short string rather than a normalized Linked Helper state.
- The frontend deliberately ignores `campaign_status`: `deploymentAttention()` returns `Running` for any deployment without a publish or sync problem. Consequently, Draft, Stopped, Completed, and Archived campaigns can all appear under Active sequences.
- The current Sequence Hub read model already contains the right identity and grouping primitives: one sequence can contain deployments with canonical campaign ID, notebook/account identity, publish lineage, sync freshness, and campaign metrics. The missing piece is a reliable Linked Helper status contract and consistent rendering.
- Overview already renders Active sequences. Account Detail already owns a notebook-scoped `CampaignTable`, and Campaign Detail already shows the raw status as small text. `/sequences` still needs the deployment-oriented Hub view described in the broader sequence-centric workspace plan.
- Linked Helper officially presents the runtime states Completed, Queued, Sleeping, Stopped, Draft, and Running. Archived campaigns live in a separate Archived view and can be restored, so archive membership must not overwrite the last runtime state. References: [Campaigns menu](https://support.linkedhelper.com/hc/en-us/articles/360017228839-Campaigns-menu), [Campaigns runner](https://support.linkedhelper.com/hc/en-us/articles/360016509999-Campaigns-runner), and [archive/unarchive behavior](https://support.linkedhelper.com/hc/en-us/articles/360018168939-How-to-delete-archive-a-campaign).
- `is_paused` from the publishing adapter is insufficient. It cannot distinguish a new Draft from a manually Stopped campaign and does not represent Queued, Sleeping, Completed, or archive membership. Publish verification is only a snapshot of campaign creation, not the current state after an operator uses Linked Helper.
- The exact data source behind the UI state is not yet proven for every deployed Linked Helper build. Some states depend on runner, queue, delay, and prior execution, and local SQLite schemas vary by version. A read-only canonical probe must compare candidate fields/accessors with the visible Linked Helper UI before implementation claims compatibility.
- Archived campaigns remain in `lh.db`; absence from the normal campaign list cannot safely mean deleted or archived. Archive membership needs an explicit observed signal.
- Status changes faster than the sync interval. The dashboard must say that it is showing the last observed state and expose its observation time rather than implying a live control connection.
- The portable PostgreSQL baseline is append-only. Any new campaign columns must be introduced as a new ledger artifact after step 013, with manifest, inventory, role/grant, RLS, clean-room, and provider-contract verification. `supabase/migrations/` remains frozen.
- AI and briefing instructions currently state that runtime state is unavailable because `campaigns.status` is unreliable. Those instructions must change only after the normalized contract is implemented and verified; the AI must also receive observation time and uncertainty.

## Decisions

- **Status vocabulary:** show the six original Linked Helper runtime states: Draft, Running, Queued, Sleeping, Stopped, and Completed. Preserve the product labels rather than inventing a dashboard-only lifecycle.
- **Archive model:** represent Archived separately from runtime state. An archived campaign keeps its last observed runtime value when available and receives a distinct Archived badge/filter.
- **Unknown behavior:** an absent, unsupported, contradictory, or unrecognized state is Unknown. It must never fall back to Active or Running.
- **Primary organization:** sequence first, then deployments by notebook/account. Provide a notebook filter so the same data can answer what exists on one machine without changing the canonical hierarchy.
- **Surfaces:** render the normalized state consistently on Overview, Sequence Hub/Deployments, the notebook campaign table, and Campaign Detail.
- **Archived visibility:** exclude archived campaigns from Active sequences, the default operational reply feed, and current operational totals. Keep them available under All/Archived and preserve their historical analytics, leads, messages, and drill-down pages.
- **Freshness:** V1 follows the normal notebook synchronization cadence, usually up to 30 minutes. Every state presentation exposes when it was observed; stale or unsupported data is explicitly marked instead of silently reused as current.
- **Read-only boundary:** the feature observes and displays Linked Helper state only. No status badge, filter, or detail view becomes a remote control.

## Approach

### Establish a canonical status contract

Add a normalized Linked Helper campaign-state model shared by the agent, ingest contract, data layer, and frontend:

- `runtime_status`: nullable and limited to `draft`, `running`, `queued`, `sleeping`, `stopped`, or `completed`; null renders as Unknown;
- `is_archived`: nullable boolean so unsupported archive detection is not misrepresented as false;
- `status_observed_at`: timestamp of the read-only observation used for this record;
- `status_source`: bounded diagnostic identifier for the verified accessor/compatibility profile;
- `status_raw`: bounded raw value useful for schema-drift diagnosis without making UI decisions from it.

Keep the existing `campaigns.status` field temporarily as a legacy compatibility field. New UI and AI semantics must read only the normalized fields. Do not backfill old `active` values into the normalized field; existing campaigns become Unknown until a compatible notebook sync observes them.

Add database checks for the normalized vocabulary while allowing null. This prevents a newly seen Linked Helper string from silently becoming a product status. Unknown raw values can still be recorded for diagnosis.

### Build a version-aware, fail-closed read-only extractor

Before choosing an implementation source, add or extend a read-only agent probe that inventories the exact Linked Helper build and compares the candidate runtime/archive signals with the visible UI. Verify every deployed build/account shape used by the fleet.

Prefer a Linked Helper read-only runtime accessor if it returns the same computed state and archive membership shown by the UI. Where a verified build requires SQLite derivation, use a versioned built-in compatibility profile rather than a free-form `mapping.campaigns.status` guess. Each profile must define how all six states and archive membership are obtained and include fixtures from a read-only probe.

If a build, schema, accessor, or state is unknown, continue syncing campaign facts but send normalized status as null. Do not fail the entire lead/message sync and do not substitute `active`. Record a clear partial warning on Health so an operator can see that campaign data synced while runtime state did not.

Archive detection is independently fail-closed. A valid runtime state with unknown archive membership is permitted and displayed with archive state unavailable; it must not be treated as unarchived.

### Extend ingest and persistence without losing provenance

Extend the machine ingest campaign row and its validation with the normalized fields. Validate the runtime vocabulary, nullable archive flag, ISO timestamp, bounded source, and bounded raw value before opening the transaction.

Add append-only portable schema step `014_campaign_runtime_status.sql` with the new columns and required app-machine write permissions. Update the campaign upsert to store exactly the status observation supplied by the authenticated notebook and to remove the `active` fallback from the normalized path.

Expose normalized state, archive membership, source, and observation time through `campaign_metrics`, route snapshots, and `sequences.hub`. Preserve canonical campaign identity as `instance_id:lh_campaign_id`; the same numeric LH campaign on two notebooks remains two deployments.

Do not let an older/partial payload erase a newer reliable observation. The upsert must define monotonic observation behavior: accept a normalized snapshot only when its `status_observed_at` is at least as new as the stored observation, and make an explicit null observation distinguishable from a payload produced by an older agent that lacks the fields.

### Separate runtime state, archive, publish progress, and health in the UI

Treat four concepts as separate visual axes:

1. Linked Helper runtime state: Draft, Running, Queued, Sleeping, Stopped, Completed, or Unknown.
2. Archive membership: Archived, not archived, or unknown.
3. Sequence Builder publish progress: queued, publishing, success, failed, conflict, and related job states.
4. Observation health: awaiting first sync, fresh, stale, unsupported, or agent unhealthy.

A publish success must never render as Running. A publish failure remains an attention signal but does not replace a valid Linked Helper runtime badge. Stale state keeps its last observed label with a visible stale qualifier and timestamp; completely unsupported state renders Unknown.

Define operational membership explicitly:

- Running, Queued, and Sleeping are active runtime deployments.
- Draft, Stopped, Completed, Archived, and Unknown are not included in Active sequences.
- A sequence appears in Active sequences when at least one non-archived deployment is Running, Queued, or Sleeping.
- A mixed sequence shows a factual summary such as `2 Running · 1 Draft · 1 Stopped`; it is never reduced to a misleading single Running label.
- Archived deployments are hidden by default from operational lists but available through All/Archived filters.

### Apply the model consistently to the agreed surfaces

- **Overview:** Active sequences uses normalized operational membership. Each card shows the deployment status mix, notebook/account attribution, archive exclusions, and freshness. Publish/sync attention remains visible separately.
- **Sequence Hub / Deployments:** make this the primary inventory. Group by master sequence, list one deployment row per notebook/campaign, and provide notebook, runtime-status, archive, source, and freshness filters. External Linked Helper campaigns retain the same read-only deployment presentation without fabricated Builder history.
- **Notebook campaign table:** add sortable/filterable Status and Archived columns, default to non-archived campaigns, and provide All/Archived access. The notebook context remains explicit even when the shared table is used elsewhere.
- **Campaign Detail:** replace the raw status text with the canonical runtime badge, separate Archived badge, notebook/account link, and `Observed … ago`. Show publish lineage independently when the campaign came from Sequence Builder.

Use one shared status parser, label map, badge component, operational-membership helper, and freshness helper so the four surfaces cannot drift. Preserve English Linked Helper labels in the UI for one-to-one recognition with the notebook.

### Preserve historical truth and bounded reads

Archived, stopped, and completed campaigns retain all historical campaign metrics, leads, replies, and messages. Historical/global analytics continue to include them unless a view is explicitly labeled operational. Only Active sequences, the default current reply feed, and current operational summaries apply the active/archive filters.

Keep route-local reads bounded. Sequence and Overview snapshots carry state, counts, timestamps, and reply previews; full conversations continue loading on demand by `(instance_id, profile_url)`.

After the normalized path is proven, update `SCHEMA_DOC` and briefing prompts to describe the exact observable: last synchronized Linked Helper state with observation time. AI answers must distinguish observed, stale, unknown, and archived state and must never imply it changed the notebook.

## Implementation phases

1. **Canonical notebook status probe (M)** — Add a read-only probe, inventory each supported Linked Helper build, compare extracted values with the visible UI for all reachable runtime states and archive membership, and save compatibility fixtures. Finish with a go/no-go table per build; unsupported builds remain Unknown.
2. **Normalized schema and ingest contract (M)** — Add portable ledger step 014, normalized campaign fields and checks, machine grants, ingest validation, monotonic observation upsert behavior, agent payload support, Health partial warnings, and compatibility tests. Deploy no production schema or agent release without the normal approval flow.
3. **Read models and shared semantics (M)** — Extend `campaign_metrics`, route snapshots, and `sequences.hub`; add shared TypeScript types/helpers for runtime, archive, operational membership, mixed-sequence summaries, and freshness; remove `campaign_status` blindness from attention logic without conflating publish errors.
4. **Four-surface read-only UI (L)** — Update Overview, Sequence Hub/Deployments, notebook CampaignTable, and Campaign Detail with shared badges, timestamps, notebook/status/archive filters, mixed deployment summaries, responsive states, and accessible labels.
5. **AI, regression coverage, and staged rollout (M)** — Update schema/prompt documentation, run agent/API/schema/frontend tests, release to one compatible notebook, compare dashboard state with Linked Helper across at least Draft/Running/Stopped/Archived plus any naturally available Queued/Sleeping/Completed states, then expand one notebook at a time. Verification remains read-only and does not manufacture production campaigns solely to obtain a state.

## Affected files/modules

- `sync-agent/agent.py`
- `sync-agent/config.example.yaml`
- New and existing sync-agent fixtures/tests under `sync-agent/tests/`
- `frontend/api/_lib/agent/ingest.ts`
- `frontend/api/_lib/data/operations/agentIngest.ts`
- `frontend/api/_lib/data/operations/sequenceHub.ts`
- `frontend/api/_lib/data/operations/routeSnapshots.ts`
- `frontend/api/_lib/data/operations/dashboard.ts`
- `frontend/api/_lib/core.ts`
- `frontend/api/briefing.ts`
- `frontend/src/lib/types.ts`
- `frontend/src/lib/sequenceHub.ts`
- A new shared campaign-status helper/component under `frontend/src/lib/` and `frontend/src/components/`
- `frontend/src/components/overview/ActiveSequences.tsx`
- `frontend/src/pages/Overview.tsx`
- `frontend/src/pages/SequenceBuilder.tsx` and Sequence Hub/Deployments components
- `frontend/src/components/CampaignTable.tsx`
- `frontend/src/pages/AccountDetail.tsx`
- `frontend/src/pages/CampaignDetail.tsx`
- `frontend/src/styles.css`
- `postgres/tenant-baseline/v1/014_campaign_runtime_status.sql`
- `postgres/tenant-baseline/v1/ledger.manifest.json`
- Portable baseline inventory, clean-room, provider-contract, ingest, route-snapshot, Sequence Hub, Overview, CampaignTable, Campaign Detail, accessibility, and responsive UI tests

## Risks & how to verify

- **The database field is not the UI state:** compare the read-only probe with the visible Linked Helper campaign list on every supported build and account. Do not enable a profile based only on a plausible column name.
- **Archive is confused with runtime:** test an archived campaign that retains a prior runtime value; assert both values survive ingestion and render as separate badges/filters.
- **Unknown silently becomes active:** cover missing mapping, unknown raw strings, unsupported builds, contradictory signals, absent archive data, and old-agent payloads. Every case must remain Unknown or archive-unknown, never Active/Running.
- **Publish state overwrites runtime state:** fixture a successful publish with Draft, Stopped, Running, and Unknown LH snapshots. Assert publish and runtime badges remain independent.
- **Older sync regresses newer truth:** submit status observations out of order and assert the newest timestamp wins. Retry the same idempotency key and verify no change.
- **Mixed deployments produce a false sequence label:** test one sequence deployed to multiple notebooks with different states, including archived and stale rows. Assert the summary contains the factual mix and Active membership depends on at least one active non-archived deployment.
- **Archived data disappears from history:** verify archived campaigns are absent from operational defaults but remain accessible through All/Archived, Campaign Detail, historical metrics, leads, replies, and full conversations.
- **Stale data looks live:** advance the clock beyond the agreed sync window and assert the previous state remains labeled stale with its observation time. Never refresh the timestamp merely because a dashboard query ran.
- **Schema drift breaks the entire sync:** simulate an unsupported status accessor and verify campaign/leads/messages still sync while the status section reports a partial warning.
- **Cross-notebook identities merge:** use the same LH campaign number and LinkedIn profile on two instances; verify campaign IDs, deployments, filters, and conversations remain instance-scoped.
- **Overview or Hub queries become unbounded:** enforce bounded deployment/count/reply-preview payloads and continue fetching full threads on demand.
- **Permission or RLS regression:** test active-member reads, machine-scoped writes, foreign-instance rejection, revoked credentials, signed-out behavior, and the absence of any runtime mutation operation.
- **Portable baseline divergence:** run manifest/hash inventory, clean-room tenant creation, role/grant/RLS checks, provider-contract tests, and `npm run typecheck:api` before any controlled database rollout.
- **UI inconsistency:** exercise the same campaign through all four surfaces and assert identical labels, archive semantics, notebook attribution, timestamps, filters, accessible names, and desktop/mobile behavior.
- **Production verification overclaims freshness:** report agent release, schema readiness, successful sync, and authenticated UI proof separately. A correct screenshot is still only a snapshot at its displayed observation time.

## Definition of done

- Every compatible notebook sync supplies a normalized runtime state limited to Draft, Running, Queued, Sleeping, Stopped, or Completed, plus independent archive membership and observation time.
- Unsupported or unrecognized Linked Helper state renders Unknown and never falls back to Active or Running.
- Sequence Builder publish progress and Linked Helper runtime state are stored and displayed as separate concepts.
- Overview shows only sequences with at least one non-archived Running, Queued, or Sleeping deployment under Active sequences and displays truthful mixed-deployment summaries.
- Sequence Hub groups by sequence, lists deployments by notebook/account, and filters by notebook, runtime status, and archive membership.
- The notebook CampaignTable and Campaign Detail display the same canonical badges and observation freshness as Overview and Sequence Hub.
- Archived campaigns are excluded from default operational views and current operational totals but remain available through All/Archived with historical metrics, leads, replies, and conversations intact.
- Every status presentation says when the state was observed and visibly marks stale or unsupported information.
- A verified compatibility matrix exists for each enabled Linked Helper build; unverified builds fail closed for status without breaking the rest of synchronization.
- AI and briefings describe runtime state only as last synchronized Linked Helper evidence, including stale/unknown limitations.
- Automated coverage passes for extraction, validation, monotonic upsert, RLS, read models, mixed deployments, archive semantics, filters, accessibility, and responsive rendering.
- Local checks, portable schema checks, controlled one-notebook rollout, and authenticated read-only UI comparison are reported separately.
- No campaign, notebook runner, archive state, lead assignment, or production test data is changed by this feature or its verification.
- Implementation is delivered in logical commits with unrelated work preserved.
