# Sequence Builder publishing to Linked Helper 2

## Goal

Add an approval-gated flow that compiles selected Sequence Builder branches into
separate, empty Linked Helper 2 campaigns on one selected Windows machine/account.
Every created campaign must be explicitly paused, read back, and verified before a
publish branch is reported as successful. Nothing in this feature may add targets,
start a campaign, or start the global campaign runner.

This specification is based on read-only repository, fixture, and external-reference
research. Implementation, database changes, agent release, and Linked Helper pilot
writes require a separate explicit approval.

## Non-goals

- Arbitrary Linked Helper Action builder.
- Adding leads or Queue targets.
- Starting or unpausing campaigns.
- Publishing to multiple physical machines in the MVP.
- Updating, renaming, archiving, or deleting existing Linked Helper campaigns.
- CSV generation/import as the primary transport.
- Traffic allocation, A/B analytics, or campaign execution from Sequence Builder.
- Copying or embedding AGPL-licensed `lhremote` code in the proprietary agent.

## Research findings

### Existing Sequence Builder

- `SequenceDocument v1` stores connection/message steps, variations, branches, and
  sample data. It does not contain workflow, delay, target-machine, or publish-job
  metadata.
- A branch has a stable ID and selects one variation for each sequence step.
- The first Connection Request is structurally retained and may have empty text.
  Ordinary follow-up messages may currently be empty in the editor, but publishing
  must reject them because Linked Helper may treat an empty Message action as invalid.
- Autosave uses optimistic revision control and immutable version snapshots. A
  publish job can therefore capture a stable version without reading a later mutable
  document revision.
- Human Sequence Builder actions are already multiplexed through `/api/playbook`.
  New human publish operations should use the same endpoint rather than adding a new
  top-level Vercel function.
- `campaign_steps` is synchronized LH2 telemetry and must not be reused as an editable
  workflow or publish-job store.
- Sequence persistence is in append-only migration 011. Publishing requires a new
  append-only step; migration 011 must not be edited.

Relevant modules:

- `frontend/src/lib/sequenceBuilder.ts`
- `frontend/src/pages/SequenceBuilder.tsx`
- `frontend/api/_lib/sequenceBuilder.ts`
- `frontend/api/_lib/data/operations/sequences.ts`
- `frontend/api/playbook.ts`
- `postgres/tenant-baseline/v1/011_sequence_builder_workspace.sql`

### Existing Windows-agent and machine authentication

- Machine bearer authentication already checks credential ID, secret hash, tenant,
  expiry, and revocation, and binds the actor to one `instanceId`.
- `/api/import?op=...` already multiplexes machine operations and fails closed for
  unknown operations.
- `agent.config` is an existing authenticated polling precedent.
- The ingest path already demonstrates digest-based idempotency: replaying the same
  key and payload is safe, while reusing a key for a different payload conflicts.
- Windows installations use separate per-account profiles, task roots, and machine
  credentials.
- The current agent is an outbound, one-shot CLI. It has no publish worker, claim,
  lease, heartbeat, or result operations.
- The existing scheduled task runs `sync` every 30 minutes. That cadence is unsuitable
  for responsive per-branch publish progress.
- Dashboard instances identify an account/profile but do not currently provide a
  durable physical-machine group, Linked Helper internal account ID, LH build, CDP
  port, database-schema fingerprint, or action capability report.

Relevant modules:

- `frontend/api/_lib/agent/machineAuth.ts`
- `frontend/api/_lib/agent/machineOps.ts`
- `frontend/api/import.ts`
- `sync-agent/agent.py`
- `sync-agent/installer/install.py`
- `sync-agent/install-windows.ps1`
- `postgres/tenant-baseline/v1/009_machine_ingest_path.sql`

### Fixture evidence

The source fixture is read-only:

`/Users/mykytashevchenko/Downloads/linked-helper-campaign-settings-fixture.csv`

Observed SHA-256:

`133c172ff0c918c87a0e8262e7c08e3f6a601f890f42c44c576dceb79f04ea21`

It contains 75 columns and two checksum-like values whose generation algorithm is not
established. Its settings confirm this chain:

