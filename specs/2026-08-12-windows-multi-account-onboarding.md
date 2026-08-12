# Windows multi-account notebook onboarding

## Goal

Support two Linked Helper accounts on one Windows computer without mixing their
identity, credentials, database paths, reports, or scheduled syncs. The first
rollout maps Alyona Kirilchenko to `uitop-1` and Katerina Bulkina to `uitop-2`,
while preserving the partially installed `uitop-1` state and keeping both
accounts behind independent dry-run and activation gates.

## Non-goals

- Do not combine two LinkedIn accounts into one dashboard instance or one
  credential.
- Do not infer account identity from folder number, modification time, campaign
  count, or the account currently visible in LH2.
- Do not share a mutable `agent.py`, config, state, log, report, or scheduled task
  between accounts.
- Do not activate either account automatically or send live data before its own
  dry-run counts are reviewed against LH2.
- Do not enable photo sync during this rollout.

## Research findings

- The dashboard data model already scopes campaigns, leads, messages, and events
  by `instance_id`; no backend redesign is required for two accounts on one PC.
- The ingest endpoint binds each machine credential to exactly one
  `instance_id`, so `uitop-1` and `uitop-2` need different `lha.` credentials.
- The existing installer is singleton: `%USERPROFILE%\sync-agent`, one
  `config.yaml`, one state/report/log set, and the fixed Task Scheduler name
  `LH2 Sync Agent`. A second run would reuse the first identity, and `-Force`
  registration would replace the first task.
- Both discovered LH2 databases contain one `li_accounts` row with a
  `full_name`. A read-only `SELECT full_name FROM li_accounts LIMIT 1` can map
  each absolute database path to Alyona or Katerina without exposing a secret.
- Both database schemas lack the milestone columns used by the bundled generic
  leads mapping. Multi-profile support alone will not fix the current
  `pic.invited_at` failure; the leads query must use verified current-schema
  sources such as action results, reply messages, and connection records.
- SQLite `mode=ro` preserves the existing non-mutating access contract.
- Windows Scheduled Tasks can coexist under unique task names. `IgnoreNew`
  prevents overlap only within the same named task, so the two profiles should
  use staggered triggers.

## Decisions

| Question | Decision |
| --- | --- |
| Stable instance mapping | Alyona Kirilchenko → `uitop-1`; Katerina Bulkina → `uitop-2` |
| User experience | One installer manages two isolated per-account profiles |
| Database association | Match exact `li_accounts.full_name`; refuse missing, duplicate, or unexpected names |
| Scheduling | Each account runs every 30 minutes; Katerina's trigger is offset by 15 minutes |
| Existing installation | Adopt and migrate the installer-owned partial `uitop-1`; never overwrite an unowned installation |
| Credentials | Preserve the existing `uitop-1` token; require a separately issued token for `uitop-2` |
| Activation | Review and activate each account independently |

## Approach

Introduce an installer-level profile registry containing only non-secret routing
metadata. Each profile gets its own root, for example
`%USERPROFILE%\sync-agents\uitop-1` and `...\uitop-2`, with its own agent,
virtual environment, config, state, reports, and logs. Tokens remain only inside
the corresponding protected `config.yaml`.

During discovery, inspect every candidate `lh.db` read-only, read the single
`li_accounts.full_name`, and match it exactly to the approved account map. Pin
the resulting absolute `lh2_db_path` locally for each profile. Do not allow
remote config to change this identity-defining path for managed multi-profile
installations.

Namespace Windows scheduled tasks by instance, for example
`LH2 Sync Agent — uitop-1` and `LH2 Sync Agent — uitop-2`. Registration, start,
status, verification, and cleanup must all receive the exact task name rather
than use a global constant. Give the second task a 15-minute initial offset.

Replace the invalid generic leads mapping with a query verified against this LH2
schema. It must produce one lead per `(campaign_id, profile_url)`, preserve the
one-human-slug deduplication, derive invite/reply milestones from successful
action history, derive connection time from the connection table, and avoid
inventing timestamps. Validate each database separately with a dry run and a
manual LH2 count comparison.

## Implementation phases

