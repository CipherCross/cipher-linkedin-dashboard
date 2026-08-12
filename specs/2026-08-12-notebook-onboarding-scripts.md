# Notebook onboarding scripts

## Goal

Replace the long, command-by-command notebook onboarding guide with one guided
launcher for macOS and one for Windows. Each launcher installs and validates the
LH2 sync agent without exposing the machine credential, then stops after a safe
dry run; a separate activation on the same launcher performs the first real sync
and enables the 30-minute schedule only after the operator has approved the LH2
counts.

The end-user experience should be: download the platform bundle, launch its
entrypoint, enter `instance_id`, a human-readable label, and the one-time
`lha.` credential, then send the generated non-secret report to the operator.

## Non-goals

- No signed or notarized `.pkg`, `.dmg`, `.msi`, or `.exe` installer in v1.
- No automatic installation of Python; the launcher detects an unsupported or
  missing Python version and gives a short, platform-specific instruction.
- No first real sync or schedule registration during the install phase.
- No automatic reconciliation or approval of LH2 campaign counts.
- No attempt to infer or repair an unknown LH2 SQLite schema. The bundled
  mapping is tried and the launcher stops safely when it does not fit.
- No Keychain or Windows Credential Manager integration in v1. The token remains
  in `config.yaml`, protected by user-only filesystem permissions.
- No system daemon, service account, or logged-out execution. Scheduling is for
  the currently logged-in notebook user.
- No migration of legacy Supabase/shadow/dual installations. An existing
  installation with a different identity or layout is reported and left
  untouched for operator handling.
- No production agent publication, dashboard deployment, credential issuance,
  or tenant lifecycle operation.
- No full repair/uninstall product in this iteration; safe reruns may resume an
  installer-owned partial installation, but must not overwrite an unrelated or
  already active agent.

## Research findings

- `docs/tenant-onboarding/notebook onboarding.md` currently walks a
  non-technical user through Python, virtualenv creation, a pinned agent
  download, YAML creation, inspection, dry run, first live sync, and scheduling.
  Those mechanics can be scripted, but its human comparison of LH2 counts must
  remain an explicit approval gate.
- `docs/tenant-onboarding/uitop-notebook-setup-ru.md` overlaps the end-user
  guide and also contains operator prerequisites. The two documents should not
  remain independent sources of installer truth.
- `sync-agent/agent.py` resolves `config.yaml` relative to its own directory,
  validates the machine credential, merges only allowlisted remote config, and
  verifies signed self-updates before atomic replacement. `instance_id`,
  `ingest_token`, and `release_public_key` must stay local-only.
- `sync-agent/requirements.txt` is the dependency source of truth. The installer
  should not carry a separately maintained package list.
- `sync-agent/config.example.yaml` is useful background but includes legacy
  paths and generic mapping commentary. A narrow installer template should
  contain only the machine-only onboarding configuration and the currently
  proven mapping from the guide.
- The mapping is not universal across LH2 versions. `inspect` can identify
  candidates, while the dry run may fail with a missing table or column. That
  is a mapping-validation result, not an installation failure to repair blindly.
- The rollout prompt establishes reusable safety gates: never print the token,
  never change `instance_id`, verify the pinned artifact before installation,
  compile it, inspect LH2, require dry-run parity, compare counts, and stop on
  schema or extraction errors.
- Apple recommends `launchd` for per-user background processes. A LaunchAgent
  in `~/Library/LaunchAgents` is a better fit than the guide's current `cron`
  entry and is inspectable through `launchctl`:
  <https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html>.
- Windows Task Scheduler supports explicit executable, arguments, working
  directory, repeating triggers, and single-instance behavior. The task should
  run as the current interactive user and set its working directory explicitly:
  <https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskaction>,
  <https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasktrigger>,
  <https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset>.
- The worktree already contains unrelated modified and untracked documentation.
  Implementation must preserve it and stage only files owned by this feature.

## Decisions

| Question | Decision |
| --- | --- |
| When may data first be sent? | Installation stops after `sync --dry-run`. Activation is a separate action performed only after the operator approves the LH2 comparison. |
| How should LH2 schema variation be handled? | Bundle the mapping currently in the guide, always generate `inspect.txt`, and stop with an operator-facing report if the mapping does not fit. Do not guess or patch SQL on the notebook. |
| Where is the machine credential stored in v1? | In local `config.yaml`, with `0600` permissions on macOS and a current-user-only ACL on Windows. Never include it in arguments, task definitions, logs, reports, or console output. |
| Must sync run while nobody is logged in? | No. Use a per-user macOS LaunchAgent and a current-user Windows scheduled task. |
| What is the distribution format? | Scripts and supporting assets, not signed native installers. The visible entrypoints are a double-clickable `.command` on macOS and `.cmd` on Windows; the Windows wrapper invokes the PowerShell implementation. |
| Language and initial audience | Russian prompts for a non-technical notebook user. |
| Existing installations | v1 targets fresh installs. It detects existing state, preserves identity and credentials, resumes only clearly installer-owned partial state, and otherwise stops for operator review. |