1. `VisitAndExtract`
2. `Follow`
3. `Waiter` (24 hours)
4. `InvitePerson`
5. `FilterContactsOutOfMyNetwork`
6. `Waiter` (24 hours)
7. `MessageToPerson`
8. `CheckForReplies` (172800000 ms)
9. `MessageToPerson`
10. `CheckForReplies` (`moveToSuccessfulAfterMs = null`)

The fixture also confirms AST variables `firstName`, `company`, and `position`, plus
the requested invite/message/filter flags, cooldowns, and per-iteration limits.

### Transport comparison

#### Generated CSV import

Advantages:

- Official Linked Helper import/export workflow.
- Imported settings intentionally do not transfer Queue targets.
- Linked Helper performs its own UI-side validation.

Limitations:

- Depends on the Multi-campaigns runner and Linked Helper version.
- Fixture includes opaque checksum-like fields.
- Requires file and visible-UI orchestration.
- No generated-file round-trip has been proven for the pilot version.

Decision: use the fixture as a semantic test oracle only. CSV may become a fallback
only after a generated export/import/export round-trip succeeds on the exact pilot
build and produces a semantically equivalent campaign.

#### Visible UI automation

Advantages:

- Exercises supported user-visible validation.
- Avoids guessed direct database repair.

Limitations:

- Sensitive to selectors, localization, layout, workspaces, and modal timing.
- Requires an unlocked foreground interactive session.
- Difficult to recover exactly once after an ambiguous timeout.
- Precise canonical readback and reconciliation are cumbersome.

Decision: retain as an operator-assisted fallback and pilot acceptance tool, not the
primary production worker.

#### CDP and internal UI API

`lhremote` demonstrates that an already-running Linked Helper Electron renderer can be
controlled with `Runtime.evaluate`, that its internal `createCampaign()` can receive
empty targets plus Action configurations, and that created campaigns can be read back.
Its tested build may leave `campaigns.is_valid = NULL` and action-level exclude-list
IDs empty; `lhremote` corrects those fields using direct transactions in `lh.db`.

This behavior is evidence for the tested `lhremote`/Linked Helper combination only.
Internal service discovery and module names have already drifted across Linked Helper
builds. A compatibility gate on the actual pilot machine is mandatory.

`lhremote` is AGPL-3.0-only. The project may be used as evidence of publicly observable
behavior, but its implementation and schema-write logic must not be copied into this
agent. Running it unchanged as a separate process requires legal review; commercial
licensing from its author is another option.

Decision: independently implement a minimal CDP adapter limited to capability probing,
account discovery, campaign creation, campaign-scoped pause, and canonical readback.
Prefer internal application APIs. Permit any direct SQLite compatibility repair only
behind an exact verified LH version/schema profile, after a separate technical and
legal/support approval.

CDP must bind to `127.0.0.1` only. Never enable `allowRemote`, port forwarding, or
external interfaces. Logs must not include credentials, Electron store contents, raw
database dumps, message bodies, or sensitive CDP expressions.

External references:

- Linked Helper campaign copy/import guide:
  https://support.linkedhelper.com/hc/en-us/articles/360019349660-How-to-duplicate-clone-a-campaign-or-copy-it-to-another-LinkedIn-account
- Linked Helper Workflow guide:
  https://support.linkedhelper.com/hc/en-us/articles/360016470720-Workflow
- lhremote CDP ADR:
  https://github.com/alexey-pelykh/lhremote/blob/fad665ded659286cd5fc15763e5625f79e0be862/docs/adr/002-cdp-automation-via-electron.md
- lhremote direct-SQL ADR:
  https://github.com/alexey-pelykh/lhremote/blob/fad665ded659286cd5fc15763e5625f79e0be862/docs/adr/003-sqlite-direct-file-access.md
- lhremote campaign service and correction logic:
  https://github.com/alexey-pelykh/lhremote/blob/fad665ded659286cd5fc15763e5625f79e0be862/packages/core/src/services/campaign.ts
  https://github.com/alexey-pelykh/lhremote/blob/fad665ded659286cd5fc15763e5625f79e0be862/packages/core/src/db/repositories/campaign.ts
- lhremote security model:
  https://github.com/alexey-pelykh/lhremote/blob/fad665ded659286cd5fc15763e5625f79e0be862/SECURITY.md

