# Linked Helper automatic compatibility promotion

## Goal

Keep Sequence Builder publishing operational when Linked Helper 2 installs routine patch updates, without requiring an operator to edit every notebook's local version fields. The system will automatically accept only builds whose live publishing capabilities and publishing-relevant SQLite schema exactly match an approved contract, use `notebook-1` as the canary for unknown contracts, replace version-stranded jobs audibly, and notify the Slack replies channel when automation cannot prove compatibility.

## Non-goals

- Do not treat a version string alone as proof of compatibility.
- Do not auto-approve a changed or unknown publishing schema without a successful notebook-1 canary.
- Do not start or unpause campaigns, add targets or leads, or add rename, archive, delete, or direct-SQL repair capabilities.
- Do not mutate immutable publish-job snapshots or retry a failed job in place.
- Do not make `lh2_publish` remotely editable or move machine credentials and security acknowledgements out of local configuration.
- Do not use the Supabase legacy migration path or change frozen `supabase/migrations/`.

## Research findings

- The agent already measures the running LH2 version from the executable path; CDP port changes are discovered dynamically and do not require config rewrites.
- `publish-probe` already checks the native create, pause, validate, canonical-readback, and zero-target capabilities. `publish-once` repeats the live preflight immediately before mutation.
- Publishing is fail-closed and narrowly scoped. Post-create verification covers immutable action fingerprints, paused state, zero targets, and action-version/exclude-list integrity.
- The current blocker is artificial coupling between a measured patch version and notebook-local `lh_version` / `compatibility_profile` strings. A compatible patch update therefore fails with `LH_VERSION_MISMATCH` before the worker can claim a job.
- Publish jobs intentionally contain an immutable target snapshot. A job created before an LH2 update cannot safely be made compatible by editing its snapshot; it needs an audited replacement that retains the sequence revision and publish options.
- Runtime/archive status already demonstrates the safer compatibility pattern: exact profile plus an exact canonical table/column fingerprint, with unknown fingerprints remaining unverified.
- Agent releases self-update only from a real `sync` run. The independent two-minute publisher task does not currently guarantee a self-update before probing or claiming.
- Chrome DevTools Protocol does not guarantee backward compatibility, and SQLite's numeric `schema_version` is not a sufficient compatibility identity. Live capability checks plus a canonical publishing-schema fingerprint are required.

## Decisions

- Automatically accept a new LH2 version only when its live publishing capabilities and publishing-relevant schema fingerprint exactly match an approved contract.
- Automatically create an audited replacement for jobs stranded by an LH2 version change, preserving the original immutable sequence revision, compiled branches, and publish options. Never modify or silently revive the original job.
- Use `notebook-1` as the only automatic canary for an unknown compatibility contract. The canary creates one empty, explicitly paused campaign and must pass canonical verification before the contract is approved for other notebooks.
- Send unknown, failed, or incompatible compatibility-promotion alerts to the existing Slack replies destination (`SLACK_REPLIES_WEBHOOK_URL`, with the existing webhook fallback behavior).

## Approach

Separate stable notebook identity/security configuration from measured LH2 compatibility. Local configuration will retain `machine_key`, account/workspace identity, adapter enablement, and the explicit secure acknowledgement, while version and contract selection become measured runtime state.

Add a deterministic `publish_contract_fingerprint` built from only the fields that affect safe publishing: required CDP/native methods and their bounded response shapes, the compiler/native action contract version, and a canonical fingerprint of the publishing-relevant SQLite tables, columns, indexes, and relationships used by create/pause/readback verification. Unrelated LH2 schema changes must not create false incompatibility.

The agent will report measured version, contract fingerprint, evidence, and probe result to the gateway. The server will maintain an append-only compatibility-contract registry with explicit audited transitions: `observed -> canary_pending -> approved|rejected`. Supersession and replacement relationships will be recorded separately rather than overloading compatibility state.

For an already approved fingerprint, any notebook may automatically bind the newly measured LH2 version to that contract after a fresh successful read-only probe. This updates effective measured state, not security-sensitive local YAML. Publishing remains blocked if the fingerprint is unknown, the probe is stale, account identity changes, or any capability differs.

For a new fingerprint, only `notebook-1` may claim a server-created canary operation. The canary will compile a fixed internal no-message-or-network-effect fixture into one empty campaign, create it through the existing native adapter, force it paused, and perform canonical readback. It must confirm account ownership, action structure, action fingerprints, `is_paused = true`, zero targets, and complete exclude-list links. The canary campaign remains visible and auditable; no automatic deletion or archive is added.

When a publish job fails solely because its immutable target snapshot names an older approved contract, the server creates at most one replacement job using a unique `replaces_job_id` constraint and a deterministic idempotency key. The replacement reuses the original sequence/document snapshots, compiler version, branches, and options, but captures the now-approved target contract. Non-version failures, partial creations, conflicts, unknown contracts, account changes, or changed payload digests are never auto-replaced.

Every publisher cycle will run a bounded self-update check, measure/probe compatibility, report evidence, process an eligible notebook-1 canary if required, then claim ordinary jobs only when the current contract is approved and fresh. Slack replies alerts will be deduplicated by machine, measured version, fingerprint, and transition so repeated two-minute runs remain quiet.

## Implementation phases

1. **S — Define and test the compatibility contract**
   - Extract a canonical publishing-schema inventory and fingerprint from the existing read-only SQLite connection.
   - Define the capability evidence and deterministic overall contract fingerprint.
   - Add fixtures proving that version-only changes with identical relevant schema produce the same contract, while required method/schema changes produce a different contract and fail closed.