## Approach

Ship a small platform bundle with one user-facing launcher per OS and shared,
non-secret installer assets. Both launchers implement the same state machine and
write only under the current user's agent directory (`~/sync-agent` on macOS,
`%USERPROFILE%\sync-agent` on Windows):

1. **Preflight.** Detect the OS context, writable install location, network
   access, Python 3.10+, and an existing agent or scheduled job. Validate the
   entered `instance_id` and `lha.<uuid>.<secret>` shape without displaying the
   credential. Reject placeholders, control characters, and unsafe identity
   changes.
2. **Verified install.** Create a virtualenv, install the repository-owned
   requirements, download the pinned `agent.py` to a temporary path, and verify
   its SHA-256, byte length, declared version, and Python compilation before an
   atomic move. Keep release URL, commit, version, size, and hash in one shared
   metadata asset consumed by both platform implementations.
3. **Protected configuration.** Render a narrow YAML template using a real YAML
   serializer or safely quoted values rather than text substitution. Preserve
   the fixed gateway, release key, machine-only mode, and proven LH2 mapping.
   Tighten file permissions immediately and verify that the resulting YAML
   parses and contains the unchanged identity.
4. **Inspection and rehearsal.** Run `inspect` into `inspect.txt`, then
   `sync --dry-run` into a separate redacted transcript. Require a discovered
   `lh.db`, successful extraction, `mode 'only'`, and `parity ok`. Treat missing
   columns/tables, an empty campaign set, parity problems, malformed credentials,
   or a traceback as a hard stop. The launcher must not treat successful process
   exit alone as approval.
5. **Operator handoff.** Generate a UTF-8 report containing platform, instance
   ID, agent version/hash verification, LH2 database discovery status,
   per-campaign dry-run counts, parity, warning lines, and an explicit
   `NOT ACTIVATED` state. It must contain no credential or config dump. Tell the
   user which two files to send: the report and `inspect.txt`.
6. **Explicit activation.** On a later launch, offer an `Activate` action only
   for a complete, not-yet-active install. Require the user to type a clear
   Russian confirmation that the operator approved the displayed instance ID
   and counts. Re-run the dry run to avoid activating stale or changed state,
   perform one real sync, require a final `sync ok`, and only then register the
   schedule. If the live sync fails, do not register a job.
7. **Native schedule verification.** On macOS, install a user LaunchAgent with
   absolute `ProgramArguments`, `WorkingDirectory`, `StartInterval=1800`, and
   explicit stdout/stderr log paths, then load it with modern `launchctl`
   commands. On Windows, register a limited-privilege current-user task with an
   explicit Python executable, arguments, working directory, 30-minute
   repetition, `StartWhenAvailable`, and `MultipleInstances=IgnoreNew`. Run one
   scheduler-originated verification and confirm a fresh successful log entry.
8. **Safe reruns and status.** Store no secrets in installer state. Infer state
   from validated files and native scheduler definitions. Re-running the
   launcher should show `Install`, `Activate`, or `Status` as appropriate;
   conflicting instance IDs, paths, or tasks stop without mutation.

The current long guide becomes an operator/troubleshooting reference rather
than something each notebook user must execute. One canonical short README will
explain distribution, the install/approval/activation sequence, expected files,
and the remaining Python/security-warning steps.

## Implementation phases

1. **Canonical assets and contracts (S).** Add the shared pinned-release
   metadata, narrow YAML template, stable install/scheduler identifiers, redacted
   report schema, and test fixtures. Add validation tests proving the two
   platform launchers consume identical release/config constants.
2. **macOS launcher (M).** Implement the Russian interactive install,
   inspection, dry-run, report, activation, LaunchAgent registration, status,
   permissions, and safe-rerun behavior. Exercise it with fixture commands and
   a disposable user-space install root before a local smoke test.
3. **Windows launcher (M).** Implement the `.cmd` entrypoint and PowerShell
   workflow with equivalent gates, ACLs, Task Scheduler behavior, reporting,
   and safe reruns. Parse-check locally when PowerShell is available and run the
   clean-user acceptance flow in a Windows VM before distribution.
4. **Documentation consolidation (S).** Replace the manual end-user path with a
   short Russian download/install/approval/activation guide. Retain operator
   prerequisites and troubleshooting in one canonical document, link rather
   than duplicate it, and clearly mark that the scripts do not issue credentials
   or approve dry-run numbers.
5. **End-to-end release rehearsal (M).** Build both platform bundles from the
   same committed inputs. Rehearse fresh install, schema mismatch, wrong token
   shape, interrupted install, rejected activation, successful activation,
   overlapping schedule prevention, and safe rerun. Record the exact bundle
   hashes distributed to notebook users; publishing or live rollout remains a
   separate user-approved action.

## Affected files/modules