## Decisions

- One selected branch produces one separate Linked Helper campaign.
- Campaign names use the sequence name and stable document-order branch letter.
  Selecting only A and C produces `<Sequence> A` and `<Sequence> C`; selection does
  not renumber C to B. This keeps preview and idempotency stable.
- The job captures an immutable sequence revision/version snapshot, exact selected
  branch IDs and letters, exact campaign names, compiler version, selected
  instance/account snapshot, compiled canonical chains, and an idempotency key.
- Publishing never reads a newer document revision after the job is created.
- The compiler runs before job creation. The agent validates the canonical contract
  again before touching Linked Helper.
- The first rollout is allowlisted to one explicit physical Windows machine and its
  approved account profiles.
- The MVP should be admin-only unless an explicit publish capability is designed and
  approved before implementation.
- A stopped Linked Helper instance fails preflight. The publisher does not start it
  implicitly.
- A created campaign is explicitly paused even if it appears initially paused.
- No success is reported until name, account, action order/settings, zero targets, and
  `is_paused = 1` are read back and verified.
- If an exact-name campaign has a different canonical fingerprint, publishing reports
  `conflict` and changes nothing.
- Partial success is retained as empty paused campaigns. No automatic deletion,
  archiving, renaming, or repair of existing campaigns occurs.
- Recommended polling SLA is one to two minutes through a separate namespaced
  `publish-once` scheduled task, leaving the mature 30-minute sync task unchanged.

The following choices remain approval inputs before implementation:

- Initial pilot profile: `uitop-1`/Alyona or `uitop-2`/Katerina.
- Whether to retain admin-only access or introduce a dedicated publish capability.
- Exact allowed insertion boundaries for optional Visit, Follow, and Delay.
- Delay constraints. Proposed MVP default: integer hours from 1 to 720; zero is not
  valid, and an omitted delay means no delay Action.
- Whether a safe durable Linked Helper metadata field exists for a publication marker.
- Whether legal/product review permits internal UI APIs and any narrowly profiled
  direct database compatibility repair.

## Approach

### End-to-end flow

1. Sequence Builder opens a publish wizard.
2. The user selects the allowlisted Windows machine/account and branches.
3. The user configures optional Visit, Follow, and permitted Delay positions.
4. The pure compiler produces canonical campaign names and Action chains.
5. The UI shows the exact immutable preview.
6. On `Create paused campaigns`, `/api/playbook` validates authorization and creates
   one publish job plus one row per selected branch.
7. The target agent claims the job through existing machine authentication.
8. The agent performs a fail-closed compatibility and account preflight.
9. For each branch, the agent reconciles exact-name campaigns, creates only when no
   match exists, immediately pauses, journals the campaign ID, and reads back state.
10. The agent reports per-branch results guarded by the current claim generation.
11. Dashboard polls and displays queued, publishing, created, conflict, and failed.

### Pure compiler boundary

Create a separate module with this conceptual signature:

`SequenceDocument + PublishOptions + VerifiedAccountSnapshot -> CanonicalCampaign[]`

The output is deterministic and contains:

- stable branch ID and letter;
- exact campaign name;
- ordered canonical Actions;
- compiler version;
- canonical JSON/action fingerprint;
- validation warnings/errors.

#### Template AST compiler

Implement a tokenizer/parser that emits Linked Helper AST nodes. Never perform string
replacement on serialized JSON.

- `{firstName}` -> variable node `firstName`
- `{companyName}` -> variable node `company`
- `{jobTitle}` -> variable node `position`
- `{senderName}` -> static text resolved from the preflight-verified account identity
- unknown `{token}` -> validation error
- empty Connection Request -> valid empty group AST
- empty ordinary message -> validation error

#### Action normalization

- Visit: `VisitAndExtract`, `{}`, cooldown 60000, max 10.
- Follow: `Follow`, fixture settings, cooldown 60000, max 10.
- Ordinary Delay: `Waiter`, integer-hour delay, cooldown 0, max -1.
- Connection Request: `InvitePerson` with AST and fixture flags, cooldown 60000,
  max 10.