1. **Profile identity and discovery (M).** Add the approved two-account manifest,
   read-only `li_accounts.full_name` discovery, exact-match refusals, explicit
   database pinning, and diagnostics that show account name beside its path.
2. **Isolated installation roots (M).** Generalize installer state and paths to
   one root per instance; preserve the existing `uitop-1` token and safely adopt
   its installer-owned partial state. Add `uitop-2` without touching the first
   config.
3. **Namespaced Windows scheduling (M).** Parameterize task names and initial
   offsets across register/start/status/unregister and scheduler verification.
   Prove operations on one profile cannot affect the other.
4. **Current-schema mapping (L).** Implement and test the milestone query against
   representative SQLite fixtures, then include it in each generated profile
   config. Keep messages and steps on their existing built-in queries.
5. **Bundle and offline rehearsal (M).** Build one Windows bundle and rehearse
   migration of the partial singleton install, fresh second-profile creation,
   reruns, malformed/duplicate account discovery, wrong credentials, and redaction.
6. **Two independent rollout gates (M).** Issue the `uitop-2` credential, run both
   dry runs, compare account names and campaign funnel counts with LH2, activate
   Alyona first, then Katerina, and verify one scheduler-originated `sync ok` for
   each staggered task.

## Affected files/modules

- `sync-agent/installer/install.py` — profile registry, discovery, migration,
  per-profile roots, menus, validation, reports, and scheduler calls.
- `sync-agent/install-windows.ps1` — parameterized task name and trigger offset.
- `sync-agent/installer/config.template.json` — corrected current-schema mapping
  and explicit local database pin.
- `sync-agent/installer/build-bundles.py` — bundle inputs if a profile manifest is
  added as a separate file.
- `sync-agent/tests/test_installers.py` — two-profile isolation, migration,
  scheduler, redaction, and bundle tests.
- `sync-agent/tests/` fixtures — representative current LH2 schema and milestone
  rows for mapping tests.
- `docs/tenant-onboarding/notebook onboarding.md` — two-account Windows flow and
  independent approval steps.
- `docs/tenant-onboarding/uitop-notebook-setup-ru.md` — operator credential and
  parity checklist for both instances.

## Risks & how to verify

- **Database cross-wiring.** Refuse any database whose stored full name is not an
  exact approved match; reports must print account name, instance ID, and a
  redacted path identifier together.
- **Token reuse or leakage.** Require two credential IDs, scan stdout, reports,
  logs, state, registry, task definitions, and archives for token canaries; only
  each protected config may contain its own token.
- **Existing `uitop-1` loss.** Migrate only when the current root carries the
  installer's ownership marker and matching instance ID; otherwise stop without
  moving or rewriting anything.
- **One task replacing or deleting the other.** Tests register two recording
  tasks, then start/status/unregister each independently and assert the other is
  unchanged.
- **Incorrect funnel semantics.** Fixture tests cover invite success/failure,
  multiple history rows, repeated reply observations, connection timestamps,
  duplicate public IDs, and one person present in multiple campaigns. Final
  acceptance still requires manual count comparison for both real databases.
- **Concurrent load.** Verify task trigger times differ by 15 minutes and each
  retains `MultipleInstances=IgnoreNew`.
- **Partial activation.** A failure for one profile must leave the other profile's
  state and schedule unchanged; each activation requires its own fresh dry run.

## Definition of done

- The installer identifies the two real databases as Alyona and Katerina using
  stored LH2 account identity, not heuristics.
- `uitop-1` and `uitop-2` have different roots, configs, credentials, state,
  reports, logs, runner files, and Windows tasks.
- The existing `uitop-1` partial installation is preserved and migrated without
  re-entering its token.
- Both dry runs finish without traceback, state `mode 'only'`, report non-empty
  campaigns/leads, and show `parity ok`.
- Counts for each account are separately reviewed against LH2 before activation.
- Each live activation ends in `sync ok`, and each namespaced scheduled task
  produces its own scheduler-originated `sync ok` at the staggered time.
- No token appears in any bundle, report, state, log, task definition, console
  capture, or Git diff.
- Installer tests, transport tests, deterministic bundle checks, and the relevant
  frontend build remain green.