- New `sync-agent/install-macos.command` — macOS user-facing launcher.
- New `sync-agent/install-windows.cmd` — Windows double-click wrapper.
- New `sync-agent/install-windows.ps1` — Windows implementation.
- New `sync-agent/installer/release.json` — one pinned artifact metadata source.
- New `sync-agent/installer/config.template.yaml` — machine-only config and
  proven LH2 mapping without per-notebook values.
- New `sync-agent/installer/` helper assets as needed for report/state handling.
- New `sync-agent/tests/test_installers.py` and fixtures — cross-platform
  contract, redaction, state transition, and failure-path tests.
- `docs/tenant-onboarding/notebook onboarding.md` — shortened end-user flow and
  troubleshooting link, preserving useful operator escalation details.
- `docs/tenant-onboarding/uitop-notebook-setup-ru.md` — consolidated so it no
  longer duplicates a second independently maintained end-user procedure.
- Possibly `sync-agent/requirements.txt` only if installer execution exposes an
  actual missing or incompatible dependency; otherwise it remains unchanged and
  authoritative.
- No change is expected in `sync-agent/agent.py`; credential-store integration
  and broader lifecycle support remain future work.

## Risks & how to verify

| Risk | Verification |
| --- | --- |
| A script sends live data during installation. | Tests replace the agent with a recording fixture and assert install invokes only `inspect` and `sync --dry-run`; no unflagged `sync` or scheduler registration occurs before activation. |
| A token leaks through prompts, process arguments, YAML errors, reports, or logs. | Canary-token tests scan captured stdout/stderr, command records, scheduler definitions, reports, and logs; only the permission-restricted config may contain it. Error paths are included. |
| An existing notebook identity is overwritten. | Rerun tests cover matching partial installs, a different `instance_id`, an existing task/plist, and a legacy config. Only the clearly owned matching partial state may be resumed. |
| The downloaded agent is truncated or replaced. | Fixtures independently fail URL, hash, byte count, version, and compile gates; `agent.py` must remain absent or unchanged in every failure case. |
| Generic mapping silently produces bad data. | Require `lh.db` discovery, non-empty extraction, `mode 'only'`, `parity ok`, and operator approval of the captured campaign table. Schema/SQL errors stop before activation. |
| macOS background execution differs from the interactive shell. | Use absolute paths and a LaunchAgent working directory; inspect `launchctl print`, trigger with `kickstart`, and verify a new `sync ok` entry under a clean user account. |
| Windows task runs from `System32`, overlaps, or lacks network access. | Assert the registered working directory and current-user principal, set `IgnoreNew` and `StartWhenAvailable`, trigger the task, inspect its result, and verify a new `sync ok` log entry in a Windows VM. |
| Windows PowerShell execution policy blocks a double-click. | The `.cmd` wrapper invokes the local script with a process-scoped policy override and no profile. Test common default Windows client policy configurations; if organization policy still blocks it, stop with a specific operator message. |
| macOS quarantine or executable-bit handling blocks launch. | Test the actual downloaded archive through Finder. Document the smallest explicit user action needed for an unsigned script; do not instruct users to disable Gatekeeper globally. |
| Two docs drift again. | Tests or a documentation check assert that release metadata and the full YAML mapping occur only in shared installer assets, not duplicated prose. |
| Platform testing creates a real scheduled job or sends production data. | Automated tests use disposable roots, fake executables, and recording scheduler adapters. Real scheduling smoke tests use an explicitly controlled test identity/endpoint; live tenant rollout requires separate approval. |

## Definition of done

- A non-technical macOS user can launch the downloaded `.command`, enter the
  three per-notebook values, and obtain `inspect.txt` plus a redacted dry-run
  report without any data being sent or schedule being registered.
- A non-technical Windows user can do the equivalent by launching the `.cmd`
  wrapper under a normal current-user account without administrator rights.
- Both installers use the same pinned agent metadata, requirements source, YAML
  template, identity rules, report fields, and activation gates.
- The machine credential is accepted without echo, validated by shape, stored
  only in the protected config, and absent from all other observed outputs and
  scheduler definitions.
- Missing Python, failed downloads, mismatched artifact metadata, invalid YAML,
  missing LH2 data, schema drift, empty extraction, parity failure, and existing
  identity conflicts all stop safely with a Russian operator-facing message.
- Activation cannot proceed without a fresh successful dry run and explicit
  approval confirmation; a failed live sync leaves scheduling disabled.
- Successful activation produces one confirmed `sync ok`, then creates a
  verified 30-minute per-user LaunchAgent or scheduled task that prevents
  overlapping runs and writes inspectable logs.
- Safe reruns report the correct state and never overwrite a different or legacy
  installation.
- Installer contract/redaction/failure-path tests pass locally; the macOS flow
  passes under a clean user account and the Windows flow passes in a clean VM.
- The Russian onboarding documentation is short, canonical, and tells users
  only how to install, send the approval report, activate, check status, and
  escalate failures.
- No production credential is minted, no live tenant is contacted, no agent
  release is published, and no notebook rollout occurs as part of implementation
  or verification without separate authorization.