- Insert `FilterContactsOutOfMyNetwork` immediately after Invite.
- Message: `MessageToPerson` with empty subject AST, compiled message AST, fixture
  reply flags, cooldown 60000, max 10.
- Insert `CheckForReplies` after every Message.
- If another Message follows, encode its delay in the preceding CheckForReplies as
  `moveToSuccessfulAfterMs = hours * 3600000`; do not add an adjacent Waiter.
- After the final Message, use `moveToSuccessfulAfterMs = null`,
  `treatMessageAcceptedAsReply = false`, and
  `keepInQueueIfRequestIsNotAccepted = true`.
- Invite-to-first-message delay remains a separate Waiter.

### Persistence

Add append-only migration:

`postgres/tenant-baseline/v1/012_sequence_publish_jobs.sql`

#### `sequence_publish_jobs`

Immutable/request fields:

- `id`
- `sequence_document_id`
- `sequence_revision`
- `sequence_version_id`
- `document_snapshot`
- `document_fingerprint`
- `compiler_version`
- `target_instance_id`
- `target_machine_key`
- `target_account_snapshot`
- `idempotency_key`
- `payload_digest`

Mutable control fields:

- `status`
- `attempt`
- `claimed_by_credential_id`
- `claim_generation`
- `lease_expires_at`
- `queued_at`, `claimed_at`, `started_at`, `finished_at`, `updated_at`
- bounded sanitized error code/details

Constraints include `UNIQUE(target_instance_id, idempotency_key)`.

#### `sequence_publish_branches`

- `job_id`
- `branch_id`
- `branch_ordinal`
- `branch_letter`
- `campaign_name`
- `compiled_action_chain`
- `action_fingerprint`
- `status`
- `lh_campaign_id`
- canonical verification summary
- bounded sanitized error code/details
- timestamps

RLS and named operations must give a machine access only to jobs for its target
instance. The machine receives the immutable compiled job payload, not arbitrary
access to sequence documents. Human reads/writes follow the approved publish role.

Update the portable manifest, digest, inventory, pinned Worker imports, grants/RLS,
and clean-room/ledger tests. Never edit applied step 011.

### Job state machine

Job states:

`queued -> claimed -> preflight -> publishing -> success | partial_failure | conflict | failed`

Branch states:

`queued -> publishing -> created | conflict | failed`

The public UI may present claimed and preflight as publishing. An expired lease in
claimed, preflight, or publishing makes the same job reclaimable; it does not create a
new job.

`success` requires every selected branch to have:

- a Linked Helper campaign ID;
- matching exact name and account;
- matching Action count, order, type, settings, cooldowns, and limits;
- zero targets across all relevant Action target tables;
- `is_paused = 1`.

Mixed terminal branch outcomes produce `partial_failure`.

### Idempotency and crash recovery

1. The dashboard sends a caller-stable idempotency key and canonical payload digest.
2. Same key plus same digest returns the existing job.
3. Same key plus different digest returns conflict.
4. Before creation the agent searches for the exact campaign name:
   - zero matches: create;
   - one match: canonicalize and compare;
   - multiple matches: fail closed as ambiguous.
5. An identical canonical fingerprint may be adopted during recovery.
6. A different fingerprint returns branch conflict without modification.
7. Immediately after create, persist job ID, branch ID, fingerprint, and LH campaign ID
   in a protected atomic local journal before sending the result to the server.
8. Server result updates require the current `claim_generation`; stale workers cannot
   overwrite a re-leased attempt.

Exactly-once ownership cannot be mathematically proven after a crash between the LH
commit and receipt of an ID unless Linked Helper exposes a durable publication metadata
field. Adoption of one exact-name campaign with an identical canonical fingerprint is
therefore an explicit recovery policy, not proof of authorship by the job.

Recovery never deletes, archives, renames, starts, unpauses, changes, or adds targets to
an existing campaign.

### Agent compatibility gate

Before any pilot write, add a read-only diagnostic command that reports only
non-sensitive compatibility facts:

- exact Linked Helper version/build;
- launcher/instance CDP discovery and loopback binding;
- exact account ID/name/workspace mapping;
- `lh.db` schema fingerprint and safe access/WAL state;
- signatures/availability of create and campaign-scoped pause services;
- installed/available Actions and plugins;
- expected tables/columns needed for canonical readback;
- compatibility-profile match.