2. **M — Add portable registry and audit schema**
   - Append a new portable PostgreSQL ledger step for compatibility contracts, observed build bindings, canary operations/results, and replacement-job lineage.
   - Add uniqueness constraints for one canary per fingerprint and one replacement per stranded job.
   - Add machine-scoped read/report/claim operations without exposing raw write SQL or broadening the owner operations surface.

3. **M — Upgrade agent probe and publisher orchestration**
   - Remove operational dependence on manually maintained version/profile strings while preserving local security fields.
   - Report measured evidence and resolve effective approval from the gateway.
   - Add publisher-cycle self-update, freshness checks, notebook-1-only canary handling, and strict blocks for unknown/rejected contracts.
   - Reuse the existing native create/pause/verify path for canaries; do not create a second mutation implementation.

4. **M — Add safe stranded-job replacement**
   - Classify terminal failures precisely so only version/contract snapshot drift is eligible.
   - Create a replacement from the original immutable snapshots after the new contract is approved.
   - Preserve full lineage and surface both the failed original and active replacement in API results.

5. **S — Add Slack replies alerts and dashboard visibility**
   - Send deduplicated alerts for unknown fingerprints, rejected canaries, stale probes, and replacement exhaustion.
   - Show observed/approved contract, measured LH2 version, canary state, and replacement lineage without labeling an unknown runtime as ready.
   - Keep sync health, LH2 runtime status, archive state, and Builder publishing progress separate.

6. **M — Canary-first rollout**
   - Deploy the portable schema/API and signed agent release in compatibility-report-only mode.
   - Validate notebook 1 against its current LH2 build, then enable automatic canary handling there.
   - Observe one real LH2 patch transition or a controlled fixture-equivalent transition before enabling automatic binding/replacement on the other notebooks.
   - Roll out to `notebook-2`, `notebook-3`, and `karina-1` only after notebook-1 evidence is complete.

## Affected files/modules

- `sync-agent/agent.py`
- `sync-agent/config.example.yaml`
- `sync-agent/install-windows.ps1`
- `sync-agent/tests/test_ingest_transport.py`
- `sync-agent/tests/fixtures/` compatibility fixtures
- `frontend/api/_lib/agent/machineOps.ts`
- `frontend/api/_lib/data/operations/sequencePublishing.ts`
- `frontend/api/_lib/sequencePublish.ts`
- `frontend/api/notify-replies.ts` or a shared Slack delivery helper
- `frontend/src/lib/sequenceBuilderApi.ts`
- `frontend/src/pages/SequenceBuilder.tsx`
- `frontend/src/pages/Health.tsx`
- `postgres/tenant-baseline/v1/` new append-only ledger artifact and manifest entry
- Portable migration and API/agent contract tests
- `docs/implementation-handoffs/campaign-creator-summary.md`

## Risks & how to verify

- **False approval after a breaking LH2 update:** mutate each required method, response shape, and relevant schema element in fixtures; every mutation must yield a new/unknown fingerprint and block ordinary publishing.
- **False block from unrelated LH2 schema drift:** add unrelated tables/columns in fixtures; the publishing-contract fingerprint must remain unchanged.
- **Canary causes LinkedIn activity:** verify the fixture contains no leads, the adapter offers no target/start operation, the campaign is forced paused before success is reported, and canonical target count is zero.
- **Duplicate canaries or replacement jobs:** exercise concurrent claims and repeated scheduler runs; database uniqueness plus idempotency must result in one canary and one replacement.
- **Replacement changes user intent:** compare the original and replacement document fingerprint, compiler version, compiled branch fingerprints, campaign names, timing, and selected branches byte-for-byte except for target-contract metadata.
- **Agent update ordering race:** test a stale agent entering a publisher cycle; it must self-update/re-exec or block before reporting/claiming under an unsupported contract.
- **Alert spam:** replay the same unknown fingerprint every two minutes; Slack receives one initial alert and one material transition alert, not periodic duplicates.
- **Cross-machine promotion mistake:** prove notebooks other than `notebook-1` cannot claim an unknown-contract canary and cannot publish until the notebook-1 result is approved.
- **Production verification:** separately record schema applied, API deployed Ready, signed agent release installed, probe evidence, canary result, job replacement lineage, dashboard state, Slack delivery, and LH2 UI/canonical readback. Do not infer one layer from another.

## Definition of done

- Routine LH2 patch changes with an identical approved publishing-contract fingerprint require no local config edits on any notebook.
- An unknown fingerprint blocks ordinary publishing and produces one Slack replies alert.
- Only notebook 1 can automatically run the empty paused canary for an unknown fingerprint.
- A successful canary approves the contract and allows fresh probes on the remaining notebooks to bind automatically.
- A failed or ambiguous canary leaves the contract rejected or unresolved and publishing blocked.
- A job stranded solely by an old compatible-version snapshot receives exactly one audited replacement after approval, with its immutable intent preserved.
- The replacement publishes successfully or terminates with a visible bounded error; it never loops indefinitely.
- Canonical verification proves created campaigns are owned by the intended account, paused, empty, structurally valid, and complete in exclude-list linkage.
- Slack replies receives deduplicated actionable alerts for incompatibility and failed recovery.
- Relevant agent, API, portable-schema, concurrency, migration, and frontend tests pass; frontend build passes.
- Canary-first production evidence is recorded for notebook 1 before fleet enablement.