The pilot then separately observes:

- empty-invite AST behavior;
- initial paused and `is_valid` values;
- active Action-version selection;
- action exclude-list creation;
- zero-target representation;
- exact campaign-scoped pause behavior.

Unknown or unmatched profiles fail closed. Do not guess SQL for an unknown schema. Do
not use a stop implementation that also stops the global runner or unrelated campaigns.

### Dashboard UX

Add a modal/stepper within Sequence Builder:

1. Target machine and account.
2. Branch selection.
3. Optional supported workflow steps and delays.
4. Immutable preview with exact names and ordered Action chains.
5. Confirmation labelled `Create paused campaigns`.
6. Per-branch progress: queued, publishing, created, conflict, failed.
7. Success details: campaign name, Linked Helper campaign ID, target computer/account.

The confirmation screen must state that campaigns remain empty and paused. The UI must
not expose start, unpause, add-target, overwrite, or cleanup controls.

## Implementation phases

1. **Compatibility probe (M)**
   - Implement a read-only Windows diagnostic command.
   - Produce pilot LH build/schema/CDP/account/action inventory.
   - Define the first exact compatibility profile.
   - No campaign or database write.

2. **Pure compiler (M)**
   - Implement stable A/B/C naming and selection behavior.
   - Implement text/token to native AST compiler.
   - Normalize supported Actions, filters, delays, and CheckForReplies.
   - Add unit and fixture-equivalence tests.

3. **Local proof of concept (M)**
   - Implement the independent minimal CDP adapter.
   - After separate approval, create one hard-coded empty test campaign.
   - Explicitly pause and read back the campaign.
   - Prove zero targets and no LinkedIn activity.
   - Stop and reassess if the internal API leaves invalid/exclude-list state.

4. **Publish persistence and APIs (L)**
   - Add migration 012, RLS/grants, manifest and ledger integration.
   - Add human create/status operations through `/api/playbook`.
   - Add machine claim/heartbeat/result operations through `/api/import`.
   - Add leases, generations, payload digests, and per-branch results.

5. **Production Windows worker (L)**
   - Add `publish-once` command.
   - Add preflight, reconcile/create/pause/readback, local journal, and timeout recovery.
   - Add per-profile file/operation lock.
   - Add a separate namespaced scheduled task on the allowlisted machine only.

6. **Dashboard publish flow (L)**
   - Implement target, branch, options, preview, confirmation, and progress UI.
   - Enforce human authorization and immutable preview semantics.
   - Do not add campaign execution controls.

7. **Integration and controlled pilot (M)**
   - Run compiler, fixture, contract, idempotency, timeout, conflict, and partial-failure
     tests.
   - Release the agent only to the selected pilot machine.
   - After separate approval, create test paused campaigns.
   - Inspect them in Linked Helper UI.
   - Verify Action order/settings, empty Queue, paused state, and zero LinkedIn sends.

Each implementation phase should end with proportional verification and a logical commit.
Migration apply, agent rollout, pilot creation, and production deployment require their
own exact approval and verification gates.

## Affected files/modules

Expected changes:

- `frontend/src/pages/SequenceBuilder.tsx`
- `frontend/src/lib/sequenceBuilderApi.ts`
- new `frontend/src/lib/sequencePublish.ts`
- `frontend/src/styles.css`
- `frontend/api/playbook.ts`
- new `frontend/api/_lib/sequencePublish.ts`
- `frontend/api/_lib/data/operations/sequences.ts` or a dedicated publish operations
  module and registries
- `frontend/api/import.ts`
- `frontend/api/_lib/agent/machineOps.ts`
- machine operation contracts/registries/tests
- new `postgres/tenant-baseline/v1/012_sequence_publish_jobs.sql`
- `postgres/tenant-baseline/v1/ledger.manifest.json`
- portable schema inventory, clean-room, RLS, and ledger tests
- `sync-agent/agent.py`
- Windows installer/scheduler/config templates
- agent/server cross-language contract and recovery tests

Exact file placement should be rechecked immediately before implementation because the
repository may change after this specification.

## Risks and how to verify

### Version and schema drift

Risk: internal services and SQLite layout differ on the pilot build.

Verification: exact compatibility profile; read-only probe first; fail closed on any
unknown fingerprint; pilot create only after separate approval.

### `is_valid` and exclude-list repair

Risk: `createCampaign()` creates incomplete state.

Verification: read back the exact pilot schema and application-visible campaign. Prefer
an internal application repair API. Any direct transaction requires a proven fixture,
exact profile, rollback-safe test, and separate approval.

### Accidental send or runner start

Risk: a campaign or global runner becomes active.

Verification: no start/unpause operation exists in the adapter contract; explicit
campaign-scoped pause; `is_paused = 1`; empty target tables; UI inspection; outbound
network/LinkedIn activity check during the pilot.

### Ambiguous timeout and duplicates

Risk: LH creates a campaign but the worker loses the ID/result.

Verification: exact-name reconciliation, local atomic journal, canonical fingerprint,
payload digest, lease generation, and simulated crash tests at every write boundary.

### Existing-name conflict

Risk: an unrelated campaign has the requested name.

Verification: never overwrite; identical canonical state may be adopted by policy;
different or ambiguous state returns conflict.

### Partial success

Risk: some branches are created before a later branch fails.

Verification: per-branch terminal state and IDs; job becomes partial_failure; created
campaigns remain empty and paused; no automatic cleanup.

### Account and physical-machine ambiguity

Risk: instance labels are mistaken for a durable machine identity.

Verification: introduce an explicit target-machine capability/allowlist and require an
exact local account ID/name match, not a stale dashboard label.

### Secret and content exposure

Risk: logs or errors include outreach text, bearer tokens, credentials, Electron store,
or raw DB content.

Verification: structured error codes and bounded safe metadata only; redaction tests;
machine RLS limited to its target job.

### Licensing and product support

Risk: AGPL obligations or unsupported internal APIs/direct DB writes.

Verification: no copied `lhremote` implementation; legal review for a separate process;
commercial-license option; explicit product/legal approval for any schema write.

### Scheduler overlap and UI latency

Risk: two workers or sync and publish contend for local state; 30-minute progress delay.

Verification: separate `publish-once` task, one-to-two-minute cadence, profile-scoped
lock, claim lease, and overlap tests.

## Estimates

### Proof of concept

4-7 engineering days, excluding waiting for pilot-machine access and approval to create
one or more empty paused test campaigns.

The PoC includes compatibility probing, compiler core, minimal local CDP creation,
explicit pause, canonical readback, and zero-target/no-send proof. It does not include
the production job queue or complete dashboard flow.

### Production MVP

18-28 engineering days, realistically 4-6 calendar weeks for one engineer, excluding
legal review or commercial-license waiting time.

Approximate split:

- compatibility and compiler: 3-5 days;
- local adapter: 3-5 days;
- schema and APIs: 3-5 days;
- worker and recovery: 4-6 days;
- dashboard UI: 3-5 days;
- integration, controlled pilot, and release: 2-4 days.

## Definition of done

- Naming tests cover A/B/C and selected-branch stability.
- AST tests cover text, all supported variables, sender-name resolution, empty invite,
  unknown tokens, and empty-message rejection.
- Fixture tests cover every supported `actionSettings`, cooldown, and per-iteration
  limit.
- Compiler tests cover optional Visit/Follow/Delay, invite filter insertion,
  invite-to-first-message Waiter, inter-message CheckForReplies timeout, and final
  Never.
- Job tests cover same-key replay, digest conflict, lease expiry, stale generation,
  ambiguous timeout recovery, exact-name conflict, and partial failure.
- Agent integration tests prove create/pause/readback behavior without starting a
  campaign or adding targets.
- No adapter/API/UI contract contains start, unpause, global runner, add-target,
  overwrite, archive, or delete operations.
- Controlled pilot campaigns are visually inspected in Linked Helper UI.
- Every pilot campaign has the correct name/account/action chain, empty Queue, and
  `is_paused = 1`.
- Pilot monitoring confirms that nothing was sent to LinkedIn.
- Rollout is limited to one explicitly allowlisted physical Windows machine.
- Migration, agent release, and production dashboard deployment follow separate
  preflight, exact approval, apply/resume, and verification gates.

